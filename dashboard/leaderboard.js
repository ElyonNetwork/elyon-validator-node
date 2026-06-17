// leaderboard.js — admin/public APOS leaderboard endpoints + uptime bot.
//
// Reads from / writes to the APOSLeaderboard contract via the admin signer.
//   GET  /api/lb/state              public — coefficients, pool sizes
//   GET  /api/lb/nodes/:month       public — sorted top-100 nodes for month
//   GET  /api/lb/owners/:month      public — sorted top-100 owners for month
//   POST /api/lb/admin/deploy       (auth) — deploy APOSLeaderboard once
//   POST /api/lb/admin/coefficients (auth) — set 6 coefficients
//   POST /api/lb/admin/rewards/node (auth) — { topN, weiPerPoint }
//   POST /api/lb/admin/rewards/owner(auth) — { topN, weiPerPoint }
//   POST /api/lb/admin/fund/node    (auth) — { amountWei }
//   POST /api/lb/admin/fund/owner   (auth) — { amountWei }
//   POST /api/lb/admin/uptime       (auth) — { node, month, pct }
//   POST /api/lb/admin/uptime/auto  (auth) — record uptime % for current month
//                                            for every known node (uses bot data)
//
// Boot also starts the uptime bot — every 60 s it tries an eth_blockNumber
// against each known node's RPC (admin-configured) and tracks success rate.

const fs   = require('fs');
const path = require('path');
const LB   = require('./leaderboard-build.json');

const STATE_PATH = path.join(process.env.DATA_DIR || '/data', 'leaderboard.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { contractAddress: null, deployedAt: null, deployedBy: null, nodeRpcs: {} /* addr → rpcUrl */ }; }
}
function saveState(s) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch (e) { console.warn('[lb] saveState:', e.message); }
}

/* ─── uptime bot (v7.39 — heartbeat based) ──────────────────────────
 * Each operator node POSTs a liveness heartbeat to the admin every 60 s
 * (POST /api/lb/heartbeat { address }). The admin samples every 60 s: a
 * node counts as "up" for that minute if its last heartbeat is < 90 s old.
 * The aggregated monthly uptime % is auto-pushed into the leaderboard
 * contract every ~10 minutes — no node-RPC discovery or manual trigger
 * needed. Heartbeat-based avoids the admin having to know each operator's
 * reachable RPC URL (which isn't published on-chain). */
const upHistory   = new Map();    // addr → { samples, ok, month }
const lastBeat    = new Map();    // addr → epoch-ms of last heartbeat
const PING_MS     = 60_000;
const PUSH_MS     = 180_000;      // push uptime to contract every 3 min
const BEAT_FRESH  = 90_000;       // heartbeat considered fresh for 90 s
function monthIdx(ts) { return Math.floor((ts || Date.now() / 1000) / 2592000); }

function recordHeartbeat(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr || '')) return false;
  lastBeat.set(addr.toLowerCase(), Date.now());
  return true;
}

let upTimer = null, upPushTimer = null;
function startUptimeBot(pushFn) {
  if (upTimer) clearInterval(upTimer);
  if (upPushTimer) clearInterval(upPushTimer);
  // sample liveness every minute
  upTimer = setInterval(() => {
    const m = monthIdx();
    const now = Date.now();
    for (const [addr, ts] of lastBeat.entries()) {
      const rec = upHistory.get(addr) || { samples: 0, ok: 0, month: m };
      if (rec.month !== m) { rec.samples = 0; rec.ok = 0; rec.month = m; }
      rec.samples += 1;
      if (now - ts < BEAT_FRESH) rec.ok += 1;
      upHistory.set(addr, rec);
    }
  }, PING_MS);
  // push aggregated uptime % into the contract on a timer, plus an early
  // push ~90 s after boot so uptime shows up quickly (not after a long wait).
  if (typeof pushFn === 'function') {
    setTimeout(() => { pushFn().catch(() => {}); }, 90_000);
    upPushTimer = setInterval(() => { pushFn().catch(() => {}); }, PUSH_MS);
  }
}

function mountLeaderboard(app, ctx) {
  const { web3, requireAuth, getAdminWallet } = ctx;
  const inst = (addr) => new web3.eth.Contract(LB.abi, addr);

  /* ─── public reads ─────────────────────────────────────────────── */

  app.get('/api/lb/state', async (_req, res) => {
    try {
      const s = loadState();
      if (!s.contractAddress) return res.json({ deployed: false });
      const c = inst(s.contractAddress);
      const [coeff, nr, or_, month, ncnt, ocnt] = await Promise.all([
        c.methods.coefficients().call(),
        c.methods.nodeRewards().call(),
        c.methods.ownerRewards().call(),
        c.methods.currentMonth().call(),
        c.methods.nodeCount().call(),
        c.methods.ownerCount().call(),
      ]);
      // v7.40 — "Tracked nodes" must match what's actually listed: exclude the
      // admin/owner so the stat lines up with the ranked table (which hides it).
      let visibleNodeCount = Number(ncnt);
      try { visibleNodeCount = (await loadAndSort(c, String(month), 'node')).length; } catch {}
      res.json({
        deployed: true,
        contractAddress: s.contractAddress,
        currentMonth: String(month),
        nodeCount: String(visibleNodeCount),
        ownerCount: String(ocnt),
        coefficients: {
          txCountWeight:      String(coeff.txCountWeight),
          txVolumeWeight:     String(coeff.txVolumeWeight),
          ownersStakedWeight: String(coeff.ownersStakedWeight),
          uptimeWeight:       String(coeff.uptimeWeight),
          stakePackageWeight: String(coeff.stakePackageWeight),
          stakePackageBase:   String(coeff.stakePackageBase),
        },
        nodeRewards: {
          poolBalanceWei: String(nr.poolBalance),
          topN:           String(nr.topN),
          weiPerPoint:    String(nr.weiPerPoint),
        },
        ownerRewards: {
          poolBalanceWei: String(or_.poolBalance),
          topN:           String(or_.topN),
          weiPerPoint:    String(or_.weiPerPoint),
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Page through every node, score them, sort, take top 100.
  // v7.37 — the admin / APOS-contract owner (chain validator) is excluded:
  // only operator nodes are ranked, even though the admin may carry historical
  // recorded txs from before this filter existed.
  async function loadAndSort(c, month, kind, limit = 100) {
    const adminAddr = (getAdminWallet()?.address || '').toLowerCase();
    const total = Number(await c.methods[kind === 'node' ? 'nodeCount' : 'ownerCount']().call());
    const out = [];
    const PAGE = 200;
    for (let off = 0; off < total; off += PAGE) {
      const slice = await c.methods[kind === 'node' ? 'nodeSlice' : 'ownerSlice'](month, off, PAGE).call();
      const addrs = slice.addrs || slice[0];
      const scores = slice.scores || slice[1];
      const metrics = slice.metrics || slice[2];
      for (let i = 0; i < addrs.length; i++) {
        if (adminAddr && String(addrs[i]).toLowerCase() === adminAddr) continue; // hide admin/owner
        out.push({ address: addrs[i], score: Number(scores[i]), metrics: metrics[i] });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  // v8 — the leaderboard ranks ONLY admin-approved APOS validators. The
  // token/contract-owner board was removed with the marketplace model.
  async function filterActiveValidators(items) {
    try {
      const cfg = typeof ctx.getConfig === 'function' ? ctx.getConfig() : null;
      if (!cfg?.aposRegistry) return items;
      const regBuild = require('./apos-registry-build.json');
      const reg = new web3.eth.Contract(regBuild.abi, cfg.aposRegistry);
      const checked = await Promise.all(items.map(async (it) => {
        try { return (await reg.methods.isValidatorActive(it.address).call()) ? it : null; }
        catch { return null; }
      }));
      return checked.filter(Boolean);
    } catch { return items; }
  }

  app.get('/api/lb/nodes/:month', async (req, res) => {
    try {
      const s = loadState();
      if (!s.contractAddress) return res.status(503).json({ error: 'not deployed' });
      const c = inst(s.contractAddress);
      const month = req.params.month === 'current'
        ? String(await c.methods.currentMonth().call())
        : req.params.month;
      const items = await filterActiveValidators(await loadAndSort(c, month, 'node'));
      res.json({ month, items });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Legacy owners board — the role no longer exists; return an empty board
  // so any cached client renders "no entries" instead of erroring.
  app.get('/api/lb/owners/:month', async (req, res) => {
    res.json({ month: String(req.params.month || 'current'), items: [], removed: true });
  });

  /* ─── admin writes ─────────────────────────────────────────────── */

  // v7.26 — shared local-sign + raw-broadcast + receipt-poll helper. Every
  // admin write below uses this instead of web3 `.send({ from })`, which made
  // Nethermind try to sign with an unlocked local account (Elyon's admin key
  // is only in the dashboard's in-memory web3 wallet, never unlocked in
  // Nethermind, so every write returned "Can only sign without passphrase
  // when account is unlocked").
  async function sendAdminTx(admin, to, data, gas, value) {
    const gasPrice = String(await web3.eth.getGasPrice());
    const chainId  = Number(await web3.eth.getChainId());
    const nonce    = await web3.eth.getTransactionCount(admin.address, 'pending');
    const signed   = await admin.signTransaction({
      to, data, value: value ? String(value) : '0x0',
      gas: String(gas), gasPrice, nonce: String(nonce), chainId, type: '0x0',
    });
    const txHash = signed.transactionHash;
    try {
      const provider = web3.currentProvider || web3.eth.currentProvider;
      const rpcUrl = (provider && (provider.host || provider.clientUrl || provider.url)) || 'http://127.0.0.1:8545';
      await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [signed.rawTransaction] }),
      });
    } catch {}
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const rec = await web3.eth.getTransactionReceipt(txHash);
        if (rec && rec.blockNumber) return rec;
      } catch (e) {
        if (!/Pruned history|not found|null/i.test(String(e?.message || ''))) throw e;
      }
    }
    throw new Error('tx confirmation timeout for ' + txHash);
  }

  app.post('/api/lb/admin/deploy', requireAuth, async (req, res) => {
    try {
      const s = loadState();
      if (s.contractAddress) return res.status(409).json({ error: 'already deployed', state: s });
      // v7.21 — body may include `adminPrivateKey` (one-time-use), same flow
      // as the faucet deploy.
      let admin = null;
      const bodyKey = (req.body?.adminPrivateKey || '').replace(/^0x/i, '').trim();
      if (bodyKey && /^[0-9a-fA-F]{64}$/.test(bodyKey)) {
        admin = web3.eth.accounts.privateKeyToAccount('0x' + bodyKey);
        web3.eth.accounts.wallet.add(admin);
      } else {
        admin = getAdminWallet();
      }
      if (!admin) return res.status(503).json({ error: 'admin signer not available — upload an admin key file' });

      // v7.24 — same pattern as the faucet deploy: Elyon Chain doesn't support
      // EIP-1559, and Nethermind sometimes answers receipt lookups with
      // "Pruned history unavailable" right after mining. Sign + broadcast +
      // poll receipts manually so the deploy survives both quirks.
      const gasPrice = String(await web3.eth.getGasPrice());
      const chainId  = Number(await web3.eth.getChainId());
      const dep      = new web3.eth.Contract(LB.abi);
      const data     = dep.deploy({ data: LB.bytecode }).encodeABI();
      const nonce    = await web3.eth.getTransactionCount(admin.address, 'pending');
      const signed   = await admin.signTransaction({
        data, gas: '3500000', gasPrice, nonce: String(nonce), chainId, type: '0x0',
      });
      const txHash = signed.transactionHash;
      try {
        const provider = web3.currentProvider || web3.eth.currentProvider;
        const rpcUrl = (provider && (provider.host || provider.clientUrl || provider.url)) || 'http://127.0.0.1:8545';
        await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [signed.rawTransaction] }),
        });
      } catch {}
      const deadline = Date.now() + 180_000;
      let receipt = null;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const rec = await web3.eth.getTransactionReceipt(txHash);
          if (rec && rec.blockNumber) { receipt = rec; break; }
        } catch (e) {
          const m = String(e?.message || '');
          if (!/Pruned history|not found|null/i.test(m)) throw e;
        }
      }
      if (!receipt) throw new Error('tx confirmation timeout for ' + txHash);
      const contractAddress = receipt.contractAddress;
      if (!contractAddress) throw new Error('deploy receipt missing contractAddress');

      const ns = { ...s, contractAddress, deployedAt: new Date().toISOString(), deployedBy: admin.address };
      saveState(ns);
      res.json({ success: true, address: contractAddress });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/lb/admin/coefficients', requireAuth, async (req, res) => {
    try {
      const s = loadState(); if (!s.contractAddress) return res.status(503).json({ error: 'not deployed' });
      const admin = getAdminWallet(); if (!admin) return res.status(503).json({ error: 'admin signer not available' });
      const c = inst(s.contractAddress);
      const b = req.body || {};
      const struct = [
        String(b.txCountWeight      || 0),
        String(b.txVolumeWeight     || 0),
        String(b.ownersStakedWeight || 0),
        String(b.uptimeWeight       || 0),
        String(b.stakePackageWeight || 0),
        String(b.stakePackageBase   || 0),
      ];
      const data = c.methods.setCoefficients(struct).encodeABI();
      const r = await sendAdminTx(admin, s.contractAddress, data, 250_000);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  function makeRewardsHandler(method) {
    return async (req, res) => {
      try {
        const s = loadState(); if (!s.contractAddress) return res.status(503).json({ error: 'not deployed' });
        const admin = getAdminWallet(); if (!admin) return res.status(503).json({ error: 'admin signer not available' });
        const c = inst(s.contractAddress);
        const { topN, weiPerPoint } = req.body || {};
        const data = c.methods[method](String(topN || 0), String(weiPerPoint || 0)).encodeABI();
        const r = await sendAdminTx(admin, s.contractAddress, data, 150_000);
        res.json({ success: true, txHash: r.transactionHash });
      } catch (e) { res.status(500).json({ error: e.message }); }
    };
  }
  app.post('/api/lb/admin/rewards/node',  requireAuth, makeRewardsHandler('setNodeRewards'));
  app.post('/api/lb/admin/rewards/owner', requireAuth, makeRewardsHandler('setOwnerRewards'));

  function makeFundHandler(method) {
    return async (req, res) => {
      try {
        const s = loadState(); if (!s.contractAddress) return res.status(503).json({ error: 'not deployed' });
        const admin = getAdminWallet(); if (!admin) return res.status(503).json({ error: 'admin signer not available' });
        const c = inst(s.contractAddress);
        const value = String(req.body?.amountWei || '0');
        if (value === '0') return res.status(400).json({ error: 'amountWei required' });
        const data = c.methods[method]().encodeABI();
        const r = await sendAdminTx(admin, s.contractAddress, data, 150_000, value);
        res.json({ success: true, txHash: r.transactionHash });
      } catch (e) { res.status(500).json({ error: e.message }); }
    };
  }
  app.post('/api/lb/admin/fund/node',  requireAuth, makeFundHandler('fundNodePool'));
  app.post('/api/lb/admin/fund/owner', requireAuth, makeFundHandler('fundOwnerPool'));

  app.post('/api/lb/admin/uptime', requireAuth, async (req, res) => {
    try {
      const s = loadState(); if (!s.contractAddress) return res.status(503).json({ error: 'not deployed' });
      const admin = getAdminWallet(); if (!admin) return res.status(503).json({ error: 'admin signer not available' });
      const c = inst(s.contractAddress);
      const { node, month, pct } = req.body || {};
      if (!node || pct === undefined) return res.status(400).json({ error: 'node + pct required' });
      const m = String(month || (await c.methods.currentMonth().call()));
      const data = c.methods.setNodeUptime(node, m, Math.max(0, Math.min(100, parseInt(pct, 10)))).encodeABI();
      const r = await sendAdminTx(admin, s.contractAddress, data, 150_000);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/lb/admin/uptime/auto', requireAuth, async (_req, res) => {
    try {
      const s = loadState(); if (!s.contractAddress) return res.status(503).json({ error: 'not deployed' });
      const admin = getAdminWallet(); if (!admin) return res.status(503).json({ error: 'admin signer not available' });
      const c = inst(s.contractAddress);
      const m = String(await c.methods.currentMonth().call());
      const updates = [];
      for (const [addr, rec] of upHistory.entries()) {
        if (rec.samples < 5) continue;
        const pct = Math.round(100 * rec.ok / rec.samples);
        updates.push({ node: addr, pct });
        const data = c.methods.setNodeUptime(addr, m, pct).encodeABI();
        await sendAdminTx(admin, s.contractAddress, data, 150_000);
      }
      res.json({ success: true, month: m, updates });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/lb/admin/node-rpc', requireAuth, (req, res) => {
    const { node, rpc } = req.body || {};
    if (!node || !rpc) return res.status(400).json({ error: 'node + rpc required' });
    const s = loadState();
    s.nodeRpcs = s.nodeRpcs || {};
    s.nodeRpcs[node] = rpc;
    saveState(s);
    res.json({ success: true });
  });

  // ── v7.39 — operator liveness heartbeat (public). Each operator node
  // POSTs { address } every ~60 s; the admin's uptime bot samples these and
  // auto-pushes the monthly uptime % into the contract.
  app.post('/api/lb/heartbeat', (req, res) => {
    const addr = (req.body && req.body.address) || '';
    if (!recordHeartbeat(addr)) return res.status(400).json({ error: 'valid address required' });
    res.json({ ok: true });
  });
  // Read-only view of what the uptime bot currently sees (debug / status).
  app.get('/api/lb/uptime-status', (_req, res) => {
    const now = Date.now();
    const nodes = [];
    for (const [addr, rec] of upHistory.entries()) {
      nodes.push({ address: addr, samples: rec.samples, ok: rec.ok,
        pct: rec.samples ? Math.round(100 * rec.ok / rec.samples) : 0,
        lastBeatSecAgo: lastBeat.has(addr) ? Math.round((now - lastBeat.get(addr)) / 1000) : null });
    }
    res.json({ nodes });
  });

  // Auto-push the aggregated uptime % into the contract for every tracked
  // node. Called on a timer by startUptimeBot and reused by /admin/uptime/auto.
  async function pushUptime() {
    const s = loadState(); if (!s.contractAddress) return [];
    const admin = getAdminWallet(); if (!admin) return [];
    const adminAddr = (admin.address || '').toLowerCase();
    const c = inst(s.contractAddress);
    const m = String(await c.methods.currentMonth().call());
    const updates = [];
    for (const [addr, rec] of upHistory.entries()) {
      if (rec.samples < 1) continue;                 // push as soon as we have a sample
      if (addr === adminAddr) continue;              // never rank the admin
      const pct = Math.round(100 * rec.ok / rec.samples);
      try {
        const data = c.methods.setNodeUptime(addr, m, pct).encodeABI();
        await sendAdminTx(admin, s.contractAddress, data, 150_000);
        updates.push({ node: addr, pct });
      } catch (e) { console.warn('[lb-uptime] push failed for', addr, e.message); }
    }
    if (updates.length && process.env.LB_ATTR_VERBOSE === '1') console.log('[lb-uptime] pushed', JSON.stringify(updates));
    return updates;
  }

  // Hook for the chain's L2 fee distributor to push tx attribution.
  // Admin-signed so external callers can't lie about volumes.
  app.post('/api/lb/admin/record/node-tx', requireAuth, async (req, res) => {
    try {
      const s = loadState(); if (!s.contractAddress) return res.status(503).json({ error: 'not deployed' });
      const admin = getAdminWallet(); if (!admin) return res.status(503).json({ error: 'admin signer not available' });
      const c = inst(s.contractAddress);
      const { node, volumeWei } = req.body || {};
      const data = c.methods.recordNodeTx(node, String(volumeWei || 0)).encodeABI();
      const r = await sendAdminTx(admin, s.contractAddress, data, 250_000);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/lb/admin/record/owner-tx', requireAuth, async (req, res) => {
    try {
      const s = loadState(); if (!s.contractAddress) return res.status(503).json({ error: 'not deployed' });
      const admin = getAdminWallet(); if (!admin) return res.status(503).json({ error: 'admin signer not available' });
      const c = inst(s.contractAddress);
      const { owner, volumeWei } = req.body || {};
      const data = c.methods.recordOwnerTx(owner, String(volumeWei || 0)).encodeABI();
      const r = await sendAdminTx(admin, s.contractAddress, data, 250_000);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/lb/admin/record/owner-stake-through-node', requireAuth, async (req, res) => {
    try {
      const s = loadState(); if (!s.contractAddress) return res.status(503).json({ error: 'not deployed' });
      const admin = getAdminWallet(); if (!admin) return res.status(503).json({ error: 'admin signer not available' });
      const c = inst(s.contractAddress);
      const { node, owner, stakedTokensWei } = req.body || {};
      const data = c.methods.recordOwnerStakeThroughNode(node, owner, String(stakedTokensWei || 0)).encodeABI();
      const r = await sendAdminTx(admin, s.contractAddress, data, 250_000);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  startUptimeBot(pushUptime);
  startAttributionWorker({ web3, getAdminWallet, sendAdminTx, inst });
  console.log('[leaderboard] mounted (deployed:', !!loadState().contractAddress, '· uptime-bot + attribution-worker armed)');
}

/* ─── auto-attribution worker ───────────────────────────────────────
 * v7.28 — the missing piece: walks new blocks every 10 s, parses the
 * URELAY1 attestation region in block.extraData to identify which
 * operator node relayed each tx, and pushes recordNodeTx to the
 * leaderboard contract. Without this the leaderboard would forever
 * show zero txs per node even on a busy chain.
 *
 * Design choices:
 *   - On first run set lastAttrBlock = head so we don't backfill the
 *     whole chain (that would spam thousands of admin-signed writes).
 *   - Pending records are queued and drained at a rate of one tx
 *     every ~2 s, capped at MAX_QUEUE so a tx storm doesn't blow
 *     unbounded memory.
 *   - Skips entirely if leaderboard not yet deployed.
 *   - Reuses sendAdminTx (local-sign + raw-broadcast + pruned-
 *     history-tolerant receipt poll). */
const URELAY1_MARKER_HEX = Buffer.from('URELAY1').toString('hex'); // 5552454c415931 (7 bytes / 14 hex chars)
function parseURelay1Map(extraDataHex) {
  // Mirrors apos.js parseURelay1 — keeps leaderboard.js self-contained.
  // Layout after marker: 2-byte BE count, then `count` × (32 hash + 20 relayer + 65 seal) entries.
  if (!extraDataHex || typeof extraDataHex !== 'string') return new Map();
  const hex = extraDataHex.replace(/^0x/, '').toLowerCase();
  const idx = hex.indexOf(URELAY1_MARKER_HEX);
  if (idx < 0) return new Map();
  const countOff = idx + URELAY1_MARKER_HEX.length;
  if (hex.length < countOff + 4) return new Map();
  const count = parseInt(hex.slice(countOff, countOff + 4), 16);
  if (count === 0 || count > 1000) return new Map();
  const ENTRY = (32 + 20 + 65) * 2;     // 234 hex chars per entry
  const start = countOff + 4;
  const map = new Map();
  for (let i = 0; i < count; i++) {
    const o = start + i * ENTRY;
    if (hex.length < o + ENTRY) break;
    map.set('0x' + hex.slice(o, o + 64), '0x' + hex.slice(o + 64, o + 64 + 40));
  }
  return map;
}

let attrTimer = null;
function startAttributionWorker({ web3, getAdminWallet, sendAdminTx, inst }) {
  if (attrTimer) clearInterval(attrTimer);
  const TICK_MS    = 10_000;
  const DRAIN_MS   = 2_000;
  const MAX_QUEUE  = 1000;
  const queue      = [];        // [{ node, volumeWei, txHash }]
  let busy = false;
  // v7.39 — lastAttrBlock is PERSISTED in leaderboard.json. Previously it
  // lived only in memory, so every admin container restart reset it to the
  // current head and silently dropped every tx relayed before the restart
  // (the cause of the leaderboard undercounting). Now we resume from the
  // saved cursor (with a bounded catch-up so a long downtime can't trigger a
  // multi-thousand-block backfill storm).
  const MAX_BACKFILL = 5000;
  let lastAttrBlock = (() => {
    const v = Number(loadState().lastAttrBlock);
    return Number.isFinite(v) && v >= 0 ? v : -1;
  })();

  function saveAttrCursor() {
    try { const s = loadState(); s.lastAttrBlock = lastAttrBlock; saveState(s); } catch {}
  }

  // v7.53 — owner attribution. The worker previously recorded only NODE tx
  // activity, so the leaderboard's "Owners" tab was always empty. We now keep
  // a map of APPROVED token/contract address → owner, refreshed from the local
  // APOS registry API, and credit the owner (recordOwnerTx) whenever a tx
  // targets one of their approved assets.
  const DASH = 'http://127.0.0.1:' + (process.env.DASHBOARD_PORT || '3000');
  const ownerMap = new Map();   // assetAddr(lc) -> owner(lc)
  async function refreshOwnerMap() {
    try {
      for (const ep of ['/api/apos/tokens', '/api/apos/contracts']) {
        const list = await fetch(DASH + ep).then(r => r.json()).catch(() => []);
        for (const x of (Array.isArray(list) ? list : [])) {
          if (Number(x.status) !== 2) continue;  // only ACTIVE/approved assets earn
          const addr = String(x.tokenAddress || x.contractAddress || '').toLowerCase();
          const owner = String(x.owner || '').toLowerCase();
          if (/^0x[0-9a-f]{40}$/.test(addr) && /^0x[0-9a-f]{40}$/.test(owner)) ownerMap.set(addr, owner);
        }
      }
    } catch (e) { console.warn('[lb-attr] ownerMap refresh:', e.message); }
  }
  refreshOwnerMap();
  setInterval(refreshOwnerMap, 60_000);

  async function tickScan() {
    try {
      const s = loadState();
      if (!s.contractAddress) return;
      const head = Number(await web3.eth.getBlockNumber().catch(() => -1));
      if (head < 0) return;
      if (lastAttrBlock < 0) {
        // First-ever run on this volume — start at head (no full-chain backfill).
        lastAttrBlock = head;
        saveAttrCursor();
        console.log('[lb-attr] initialised at head=', head);
        return;
      }
      // Resume from the persisted cursor, but never backfill more than
      // MAX_BACKFILL blocks in one catch-up (cap protects a cold restart).
      if (head - lastAttrBlock > MAX_BACKFILL) {
        console.warn('[lb-attr] cursor', lastAttrBlock, 'is >', MAX_BACKFILL, 'behind head', head, '— fast-forwarding');
        lastAttrBlock = head - MAX_BACKFILL;
      }
      const from = lastAttrBlock + 1;
      if (from > head) return;
      const to = Math.min(head, from + 50);   // process up to 50 blocks per tick
      const lbContract = String(s.contractAddress || '').toLowerCase();
      // v7.37 — the admin / APOS-contract owner (the chain's own validator)
      // must NOT appear on the leaderboard; only operator nodes are ranked.
      const adminAddr = (getAdminWallet()?.address || '').toLowerCase();
      for (let b = from; b <= to; b++) {
        const block = await web3.eth.getBlock(b, true).catch(() => null);
        if (!block || !block.transactions || !block.transactions.length) { lastAttrBlock = b; continue; }
        const relayerMap = parseURelay1Map(block.extraData);
        // v7.29 — when no URELAY1 attestation exists for a tx (current
        // Nethermind binaries omit it from extraData), fall back to crediting
        // block.miner — the validator that actually sealed the block. Same
        // graceful-degrade pattern apos.js' fee-scan uses.
        const fallbackNode = (block.miner || '').toLowerCase();
        for (const tx of block.transactions) {
          if (!tx?.hash) continue;
          // v7.29 — skip the worker's own recordNodeTx writes. Otherwise the
          // worker records each record-tx, which is itself a tx, ad infinitum.
          if (String(tx.to || '').toLowerCase() === lbContract) continue;
          const volWei = String(BigInt(tx.value || 0));
          if (queue.length >= MAX_QUEUE) {
            console.warn('[lb-attr] queue full (' + MAX_QUEUE + ') — dropping older entries');
            queue.splice(0, queue.length - MAX_QUEUE + 1);
          }
          // v7.53 — credit the OWNER if this tx targets an approved token/contract.
          const target = String(tx.to || '').toLowerCase();
          const owner = target && ownerMap.get(target);
          if (owner && owner !== adminAddr) {
            queue.push({ kind: 'owner', owner, volumeWei: volWei, txHash: tx.hash });
          }
          // NODE attribution (relayer or sealing validator).
          const relayer = relayerMap.get(String(tx.hash).toLowerCase()) || fallbackNode;
          if (!relayer || relayer === '0x0000000000000000000000000000000000000000') continue;
          if (adminAddr && relayer.toLowerCase() === adminAddr) continue;  // never record the admin
          queue.push({ kind: 'node', node: relayer, volumeWei: volWei, txHash: tx.hash });
        }
        lastAttrBlock = b;
      }
      saveAttrCursor();   // persist progress so a restart resumes here
    } catch (e) {
      console.warn('[lb-attr] tickScan:', e.message);
    }
  }

  async function drainOne() {
    if (busy) return;
    if (!queue.length) return;
    busy = true;
    const item = queue.shift();
    try {
      const s = loadState();
      const admin = getAdminWallet();
      if (!s.contractAddress || !admin) { busy = false; return; }
      const c = inst(s.contractAddress);
      const data = item.kind === 'owner'
        ? c.methods.recordOwnerTx(item.owner, item.volumeWei).encodeABI()
        : c.methods.recordNodeTx(item.node, item.volumeWei).encodeABI();
      await sendAdminTx(admin, s.contractAddress, data, 250_000);
      if (process.env.LB_ATTR_VERBOSE === '1') {
        const who = item.kind === 'owner' ? 'owner ' + item.owner.slice(0, 10) : 'node ' + (item.node || '').slice(0, 10);
        console.log('[lb-attr] recorded', who + '… vol=', item.volumeWei, 'tx=', (item.txHash || '').slice(0, 10) + '…');
      }
    } catch (e) {
      console.warn('[lb-attr] record' + (item.kind === 'owner' ? 'OwnerTx' : 'NodeTx') + ' failed:', e.message);
    } finally { busy = false; }
  }

  attrTimer = setInterval(tickScan, TICK_MS);
  setInterval(drainOne, DRAIN_MS);
}

module.exports = { mountLeaderboard };
