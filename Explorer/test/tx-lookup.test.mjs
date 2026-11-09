import test from 'node:test';
import assert from 'node:assert/strict';
import { txLookup } from '../src/tx-lookup.js';
import { parseUrelay } from '../src/rpc.js';

const H = 'ab'.repeat(32);
const FLOOR = 4288951;

// Records every SQL statement and RPC call; answers from the given tables.
function harness({ hot = null, hotBlock = null, archive = null, archiveBlock = null, chain, chainBlock, receipt, block, flags = null }) {
  const sql = [];
  const calls = [];
  const pool = {
    async query(text) {
      sql.push(text);
      if (text.includes('FROM public.txs')) return { rows: hot ? [hot] : [] };
      if (text.includes('FROM public.blocks')) return { rows: hotBlock ? [hotBlock] : [] };
      if (text.includes('archive_meta.progress')) return { rows: [{ block_until: String(FLOOR) }] };
      if (text.includes('FROM accounts')) return { rows: flags ? [flags] : [] };
      throw new Error('unexpected pool query: ' + text);
    },
  };
  const q = async text => {
    sql.push(text);
    if (text.includes('FROM txs')) return archive ? [archive] : [];
    if (text.includes('FROM blocks')) return archiveBlock ? [archiveBlock] : [];
    throw new Error('unexpected q: ' + text);
  };
  const rpc = async (method, params) => {
    calls.push(method);
    const answer = {
      eth_getTransactionByHash: chain,
      eth_getBlockByHash: chainBlock,
      eth_getTransactionReceipt: receipt,
      eth_getBlockByNumber: block,
    }[method];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { lookup: txLookup({ pool, q, rpc }), sql, calls };
}

test('indexed transactions are answered from the hot table without the node', async () => {
  const { lookup, calls } = harness({ hot: { hash: H } });
  assert.deepEqual(await lookup.findTx(H), { where: 'hot', row: { hash: H } });
  assert.deepEqual(calls, []);
});

test('a confirmed transaction the indexer has not reached comes from the chain, never the archive', async () => {
  const chain = { hash: '0x' + H, blockNumber: '0x' + (FLOOR + 10).toString(16) };
  const { lookup, sql } = harness({ chain });
  assert.deepEqual(await lookup.findTx(H), { where: 'chain', chainTx: chain });
  assert.ok(!sql.some(s => s.includes('FROM txs')), 'no archive read');
});

test('archived transactions placed by the node read only their block', async () => {
  const { lookup, sql } = harness({ chain: { blockNumber: '0x100' }, archive: { hash: H, block_number: '256' } });
  assert.deepEqual(await lookup.findTx(H), { where: 'archive', row: { hash: H, block_number: '256' } });
  assert.match(sql.find(s => s.includes('FROM txs')), /block_number = \$2/);
});

test('hashes older than the node transaction index still reach the archive', async () => {
  const { lookup, sql } = harness({ chain: null, archive: { hash: H } });
  assert.deepEqual(await lookup.findTx(H), { where: 'archive', row: { hash: H } });
  assert.equal(sql.filter(s => s.includes('FROM txs')).length, 1);
});

test('the archive-wide scan can be deferred, e.g. until block hashes are ruled out', async () => {
  const { lookup, sql } = harness({ chain: null, archive: { hash: H } });
  assert.equal(await lookup.findTx(H, { scanArchive: false }), null);
  assert.ok(!sql.some(s => s.includes('FROM txs')));
});

test('an unreachable node falls back to the archive instead of answering not found', async () => {
  const { lookup } = harness({ chain: new Error('ECONNREFUSED'), archive: { hash: H } });
  assert.equal((await lookup.findTx(H)).where, 'archive');
});

test('pending transactions skip the archive scan', async () => {
  const { lookup, sql } = harness({ chain: { hash: '0x' + H, blockNumber: null } });
  assert.equal(await lookup.findTx(H), null);
  assert.ok(!sql.some(s => s.includes('FROM txs')));
});

test('block hashes resolve through the hot table, then the node; unknown hashes skip the archive', async () => {
  assert.equal(await harness({ hotBlock: { number: '7' } }).lookup.findBlockByHash(H), 7);
  assert.equal(await harness({ chainBlock: { number: '0x2a' } }).lookup.findBlockByHash(H), 42);
  const unknown = harness({ chainBlock: null, archiveBlock: { number: '1' } });
  assert.equal(await unknown.lookup.findBlockByHash(H), null);
  assert.ok(!unknown.sql.some(s => s.includes('FROM blocks') && !s.includes('public.blocks')));
  const offline = harness({ chainBlock: new Error('down'), archiveBlock: { number: '9' } });
  assert.equal(await offline.lookup.findBlockByHash(H), 9);
});

test('rows built from the chain match what the indexer would store', async () => {
  const relayer = 'cd'.repeat(20);
  // URELAY1 marker + one record: tx hash (32) + relayer (20) + signature (65).
  const extraData = '0x' + Buffer.from('URELAY1').toString('hex') + H + relayer + '00'.repeat(65);
  assert.equal(parseUrelay(extraData)[0].relayer, relayer);
  const token = '11'.repeat(20);
  const holder = '22'.repeat(20);
  const { lookup } = harness({
    flags: { is_registered_contract: true, is_registered_token: false },
    receipt: {
      status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', contractAddress: null,
      logs: [
        { address: '0x' + token, logIndex: '0x3', data: '0x0de0b6b3a7640000', topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          '0x' + '0'.repeat(64),
          '0x' + '0'.repeat(24) + holder,
        ] },
        { address: '0x' + token, logIndex: '0x4', data: '0x', topics: ['0x' + '99'.repeat(32)] },
      ],
    },
    block: { timestamp: '0x6900f000', extraData },
  });
  const built = await lookup.fromChain({
    hash: '0x' + H, blockNumber: '0x5571b5', transactionIndex: '0x2',
    from: '0x' + 'AA'.repeat(20), to: '0x' + 'BB'.repeat(20), value: '0x10', input: '0xa9059cbb0000', gasPrice: '0x1',
  });
  const fee = 21000n * 1000000000n;
  assert.deepEqual(built.row, {
    hash: H, block_number: 5599669, tx_index: 2, timestamp: 0x6900f000,
    from_addr: 'aa'.repeat(20), to_addr: 'bb'.repeat(20), value: '16',
    gas_used: '21000', gas_price: '1000000000', gas_fee: fee.toString(), status: 1,
    method_id: 'a9059cbb', is_contract_creation: false, contract_created: null,
    fee_node_share: (fee * 1000n / 10000n).toString(),
    fee_contract_share: (fee * 500n / 10000n).toString(),
    fee_token_share: '0',
    fee_admin_residual: (fee - fee * 1000n / 10000n - fee * 500n / 10000n).toString(),
    relayer,
  });
  assert.deepEqual(built.transfers, [{
    tx_hash: H, block_number: 5599669, log_index: 3, timestamp: 0x6900f000,
    token_addr: token, from_addr: '0'.repeat(40), to_addr: holder, amount: '1000000000000000000',
  }]);
});

test('contract creations keep the created address and no recipient', async () => {
  const { lookup } = harness({
    receipt: { status: '0x0', gasUsed: '0x1', contractAddress: '0x' + 'ee'.repeat(20), logs: [] },
    block: { timestamp: '0x1', extraData: '0x' },
  });
  const { row } = await lookup.fromChain({ hash: '0x' + H, blockNumber: '0x1', to: null, from: '0x' + 'aa'.repeat(20), gasPrice: '0x2', input: '0x60' });
  assert.equal(row.is_contract_creation, true);
  assert.equal(row.contract_created, 'ee'.repeat(20));
  assert.equal(row.to_addr, null);
  assert.equal(row.status, 0);
  assert.equal(row.method_id, null);
  assert.equal(row.gas_fee, '2');
  assert.equal(row.fee_admin_residual, '2');
});

test('a receipt that vanished (reorg) is treated as not found', async () => {
  const { lookup } = harness({ receipt: null, block: { timestamp: '0x1', extraData: '0x' } });
  assert.equal(await lookup.fromChain({ hash: '0x' + H, blockNumber: '0x1' }), null);
});
