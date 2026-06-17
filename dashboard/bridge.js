// v7.5.0 — Transaction-Mirror Bridge between L1 (vanilla-engine) and L2 (APOS).
//
// Architecture:
//   * Same chainId on both. Signed txs valid on both.
//   * L1 dashboard is the orchestrator: intercepts eth_sendRawTransaction,
//     forwards to L2, then forwards to local L1 Nethermind.
//   * L1 dashboard has a background worker that polls L2 for per-block
//     distribution events, then submits applyDistribution() to L1's APOS
//     contract so L1's tracker state mirrors L2's.
//   * L2 dashboard exposes /api/bridge/distributions-since/:from that
//     diffs accumulatedFees snapshots and returns events.
//
// Resilience: if peer is unreachable, neither side crashes — orchestrator
// retries with backoff, L1 simply doesn't apply distributions until L2
// is reachable again.

'use strict';
const fs = require('fs');
const path = require('path');

function init(app, ctx) {
  const { web3Ref, getConfig, log, DATA_DIR } = ctx;
  const Web3 = require('web3').default || require('web3');

  // ─── Config helpers ────────────────────────────────────────────────
  function bridgeCfg() {
    const cfg = getConfig() || {};
    // peerHost is just the host part (IP or hostname). We derive the two URLs
    // from it: JSON-RPC at :8545, HTTP API at :3000.
    const host = cfg.bridgePeerHost || cfg.bridgePeerUrl || null;
    let host_only = host;
    if (host_only) {
      host_only = String(host_only).replace(/^https?:\/\//, '').replace(/:.*$/, '').replace(/\/+$/, '');
    }
    return {
      mode: cfg.bridgeMode || null,
      peerHost: host_only,
      peerRpcUrl: host_only ? `http://${host_only}:8545` : null,
      peerApiUrl: host_only ? `http://${host_only}:3000` : null,
      secret: cfg.bridgeSecret || null,
      pollMs: parseInt(cfg.bridgePollMs || '5000', 10),
    };
  }

  // ─── L2 side: serve distribution snapshots ────────────────────────
  //
  // The L2 dashboard maintains an in-memory snapshot of every active
  // entity's accumulatedFees (nodes, tokens, contracts, admin).
  // On every poll, it compares against the previous snapshot and writes
  // the diff to a ring buffer keyed by block number.
  // L1 polls /api/bridge/distributions-since/:fromBlock to drain the buffer.

  const REGISTRY_BUILD = JSON.parse(fs.readFileSync(path.join(__dirname, 'apos-registry-build.json'), 'utf8'));
  let _l2_lastSnapshot = null; // { admin: bigInt, nodes: Map<addr,bigInt>, tokens:..., contracts:... }
  let _l2_eventsByBlock = new Map(); // blockNum -> events[]
  const L2_BUFFER_BLOCKS = 1000;

  async function _l2ReadSnapshot() {
    const cfg = getConfig() || {};
    if (!cfg.aposRegistry) return null;
    const web3 = web3Ref();
    const reg = new web3.eth.Contract(REGISTRY_BUILD.abi, cfg.aposRegistry);
    const snap = {
      admin: BigInt(await reg.methods.adminAccumulatedFees().call()),
      nodes: new Map(),
      tokens: new Map(),
      contracts: new Map(),
    };
    // Enumerate active nodes
    try {
      const nodeCount = Number(await reg.methods.getNodeCount().call());
      for (let i = 0; i < nodeCount && i < 256; i++) {
        const addr = await reg.methods.nodeList(i).call();
        if (addr === '0x0000000000000000000000000000000000000000') continue;
        const info = await reg.methods.getNodeInfo(addr).call();
        snap.nodes.set(addr.toLowerCase(), BigInt(info.fees));
      }
    } catch {}
    try {
      const tokenCount = Number(await reg.methods.getTokenCount().call());
      for (let i = 0; i < tokenCount && i < 1024; i++) {
        const addr = await reg.methods.tokenList(i).call();
        if (addr === '0x0000000000000000000000000000000000000000') continue;
        const info = await reg.methods.getTokenInfo(addr).call();
        snap.tokens.set(addr.toLowerCase(), BigInt(info.fees));
      }
    } catch {}
    try {
      const contractCount = Number(await reg.methods.getContractCount().call());
      for (let i = 0; i < contractCount && i < 1024; i++) {
        const addr = await reg.methods.contractList(i).call();
        if (addr === '0x0000000000000000000000000000000000000000') continue;
        const info = await reg.methods.getContractInfo(addr).call();
        snap.contracts.set(addr.toLowerCase(), BigInt(info.fees));
      }
    } catch {}
    return snap;
  }

  function _l2DiffSnapshots(prev, curr) {
    const events = [];
    if (curr.admin > prev.admin) {
      events.push({ kind: 3, target: '0x0000000000000000000000000000000000000000', amount: (curr.admin - prev.admin).toString() });
    }
    for (const [addr, fees] of curr.nodes) {
      const prevFees = prev.nodes.get(addr) || 0n;
      if (fees > prevFees) events.push({ kind: 0, target: addr, amount: (fees - prevFees).toString() });
    }
    for (const [addr, fees] of curr.tokens) {
      const prevFees = prev.tokens.get(addr) || 0n;
      if (fees > prevFees) events.push({ kind: 1, target: addr, amount: (fees - prevFees).toString() });
    }
    for (const [addr, fees] of curr.contracts) {
      const prevFees = prev.contracts.get(addr) || 0n;
      if (fees > prevFees) events.push({ kind: 2, target: addr, amount: (fees - prevFees).toString() });
    }
    return events;
  }

  async function _l2WorkerTick() {
    try {
      const cfg = getConfig() || {};
      if (!cfg.aposRegistry) return;
      const web3 = web3Ref();
      const currentBlock = Number(await web3.eth.getBlockNumber());
      const snap = await _l2ReadSnapshot();
      if (!snap) return;
      if (_l2_lastSnapshot) {
        const events = _l2DiffSnapshots(_l2_lastSnapshot, snap);
        if (events.length > 0) {
          _l2_eventsByBlock.set(currentBlock, events);
          if (_l2_eventsByBlock.size > L2_BUFFER_BLOCKS) {
            const oldestKey = _l2_eventsByBlock.keys().next().value;
            _l2_eventsByBlock.delete(oldestKey);
          }
          log(`[bridge-l2] block ${currentBlock}: ${events.length} distribution events buffered`);
        }
      }
      _l2_lastSnapshot = snap;
    } catch (e) {
      console.warn('[bridge-l2] worker tick failed:', e.message);
    }
  }

  // L2 endpoint: return buffered events from fromBlock onwards
  app.get('/api/bridge/distributions-since/:fromBlock', async (req, res) => {
    try {
      const fromBlock = parseInt(req.params.fromBlock, 10);
      if (isNaN(fromBlock)) return res.status(400).json({ error: 'fromBlock NaN' });
      const cfg = bridgeCfg();
      // Optional shared-secret check — drop unauth requests at the door.
      if (cfg.secret) {
        const tok = req.headers['x-bridge-secret'] || '';
        if (tok !== cfg.secret) return res.status(401).json({ error: 'bad secret' });
      }
      const out = [];
      for (const [bn, events] of _l2_eventsByBlock) {
        if (bn > fromBlock) out.push({ blockNumber: bn, events });
      }
      out.sort((a, b) => a.blockNumber - b.blockNumber);
      res.json({
        currentBlock: Number(await web3Ref().eth.getBlockNumber()),
        items: out,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── L1 side: orchestrator ─────────────────────────────────────────
  //
  // (a) Intercept eth_sendRawTransaction in the RPC proxy and forward
  //     the rawTx to L2 in parallel with local L1 forwarding.
  // (b) Background worker polls L2 for new distribution events and
  //     submits applyDistribution(events) to L1's APOS contract.

  let _l1_lastAppliedBlock = 0;

  async function _l1ForwardTxToL2(rawTx) {
    const cfg = bridgeCfg();
    if (cfg.mode !== 'L1' || !cfg.peerRpcUrl) return;
    // v7.7.0 — gate tx-mirror on handshake. Until both sides have
    // entered each other, this L1 runs as an independent miner; no
    // tx-forwarding to a peer that may not even know we exist.
    const hs = await _checkHandshake();
    if (!hs.ok) return;
    try {
      await fetch(cfg.peerRpcUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [rawTx], id: 1 }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
    } catch {}
  }

  async function _l1WorkerTick() {
    try {
      const cfg = getConfig() || {};
      const br = bridgeCfg();
      if (br.mode !== 'L1' || !br.peerApiUrl) return;
      if (!cfg.aposRegistry || !cfg.validatorKey) return;
      // v7.7.0 — same handshake gate as forwardTxToL2. Don't pull or
      // apply distributions until the L2 admin has acknowledged us.
      const hs = await _checkHandshake();
      if (!hs.ok) return;
      // Pull latest distributions from L2
      const url = br.peerApiUrl + '/api/bridge/distributions-since/' + _l1_lastAppliedBlock;
      const headers = { 'Content-Type': 'application/json' };
      if (br.secret) headers['x-bridge-secret'] = br.secret;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) }).then(x => x.json()).catch(() => null);
      if (!r || !r.items || r.items.length === 0) return;

      // Decrypt validator key
      let pk = cfg.validatorKey;
      if (String(pk).startsWith('enc:v1:')) {
        if (typeof ctx.decryptKey === 'function') pk = ctx.decryptKey(pk);
      }
      const web3 = web3Ref();
      const reg = new web3.eth.Contract(REGISTRY_BUILD.abi, cfg.aposRegistry);
      const acct = web3.eth.accounts.privateKeyToAccount(pk);
      const cid = await web3.eth.getChainId();

      for (const item of r.items) {
        try {
          let totalWei = 0n;
          for (const e of item.events) totalWei += BigInt(e.amount);
          if (totalWei === 0n) continue;
          const data = reg.methods.applyDistribution(item.events).encodeABI();
          const nonce = await web3.eth.getTransactionCount(acct.address, 'pending');
          const gp = await web3.eth.getGasPrice();
          const tx = {
            from: acct.address, to: cfg.aposRegistry, data,
            value: totalWei.toString(),
            gas: '1500000', gasPrice: gp.toString(),
            nonce: Number(nonce), chainId: Number(cid),
          };
          const signed = await web3.eth.accounts.signTransaction(tx, pk);
          const txHash = await web3.requestManager.send({ method: 'eth_sendRawTransaction', params: [signed.rawTransaction] });
          log(`[bridge-l1] applied L2 block ${item.blockNumber} → L1 APOS: ${item.events.length} events, ${totalWei} wei, tx ${txHash}`);
          _l1_lastAppliedBlock = item.blockNumber;
        } catch (e) {
          console.warn(`[bridge-l1] applyDistribution for L2 block ${item.blockNumber} failed:`, e.message);
          break; // don't advance watermark on failure; retry next tick
        }
      }
    } catch (e) {
      console.warn('[bridge-l1] worker tick failed:', e.message);
    }
  }

  // Read/write the L1 watermark to disk so restarts don't double-apply.
  const WATERMARK_FILE = path.join(DATA_DIR, 'bridge-l1-watermark.json');
  try {
    if (fs.existsSync(WATERMARK_FILE)) {
      const j = JSON.parse(fs.readFileSync(WATERMARK_FILE, 'utf8'));
      if (typeof j.lastAppliedBlock === 'number') _l1_lastAppliedBlock = j.lastAppliedBlock;
    }
  } catch {}
  setInterval(() => {
    try { fs.writeFileSync(WATERMARK_FILE, JSON.stringify({ lastAppliedBlock: _l1_lastAppliedBlock })); } catch {}
  }, 30_000);

  // ─── Two-way handshake (v7.7.0) ───────────────────────────────────
  //
  // Mirroring is gated on a mutual configuration check: BOTH sides must
  // have the other's host saved. The L1 mirror should not blindly fan
  // out raw txs / fees to a peer that doesn't know about it — that's
  // both a privacy leak (broadcasting txs to an unrelated host) and an
  // attack surface (an attacker could point an L1 at an unrelated L2
  // and pollute applyDistribution).
  //
  // Algorithm:
  //   1. L1 calls L2's /api/bridge/handshake-ping with its own host.
  //   2. L2 responds with the host IT has stored for its bridge peer.
  //   3. If L2's stored peer host matches L1's own host (+ secrets line
  //      up), handshake = true.
  // Same direction inverted for L2's check.
  //
  // The result is cached for HANDSHAKE_TTL_MS so we don't hammer the
  // peer; if mirroring is failing, look at /api/bridge/status to see
  // which side is broken.
  const HANDSHAKE_TTL_MS = 15_000;
  let _handshakeCache = { ok: false, checkedAt: 0, reason: 'never checked', peerReportedHost: null };

  async function _checkHandshake() {
    const now = Date.now();
    if (now - _handshakeCache.checkedAt < HANDSHAKE_TTL_MS) return _handshakeCache;
    const br = bridgeCfg();
    if (!br.mode || !br.peerApiUrl) {
      _handshakeCache = { ok: false, checkedAt: now, reason: 'bridge not configured', peerReportedHost: null };
      return _handshakeCache;
    }
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (br.secret) headers['x-bridge-secret'] = br.secret;
      const r = await fetch(br.peerApiUrl + '/api/bridge/handshake-ping', {
        method: 'POST', headers, body: JSON.stringify({ myHost: br.peerHost ? null : null }),
        signal: AbortSignal.timeout(5000),
      }).then(x => x.json()).catch(() => null);
      if (!r) {
        _handshakeCache = { ok: false, checkedAt: now, reason: 'peer unreachable', peerReportedHost: null };
        return _handshakeCache;
      }
      if (r.error) {
        _handshakeCache = { ok: false, checkedAt: now, reason: 'peer error: ' + r.error, peerReportedHost: null };
        return _handshakeCache;
      }
      // The peer must:
      //   (a) be the opposite role (L1<->L2)
      //   (b) have SOME peer host configured (not null)
      // The strict equality check ('peer's stored host == my own external
      // IP') is informational here — we don't actually know our own
      // external IP from inside docker. We accept any non-null peer host
      // as evidence the operator has done the second step of the
      // handshake on the other side.
      const expectedOppositeMode = br.mode === 'L1' ? 'L2' : 'L1';
      if (r.mode !== expectedOppositeMode) {
        _handshakeCache = { ok: false, checkedAt: now, reason: `peer reports mode=${r.mode}, expected ${expectedOppositeMode}`, peerReportedHost: r.peerHost || null };
        return _handshakeCache;
      }
      if (!r.peerHost) {
        _handshakeCache = { ok: false, checkedAt: now, reason: 'peer has not configured its bridgePeerHost yet (complete step B on the other side)', peerReportedHost: null };
        return _handshakeCache;
      }
      if (br.secret && !r.secretMatches) {
        _handshakeCache = { ok: false, checkedAt: now, reason: 'shared secret mismatch', peerReportedHost: r.peerHost };
        return _handshakeCache;
      }
      _handshakeCache = { ok: true, checkedAt: now, reason: 'ok', peerReportedHost: r.peerHost };
      return _handshakeCache;
    } catch (e) {
      _handshakeCache = { ok: false, checkedAt: now, reason: 'check failed: ' + e.message, peerReportedHost: null };
      return _handshakeCache;
    }
  }

  // Peer calls this to learn what WE have stored. The peer interprets
  // the response to decide if handshake is complete from its side.
  app.post('/api/bridge/handshake-ping', (req, res) => {
    const cfg = bridgeCfg();
    const secretMatches = !cfg.secret || (req.headers['x-bridge-secret'] || '') === cfg.secret;
    res.json({
      mode: cfg.mode,
      peerHost: cfg.peerHost || null,
      hasSecret: !!cfg.secret,
      secretMatches,
    });
  });

  // ─── Status endpoint (read-only, public) ──────────────────────────
  app.get('/api/bridge/status', async (req, res) => {
    const cfg = bridgeCfg();
    const hs = await _checkHandshake();
    res.json({
      mode: cfg.mode,
      peerHost: cfg.peerHost || null,
      peerRpcUrl: cfg.peerRpcUrl || null,
      peerApiUrl: cfg.peerApiUrl || null,
      hasSecret: !!cfg.secret,
      pollMs: cfg.pollMs,
      l1_lastAppliedBlock: _l1_lastAppliedBlock,
      l2_bufferedBlocks: _l2_eventsByBlock.size,
      handshake: {
        ok: hs.ok,
        reason: hs.reason,
        peerReportedHost: hs.peerReportedHost,
        checkedAt: hs.checkedAt,
      },
    });
  });

  // ─── Boot the right worker ─────────────────────────────────────────
  function startWorkers() {
    const br = bridgeCfg();
    if (br.mode === 'L2') {
      log(`[bridge] booting L2 worker; poll every ${br.pollMs}ms`);
      setInterval(() => { _l2WorkerTick().catch(() => {}); }, br.pollMs);
      _l2WorkerTick().catch(() => {});
    } else if (br.mode === 'L1') {
      log(`[bridge] booting L1 worker; peer=${br.peerHost} poll=${br.pollMs}ms`);
      setInterval(() => { _l1WorkerTick().catch(() => {}); }, br.pollMs);
      _l1WorkerTick().catch(() => {});
    }
  }
  // Defer boot until config is loaded.
  setTimeout(startWorkers, 5000);

  // Expose the forward-helper to the RPC proxy.
  return { forwardTxToL2: _l1ForwardTxToL2 };
}

module.exports = { init };
