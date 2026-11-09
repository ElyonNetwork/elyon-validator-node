// claim-guard.js — keeps excluded wallets off the campaign faucet (v9.17)
//
// Why this exists (2026-10-28 incident): CampaignQuests.claim() is
// permissionless, so wallets the Quest Engine had banned kept claiming 25 ELN
// a day straight through this RPC. 80–90% of all claims (40–55k a day) came
// from banned wallets; they drained the campaign hot wallet to its reserve on
// Oct 26 and then the contract itself (including users' delegated stake) on
// Oct 27, after which every claim reverted "claim: faucet empty" — for real
// users too.
//
// The Quest Engine publishes its banned wallets at an internal, token-gated
// endpoint (GET /v1/internal/claim-blocklist). This module keeps that list in
// memory, refreshes it on a timer, and refuses claim() from those wallets at
// eth_sendRawTransaction (the real gate: the signer is recovered from the raw
// tx) and at eth_estimateGas (so the wallet fails before asking to sign).
// Every other method, contract and wallet passes through untouched.
//
// Fails OPEN: no contract configured, list not loaded yet, endpoint down or a
// tx that does not parse → nothing is refused. A stale list only lets a banned
// wallet through; it never blocks someone who is not on it.
'use strict';

const { Transaction, id: keccakId } = require('ethers');

const CLAIM_SELECTOR = keccakId('claim()').slice(0, 10);   // 0x4e71d92d
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const DENY_MESSAGE = 'claim refused: this wallet is excluded from the Elyon campaign, ' +
  'so the campaign faucet is closed to it';

const lc = v => (typeof v === 'string' ? v.toLowerCase() : '');
const isClaimData = data => lc(data).startsWith(CLAIM_SELECTOR);

function createClaimGuard({
  contract, url, token, refreshMs = 120000, timeoutMs = 15000,
  fetchImpl = globalThis.fetch, log = console,
} = {}) {
  const target = lc(contract);
  const enabled = ADDR_RE.test(target) && !!url;
  let blocked = new Set();
  let loadedAt = 0, lastError = null, timer = null;
  const denied = { sendRawTransaction: 0, estimateGas: 0 };
  let deniedSinceLog = 0;

  async function refresh() {
    if (!enabled) return false;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { headers: { 'x-claim-guard-token': token || '' }, signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (!body || !Array.isArray(body.wallets)) throw new Error('response has no wallets array');
      const next = new Set();
      for (const w of body.wallets) { const a = lc(w); if (ADDR_RE.test(a)) next.add(a); }
      blocked = next;
      loadedAt = Date.now();
      lastError = null;
      return true;
    } catch (e) {
      lastError = e.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : e.message;
      log.warn(`[claim-guard] refresh failed (keeping ${blocked.size} wallets): ${lastError}`);
      return false;
    } finally { clearTimeout(t); }
  }

  // The wallet a claim() call would come from, or '' when the call is not a
  // claim() on the campaign contract (or cannot be read).
  function claimSender(method, params) {
    if (method === 'eth_sendRawTransaction') {
      const raw = params?.[0];
      if (typeof raw !== 'string') return '';
      const tx = Transaction.from(raw);            // parse only; the signer is recovered below
      if (lc(tx.to) !== target || !isClaimData(tx.data)) return '';
      return lc(tx.from);
    }
    if (method === 'eth_estimateGas') {
      const call = params?.[0];
      if (!call || lc(call.to) !== target || !isClaimData(call.data ?? call.input)) return '';
      return lc(call.from);
    }
    return '';
  }

  // null → let the call through; a string → refuse it with that message.
  function check(method, params) {
    if (!enabled || blocked.size === 0) return null;
    if (method !== 'eth_sendRawTransaction' && method !== 'eth_estimateGas') return null;
    let from;
    try { from = claimSender(method, params); } catch { return null; }
    if (!from || !blocked.has(from)) return null;
    denied[method.slice(4)] += 1;
    deniedSinceLog += 1;
    return DENY_MESSAGE;
  }

  function stats() {
    return { enabled, contract: target || null, wallets: blocked.size,
      loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null, lastError, denied: { ...denied } };
  }

  function start() {
    if (!enabled || timer) return;
    refresh().then(ok => ok && log.log(`[claim-guard] on for ${target}: ${blocked.size} excluded wallets`));
    timer = setInterval(async () => {
      await refresh();
      if (deniedSinceLog) {
        log.log(`[claim-guard] refused ${deniedSinceLog} claim call(s) from excluded wallets ` +
          `(list ${blocked.size}, totals ${JSON.stringify(denied)})`);
        deniedSinceLog = 0;
      }
    }, refreshMs);
    timer.unref?.();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, refresh, check, stats };
}

module.exports = { createClaimGuard, CLAIM_SELECTOR, DENY_MESSAGE };
