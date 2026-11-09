import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

import { config } from './config.js';
import { pool, q, q1, norm } from './db.js';
import { provider, rpc, ERC20_IFACE, checksum, getRevertReason, parseUrelay } from './rpc.js';
import { startIndexer } from './indexer.js';
import { txLookup } from './tx-lookup.js';
import * as caddy from './caddy.js';

const lookup = txLookup({ pool, q, rpc });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const app = express();

// Express 4 does not forward rejected async route promises automatically.
// An unavailable history object must be an explicit retryable error, not a
// missing transaction response or an unhandled rejection that stops the app.
const registerGet = app.get.bind(app);
app.get = (route, ...handlers) => {
  if (handlers.length === 0) return registerGet(route);
  return registerGet(route, ...handlers.map(handler => (req, res, next) => {
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  }));
};

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,           // explorer needs inline JSON-injects in HTML
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const apiLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

// ─── Helpers ─────────────────────────────────────────────────────────
function withHex(addr) { return addr ? '0x' + addr : null; }
function txRow(r) {
  if (!r) return null;
  return {
    hash:         '0x' + r.hash,
    blockNumber:  Number(r.block_number),
    txIndex:      r.tx_index,
    timestamp:    Number(r.timestamp),
    from:         withHex(r.from_addr),
    to:           withHex(r.to_addr),
    value:        r.value,
    gasUsed:      r.gas_used,
    gasPrice:     r.gas_price,
    gasFee:       r.gas_fee,
    status:       r.status,
    methodId:     r.method_id ? '0x' + r.method_id : null,
    isContractCreation: r.is_contract_creation,
    contractCreated: withHex(r.contract_created),
    feeNodeShare:     r.fee_node_share,
    feeContractShare: r.fee_contract_share,
    feeTokenShare:    r.fee_token_share,
    feeAdminResidual: r.fee_admin_residual,
    relayer:      withHex(r.relayer),
  };
}
function blockRow(r) {
  if (!r) return null;
  return {
    number:        Number(r.number),
    hash:          '0x' + r.hash,
    parentHash:    '0x' + r.parent_hash,
    timestamp:     Number(r.timestamp),
    miner:         withHex(r.miner),
    gasUsed:       r.gas_used,
    gasLimit:      r.gas_limit,
    baseFeePerGas: r.base_fee_per_gas,
    txCount:       r.tx_count,
    size:          r.size,
    urelayCount:   r.urelay_count,
  };
}

function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return res.status(401).json({ error: 'missing bearer token' });
  try {
    const payload = jwt.verify(m[1], config.jwtSecret);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    req.admin = payload;
    next();
  } catch { return res.status(401).json({ error: 'invalid token' }); }
}

// ─── Chain config + handshake ────────────────────────────────────────
app.get('/api/chain', async (_req, res) => {
  let cid = config.chainId;
  if (!cid) {
    try { cid = parseInt(await rpc('eth_chainId', []), 16); }
    catch { cid = 0; }
  }
  let clientVersion = null;
  try { clientVersion = await rpc('web3_clientVersion', []); } catch {}
  res.json({
    chainId: cid,
    chainIdHex: '0x' + (cid >>> 0).toString(16),
    chainName: config.chainName,
    nativeToken: config.nativeToken,
    rpcUrl: config.publicRpcUrl,
    feeBps: config.feeBps,
    clientVersion,
    explorerName: 'Elyon Explorer',
  });
});

// ─── Stats / dashboard ───────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  const s = await q1('SELECT * FROM chain_stats WHERE id = 1');
  const head = s?.latest_block ?? '0';
  // 24h rolling tx count for a tps indicator.
  const since = Math.floor(Date.now() / 1000) - 86400;
  const r = await q1('SELECT COUNT(*)::bigint AS c FROM txs WHERE timestamp > $1', [since]);
  res.json({
    latestBlock: Number(head),
    totalTxs:    Number(s?.total_txs ?? 0),
    totalAddresses: Number(s?.total_addresses ?? 0),
    totalContracts: Number(s?.total_contracts ?? 0),
    totalTokens: Number(s?.total_tokens ?? 0),
    medianGasPrice: s?.median_gas_price ?? '0',
    tx24h: Number(r?.c ?? 0),
    tps24h: Number(r?.c ?? 0) / 86400,
    updatedAt: s?.updated_at ?? null,
  });
});

// Daily tx volume for the home-page sparkline.
app.get('/api/stats/daily', async (req, res) => {
  const days = Math.min(60, Math.max(1, parseInt(req.query.days || '14', 10)));
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = await q(`
    SELECT (timestamp / 86400)::bigint * 86400 AS day, COUNT(*)::bigint AS c
      FROM txs
     WHERE timestamp >= $1
     GROUP BY 1
     ORDER BY 1 ASC
  `, [sinceTs]);
  // Fill in zero days so the chart is uniform.
  const today = Math.floor(Date.now() / 86400000) * 86400;
  const map = new Map(rows.map(r => [Number(r.day), Number(r.c)]));
  const series = [];
  for (let d = today - (days - 1) * 86400; d <= today; d += 86400) {
    series.push({ day: d, count: map.get(d) || 0 });
  }
  res.json({ series });
});

// ─── Latest blocks / txs (home page feed — limit only, no paging) ────
app.get('/api/blocks/latest', async (req, res) => {
  const lim = Math.min(50, parseInt(req.query.limit || '10', 10));
  const rows = await q('SELECT * FROM blocks ORDER BY number DESC LIMIT $1', [lim]);
  res.json(rows.map(blockRow));
});

app.get('/api/txs/latest', async (req, res) => {
  const lim = Math.min(50, parseInt(req.query.limit || '10', 10));
  const rows = await q('SELECT * FROM txs ORDER BY block_number DESC, tx_index DESC LIMIT $1', [lim]);
  res.json(rows.map(txRow));
});

// ─── Paginated lists (full list pages) ───────────────────────────────
app.get('/api/blocks', async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page || '0', 10));
  const lim  = Math.min(100, parseInt(req.query.limit || '25', 10));
  const rows = await q('SELECT * FROM blocks ORDER BY number DESC LIMIT $1 OFFSET $2', [lim, page * lim]);
  const tot  = await q1('SELECT COUNT(*)::bigint AS c FROM blocks');
  res.json({ items: rows.map(blockRow), page, limit: lim, total: Number(tot?.c ?? 0) });
});

app.get('/api/txs', async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page || '0', 10));
  const lim  = Math.min(100, parseInt(req.query.limit || '25', 10));
  const rows = await q('SELECT * FROM txs ORDER BY block_number DESC, tx_index DESC LIMIT $1 OFFSET $2', [lim, page * lim]);
  const tot  = await q1('SELECT COUNT(*)::bigint AS c FROM txs');
  res.json({ items: rows.map(txRow), page, limit: lim, total: Number(tot?.c ?? 0) });
});

app.get('/api/token-transfers', async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page || '0', 10));
  const lim  = Math.min(100, parseInt(req.query.limit || '25', 10));
  const rows = await q(`
    SELECT tt.*, t.name AS token_name, t.symbol, t.decimals
      FROM token_transfers tt
      LEFT JOIN tokens t ON t.addr = tt.token_addr
     ORDER BY tt.block_number DESC, tt.log_index DESC
     LIMIT $1 OFFSET $2
  `, [lim, page * lim]);
  const tot = await q1('SELECT COUNT(*)::bigint AS c FROM token_transfers');
  res.json({
    items: rows.map(r => ({
      txHash: '0x' + r.tx_hash,
      blockNumber: Number(r.block_number),
      timestamp: Number(r.timestamp),
      token: { addr: withHex(r.token_addr), name: r.token_name, symbol: r.symbol, decimals: r.decimals },
      from: withHex(r.from_addr), to: withHex(r.to_addr), amount: r.amount,
    })),
    page, limit: lim, total: Number(tot?.c ?? 0),
  });
});

// Rows indexed before the parser fix start 2 bytes early, so the true entry is
// found again in the block's own extraData.
function attestationReader() {
  const blocks = new Map();
  return r => {
    if (!blocks.has(r.block_number)) {
      const hex = (r.extra_data || '').startsWith('0x') ? r.extra_data : '0x' + (r.extra_data || '');
      blocks.set(r.block_number, new Map(parseUrelay(hex).map(a => [a.txHash.slice(0, 60), a])));
    }
    const a = blocks.get(r.block_number).get(r.tx_hash.trim().slice(4));
    return a ? { txHash: a.txHash, relayer: a.relayer } : { txHash: r.tx_hash.trim(), relayer: r.relayer.trim() };
  };
}

app.get('/api/attestations', async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page || '0', 10));
  const lim  = Math.min(100, parseInt(req.query.limit || '25', 10));
  const rows = await q(`
    SELECT a.*, b.timestamp, b.extra_data
      FROM urelay_attestations a
      JOIN blocks b ON b.number = a.block_number
     ORDER BY a.block_number DESC, a.id DESC
     LIMIT $1 OFFSET $2
  `, [lim, page * lim]);
  const tot = await q1('SELECT COUNT(*)::bigint AS c FROM urelay_attestations');
  const read = attestationReader();
  res.json({
    items: rows.map(r => {
      const a = read(r);
      return {
        blockNumber: Number(r.block_number),
        txHash: '0x' + a.txHash,
        relayer: '0x' + a.relayer,
        timestamp: Number(r.timestamp),
      };
    }),
    page, limit: lim, total: Number(tot?.c ?? 0),
  });
});

app.get('/api/top-accounts', async (req, res) => {
  const lim = Math.min(200, parseInt(req.query.limit || '100', 10));
  // Approximate "top accounts" by total tx involvement + last seen.
  // Native ELN balance would need an RPC call per address; too costly here.
  const rows = await q(`
    SELECT a.addr,
           (SELECT COUNT(*) FROM txs WHERE from_addr = a.addr OR to_addr = a.addr)::bigint AS txs,
           a.is_contract, a.is_operator, a.is_registered_contract, a.is_registered_token,
           a.last_seen_block, a.first_seen_block
      FROM accounts a
     ORDER BY txs DESC
     LIMIT $1
  `, [lim]);
  res.json({ items: rows.map(r => ({
    addr: '0x' + r.addr,
    txs: Number(r.txs),
    isContract: r.is_contract,
    isOperator: r.is_operator,
    isRegisteredContract: r.is_registered_contract,
    isRegisteredToken: r.is_registered_token,
    lastSeenBlock: r.last_seen_block ? Number(r.last_seen_block) : null,
    firstSeenBlock: r.first_seen_block ? Number(r.first_seen_block) : null,
  })) });
});

app.get('/api/verified-contracts', async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page || '0', 10));
  const lim  = Math.min(100, parseInt(req.query.limit || '50', 10));
  const rows = await q(`
    SELECT addr, name, compiler_version, optimization, optimization_runs, license, verified_at
      FROM contract_sources
     ORDER BY verified_at DESC
     LIMIT $1 OFFSET $2
  `, [lim, page * lim]);
  const tot = await q1('SELECT COUNT(*)::bigint AS c FROM contract_sources');
  res.json({
    items: rows.map(r => ({
      addr: '0x' + r.addr,
      name: r.name,
      compilerVersion: r.compiler_version,
      optimization: r.optimization,
      optimizationRuns: r.optimization_runs,
      license: r.license,
      verifiedAt: r.verified_at,
    })),
    page, limit: lim, total: Number(tot?.c ?? 0),
  });
});

// Broadcast a raw signed transaction via the chain RPC.
app.post('/api/broadcast', async (req, res) => {
  const { rawTx } = req.body || {};
  if (typeof rawTx !== 'string' || !rawTx.startsWith('0x'))
    return res.status(400).json({ error: 'rawTx (0x-prefixed hex) required' });
  try {
    const hash = await rpc('eth_sendRawTransaction', [rawTx]);
    res.json({ ok: true, hash });
  } catch (e) {
    res.status(400).json({ error: e?.shortMessage || e?.message || String(e) });
  }
});

// ─── Block detail ───────────────────────────────────────────────────
app.get('/api/blocks/:num', async (req, res) => {
  let num = req.params.num;
  let r;
  if (/^\d+$/.test(num)) {
    r = await q1('SELECT * FROM blocks WHERE number = $1', [parseInt(num, 10)]);
  } else {
    r = await q1('SELECT * FROM blocks WHERE hash = $1', [norm(num)]);
  }
  if (!r) return res.status(404).json({ error: 'block not found' });
  const txs = await q('SELECT * FROM txs WHERE block_number = $1 ORDER BY tx_index ASC', [r.number]);
  res.json({ block: blockRow(r), txs: txs.map(txRow) });
});

// Pagination of txs inside a block.
app.get('/api/blocks/:num/txs', async (req, res) => {
  const num = parseInt(req.params.num, 10);
  if (!Number.isFinite(num)) return res.status(400).json({ error: 'bad block number' });
  const page = Math.max(0, parseInt(req.query.page || '0', 10));
  const lim = Math.min(100, parseInt(req.query.limit || '25', 10));
  const txs = await q(
    'SELECT * FROM txs WHERE block_number = $1 ORDER BY tx_index ASC LIMIT $2 OFFSET $3',
    [num, lim, page * lim]);
  res.json({ items: txs.map(txRow), page, limit: lim });
});

// ─── Transaction detail (incl. logs + fee breakdown) ────────────────
app.get('/api/tx/:hash', async (req, res) => {
  const h = norm(req.params.hash);
  if (!h) return res.status(400).json({ error: 'bad hash' });
  const found = await lookup.findTx(h);
  const built = found?.where === 'chain' ? await lookup.fromChain(found.chainTx) : null;
  const t = built ? built.row : found?.row;
  if (!t) return res.status(404).json({ error: 'tx not found' });
  // Archived rows carry their block number, which limits the archive read to one chunk.
  const transfers = built ? built.transfers : found.where === 'archive'
    ? await q('SELECT * FROM token_transfers WHERE tx_hash = $1 AND block_number = $2 ORDER BY log_index ASC',
        [h, t.block_number])
    : await q('SELECT * FROM token_transfers WHERE tx_hash = $1 ORDER BY log_index ASC', [h]);
  // Fetch ERC-20 metadata once per token to render symbols.
  const tokenAddrs = [...new Set(transfers.map(x => x.token_addr))];
  let tokenMeta = {};
  if (tokenAddrs.length) {
    const rs = await q(
      'SELECT t.addr, t.name, t.symbol, t.decimals FROM tokens t WHERE t.addr = ANY($1)',
      [tokenAddrs]);
    tokenMeta = Object.fromEntries(rs.map(r => [r.addr, r]));
  }
  // Optional: raw receipt logs from the chain for log display.
  let logs = built?.receipt.logs || [];
  if (!built) {
    try {
      const r = await rpc('eth_getTransactionReceipt', ['0x' + h]);
      logs = r?.logs || [];
    } catch {}
  }
  res.json({
    tx: txRow(t),
    transfers: transfers.map(x => ({
      tokenAddr: withHex(x.token_addr),
      from: withHex(x.from_addr),
      to: withHex(x.to_addr),
      amount: x.amount,
      logIndex: x.log_index,
      meta: tokenMeta[x.token_addr] || null,
    })),
    logs,
    // false: confirmed on chain, but the indexer has not reached its block yet.
    indexed: !built || found.retained === false,
  });
});

// Lazy revert-reason lookup for failed txs. Cached after the first call so
// the chain RPC isn't re-queried on every page load.
app.get('/api/tx/:hash/revert', async (req, res) => {
  const h = norm(req.params.hash);
  if (!h) return res.status(400).json({ error: 'bad hash' });
  const found = await lookup.findTx(h);
  const t = found?.where === 'chain' ? (await lookup.fromChain(found.chainTx))?.row : found?.row;
  if (!t) return res.status(404).json({ error: 'tx not found' });
  if (t.status !== 0) return res.json({ kind: 'ok', message: 'transaction succeeded' });

  if (t.revert_kind) {
    return res.json({
      kind: t.revert_kind,
      message: t.revert_message,
      selector: t.revert_selector,
      data: t.revert_data,
      cached: true,
    });
  }
  try {
    const r = await getRevertReason('0x' + h, Number(t.block_number));
    await q(`
      UPDATE txs SET
        revert_kind     = $2,
        revert_message  = $3,
        revert_selector = $4,
        revert_data     = $5,
        revert_checked_at = NOW()
       WHERE hash = $1
    `, [h, r.kind, r.message, r.selector || null, r.data || null]);
    res.json(r);
  } catch (e) {
    res.status(502).json({ kind: 'unknown', message: 'replay failed: ' + (e?.message || String(e)) });
  }
});

// ─── Address page (overview + tabbed feeds) ─────────────────────────
// Archived history is totalled per address when it is archived
// (archive_meta.address_stats), so the overview adds one summary row to the
// indexed hot-table counts instead of scanning every archived chunk, which
// took minutes and timed out at the proxy. One statement, one snapshot: a
// concurrent cutover moves rows and their totals atomically.
const ADDRESS_COUNTS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM txs WHERE from_addr = $1 OR to_addr = $1)::bigint AS txs,
    (SELECT COUNT(*) FROM token_transfers WHERE from_addr = $1 OR to_addr = $1)::bigint AS transfers,
    (SELECT COUNT(*) FROM txs WHERE relayer = $1)::bigint AS relayed,
    (SELECT COALESCE(SUM(fee_node_share),0) FROM txs WHERE relayer = $1)::numeric AS earned_node,
    (SELECT COALESCE(SUM(fee_contract_share),0) FROM txs WHERE to_addr = $1)::numeric AS earned_contract,
    (SELECT COALESCE(SUM(fee_token_share),0) FROM txs WHERE to_addr = $1)::numeric AS earned_token
`;
async function addressCounts(a) {
  try {
    const r = await pool.query(`
      SELECT
        ((SELECT COUNT(*) FROM (SELECT 1 FROM public.txs WHERE from_addr = $1
            UNION ALL SELECT 1 FROM public.txs WHERE to_addr = $1 AND from_addr IS DISTINCT FROM $1) hot)
          + COALESCE(s.txs, 0))::bigint AS txs,
        ((SELECT COUNT(*) FROM (SELECT 1 FROM public.token_transfers WHERE from_addr = $1
            UNION ALL SELECT 1 FROM public.token_transfers WHERE to_addr = $1 AND from_addr IS DISTINCT FROM $1) hot)
          + COALESCE(s.transfers, 0))::bigint AS transfers,
        ((SELECT COUNT(*) FROM public.txs WHERE relayer = $1) + COALESCE(s.relayed, 0))::bigint AS relayed,
        ((SELECT COALESCE(SUM(fee_node_share),0) FROM public.txs WHERE relayer = $1)
          + COALESCE(s.earned_node, 0))::numeric AS earned_node,
        -- Zero shares do not change the sums; the partial index txs_to_fee_share_idx
        -- keeps busy contracts from summing millions of zero rows.
        ((SELECT COALESCE(SUM(fee_contract_share),0) FROM public.txs
            WHERE to_addr = $1 AND (fee_contract_share <> 0 OR fee_token_share <> 0))
          + COALESCE(s.earned_contract, 0))::numeric AS earned_contract,
        ((SELECT COALESCE(SUM(fee_token_share),0) FROM public.txs
            WHERE to_addr = $1 AND (fee_contract_share <> 0 OR fee_token_share <> 0))
          + COALESCE(s.earned_token, 0))::numeric AS earned_token
      FROM (SELECT 1) one
      LEFT JOIN archive_meta.address_stats s ON s.addr = $1
    `, [a]);
    return r.rows[0];
  } catch (e) {
    if (e.code !== '42P01') throw e; // no archive totals: count through history.* instead
    return q1(ADDRESS_COUNTS_SQL, [a]);
  }
}
app.get('/api/address/:addr', async (req, res) => {
  const a = norm(req.params.addr);
  if (!a) return res.status(400).json({ error: 'bad address' });
  const acct = await q1('SELECT * FROM accounts WHERE addr = $1', [a]);
  // Live balance + code
  let balance = '0', code = '0x';
  try {
    balance = BigInt(await rpc('eth_getBalance', ['0x' + a, 'latest'])).toString();
    code = await rpc('eth_getCode', ['0x' + a, 'latest']);
  } catch {}
  const isContract = code && code !== '0x';
  const token = isContract ? await q1('SELECT * FROM tokens WHERE addr = $1', [a]) : null;
  const source = isContract ? await q1('SELECT addr, name, compiler_version, optimization, optimization_runs, license, verified_at FROM contract_sources WHERE addr = $1', [a]) : null;
  // Tx counters
  const counts = await addressCounts(a);
  res.json({
    address:    '0x' + a,
    isContract,
    code: isContract ? code : null,
    balance,
    account: acct ? {
      txCount: acct.tx_count,
      isOperator: acct.is_operator,
      isRegisteredToken: acct.is_registered_token,
      isRegisteredContract: acct.is_registered_contract,
      displayName: acct.display_name,
    } : null,
    token,
    contractSource: source,
    counts: counts ? {
      txs: Number(counts.txs),
      transfers: Number(counts.transfers),
      relayed: Number(counts.relayed),
      earnedNode: counts.earned_node,
      earnedContract: counts.earned_contract,
      earnedToken: counts.earned_token,
    } : null,
  });
});

app.get('/api/address/:addr/txs', async (req, res) => {
  const a = norm(req.params.addr);
  if (!a) return res.status(400).json({ error: 'bad address' });
  const page = Math.max(0, parseInt(req.query.page || '0', 10));
  const lim = Math.min(100, parseInt(req.query.limit || '25', 10));
  const rows = await q(
    `SELECT * FROM txs WHERE from_addr = $1 OR to_addr = $1
     ORDER BY block_number DESC, tx_index DESC LIMIT $2 OFFSET $3`,
    [a, lim, page * lim]);
  res.json({ items: rows.map(txRow), page, limit: lim });
});

app.get('/api/address/:addr/transfers', async (req, res) => {
  const a = norm(req.params.addr);
  if (!a) return res.status(400).json({ error: 'bad address' });
  const page = Math.max(0, parseInt(req.query.page || '0', 10));
  const lim = Math.min(100, parseInt(req.query.limit || '25', 10));
  const rows = await q(
    `SELECT tt.*, t.symbol, t.decimals, t.name AS token_name
       FROM token_transfers tt
       LEFT JOIN tokens t ON t.addr = tt.token_addr
      WHERE tt.from_addr = $1 OR tt.to_addr = $1
      ORDER BY tt.block_number DESC, tt.log_index DESC
      LIMIT $2 OFFSET $3`,
    [a, lim, page * lim]);
  res.json({
    items: rows.map(r => ({
      txHash: '0x' + r.tx_hash,
      blockNumber: Number(r.block_number),
      timestamp: Number(r.timestamp),
      token: { addr: withHex(r.token_addr), name: r.token_name, symbol: r.symbol, decimals: r.decimals },
      from: withHex(r.from_addr),
      to: withHex(r.to_addr),
      amount: r.amount,
    })),
    page, limit: lim,
  });
});

app.get('/api/address/:addr/relayed', async (req, res) => {
  const a = norm(req.params.addr);
  if (!a) return res.status(400).json({ error: 'bad address' });
  const page = Math.max(0, parseInt(req.query.page || '0', 10));
  const lim = Math.min(100, parseInt(req.query.limit || '25', 10));
  const rows = await q(
    `SELECT * FROM txs WHERE relayer = $1
      ORDER BY block_number DESC, tx_index DESC LIMIT $2 OFFSET $3`,
    [a, lim, page * lim]);
  res.json({ items: rows.map(txRow), page, limit: lim });
});

app.get('/api/address/:addr/holdings', async (req, res) => {
  const a = norm(req.params.addr);
  if (!a) return res.status(400).json({ error: 'bad address' });
  // Compute net balances from transfer history (avoids per-token balanceOf calls).
  const rows = await q(`
    WITH net AS (
      SELECT token_addr, SUM(CASE WHEN to_addr   = $1 THEN amount ELSE 0 END
                            - CASE WHEN from_addr = $1 THEN amount ELSE 0 END) AS balance
        FROM token_transfers
       WHERE from_addr = $1 OR to_addr = $1
    GROUP BY token_addr
    )
    SELECT n.token_addr, n.balance, t.name, t.symbol, t.decimals
      FROM net n LEFT JOIN tokens t ON t.addr = n.token_addr
     WHERE n.balance > 0
     ORDER BY n.balance DESC
     LIMIT 200
  `, [a]);
  res.json({ items: rows.map(r => ({
    token: { addr: withHex(r.token_addr), name: r.name, symbol: r.symbol, decimals: r.decimals },
    balance: r.balance,
  })) });
});

// Holders of a token — net balance per address (received − sent), ranked.
// Optional ?exclude=0x.. removes an address (e.g. the issuer/admin wallet).
// Percentages are computed from supply server-side; the raw supply is NOT
// returned, by design.
app.get('/api/token/:addr/holders', async (req, res) => {
  const a = norm(req.params.addr);
  if (!a) return res.status(400).json({ error: 'bad address' });
  const lim = Math.min(500, parseInt(req.query.limit || '100', 10));
  const exclude = norm(req.query.exclude || '');
  const tok = await q1('SELECT decimals, symbol, total_supply FROM tokens WHERE addr = $1', [a]);
  const rows = await q(`
    WITH net AS (
      SELECT holder, SUM(amt) AS balance FROM (
        SELECT to_addr   AS holder,  amount AS amt FROM token_transfers WHERE token_addr = $1
        UNION ALL
        SELECT from_addr AS holder, -amount AS amt FROM token_transfers WHERE token_addr = $1
      ) m GROUP BY holder
    )
    SELECT holder, balance FROM net
     WHERE balance > 0
       AND holder <> '0000000000000000000000000000000000000000'
       ${exclude ? 'AND holder <> $3' : ''}
     ORDER BY balance DESC
     LIMIT $2
  `, exclude ? [a, lim, exclude] : [a, lim]);
  const supply = tok?.total_supply ? BigInt(tok.total_supply) : 0n;
  res.json({
    decimals: tok?.decimals ?? 18,
    symbol: tok?.symbol || '',
    count: rows.length,
    holders: rows.map(r => {
      const bal = BigInt(r.balance);
      const pct = supply > 0n ? Number((bal * 1000000n) / supply) / 10000 : null;
      return { address: withHex(r.holder), balance: r.balance, pct };
    }),
  });
});

// ELN spot price in USDT, read live from the ELN/USDT DEX pair (Uniswap-V2
// style: getReserves/token0/token1). price = USDT_reserve / ELN_reserve,
// decimal-adjusted. Cached 10s to avoid hammering the RPC.
const ELN_USDT_PAIR = '0xc7E38a117eA87Fb69610101aDFd4b556D18D188D';
const USDT_TOKEN_ADDR = '0x4A0BCE713e45B09353AADf320AFB14B46e143b19';
let _elnPriceCache = { at: 0, data: null };
app.get('/api/eln-price', async (_req, res) => {
  try {
    if (_elnPriceCache.data && Date.now() - _elnPriceCache.at < 10_000) {
      return res.json(_elnPriceCache.data);
    }
    const pairAbi = [
      'function getReserves() view returns (uint112 r0, uint112 r1, uint32 ts)',
      'function token0() view returns (address)',
      'function token1() view returns (address)',
    ];
    const ercAbi = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'];
    const pair = new ethers.Contract(ELN_USDT_PAIR, pairAbi, provider);
    const [t0, t1, r] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
    const usdt = USDT_TOKEN_ADDR.toLowerCase();
    let usdtRes, elnRes, elnToken;
    if (t0.toLowerCase() === usdt)      { usdtRes = r[0]; elnRes = r[1]; elnToken = t1; }
    else if (t1.toLowerCase() === usdt) { usdtRes = r[1]; elnRes = r[0]; elnToken = t0; }
    else throw new Error('pair does not include USDT');
    const eln = new ethers.Contract(elnToken, ercAbi, provider);
    const elnDec = Number(await eln.decimals());
    const usdtAmt = Number(ethers.formatUnits(usdtRes, 6));
    const elnAmt = Number(ethers.formatUnits(elnRes, elnDec));
    const price = elnAmt > 0 ? usdtAmt / elnAmt : 0;
    const data = {
      priceUsdt: price,
      pair: ELN_USDT_PAIR,
      elnToken,
      liquidityUsdt: usdtAmt,
      updatedAt: new Date().toISOString(),
    };
    _elnPriceCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Tokens directory ───────────────────────────────────────────────
app.get('/api/tokens', async (req, res) => {
  const lim = Math.min(100, parseInt(req.query.limit || '50', 10));
  const page = Math.max(0, parseInt(req.query.page || '0', 10));
  const rows = await q(
    `SELECT t.*, a.is_registered_token FROM tokens t LEFT JOIN accounts a ON a.addr = t.addr
      ORDER BY t.transfers DESC, t.holders DESC LIMIT $1 OFFSET $2`,
    [lim, page * lim]);
  res.json({ items: rows.map(r => ({
    addr: '0x' + r.addr, name: r.name, symbol: r.symbol, decimals: r.decimals,
    totalSupply: r.total_supply, holders: r.holders, transfers: r.transfers,
    registered: !!r.is_registered_token,
  })), page, limit: lim });
});

// Ad-hoc token enrichment — fetch name/symbol/decimals once on first request.
app.post('/api/tokens/:addr/enrich', async (req, res) => {
  const a = norm(req.params.addr);
  if (!a) return res.status(400).json({ error: 'bad address' });
  try {
    const [nm, sy, dc, ts] = await Promise.all([
      provider.call({ to: '0x' + a, data: ERC20_IFACE.encodeFunctionData('name') }).then(x => ERC20_IFACE.decodeFunctionResult('name', x)[0]).catch(() => null),
      provider.call({ to: '0x' + a, data: ERC20_IFACE.encodeFunctionData('symbol') }).then(x => ERC20_IFACE.decodeFunctionResult('symbol', x)[0]).catch(() => null),
      provider.call({ to: '0x' + a, data: ERC20_IFACE.encodeFunctionData('decimals') }).then(x => Number(ERC20_IFACE.decodeFunctionResult('decimals', x)[0])).catch(() => 18),
      provider.call({ to: '0x' + a, data: ERC20_IFACE.encodeFunctionData('totalSupply') }).then(x => ERC20_IFACE.decodeFunctionResult('totalSupply', x)[0].toString()).catch(() => null),
    ]);
    if (!nm && !sy) return res.status(400).json({ error: 'not an ERC-20' });
    await q(`
      INSERT INTO tokens (addr, name, symbol, decimals, total_supply)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (addr) DO UPDATE
        SET name = EXCLUDED.name, symbol = EXCLUDED.symbol,
            decimals = EXCLUDED.decimals, total_supply = EXCLUDED.total_supply
    `, [a, nm, sy, dc, ts]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Search ─────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q0 = String(req.query.q || '').trim();
  if (!q0) return res.json({ kind: 'empty', results: [] });
  // Block number
  if (/^\d+$/.test(q0)) {
    const r = await q1('SELECT number FROM blocks WHERE number = $1', [parseInt(q0, 10)]);
    if (r) return res.json({ kind: 'block', target: '/block/' + r.number });
  }
  // Tx hash
  if (/^0x[0-9a-f]{64}$/i.test(q0)) {
    const h = norm(q0);
    // Block hashes resolve before the slow archive-wide transaction scan.
    if (await lookup.findTx(h, { scanArchive: false })) return res.json({ kind: 'tx', target: '/tx/0x' + h });
    const b = await lookup.findBlockByHash(h);
    if (b != null) return res.json({ kind: 'block', target: '/block/' + b });
    if (await lookup.findTx(h)) return res.json({ kind: 'tx', target: '/tx/0x' + h });
  }
  // Address
  if (/^0x[0-9a-f]{40}$/i.test(q0)) {
    return res.json({ kind: 'address', target: '/address/' + q0.toLowerCase() });
  }
  // Token by symbol/name
  const tok = await q(`
    SELECT addr, name, symbol FROM tokens
     WHERE LOWER(symbol) = LOWER($1) OR LOWER(name) LIKE LOWER($2)
     ORDER BY transfers DESC LIMIT 10
  `, [q0, '%' + q0 + '%']);
  if (tok.length) return res.json({ kind: 'tokens', results: tok.map(t => ({ addr: '0x' + t.addr, name: t.name, symbol: t.symbol })) });
  res.json({ kind: 'unknown', results: [] });
});

// ─── Contract verify ────────────────────────────────────────────────
app.get('/api/contract/:addr', async (req, res) => {
  const a = norm(req.params.addr);
  const r = await q1('SELECT * FROM contract_sources WHERE addr = $1', [a]);
  if (!r) return res.status(404).json({ error: 'not verified' });
  r.addr = '0x' + r.addr;
  res.json(r);
});

app.post('/api/contract/verify', async (req, res) => {
  const { addr, name, compilerVersion, optimization, optimizationRuns, license, sourceCode, abi, constructorArgs } = req.body || {};
  const a = norm(addr);
  if (!a) return res.status(400).json({ error: 'address required' });
  if (!sourceCode || sourceCode.length < 10) return res.status(400).json({ error: 'source code required' });
  if (!name) return res.status(400).json({ error: 'contract name required' });
  if (!compilerVersion) return res.status(400).json({ error: 'compiler version required' });
  let code = '0x';
  try { code = await rpc('eth_getCode', ['0x' + a, 'latest']); } catch {}
  if (!code || code === '0x') return res.status(400).json({ error: 'address has no bytecode' });
  // We deliberately accept submissions without running a full solc match —
  // the source is stored and surfaced under the Contract tab. The chain
  // dashboard's verifier can flag mismatches; first-pass is honour-system.
  await q(`
    INSERT INTO contract_sources (
      addr, name, compiler_version, optimization, optimization_runs,
      license, source_code, abi, bytecode, constructor_args)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (addr) DO UPDATE
      SET name = EXCLUDED.name, compiler_version = EXCLUDED.compiler_version,
          optimization = EXCLUDED.optimization, optimization_runs = EXCLUDED.optimization_runs,
          license = EXCLUDED.license, source_code = EXCLUDED.source_code,
          abi = EXCLUDED.abi, bytecode = EXCLUDED.bytecode,
          constructor_args = EXCLUDED.constructor_args,
          verified_at = NOW()
  `, [
    a, name, compilerVersion, !!optimization, optimizationRuns || null,
    license || null, sourceCode, abi ? JSON.stringify(abi) : null, code, constructorArgs || null,
  ]);
  await q('UPDATE accounts SET is_contract = TRUE WHERE addr = $1', [a]);
  res.json({ ok: true, addr: '0x' + a });
});

// ─── Admin auth + custom domain ─────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== config.adminPassword) return res.status(401).json({ error: 'bad password' });
  const token = jwt.sign({ role: 'admin' }, config.jwtSecret, { expiresIn: '8h' });
  res.json({ token });
});

app.get('/api/admin/domain', async (_req, res) => {
  const d = await caddy.readDomainConfig();
  res.json({
    domain: d?.domain || null,
    acmeEmail: d?.acme_email || null,
    running: caddy.isRunning(),
    caddyDir: caddy.getCaddyDir(),
    updatedAt: d?.updated_at || null,
  });
});

app.post('/api/admin/domain', adminAuth, async (req, res) => {
  const { domain, acmeEmail } = req.body || {};
  if (!domain || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(domain))
    return res.status(400).json({ error: 'invalid domain' });
  await caddy.saveDomainConfig(domain, acmeEmail);
  await caddy.applyDomain(domain, acmeEmail, config.port);
  res.json({ ok: true, domain, running: caddy.isRunning() });
});

app.delete('/api/admin/domain', adminAuth, async (_req, res) => {
  await caddy.saveDomainConfig(null, null);
  await caddy.stopCaddy();
  res.json({ ok: true });
});

// ─── Favicon ─────────────────────────────────────────────────────────
// Browsers auto-request /favicon.ico; serve the PNG with the right type so
// the request resolves cleanly even for pages that don't declare a <link>.
app.get('/favicon.ico', (_req, res) => {
  res.type('image/png');
  res.sendFile(path.join(PUBLIC_DIR, 'img', 'favicon.png'));
});

// ─── Static files + extensionless rewrites ───────────────────────────
app.use((req, res, next) => {
  // /block/123 → /block.html, /tx/0x… → /tx.html, etc. We keep the URL
  // path; the page reads location.pathname.
  const p = req.path;
  if (p === '/' || p === '') return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  if (p.startsWith('/block/'))   return res.sendFile(path.join(PUBLIC_DIR, 'block.html'));
  if (p.startsWith('/tx/'))      return res.sendFile(path.join(PUBLIC_DIR, 'tx.html'));
  if (p.startsWith('/address/')) return res.sendFile(path.join(PUBLIC_DIR, 'address.html'));
  if (p === '/blocks')           return res.sendFile(path.join(PUBLIC_DIR, 'blocks.html'));
  if (p === '/txs')              return res.sendFile(path.join(PUBLIC_DIR, 'txs.html'));
  if (p === '/transactions')     return res.sendFile(path.join(PUBLIC_DIR, 'txs.html'));
  if (p === '/tokens')           return res.sendFile(path.join(PUBLIC_DIR, 'tokens.html'));
  if (p === '/token-transfers')  return res.sendFile(path.join(PUBLIC_DIR, 'token-transfers.html'));
  if (p === '/top-accounts')     return res.sendFile(path.join(PUBLIC_DIR, 'top-accounts.html'));
  if (p === '/verified-contracts') return res.sendFile(path.join(PUBLIC_DIR, 'verified-contracts.html'));
  if (p === '/attestations')     return res.sendFile(path.join(PUBLIC_DIR, 'attestations.html'));
  if (p === '/broadcast-tx')     return res.sendFile(path.join(PUBLIC_DIR, 'broadcast-tx.html'));
  if (p === '/verify-contract')  return res.sendFile(path.join(PUBLIC_DIR, 'verify-contract.html'));
  if (p === '/admin')            return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  next();
});
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: '1h',
  // JS/CSS must revalidate so app updates aren't pinned by the browser or
  // Cloudflare's edge cache (HTML isn't cached by CF, but .js/.css are).
  setHeaders: (res, filePath) => {
    if (/\.(js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  console.warn('[request] data lookup failed:', err.code || err.name || 'unknown');
  res.status(503).set('Retry-After', '10').json({
    error: 'Data is temporarily unavailable. Please retry.',
    code: 'DATA_UNAVAILABLE',
  });
});

// ─── Boot ────────────────────────────────────────────────────────────
async function ensureSchema() {
  // Idempotent: re-applying the schema is safe (everything is IF NOT EXISTS).
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  let locked = false;
  try {
    // Coordinate startup DDL with the archive controller's session lock.
    // Existing installations can serve requests while maintenance completes.
    locked = (await client.query('SELECT pg_try_advisory_lock(638812170) AS locked')).rows[0].locked;
    if (!locked) {
      console.log('[server] schema initialization deferred during archive maintenance');
      return;
    }
    await client.query("SET lock_timeout='5s';\n" + sql + '\nRESET lock_timeout;');
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(638812170)'); }
    finally { client.release(); }
  }
}

(async () => {
  try {
    await ensureSchema();
  } catch (e) {
    console.error('[server] db init failed:', e.message);
  }
  app.listen(config.port, () => {
    console.log(`[server] Elyon Explorer listening on :${config.port}`);
  });
  if (config.indexer.enabled) startIndexer().catch(e => console.warn('[indexer] crashed', e));
  caddy.autoStart(config.port).catch(() => {});
})();
