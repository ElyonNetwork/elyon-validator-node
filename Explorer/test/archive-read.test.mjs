import test from 'node:test';
import assert from 'node:assert/strict';
import {pool,q} from '../src/db.js';

const query='SELECT * FROM token_transfers WHERE tx_hash = $1 ORDER BY log_index ASC';
const transfer={tx_hash:'a'.repeat(64),log_index:1,amount:'115792089237316195423570985008687907853269984665640564039457584007913129639935'};

test('transfers remain visible if archival commits between hot queries',async()=>{
  let committed=false;
  pool.query=async text=>{
    if(text.includes('to_regclass'))return {rows:[{enabled:true}]};
    if(text.startsWith('SELECT 1 FROM public.txs')){
      const rows=committed?[]:[{exists:1}];committed=true;return {rows};
    }
    if(text.includes('FROM history.token_transfers'))return {rows:[transfer]};
    const rows=committed?[]:[transfer];committed=true;return {rows};
  };
  assert.deepEqual(await q(query,[transfer.tx_hash]),[transfer]);
});

test('archived transactions fall back when no hot parent remains',async()=>{
  pool.query=async text=>({rows:text.includes('FROM history.token_transfers')?[transfer]:[]});
  assert.deepEqual(await q(query,[transfer.tx_hash]),[transfer]);
});

test('a current transaction with no transfers avoids cold reads',async()=>{
  pool.query=async text=>{
    assert.ok(!text.includes('FROM history.token_transfers'));
    return {rows:text.startsWith('SELECT 1 FROM public.txs')?[{exists:1}]:[]};
  };
  assert.deepEqual(await q(query,[transfer.tx_hash]),[]);
});

const addressQuery='SELECT * FROM txs WHERE from_addr = $1 OR to_addr = $1 ORDER BY block_number DESC, tx_index DESC LIMIT $2 OFFSET $3';
test('current address pages use separate indexed sender and receiver probes',async()=>{
  pool.query=async text=>{
    assert.match(text,/UNION ALL/);
    assert.match(text,/IS DISTINCT FROM/);
    assert.ok(!text.includes('history.'));
    return {rows:[{hash:'current'}]};
  };
  assert.deepEqual(await q(addressQuery,['a',1,0]),[{hash:'current'}]);
});

test('incomplete hot address pages include the archive with no OR full scan',async()=>{
  pool.query=async text=>{
    assert.ok(!text.includes(' OR '));
    return {rows:text.includes('history.txs')?[{hash:'old'}]:[]};
  };
  assert.deepEqual(await q(addressQuery,['a',1,0]),[{hash:'old'}]);
});
