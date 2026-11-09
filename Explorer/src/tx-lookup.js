// Hash lookups that do not depend on the indexer having reached a block and
// that avoid whole-archive scans whenever the chain node can place a hash.
//
// The node keeps a transaction index for recent blocks only, so it can give
// the block number of a recent hash (archived rows are then read from that
// single block's archive chunk) or the full transaction when the indexer is
// still behind. Hashes the node cannot place fall back to the archive-wide
// scan, so old history stays searchable.
import { parseUrelay } from './rpc.js';
import { config } from './config.js';
import { norm } from './db.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDR = '0'.repeat(40);

function uint(hex) {
  try { return BigInt(hex || '0x0'); } catch { return 0n; }
}

export function txLookup({ pool, q, rpc }) {
  const q1 = async (text, params) => (await q(text, params))[0] || null;

  // undefined when the node is unreachable, null when it does not know the hash.
  async function node(method, params) {
    try { return await rpc(method, params, { retries: 1 }); }
    catch { return undefined; }
  }

  async function archiveFloor() {
    try {
      const r = await pool.query('SELECT block_until FROM archive_meta.progress WHERE id = 1');
      return Number(r.rows[0]?.block_until ?? 0);
    } catch {
      return 0; // archive not installed
    }
  }

  // { where: 'hot' | 'archive', row } or { where: 'chain', chainTx } or null.
  // scanArchive: false skips the archive-wide scan for hashes the node cannot place.
  async function findTx(h, { scanArchive = true } = {}) {
    const hot = await pool.query('SELECT * FROM public.txs WHERE hash = $1', [h]);
    if (hot.rows[0]) return { where: 'hot', row: hot.rows[0] };
    const onChain = await node('eth_getTransactionByHash', ['0x' + h]);
    if (onChain && onChain.blockNumber == null) return null; // still pending
    if (onChain) {
      const num = parseInt(onChain.blockNumber, 16);
      if (num >= await archiveFloor()) return { where: 'chain', chainTx: onChain };
      const row = await q1('SELECT * FROM txs WHERE hash = $1 AND block_number = $2', [h, num]);
      if (row) return { where: 'archive', row };
      // Past the local retention window, but the node can still show it.
      return { where: 'chain', chainTx: onChain, retained: false };
    }
    if (!scanArchive) return null;
    const row = await q1('SELECT * FROM txs WHERE hash = $1', [h]);
    return row ? { where: 'archive', row } : null;
  }

  async function findBlockByHash(h) {
    const hot = await pool.query('SELECT number FROM public.blocks WHERE hash = $1', [h]);
    if (hot.rows[0]) return Number(hot.rows[0].number);
    const onChain = await node('eth_getBlockByHash', ['0x' + h, false]);
    if (onChain) return parseInt(onChain.number, 16);
    if (onChain === null) return null; // the node has every block header
    const row = await q1('SELECT number FROM blocks WHERE hash = $1', [h]);
    return row ? Number(row.number) : null;
  }

  // Build the same row shapes the indexer stores, for a confirmed transaction
  // whose block has not been indexed yet. Mirrors indexBlock() in indexer.js.
  async function fromChain(t) {
    const [receipt, block] = await Promise.all([
      node('eth_getTransactionReceipt', [t.hash]),
      node('eth_getBlockByNumber', [t.blockNumber, false]),
    ]);
    if (!receipt || !block) return null;
    const h = norm(t.hash);
    const num = parseInt(t.blockNumber, 16);
    const ts = parseInt(block.timestamp, 16);
    const from = norm(t.from);
    const to = norm(t.to);
    const gasUsed = uint(receipt.gasUsed);
    const gasPrice = uint(receipt.effectiveGasPrice || t.gasPrice);
    const gasFee = gasUsed * gasPrice;
    const input = t.input || '0x';
    const relayer = parseUrelay(block.extraData).find(a => a.txHash.toLowerCase() === h)?.relayer || null;
    const flags = to
      ? (await pool.query('SELECT is_registered_contract, is_registered_token FROM accounts WHERE addr = $1', [to])).rows[0]
      : null;
    const share = bps => (gasFee * BigInt(bps)) / 10000n;
    const nodeShare = relayer ? share(config.feeBps.node) : 0n;
    const contractShare = flags?.is_registered_contract ? share(config.feeBps.contract) : 0n;
    const tokenShare = flags?.is_registered_token ? share(config.feeBps.token) : 0n;
    const row = {
      hash: h,
      block_number: num,
      tx_index: parseInt(t.transactionIndex || '0x0', 16),
      timestamp: ts,
      from_addr: from,
      to_addr: to,
      value: uint(t.value).toString(),
      gas_used: gasUsed.toString(),
      gas_price: gasPrice.toString(),
      gas_fee: gasFee.toString(),
      status: parseInt(receipt.status || '0x0', 16),
      method_id: input.length >= 10 ? input.slice(2, 10).toLowerCase() : null,
      is_contract_creation: !to && !!receipt.contractAddress,
      contract_created: receipt.contractAddress ? norm(receipt.contractAddress) : null,
      fee_node_share: nodeShare.toString(),
      fee_contract_share: contractShare.toString(),
      fee_token_share: tokenShare.toString(),
      fee_admin_residual: (gasFee - nodeShare - contractShare - tokenShare).toString(),
      relayer,
    };
    const transfers = (receipt.logs || [])
      .filter(l => l.topics?.length >= 3 && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC)
      .map(l => ({
        tx_hash: h,
        block_number: num,
        log_index: parseInt(l.logIndex || '0x0', 16),
        timestamp: ts,
        token_addr: norm(l.address),
        from_addr: norm('0x' + l.topics[1].slice(26)) || ZERO_ADDR,
        to_addr: norm('0x' + l.topics[2].slice(26)) || ZERO_ADDR,
        amount: uint(l.data).toString(),
      }));
    return { row, transfers, receipt };
  }

  return { findTx, findBlockByHash, fromChain };
}
