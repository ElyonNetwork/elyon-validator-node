// faucet-v2.js — NATIVE ELN faucet for Elyon Chain (testnet)
//
// A testnet faucet must dispense the chain's NATIVE gas coin (ELN) so users can
// actually pay gas and transact. It sends native ELN straight from the admin
// wallet. One claim of the role amount per wallet per 24 h.
//
// v9.16 (2026-10-19) — rebuilt after the faucet-farm incident:
//   ✓ State lives in MEMORY and is persisted with a debounced, atomic write.
//     The old code re-read + JSON.parsed the (14.5 MB) state file on EVERY
//     request inside the same single-threaded process that proxies the public
//     JSON-RPC — a ~1 req/s bot farm was enough to stall the chain's RPC.
//     Expired cooldown entries are pruned, so the file stays small forever.
//   ✓ Anti-abuse gate (faucet-guard.js): image CAPTCHA, browser proof-of-work,
//     real-client-IP quota (1 / IP / 24 h), device-fingerprint quota, automation
//     and stale-UA rejection, same-origin checks, honeypot, fail-ban, global
//     per-minute and per-day circuit breakers.
//   ✓ Wallet rules: EOA only, and a wallet already holding more ELN than the
//     faucet would send is refused.
//   ✓ Old GET /captcha + math answer flow removed (410) — scripts built for it
//     are rejected outright.
//
// Wiring:  call mountFaucet(app, ctx) from server.js once after the
// dashboard's web3/config singletons exist.

const fs   = require('fs');
const path = require('path');
const { FaucetGuard, realIp } = require('./faucet-guard.js');

const STATE_DIR  = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(STATE_DIR, 'faucet-v2.json');
const COOLDOWN_MS = parseInt(process.env.FAUCET_COOLDOWN_MS || String(24 * 60 * 60 * 1000), 10);

/* ───────────────────────────── persistent state (in memory) ───────── */
// { elnAddress, faucetAddress, deployedAt, deployedBy, native, amounts,
//   lastClaim: { addr -> ms }  (only entries inside the cooldown window),
//   guard: { ipClaims, fpClaims, bans, day } }
const S = { meta: { elnAddress: null, faucetAddress: null, deployedAt: null, deployedBy: null, native: true, amounts: null }, lastClaim: new Map(), guardBlob: null };

function loadStateOnce() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return;
  for (const k of Object.keys(S.meta)) if (raw[k] !== undefined) S.meta[k] = raw[k];
  const now = Date.now();
  let total = 0;
  for (const [addr, ms] of Object.entries(raw.lastClaim || {})) {
    total++;
    const v = Number(ms);
    if (v && now - v < COOLDOWN_MS) S.lastClaim.set(String(addr).toLowerCase(), v);
  }
  S.guardBlob = raw.guard || null;
  S.prunedOnLoad = total - S.lastClaim.size;
  // Keep one archive of a bloated legacy file (it is the full claim history).
  try {
    const st = fs.statSync(STATE_FILE);
    if (st.size > 2 * 1024 * 1024) {
      const bak = STATE_FILE + '.bak-' + new Date().toISOString().slice(0, 10);
      if (!fs.existsSync(bak)) fs.copyFileSync(STATE_FILE, bak);
      console.log(`[faucet-v2] legacy state archived to ${bak} (${st.size} bytes, ${total} wallets); kept ${S.lastClaim.size} inside the cooldown window`);
    }
  } catch {}
}

let guard = null;
let saveTimer = null, saving = false, dirty = false;
function serialize() {
  const now = Date.now();
  const lastClaim = {};
  for (const [a, v] of S.lastClaim) if (now - v < COOLDOWN_MS) lastClaim[a] = v; else S.lastClaim.delete(a);
  return JSON.stringify({ ...S.meta, lastClaim, guard: guard ? guard.exportState() : S.guardBlob, savedAt: new Date(now).toISOString() });
}
async function flush() {
  if (saving) { dirty = true; return; }
  saving = true;
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    await fs.promises.writeFile(tmp, serialize());
    await fs.promises.rename(tmp, STATE_FILE);
  } catch (e) { console.warn('[faucet-v2] saveState failed:', e.message); }
  finally { saving = false; if (dirty) { dirty = false; scheduleSave(); } }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 1500);
}
function flushSync() {
  try { fs.writeFileSync(STATE_FILE + '.tmp', serialize()); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch {}
}
process.once('SIGTERM', () => { flushSync(); });
process.once('SIGINT',  () => { flushSync(); });

/* ───────────────────────────── mount ────────────────────────────── */
function mountFaucet(app, ctx) {
  const { web3, getAdminWallet, requireAuth, getConfig, getCaptchaSecret } = ctx;

  loadStateOnce();
  guard = new FaucetGuard({
    // A fixed secret keeps challenge tokens valid across a restart; a random one
    // (default when nothing is configured) only invalidates in-flight challenges.
    secret: process.env.FAUCET_GUARD_SECRET || undefined,
    onChange: scheduleSave,
  });
  guard.importState(S.guardBlob);
  if (S.prunedOnLoad) scheduleSave();   // rewrite the slim file right away
  void getCaptchaSecret; // legacy math-captcha secret — no longer used
  console.log(`[faucet-v2] ready: ${S.lastClaim.size} wallets in cooldown, guard: 1 claim / IP / 24 h, captcha + PoW ${guard.cfg.powBits} bits`);

  const NATIVE_SYMBOL = process.env.NATIVE_SYMBOL || 'ELN';
  const isTestnet = () => ((getConfig() || {}).networkType || 'testnet').toLowerCase() === 'testnet';
  function amounts() {
    const a = S.meta.amounts || {};
    return {
      validator: String(a.validator || web3.utils.toWei('100', 'ether')),
      delegator: String(a.delegator || web3.utils.toWei('25', 'ether')),
    };
  }
  const lastClaimMs = addr => S.lastClaim.get(String(addr).toLowerCase()) || 0;
  function recordClaim(addr) { S.lastClaim.set(String(addr).toLowerCase(), Date.now()); scheduleSave(); }
  const walletStatus = (addr) => {
    const lastMs = lastClaimMs(addr), now = Math.floor(Date.now() / 1000);
    const nextSec = lastMs ? Math.floor((lastMs + COOLDOWN_MS) / 1000) : 0;
    return { lastClaimAt: lastMs ? Math.floor(lastMs / 1000) : 0, nextClaimAt: nextSec, canClaim: !lastMs || now >= nextSec, secondsUntilNextClaim: !lastMs ? 0 : Math.max(0, nextSec - now), nowServer: now };
  };
  const readGate = (req, res) => { if (guard.allowRead(req)) return true; res.status(429).json({ error: 'too many requests — slow down' }); return false; };

  // v7.27 — local-sign + raw-broadcast + receipt-poll helper (admin key is an
  // in-memory web3 account; Nethermind's unlocked-account store is never used).
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

  // ───── Public info ─────
  app.get('/api/faucet/v2/info', async (req, res) => {
    if (!readGate(req, res)) return;
    try {
      const admin = getAdminWallet();
      if (!admin) return res.json({ deployed: false });
      const { validator, delegator } = amounts();
      let balanceWei = null;
      try { balanceWei = String(await web3.eth.getBalance(admin.address)); } catch {}
      res.json({
        deployed: true, native: true,
        token:    { symbol: NATIVE_SYMBOL, native: true },
        amounts:  { validator, delegator },
        faucetWalletBalance: balanceWei,
        cooldownSec: Math.floor(COOLDOWN_MS / 1000),
        rules: { perWalletPerDay: 1, perIpPerDay: guard.cfg.ipDailyMax, captcha: true, proofOfWork: true },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ───── Per-wallet (+ per-network) status — drives the countdown timer ─────
  app.get('/api/faucet/v2/status/:addr', (req, res) => {
    if (!readGate(req, res)) return;
    const addr = req.params.addr;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return res.status(400).json({ error: 'invalid address' });
    const w = walletStatus(addr), ip = guard.ipStatus(req);
    const blocked = !w.canClaim ? 'wallet' : !ip.canClaim ? (ip.banned ? 'banned' : 'ip') : null;
    res.json({ address: addr, ...w, canClaim: !blocked, blockedBy: blocked,
      secondsUntilNextClaim: blocked === 'ip' ? ip.secondsUntilNextClaim : w.secondsUntilNextClaim,
      ip: { claimsToday: ip.claimsToday, canClaim: ip.canClaim, secondsUntilNextClaim: ip.secondsUntilNextClaim } });
  });

  // ───── Legacy math captcha — retired ─────
  app.get('/api/faucet/v2/captcha', (_req, res) => {
    res.status(410).json({ error: 'This faucet flow was retired. Reload the faucet page and complete the picture verification.' });
  });

  // ───── Step 1: challenge (image captcha + proof-of-work), bound to IP + wallet ─────
  app.post('/api/faucet/v2/challenge', (req, res) => {
    if (!isTestnet()) return res.status(400).json({ error: 'faucet only enabled on testnet' });
    const r = guard.issueChallenge(req, (req.body || {}).address);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.message, reason: r.reason, retryAt: r.retryAt });
    res.json(r);
  });

  // ───── Step 2: claim — sends native ELN from the admin wallet ─────
  app.post('/api/faucet/v2/claim', async (req, res) => {
    if (!isTestnet()) return res.status(400).json({ error: 'faucet only enabled on testnet' });
    const body = req.body || {};
    const g = guard.precheck(req, body);
    if (!g.ok) {
      console.log(`[faucet-guard] reject ${g.reason} ip=${realIp(req)} addr=${String(body.address || '').slice(0, 12)}`);
      return res.status(g.status || 400).json({ error: g.message, reason: g.reason, retryAt: g.retryAt, secondsUntilNextClaim: g.secondsUntilNextClaim });
    }
    try {
      const address = body.address;
      const roleNum = body.role === 'validator' || body.role === 0 ? 0 : 1;
      // Wallet cooldown (the ONLY wallet-level gate before v9.16, still enforced).
      const w = walletStatus(address);
      if (!w.canClaim) { guard.abort(g); return res.status(429).json({ error: 'This wallet already claimed in the last 24 hours.', reason: 'wallet_cooldown', secondsUntilNextClaim: w.secondsUntilNextClaim }); }
      const { validator, delegator } = amounts();
      const amountWei = roleNum === 0 ? validator : delegator;
      // On-chain wallet rules: must be a plain account, and not already funded beyond what we give.
      try {
        const code = await web3.eth.getCode(address);
        if (code && code !== '0x' && code !== '0x0') { guard.abort(g); return res.status(400).json({ error: 'Contract addresses cannot claim — use a normal wallet address.', reason: 'contract_wallet' }); }
        const bal = BigInt(String(await web3.eth.getBalance(address)));
        if (bal >= BigInt(amountWei) * 2n) { guard.abort(g); return res.status(400).json({ error: 'This wallet already holds enough ELN for gas — the faucet is for empty wallets.', reason: 'already_funded' }); }
      } catch (e) { guard.abort(g); return res.status(503).json({ error: 'The node is busy — please try again in a moment.' }); }
      const admin = getAdminWallet();
      if (!admin) { guard.abort(g); return res.status(503).json({ error: 'admin signer not available' }); }

      const receipt = await sendAdminTx(admin, address, '0x', 21000, amountWei);
      recordClaim(address);
      guard.commit(g);
      console.log(`[faucet-v2] sent ${amountWei} wei to ${address} ip=${g.ipKey} tx=${receipt.transactionHash}`);
      res.json({ success: true, txHash: receipt.transactionHash, amount: String(amountWei), symbol: NATIVE_SYMBOL, native: true, role: roleNum === 0 ? 'validator' : 'delegator' });
    } catch (e) {
      guard.abort(g);
      const msg = e.message || String(e);
      const friendly = /insufficient funds/i.test(msg) ? 'faucet wallet is temporarily out of ELN — please notify the admin' : msg;
      res.status(500).json({ error: friendly });
    }
  });

  // ───── Admin: deploy (no-op for the native faucet — the admin wallet IS the faucet) ─────
  app.post('/api/faucet/v2/admin/deploy', requireAuth, async (_req, res) => {
    if (!isTestnet()) return res.status(400).json({ error: 'faucet is disabled on mainnet' });
    const admin = getAdminWallet();
    if (!admin) return res.status(503).json({ error: 'admin signer not available' });
    S.meta.native = true; S.meta.deployedAt = S.meta.deployedAt || new Date().toISOString(); S.meta.deployedBy = admin.address;
    scheduleSave();
    res.json({ success: true, native: true, faucetWallet: admin.address });
  });

  // ───── Admin: set per-role amounts (native ELN, wei strings) ─────
  app.post('/api/faucet/v2/admin/amounts', requireAuth, async (req, res) => {
    try {
      if (!isTestnet()) return res.status(400).json({ error: 'faucet is disabled on mainnet' });
      const { validator, delegator } = req.body || {};
      if (!validator || !delegator) return res.status(400).json({ error: 'validator + delegator (wei strings) required' });
      S.meta.amounts = { validator: String(validator), delegator: String(delegator) };
      scheduleSave();
      res.json({ success: true, amounts: S.meta.amounts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ───── Admin: guard statistics + unban ─────
  app.get('/api/faucet/v2/admin/guard', requireAuth, (_req, res) => {
    res.json({ walletsInCooldown: S.lastClaim.size, ...guard.stats() });
  });
  app.post('/api/faucet/v2/admin/guard/unban', requireAuth, (req, res) => {
    const ip = String((req.body || {}).ip || '');
    if (!ip) return res.status(400).json({ error: 'ip required' });
    res.json({ success: true, removed: guard.unban(ip) });
  });
}

module.exports = { mountFaucet };
