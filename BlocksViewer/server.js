// Elyon Blocks — a public, read-only live view of the last 100 mainnet blocks.
// One poller reads the node and keeps the blocks in memory; every visitor is
// served from that memory, so traffic here never reaches the node.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL || 'http://elyon-mainnet:8545';
const STAKING = (process.env.STAKING_CONTRACT || '0x04250541308a1d1c633de3d435e361402505cf29').toLowerCase();
const PORT = Number(process.env.PORT || 8080);
const KEEP = 100;
const POLL_MS = 1000;
const PUBLIC = path.join(__dirname, 'public');
const MARKER = Buffer.from('URELAY1').toString('hex');
const SEAL_HEX = 130;
const ATTESTATION_HEX = 234;

let rpcId = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}
const num = hex => hex == null ? null : Number(BigInt(hex));

// extraData is 32 bytes of client name, then optional relayer attestations, then the 65-byte seal.
function decodeExtra(hex) {
  const body = String(hex || '0x').slice(2);
  const vanityHex = body.slice(0, 64);
  const vanity = Buffer.from(vanityHex, 'hex').toString('utf8').replace(/\0+$/, '');
  const seal = body.length >= SEAL_HEX ? '0x' + body.slice(-SEAL_HEX) : null;
  const at = body.indexOf(MARKER, 64);
  let attestations = 0;
  if (at >= 0) {
    const count = parseInt(body.slice(at + MARKER.length, at + MARKER.length + 4), 16);
    if (Number.isFinite(count) && at + MARKER.length + 4 + count * ATTESTATION_HEX <= body.length) attestations = count;
  }
  return { vanity, seal, attestations };
}

function toBlock(b, parentTs) {
  const timestamp = num(b.timestamp), gasUsed = num(b.gasUsed), gasLimit = num(b.gasLimit);
  const extra = decodeExtra(b.extraData);
  return {
    number: num(b.number), hash: b.hash, parentHash: b.parentHash, timestamp,
    spacing: parentTs != null ? timestamp - parentTs : null,
    producer: b.miner, inTurn: num(b.difficulty) === 2, difficulty: num(b.difficulty), totalDifficulty: b.totalDifficulty != null ? BigInt(b.totalDifficulty).toString() : null,
    txCount: b.transactions.length, gasUsed, gasLimit, gasPct: gasLimit ? gasUsed / gasLimit * 100 : 0,
    baseFeePerGas: b.baseFeePerGas != null ? BigInt(b.baseFeePerGas).toString() : null, size: num(b.size),
    stateRoot: b.stateRoot, transactionsRoot: b.transactionsRoot, receiptsRoot: b.receiptsRoot, logsBloom: b.logsBloom,
    sha3Uncles: b.sha3Uncles, mixHash: b.mixHash, nonce: b.nonce, extraData: b.extraData,
    vanity: extra.vanity, seal: extra.seal, attestations: extra.attestations, txs: b.transactions.slice(0, 200),
  };
}

const state = { blocks: [], validators: [], minStakeEln: null, head: null, updatedAt: 0, rpcOk: false };
const clients = new Set();

function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const c of clients) { try { send(c, event, data); } catch { clients.delete(c); } } }

function networkSummary() {
  const b = state.blocks;
  const spans = b.filter(x => x.spacing != null).map(x => x.spacing);
  const counts = {};
  for (const x of b) counts[x.producer] = (counts[x.producer] || 0) + 1;
  const last = b[0];
  return {
    head: last ? last.number : null, headTime: last ? last.timestamp : null, avgBlockTime: spans.length ? spans.reduce((a, c) => a + c, 0) / spans.length : null,
    txs: b.reduce((a, x) => a + x.txCount, 0), tps: spans.length ? b.reduce((a, x) => a + x.txCount, 0) / Math.max(1, spans.reduce((a, c) => a + c, 0)) : null,
    gasPct: b.length ? b.reduce((a, x) => a + x.gasPct, 0) / b.length : null,
    inTurnShare: b.length ? b.filter(x => x.inTurn).length / b.length : null,
    validators: state.validators, producedBy: counts, minStakeEln: state.minStakeEln, rpcOk: state.rpcOk, updatedAt: state.updatedAt,
  };
}

async function refreshValidators() {
  try {
    const out = [];
    const count = num(await rpc('eth_getStorageAt', [STAKING, '0x3', 'latest']));
    const base = BigInt('0xc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b');   // keccak256(uint256(3))
    for (let i = 0; i < Math.min(count, 256); i++) {
      const v = await rpc('eth_getStorageAt', [STAKING, '0x' + (base + BigInt(i)).toString(16), 'latest']);
      out.push('0x' + v.slice(-40));
    }
    state.validators = out;
    const min = await rpc('eth_getStorageAt', [STAKING, '0x1', 'latest']);
    state.minStakeEln = BigInt(min) >= 2n ** 255n ? null : Number(BigInt(min) / 10n ** 18n);
  } catch { /* keep the previous set */ }
}

async function loadBlock(n) { return rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false]); }

async function poll() {
  try {
    const head = num(await rpc('eth_blockNumber'));
    state.rpcOk = true;
    if (state.head == null) {
      const from = Math.max(0, head - KEEP + 1);
      const raw = await Promise.all(Array.from({ length: head - from + 1 }, (_, i) => loadBlock(from + i)));
      const blocks = raw.filter(Boolean);
      let prev = blocks.length && blocks[0].number !== '0x0' ? (await loadBlock(num(blocks[0].number) - 1)) : null;
      state.blocks = blocks.map(b => { const x = toBlock(b, prev ? num(prev.timestamp) : null); prev = b; return x; }).reverse();
      state.head = head;
    } else if (head > state.head) {
      for (let n = state.head + 1; n <= head; n++) {
        const b = await loadBlock(n);
        if (!b) break;
        const newest = state.blocks[0];
        if (newest && b.parentHash !== newest.hash) { console.log('reorg at block', n, b.hash); state.head = null; return; }   // the next poll rebuilds the list
        const block = toBlock(b, newest ? newest.timestamp : null);
        state.blocks.unshift(block);
        state.blocks.length = Math.min(state.blocks.length, KEEP);
        state.head = n;
        state.updatedAt = Date.now();
        if (n % 15 === 0) await refreshValidators();
        broadcast('block', { block, network: networkSummary() });
      }
    }
    state.updatedAt = Date.now();
  } catch (e) {
    state.rpcOk = false;
    console.error('poll failed:', e.message);
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SEC); return res.end(); }
  if (url.pathname === '/healthz') { res.writeHead(state.rpcOk ? 200 : 503, { ...SEC, 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: state.rpcOk, head: state.head })); }
  if (url.pathname === '/api/blocks') { res.writeHead(200, { ...SEC, 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ blocks: state.blocks, network: networkSummary() })); }
  if (url.pathname === '/events') {
    if (clients.size >= 2000) { res.writeHead(503, SEC); return res.end(); }
    res.writeHead(200, { ...SEC, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403, SEC); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SEC); return res.end('Not found'); }
    res.writeHead(200, { ...SEC, 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'public, max-age=60' });
    res.end(data);
  });
}).listen(PORT, () => console.log('elyon-blocks listening on', PORT));

refreshValidators();
setInterval(poll, POLL_MS);
setInterval(() => broadcast('ping', { t: Date.now() }), 20000).unref();
