// Block indexer for Elyon Explorer.
//
// Loop:
//   1. Read `last_indexed_block` from sync_state
//   2. Pull head block number from RPC
//   3. For each new block (up to head - headLag):
//        - eth_getBlockByNumber (full)
//        - eth_getTransactionReceipt for each tx (parallel, capped)
//        - Decode URELAY1 attestations from extraData
//        - Parse ERC-20 Transfer events from receipt logs
//        - Compute Elyon fee distribution (node/contract/token/admin)
//        - Persist everything in a single transaction
//   4. Sleep pollMs and repeat
//
// The indexer is purposely simple — no parallel block ingestion, no reorg
// handling beyond `headLag` (we stay N blocks behind the head, by which
// point reorgs on a PoA-style L2 are vanishingly rare). For mainnet we'd
// add proper reorg detection.

import { provider, parseUrelay, ERC20_IFACE, rpc } from './rpc.js';
import { pool, q, q1, tx, norm } from './db.js';
import { config } from './config.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// In-memory set of token addresses we've already enriched this process —
// avoids retrying tokens whose calls revert (e.g. non-ERC20 contracts that
// happen to emit a Transfer-shaped event).
const enrichedTokens = new Set();
const enrichmentFailed = new Set();

function bn(x) {
  if (x == null) return '0';
  if (typeof x === 'bigint') return x.toString();
  if (typeof x === 'number') return x.toString();
  if (typeof x === 'string') {
    if (x.startsWith('0x')) return BigInt(x).toString();
    return x;
  }
  return String(x);
}

async function getSyncedBlock() {
  const r = await q1('SELECT last_indexed_block FROM sync_state WHERE id = 1');
  return Number(r?.last_indexed_block ?? -1);
}

async function setSyncedBlock(client, n) {
  await client.query('UPDATE sync_state SET last_indexed_block = $1, updated_at = NOW() WHERE id = 1', [n]);
}

async function fetchBlock(num) {
  return rpc('eth_getBlockByNumber', ['0x' + num.toString(16), true]);
}
async function fetchReceipt(hash) {
  return rpc('eth_getTransactionReceipt', [hash]);
}

function splitFee(gasFeeStr, bps) {
  // gasFeeStr is a base-10 string (wei). Compute node / contract / token / admin shares.
  const gasFee = BigInt(gasFeeStr);
  const node = (gasFee * BigInt(bps.node)) / 10000n;
  const contract = (gasFee * BigInt(bps.contract)) / 10000n;
  const token = (gasFee * BigInt(bps.token)) / 10000n;
  const admin = gasFee - node - contract - token;
  return { node: node.toString(), contract: contract.toString(), token: token.toString(), admin: admin.toString() };
}

async function isRegisteredContract(addr) {
  if (!addr) return false;
  const r = await q1('SELECT is_registered_contract FROM accounts WHERE addr = $1', [addr]);
  return !!r?.is_registered_contract;
}
async function isRegisteredToken(addr) {
  if (!addr) return false;
  const r = await q1('SELECT is_registered_token FROM accounts WHERE addr = $1', [addr]);
  return !!r?.is_registered_token;
}

async function ensureAccount(client, addr, blockNum, { isContract = false } = {}) {
  if (!addr) return;
  await client.query(`
    INSERT INTO accounts (addr, is_contract, first_seen_block, last_seen_block)
    VALUES ($1, $2, $3, $3)
    ON CONFLICT (addr) DO UPDATE
      SET last_seen_block = GREATEST(accounts.last_seen_block, EXCLUDED.last_seen_block),
          is_contract = accounts.is_contract OR EXCLUDED.is_contract
  `, [addr, isContract, blockNum]);
}

// Fetch ERC-20 metadata for a token address. Returns null if any of the
// view functions revert — we keep that address out of the tokens table.
async function fetchTokenMeta(addr) {
  const callOne = async (sig) => {
    try {
      const data = ERC20_IFACE.encodeFunctionData(sig);
      const raw = await provider.call({ to: '0x' + addr, data });
      return ERC20_IFACE.decodeFunctionResult(sig, raw)[0];
    } catch { return null; }
  };
  const [name, symbol, dec, supply] = await Promise.all([
    callOne('name'), callOne('symbol'), callOne('decimals'), callOne('totalSupply'),
  ]);
  // Symbol+decimals are the minimum we consider "real" ERC-20.
  if (symbol == null) return null;
  return {
    name:   name ? String(name).slice(0, 96) : null,
    symbol: String(symbol).slice(0, 32),
    decimals: Number(dec ?? 18),
    totalSupply: supply != null ? supply.toString() : null,
  };
}

async function enrichToken(addr) {
  if (enrichedTokens.has(addr) || enrichmentFailed.has(addr)) return;
  const existing = await q1('SELECT addr FROM tokens WHERE addr = $1', [addr]);
  if (existing) { enrichedTokens.add(addr); return; }
  const meta = await fetchTokenMeta(addr);
  if (!meta) { enrichmentFailed.add(addr); return; }
  await q(`
    INSERT INTO tokens (addr, name, symbol, decimals, total_supply, type)
    VALUES ($1, $2, $3, $4, $5, 'ERC-20')
    ON CONFLICT (addr) DO UPDATE
      SET name = EXCLUDED.name, symbol = EXCLUDED.symbol,
          decimals = EXCLUDED.decimals, total_supply = EXCLUDED.total_supply
  `, [addr, meta.name, meta.symbol, meta.decimals, meta.totalSupply]);
  enrichedTokens.add(addr);
}

async function indexBlock(num) {
  const blk = await fetchBlock(num);
  if (!blk) throw new Error('block ' + num + ' returned null');

  // Parse URELAY1 attestations from extraData.
  const attestations = parseUrelay(blk.extraData);
  const relayerByTx = new Map(attestations.map(a => [a.txHash.toLowerCase(), a.relayer]));

  // Fetch receipts in parallel (capped at 8).
  const receipts = [];
  const txs = blk.transactions || [];
  const concurrency = 8;
  for (let i = 0; i < txs.length; i += concurrency) {
    const slice = txs.slice(i, i + concurrency);
    const fetched = await Promise.all(slice.map(t => fetchReceipt(t.hash)));
    receipts.push(...fetched);
  }

  const newTokensThisBlock = new Set();
  let insertedTxs = 0;

  await tx(async client => {
    // Block row
    await client.query(`
      INSERT INTO blocks (number, hash, parent_hash, timestamp, miner, gas_used, gas_limit, base_fee_per_gas, tx_count, size, extra_data, urelay_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (number) DO NOTHING
    `, [
      num,
      blk.hash.slice(2).toLowerCase(),
      blk.parentHash.slice(2).toLowerCase(),
      parseInt(blk.timestamp, 16),
      norm(blk.miner) || '0'.repeat(40),
      bn(blk.gasUsed), bn(blk.gasLimit),
      blk.baseFeePerGas ? bn(blk.baseFeePerGas) : null,
      txs.length,
      parseInt(blk.size || '0x0', 16),
      blk.extraData || null,
      attestations.length,
    ]);

    // URELAY1 attestation rows
    for (const a of attestations) {
      await client.query(`
        INSERT INTO urelay_attestations (block_number, tx_hash, relayer, signature)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT DO NOTHING
      `, [num, a.txHash.toLowerCase(), a.relayer.toLowerCase(), a.signature.toLowerCase()]);
    }

    // Per-tx processing
    for (let i = 0; i < txs.length; i++) {
      const t = txs[i];
      const r = receipts[i];
      const from = norm(t.from);
      const to = norm(t.to);
      const txHash = t.hash.slice(2).toLowerCase();
      const ts = parseInt(blk.timestamp, 16);
      const gasUsed = BigInt(r?.gasUsed || '0x0');
      const gasPrice = BigInt(r?.effectiveGasPrice || t.gasPrice || '0x0');
      const gasFee = (gasUsed * gasPrice).toString();
      const status = parseInt(r?.status || '0x0', 16);
      const isCreation = !to && !!r?.contractAddress;
      const created = r?.contractAddress ? norm(r.contractAddress) : null;
      const input = t.input || '0x';
      const methodId = input.length >= 10 ? input.slice(2, 10).toLowerCase() : null;

      const relayer = relayerByTx.get(txHash) || null;
      const split = splitFee(gasFee, config.feeBps);
      // Apply registry-gated rules: contract-share only if `to` is a
      // registered contract; token-share only if `to` is a registered token.
      // Anything that doesn't apply rolls into admin residual.
      const toContract = await isRegisteredContract(to);
      const toToken = await isRegisteredToken(to);
      let nodeShare = relayer ? split.node : '0';
      let contractShare = toContract ? split.contract : '0';
      let tokenShare = toToken ? split.token : '0';
      const totalPaid = BigInt(nodeShare) + BigInt(contractShare) + BigInt(tokenShare);
      const adminResidual = (BigInt(gasFee) - totalPaid).toString();

      await ensureAccount(client, from, num);
      if (to) await ensureAccount(client, to, num);
      if (created) await ensureAccount(client, created, num, { isContract: true });

      const insertedTx = await client.query(`
        INSERT INTO txs (
          hash, block_number, tx_index, timestamp, from_addr, to_addr,
          value, gas_used, gas_price, effective_gas_price, gas_fee,
          status, nonce, input_size, method_id, is_contract_creation, contract_created,
          fee_node_share, fee_contract_share, fee_token_share, fee_admin_residual, relayer
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,$17,
          $18,$19,$20,$21,$22
        )
        ON CONFLICT (hash) DO NOTHING
      `, [
        txHash, num, i, ts, from, to,
        bn(t.value), gasUsed.toString(), gasPrice.toString(), gasPrice.toString(), gasFee,
        status, parseInt(t.nonce, 16), Math.max(0, (input.length - 2) / 2), methodId, isCreation, created,
        nodeShare, contractShare, tokenShare, adminResidual, relayer,
      ]);
      insertedTxs += insertedTx.rowCount;

      // ERC-20 Transfer logs from this tx.
      const logs = r?.logs || [];
      for (const log of logs) {
        if (!log.topics || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
        if (log.topics.length < 3) continue;
        const tokenAddr = norm(log.address);
        const fromTok = norm('0x' + log.topics[1].slice(26));
        const toTok = norm('0x' + log.topics[2].slice(26));
        let amount = '0';
        try { amount = BigInt(log.data || '0x0').toString(); } catch {}
        await ensureAccount(client, tokenAddr, num, { isContract: true });
        const ins = await client.query(`
          INSERT INTO token_transfers (tx_hash, block_number, log_index, timestamp, token_addr, from_addr, to_addr, amount)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (tx_hash, log_index) DO NOTHING
          RETURNING id
        `, [
          txHash, num, parseInt(log.logIndex || '0x0', 16), ts,
          tokenAddr, fromTok || '0'.repeat(40), toTok || '0'.repeat(40), amount,
        ]);
        if (ins.rowCount > 0) {
          // Bump the transfers counter for the token (creates a placeholder
          // row that the enrich step below will fill with metadata).
          await client.query(`
            INSERT INTO tokens (addr, transfers) VALUES ($1, 1)
            ON CONFLICT (addr) DO UPDATE SET transfers = tokens.transfers + 1
          `, [tokenAddr]);
          newTokensThisBlock.add(tokenAddr);
        }
      }
    }

    await setSyncedBlock(client, num);
  });

  // After the DB tx commits, enrich any tokens we just saw with their
  // name/symbol/decimals via RPC. Failures are cached so we don't retry
  // non-ERC20 contracts on every block.
  for (const tokenAddr of newTokensThisBlock) {
    try { await enrichToken(tokenAddr); }
    catch (e) { /* swallow — indexer keeps moving */ }
  }
  return insertedTxs;
}

// COUNT(*) over a month of transactions re-reads ~10 GB, which is far too
// expensive after every batch. Between periodic full recounts the total grows
// by the rows each committed batch actually inserted.
const STATS_RECOUNT_MS = parseInt(process.env.INDEXER_STATS_RECOUNT_MS || String(60 * 60_000), 10);
let statsRecountedAt = 0;

async function refreshStats(insertedTxs) {
  const recount = Date.now() - statsRecountedAt >= STATS_RECOUNT_MS;
  await q(`
    UPDATE chain_stats SET
      latest_block     = COALESCE((SELECT MAX(number) FROM blocks), 0),
      total_txs        = ${recount ? '(SELECT COUNT(*) FROM txs)' : 'total_txs + $1::bigint'},
      total_addresses  = (SELECT COUNT(*) FROM accounts),
      total_contracts  = (SELECT COUNT(*) FROM accounts WHERE is_contract),
      total_tokens     = (SELECT COUNT(*) FROM tokens),
      median_gas_price = COALESCE(
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY gas_price)
           FROM (SELECT gas_price FROM txs ORDER BY block_number DESC LIMIT 1000) s)::numeric(78,0),
        0),
      updated_at = NOW()
    WHERE id = 1
  `, recount ? [] : [insertedTxs]);
  if (recount) statsRecountedAt = Date.now();
}

export async function runOnce() {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const target = head - config.indexer.headLag;
  let cur = await getSyncedBlock();
  let processed = 0;
  let insertedTxs = 0;
  try {
    while (cur < target && processed < config.indexer.batchSize) {
      insertedTxs += await indexBlock(cur + 1);
      cur += 1;
      processed += 1;
    }
  } finally {
    // Committed blocks are counted even when a later block in the batch fails.
    if (processed > 0) {
      console.log(`[indexer] indexed ${processed} block(s) up to ${cur} (head ${head})`);
      await refreshStats(insertedTxs);
    }
  }
  return { processed, head, synced: cur };
}

// Run once at startup: walk distinct token_transfers.token_addr that are
// either missing from `tokens` or missing a symbol, and try to enrich them.
// Cheap, idempotent, fine to call every boot.
export async function backfillTokenMetadata() {
  try {
    const rows = await q(`
      SELECT DISTINCT tt.token_addr
        FROM token_transfers tt
        LEFT JOIN tokens t ON t.addr = tt.token_addr
       WHERE t.addr IS NULL OR t.symbol IS NULL OR t.symbol = ''
       LIMIT 500
    `);
    if (!rows.length) return;
    console.log('[indexer] backfilling metadata for', rows.length, 'token(s)');
    let ok = 0;
    for (const r of rows) {
      const a = r.token_addr;
      // Make sure the counter row exists before we try to enrich.
      const cnt = await q1('SELECT COUNT(*)::bigint AS c FROM token_transfers WHERE token_addr = $1', [a]);
      await q(`
        INSERT INTO tokens (addr, transfers) VALUES ($1, $2)
        ON CONFLICT (addr) DO UPDATE SET transfers = EXCLUDED.transfers
      `, [a, Number(cnt?.c ?? 0)]);
      const meta = await fetchTokenMeta(a);
      if (meta) {
        await q(`
          UPDATE tokens SET name = $2, symbol = $3, decimals = $4, total_supply = $5
           WHERE addr = $1
        `, [a, meta.name, meta.symbol, meta.decimals, meta.totalSupply]);
        enrichedTokens.add(a);
        ok += 1;
      } else {
        enrichmentFailed.add(a);
      }
    }
    console.log('[indexer] backfill done — enriched', ok, 'of', rows.length);
  } catch (e) {
    console.warn('[indexer] backfill failed:', e?.message || e);
  }
}

// Recompute the `holders` column on every token using actual net balances
// from token_transfers. Run periodically — it's a scan, not cheap per-tx.
export async function refreshTokenHolders() {
  // The aggregation spans every transfer; with the default 4MB work_mem its
  // hash table spills to disk and a pass runs for many minutes.
  const client = await pool.connect();
  let broken;
  try {
    await client.query("SET work_mem = '1GB'");
    await q(`
      WITH positions AS (
        SELECT token_addr, to_addr   AS holder,  amount AS delta FROM token_transfers
        UNION ALL
        SELECT token_addr, from_addr AS holder, -amount AS delta FROM token_transfers
      ),
      balances AS (
        SELECT token_addr, holder, SUM(delta) AS balance
          FROM positions
         WHERE holder <> repeat('0', 40)
         GROUP BY token_addr, holder
      ),
      holder_counts AS (
        SELECT token_addr, COUNT(*) FILTER (WHERE balance > 0) AS holders
          FROM balances
         GROUP BY token_addr
      )
      UPDATE tokens t SET holders = COALESCE(h.holders, 0)::int
        FROM holder_counts h
       WHERE t.addr = h.token_addr
         AND t.holders IS DISTINCT FROM COALESCE(h.holders, 0)::int
    `, [], client);
  } catch (e) {
    console.warn('[indexer] holders refresh failed:', e?.message || e);
  } finally {
    // Pooled clients must not keep the large work_mem.
    await client.query('RESET work_mem').catch(e => { broken = e; });
    client.release(broken);
  }
}

// Holder counts and the metadata backfill scan every transfer (tens of
// millions of rows) and take minutes. They run on a timer beside the block
// loop, so a slow pass never holds back new blocks.
const HOLDERS_REFRESH_MS = parseInt(process.env.INDEXER_HOLDERS_MS || String(60 * 60_000), 10);
let holdersRefreshing = false;
let holdersRefreshedAt = Date.now();

function scheduleHolderRefresh() {
  if (holdersRefreshing || Date.now() - holdersRefreshedAt < HOLDERS_REFRESH_MS) return;
  holdersRefreshing = true;
  holdersRefreshedAt = Date.now();
  (async () => {
    await refreshTokenHolders();
    await backfillTokenMetadata();
  })()
    .catch(e => console.warn('[indexer] holders refresh failed:', e?.message || e))
    .finally(() => { holdersRefreshing = false; });
}

export async function startIndexer() {
  if (!config.indexer.enabled) {
    console.log('[indexer] disabled by env');
    return;
  }
  console.log('[indexer] starting against', config.rpcUrl);
  // One-off backfill before the main loop.
  await backfillTokenMetadata();
  for (;;) {
    try { await runOnce(); }
    catch (e) { console.warn('[indexer] tick failed:', e?.message || e); }
    scheduleHolderRefresh();
    await new Promise(r => setTimeout(r, config.indexer.pollMs));
  }
}

// Allow `node src/indexer.js` to run the loop standalone too.
const isMain = process.argv[1]?.endsWith('indexer.js');
if (isMain) {
  startIndexer().catch(e => { console.error('[indexer] fatal', e); process.exit(1); });
}
