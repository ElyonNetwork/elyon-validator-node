// faucet-guard.js — anti-abuse layer for the native testnet faucet (v9.16)
//
// Why this exists (2026-10-19 incident): a farm of ~4,000 rotating IPs with one
// hard-coded browser signature drained the dashboard faucet ~12k×/day. The old
// gate was a math question + a per-wallet cooldown; the per-IP limit was off and
// keyed on the proxy's address anyway. Worse, every faucet call re-parsed a
// 14.5 MB JSON file inside the SAME single-threaded process that proxies the
// public JSON-RPC, so the farm also stalled the chain's RPC for real users.
//
// This module is dependency-free (node:crypto only) and keeps everything in
// memory; faucet-v2.js persists the small `guard` state blob alongside its own.
//
// Layers, all enforced server-side (a client can skip none of them):
//   1. Real client IP (CF-Connecting-IP → X-Real-IP → X-Forwarded-For → socket),
//      bucketed /64 for IPv6, with a per-IP challenge budget and a fail-ban.
//   2. Image CAPTCHA — "select all the <icon>" 3×3 SVG grid (same paradigm as the
//      quest site's Sentinel). The answer lives only as an HMAC inside the
//      signed challenge token, never in the DOM. One-shot, 5-minute TTL, and it
//      cannot be solved faster than a human could (minimum solve time).
//   3. Browser proof-of-work (hashcash, SHA-256, adaptive 18–24 bits) — makes
//      every claim cost real CPU seconds, so mass farming stops being free.
//   4. Browser sanity — automation user agents, stale spoofed Chrome versions,
//      missing same-origin fetch headers and a honeypot field are rejected.
//   5. Hard quotas — 1 claim / wallet / 24 h, 1 claim / IP / 24 h, N / device
//      fingerprint / 24 h, a global per-minute and per-day circuit breaker.
//   6. Wallet rules (checked by faucet-v2 with web3): EOA only, and not already
//      holding more ELN than the faucet would give.
'use strict';

const crypto = require('crypto');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const nowMs = () => Date.now();
const ri = n => crypto.randomInt(n);
const rf = (lo, hi) => lo + Math.random() * (hi - lo); // cosmetic jitter only

const envInt = (k, d) => { const v = parseInt(process.env[k] || '', 10); return Number.isFinite(v) ? v : d; };

const DEFAULTS = Object.freeze({
  cooldownMs:          envInt('FAUCET_COOLDOWN_MS', DAY),
  ipDailyMax:          envInt('FAUCET_IP_DAILY_MAX', 1),          // claims per IP (/64) per 24 h
  fpDailyMax:          envInt('FAUCET_FP_DAILY_MAX', 2),          // claims per device fingerprint per 24 h
  globalDailyMax:      envInt('FAUCET_GLOBAL_DAILY_MAX', 3000),   // circuit breaker
  globalPerMinuteMax:  envInt('FAUCET_GLOBAL_PER_MINUTE_MAX', 20),
  challengeTtlSec:     envInt('FAUCET_CHALLENGE_TTL_SEC', 300),
  minSolveSec:         envInt('FAUCET_MIN_SOLVE_SEC', 4),
  powBits:             envInt('FAUCET_POW_BITS', 18),
  powMaxBits:          envInt('FAUCET_POW_MAX_BITS', 24),
  challengesPerIpHour: envInt('FAUCET_CHALLENGES_PER_IP_HOUR', 12),
  wrongCaptchaMax:     envInt('FAUCET_WRONG_CAPTCHA_MAX', 3),
  wrongWindowMs:       envInt('FAUCET_WRONG_WINDOW_MS', 15 * 60 * 1000),
  banMs:               envInt('FAUCET_BAN_MS', HOUR),
  minChromeMajor:      envInt('FAUCET_MIN_CHROME', 130),
  minSamsungChrome:    envInt('FAUCET_MIN_SAMSUNG_CHROME', 118),
  readPerMinute:       envInt('FAUCET_READ_PER_MINUTE', 60),      // /info + /status per IP
});

/* ───────────────────────────── client IP ─────────────────────────── */
function realIp(req) {
  const h = req.headers || {};
  const cf = h['cf-connecting-ip'];
  if (cf) return String(cf).trim().replace(/^::ffff:/, '');
  const xr = h['x-real-ip'];
  if (xr) return String(xr).trim().replace(/^::ffff:/, '');
  const xff = h['x-forwarded-for'];
  if (xff) { const first = String(xff).split(',')[0].trim(); if (first) return first.replace(/^::ffff:/, ''); }
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
// IPv4 → exact address; IPv6 → /64 (one household / one mobile session).
function ipKey(ip) {
  if (!ip) return '';
  if (ip.includes(':')) {
    const full = expandIpv6(ip);
    return full ? full.split(':').slice(0, 4).join(':') + '::/64' : ip;
  }
  return ip;
}
function expandIpv6(ip) {
  try {
    const [head, tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
    if (ip.includes('::')) { const fill = 8 - h.length - t.length; if (fill < 0) return null; return [...h, ...Array(fill).fill('0'), ...t].map(x => x.padStart(4, '0')).join(':'); }
    return h.length === 8 ? h.map(x => x.padStart(4, '0')).join(':') : null;
  } catch { return null; }
}

/* ───────────────────────────── signed tokens ─────────────────────── */
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function sign(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + mac;
}
function verify(token, secret) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const i = token.indexOf('.');
  if (i <= 0) return null;
  const body = token.slice(0, i), mac = token.slice(i + 1);
  const want = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(unb64u(body).toString('utf8')); } catch { return null; }
}
const shortHash = (s, n = 24) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);

/* ───────────────────────────── image CAPTCHA ─────────────────────── */
const INK = ['#7cc4ff', '#8ef0c8', '#ffd27c', '#ff9ab0', '#c9b6ff', '#8affd1', '#ffc0f0', '#a8d0ff', '#b7ff9a'];
function wrap(inner, cx, cy, rotDeg) { return `<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rotDeg.toFixed(1)})">${inner}</g>`; }
function starPts(R, r) {
  const p = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 === 0 ? R : r; p.push([(rad * Math.cos(a)).toFixed(1), (rad * Math.sin(a)).toFixed(1)]); }
  return p.map(q => q.join(',')).join(' ');
}
const ICONS = {
  star:    { label: 'stars',           draw: (cx, cy, R, c, r) => wrap(`<polygon points="${starPts(R, R * 0.42)}" fill="${c}"/>`, cx, cy, r) },
  heart:   { label: 'hearts',          draw: (cx, cy, R, c, r) => { const s = R / 15; return wrap(`<path d="M0,${(-5 * s).toFixed(1)} C${(-7 * s).toFixed(1)},${(-15 * s).toFixed(1)} ${(-17 * s).toFixed(1)},${(-4 * s).toFixed(1)} 0,${(12 * s).toFixed(1)} C${(17 * s).toFixed(1)},${(-4 * s).toFixed(1)} ${(7 * s).toFixed(1)},${(-15 * s).toFixed(1)} 0,${(-5 * s).toFixed(1)} Z" fill="${c}"/>`, cx, cy, r); } },
  triangle:{ label: 'triangles',       draw: (cx, cy, R, c, r) => wrap(`<polygon points="0,${(-R).toFixed(1)} ${(R * 0.92).toFixed(1)},${(R * 0.72).toFixed(1)} ${(-R * 0.92).toFixed(1)},${(R * 0.72).toFixed(1)}" fill="${c}"/>`, cx, cy, r) },
  circle:  { label: 'circles',         draw: (cx, cy, R, c) => `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(R * 0.92).toFixed(1)}" fill="${c}"/>` },
  plus:    { label: 'plus signs',      draw: (cx, cy, R, c, r) => { const t = R * 0.34; return wrap(`<path d="M${(-t).toFixed(1)},${(-R).toFixed(1)} h${(2 * t).toFixed(1)} v${(R - t).toFixed(1)} h${(R - t).toFixed(1)} v${(2 * t).toFixed(1)} h${(-(R - t)).toFixed(1)} v${(R - t).toFixed(1)} h${(-2 * t).toFixed(1)} v${(-(R - t)).toFixed(1)} h${(-(R - t)).toFixed(1)} v${(-2 * t).toFixed(1)} h${(R - t).toFixed(1)} Z" fill="${c}"/>`, cx, cy, r); } },
  moon:    { label: 'crescent moons',  draw: (cx, cy, R, c, r) => wrap(`<path d="M${(R * 0.55).toFixed(1)},${(-R * 0.85).toFixed(1)} A${R.toFixed(1)},${R.toFixed(1)} 0 1 0 ${(R * 0.55).toFixed(1)},${(R * 0.85).toFixed(1)} A${(R * 0.8).toFixed(1)},${(R * 0.8).toFixed(1)} 0 1 1 ${(R * 0.55).toFixed(1)},${(-R * 0.85).toFixed(1)} Z" fill="${c}"/>`, cx, cy, r) },
  bolt:    { label: 'lightning bolts', draw: (cx, cy, R, c, r) => wrap(`<polygon points="${(R * 0.2).toFixed(1)},${(-R).toFixed(1)} ${(-R * 0.55).toFixed(1)},${(R * 0.15).toFixed(1)} ${(-R * 0.05).toFixed(1)},${(R * 0.15).toFixed(1)} ${(-R * 0.2).toFixed(1)},${R.toFixed(1)} ${(R * 0.55).toFixed(1)},${(-R * 0.2).toFixed(1)} ${(R * 0.05).toFixed(1)},${(-R * 0.2).toFixed(1)}" fill="${c}"/>`, cx, cy, r) },
  drop:    { label: 'droplets',        draw: (cx, cy, R, c, r) => wrap(`<path d="M0,${(-R).toFixed(1)} C${(R * 0.85).toFixed(1)},${(-R * 0.1).toFixed(1)} ${(R * 0.72).toFixed(1)},${(R * 0.9).toFixed(1)} 0,${(R * 0.9).toFixed(1)} C${(-R * 0.72).toFixed(1)},${(R * 0.9).toFixed(1)} ${(-R * 0.85).toFixed(1)},${(-R * 0.1).toFixed(1)} 0,${(-R).toFixed(1)} Z" fill="${c}"/>`, cx, cy, r) },
  hexagon: { label: 'hexagons',        draw: (cx, cy, R, c, r) => { const p = []; for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + i * Math.PI / 3; p.push(`${(R * Math.cos(a)).toFixed(1)},${(R * Math.sin(a)).toFixed(1)}`); } return wrap(`<polygon points="${p.join(' ')}" fill="${c}"/>`, cx, cy, r); } },
  arrow:   { label: 'right arrows',    draw: (cx, cy, R, c, r) => wrap(`<path d="M${(-R * 0.9).toFixed(1)},${(-R * 0.35).toFixed(1)} h${(R * 0.9).toFixed(1)} v${(-R * 0.4).toFixed(1)} l${(R * 0.9).toFixed(1)},${(R * 0.75).toFixed(1)} l${(-R * 0.9).toFixed(1)},${(R * 0.75).toFixed(1)} v${(-R * 0.4).toFixed(1)} h${(-R * 0.9).toFixed(1)} Z" fill="${c}"/>`, cx, cy, r) },
};
const ICON_KEYS = Object.keys(ICONS);

function renderGrid(cells) {
  const S = 300, C = 100, pad = 4;
  let noise = '';
  for (let i = 0; i < 26; i++) { const x1 = rf(0, S), y1 = rf(0, S); noise += `<line x1="${x1.toFixed(0)}" y1="${y1.toFixed(0)}" x2="${(x1 + rf(-40, 40)).toFixed(0)}" y2="${(y1 + rf(-40, 40)).toFixed(0)}" stroke="#20406e" stroke-width="1" opacity="${rf(0.12, 0.3).toFixed(2)}"/>`; }
  for (let i = 0; i < 40; i++) noise += `<circle cx="${rf(0, S).toFixed(0)}" cy="${rf(0, S).toFixed(0)}" r="${rf(0.6, 1.8).toFixed(1)}" fill="#2a4e82" opacity="${rf(0.1, 0.28).toFixed(2)}"/>`;
  let tiles = '';
  cells.forEach((key, idx) => {
    const x = (idx % 3) * C, y = Math.floor(idx / 3) * C;
    tiles += `<rect x="${x + pad}" y="${y + pad}" width="${C - pad * 2}" height="${C - pad * 2}" rx="11" fill="#0e2038" stroke="#1d3a63" stroke-width="1"/>`;
    tiles += ICONS[key].draw(x + C / 2 + rf(-8, 8), y + C / 2 + rf(-8, 8), rf(26, 33), INK[ri(INK.length)], rf(-20, 20));
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="100%" height="100%" role="img" aria-label="verification picture"><rect width="${S}" height="${S}" fill="#0b1830"/>${noise}${tiles}</svg>`;
}
// Returns { label, svg, answer:[cell indexes] } — the answer must never leave the server in clear.
function newCaptcha() {
  const target = ICON_KEYS[ri(ICON_KEYS.length)];
  const decoys = ICON_KEYS.filter(k => k !== target);
  const k = 2 + ri(3);
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = order.length - 1; i > 0; i--) { const j = ri(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const answer = order.slice(0, k).sort((a, b) => a - b);
  const set = new Set(answer);
  const cells = []; for (let i = 0; i < 9; i++) cells.push(set.has(i) ? target : decoys[ri(decoys.length)]);
  return { label: ICONS[target].label, svg: renderGrid(cells), answer };
}
function normalizeCells(sel) {
  const arr = Array.isArray(sel) ? sel.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 9) : [];
  return [...new Set(arr)].sort((a, b) => a - b);
}

/* ───────────────────────────── proof of work ─────────────────────── */
function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) { if (byte === 0) { n += 8; continue; } n += Math.clz32(byte) - 24; break; }
  return n;
}
function powHash(seed, addr, nonce) { return crypto.createHash('sha256').update(`${seed}:${String(addr).toLowerCase()}:${nonce}`).digest(); }
function powVerify(seed, addr, nonce, bits) {
  if (typeof nonce !== 'string' && typeof nonce !== 'number') return false;
  const s = String(nonce); if (s.length > 32 || !/^[0-9a-zA-Z_-]+$/.test(s)) return false;
  return leadingZeroBits(powHash(seed, addr, s)) >= bits;
}
// Only used by tests / tooling — solves a challenge the way the browser does.
function powSolve(seed, addr, bits, maxIter = 50_000_000) {
  for (let n = 0; n < maxIter; n++) { if (leadingZeroBits(powHash(seed, addr, String(n))) >= bits) return String(n); }
  return null;
}

/* ───────────────────────────── browser sanity ────────────────────── */
const AUTOMATION_UA = /python|requests|urllib|aiohttp|httpx|curl\/|wget|go-http-client|okhttp|java\/|apache-httpclient|axios|node-fetch|undici|got\/|scrapy|headless|phantomjs|puppeteer|playwright|selenium|webdriver|electron|bot\b|spider|crawler|postman|insomnia|libwww|lwp|perl|ruby|php\//i;
function uaVerdict(ua, cfg = DEFAULTS) {
  const s = String(ua || '').trim();
  if (!s || s.length < 20) return { ok: false, reason: 'ua_missing' };
  if (AUTOMATION_UA.test(s)) return { ok: false, reason: 'ua_automation' };
  if (!/Mozilla\/5\.0/.test(s)) return { ok: false, reason: 'ua_shape' };
  const chrome = /(?:Chrome|CriOS)\/(\d+)/.exec(s);
  if (chrome) {
    const major = parseInt(chrome[1], 10);
    const samsung = /SamsungBrowser\//.test(s);
    const min = samsung ? cfg.minSamsungChrome : cfg.minChromeMajor;
    if (major < min) return { ok: false, reason: 'ua_stale', major };
  }
  return { ok: true };
}
// A browser POSTing JSON from the faucet page always sends these. Scripts rarely bother.
function originVerdict(req) {
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase();
  const origin = String(h.origin || '').trim().toLowerCase();
  const referer = String(h.referer || '').trim().toLowerCase();
  const matches = u => { try { return new URL(u).host.toLowerCase() === host; } catch { return false; } };
  if (origin && origin !== 'null') { if (!matches(origin)) return { ok: false, reason: 'origin_mismatch' }; }
  else if (referer) { if (!matches(referer)) return { ok: false, reason: 'referer_mismatch' }; }
  else return { ok: false, reason: 'origin_missing' };
  const mode = String(h['sec-fetch-mode'] || '').toLowerCase();
  const site = String(h['sec-fetch-site'] || '').toLowerCase();
  if (mode && !/^(cors|same-origin)$/.test(mode)) return { ok: false, reason: 'fetch_mode' };
  if (site && site !== 'same-origin') return { ok: false, reason: 'fetch_site' };
  const ct = String(h['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) return { ok: false, reason: 'content_type' };
  return { ok: true };
}
// Stable device fingerprint: server-visible headers + a few client-reported facts.
function fingerprint(req, fp) {
  const h = req.headers || {};
  const f = fp && typeof fp === 'object' ? fp : {};
  const parts = [h['user-agent'] || '', h['accept-language'] || '', String(f.tz || ''), String(f.lang || ''), String(f.scr || ''),
    String(f.hc || ''), String(f.dm || ''), String(f.plat || ''), String(f.cv || '')];
  return shortHash(parts.join('|'), 32);
}

/* ───────────────────────────── the guard ─────────────────────────── */
class FaucetGuard {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...(opts.config || {}) };
    this.secret = opts.secret || process.env.FAUCET_GUARD_SECRET || crypto.randomBytes(32).toString('hex');
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    this.log = typeof opts.log === 'function' ? opts.log : (...a) => console.log('[faucet-guard]', ...a);
    // volatile (not persisted)
    this.usedTokens = new Map();     // cid -> expMs
    this.challenges = new Map();     // ipKey -> [ms]
    this.wrong = new Map();          // ipKey -> [ms]
    this.reads = new Map();          // ipKey -> [ms]
    this.inFlight = new Set();       // 'a:'+addr / 'i:'+ipKey
    this.minute = new Map();         // minuteIndex -> count
    this.rejects = {};               // reason -> count (since boot)
    this.accepted = 0;
    // persisted (small)
    this.ipClaims = new Map();       // ipKey -> [ms]
    this.fpClaims = new Map();       // fp -> [ms]
    this.bans = new Map();           // ipKey -> untilMs
    this.day = { d: this._dayKey(), n: 0 };
    this._sweep = setInterval(() => this.sweep(), 60 * 1000);
    if (this._sweep.unref) this._sweep.unref();
  }
  _dayKey(t = nowMs()) { return new Date(t).toISOString().slice(0, 10); }
  _push(map, key, t = nowMs(), windowMs = DAY) {
    const arr = (map.get(key) || []).filter(x => t - x < windowMs); arr.push(t); map.set(key, arr); return arr.length;
  }
  _count(map, key, windowMs = DAY, t = nowMs()) { return (map.get(key) || []).filter(x => t - x < windowMs).length; }
  _reject(reason, status, message, extra) { this.rejects[reason] = (this.rejects[reason] || 0) + 1; return { ok: false, reason, status, message, ...(extra || {}) }; }

  /* persistence */
  exportState() {
    const o = { ipClaims: {}, fpClaims: {}, bans: {}, day: this.day };
    for (const [k, v] of this.ipClaims) if (v.length) o.ipClaims[k] = v;
    for (const [k, v] of this.fpClaims) if (v.length) o.fpClaims[k] = v;
    for (const [k, v] of this.bans) if (v > nowMs()) o.bans[k] = v;
    return o;
  }
  importState(o) {
    if (!o || typeof o !== 'object') return;
    const t = nowMs();
    for (const [k, v] of Object.entries(o.ipClaims || {})) { const a = (v || []).map(Number).filter(x => t - x < this.cfg.cooldownMs); if (a.length) this.ipClaims.set(k, a); }
    for (const [k, v] of Object.entries(o.fpClaims || {})) { const a = (v || []).map(Number).filter(x => t - x < this.cfg.cooldownMs); if (a.length) this.fpClaims.set(k, a); }
    for (const [k, v] of Object.entries(o.bans || {})) if (Number(v) > t) this.bans.set(k, Number(v));
    if (o.day && o.day.d === this._dayKey()) this.day = { d: o.day.d, n: Number(o.day.n) || 0 };
  }
  sweep() {
    const t = nowMs();
    for (const [k, v] of this.usedTokens) if (v < t) this.usedTokens.delete(k);
    for (const [k, v] of this.bans) if (v < t) this.bans.delete(k);
    for (const m of [this.challenges, this.wrong, this.reads]) for (const [k, v] of m) { const a = v.filter(x => t - x < HOUR); if (a.length) m.set(k, a); else m.delete(k); }
    for (const m of [this.ipClaims, this.fpClaims]) for (const [k, v] of m) { const a = v.filter(x => t - x < this.cfg.cooldownMs); if (a.length) m.set(k, a); else m.delete(k); }
    const cur = Math.floor(t / 60000); for (const k of this.minute.keys()) if (k < cur - 2) this.minute.delete(k);
  }

  /* cheap read endpoints (/info, /status) */
  allowRead(req) {
    const key = ipKey(realIp(req)); if (!key) return true;
    return this._push(this.reads, key, nowMs(), 60 * 1000) <= this.cfg.readPerMinute;
  }
  ipStatus(req) {
    const key = ipKey(realIp(req)); const t = nowMs();
    const times = (this.ipClaims.get(key) || []).filter(x => t - x < this.cfg.cooldownMs);
    const banned = (this.bans.get(key) || 0) > t;
    const next = times.length >= this.cfg.ipDailyMax ? Math.min(...times) + this.cfg.cooldownMs : 0;
    return { ipKey: key, claimsToday: times.length, canClaim: !banned && times.length < this.cfg.ipDailyMax, secondsUntilNextClaim: next ? Math.max(0, Math.ceil((next - t) / 1000)) : 0, banned };
  }

  /* adaptive PoW difficulty: more challenges from one IP, or a busy faucet → harder */
  powBitsFor(key) {
    const t = nowMs();
    let bits = this.cfg.powBits;
    const recent = this._count(this.challenges, key, HOUR, t);
    if (recent > 2) bits += 2;
    if (recent > 6) bits += 2;
    const cur = Math.floor(t / 60000);
    const perMin = (this.minute.get(cur) || 0) + (this.minute.get(cur - 1) || 0);
    if (perMin >= this.cfg.globalPerMinuteMax) bits += 2;
    return Math.min(bits, this.cfg.powMaxBits);
  }

  /* step 1 — issue a challenge (captcha + pow) bound to ip + wallet */
  issueChallenge(req, address) {
    const t = nowMs();
    const ip = realIp(req), key = ipKey(ip);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) return this._reject('bad_address', 400, 'Enter a valid wallet address (0x…).');
    if ((this.bans.get(key) || 0) > t) return this._reject('banned', 429, 'Too many failed attempts from your network — try again in an hour.', { retryAt: this.bans.get(key) });
    const ua = uaVerdict(req.headers['user-agent'], this.cfg);
    if (!ua.ok) return this._reject(ua.reason, 403, ua.reason === 'ua_stale' ? 'Your browser reports an outdated version — please update it and try again.' : 'Automated clients are not allowed. Please use a normal, up-to-date browser.');
    if (this._push(this.challenges, key, t, HOUR) > this.cfg.challengesPerIpHour) return this._reject('challenge_rate', 429, 'Too many verification requests from your network — slow down.');
    const cap = newCaptcha();
    const cid = crypto.randomBytes(9).toString('base64url');
    const bits = this.powBitsFor(key);
    const seed = crypto.randomBytes(8).toString('hex');
    const exp = t + this.cfg.challengeTtlSec * 1000;
    const token = sign({ t: 'fc', cid, ip: key, a: address.toLowerCase(), iat: t, exp, ah: shortHash(cid + '|' + cap.answer.join(','), 24), pb: bits, ps: seed }, this.secret);
    return { ok: true, token, captcha: { label: cap.label, svg: cap.svg, cols: 3, rows: 3 }, pow: { seed, bits }, ttlSec: this.cfg.challengeTtlSec, minSolveSec: this.cfg.minSolveSec };
  }

  /* step 2 — validate a claim (everything but the on-chain checks) */
  precheck(req, body) {
    const t = nowMs();
    const ip = realIp(req), key = ipKey(ip);
    const b = body && typeof body === 'object' ? body : {};
    const address = String(b.address || '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return this._reject('bad_address', 400, 'Enter a valid wallet address (0x…).');
    const addr = address.toLowerCase();
    if ((this.bans.get(key) || 0) > t) return this._reject('banned', 429, 'Too many failed attempts from your network — try again in an hour.', { retryAt: this.bans.get(key) });
    if (b.website) return this._reject('honeypot', 400, 'Invalid request.');
    const ua = uaVerdict(req.headers['user-agent'], this.cfg);
    if (!ua.ok) return this._reject(ua.reason, 403, ua.reason === 'ua_stale' ? 'Your browser reports an outdated version — please update it and try again.' : 'Automated clients are not allowed. Please use a normal, up-to-date browser.');
    const org = originVerdict(req);
    if (!org.ok) return this._reject(org.reason, 403, 'Requests must come from the faucet page in a browser.');
    const p = verify(b.token, this.secret);
    if (!p || p.t !== 'fc' || !p.cid) return this._reject('token_invalid', 400, 'Verification expired or invalid — please solve the verification again.');
    if (p.exp < t) return this._reject('token_expired', 400, 'Verification expired — please solve it again.');
    if (p.ip !== key) return this._reject('token_ip', 403, 'Your network changed during verification — please solve it again.');
    if (p.a !== addr) return this._reject('token_addr', 400, 'The wallet address changed — please solve the verification again.');
    if (t - p.iat < this.cfg.minSolveSec * 1000) return this._reject('too_fast', 400, 'That was too fast — please solve the verification again.');
    if (this.usedTokens.has(p.cid)) return this._reject('token_replay', 400, 'This verification was already used — please solve a new one.');
    // captcha
    const sel = normalizeCells(b.cells);
    const got = shortHash(p.cid + '|' + sel.join(','), 24);
    const A = Buffer.from(got), B = Buffer.from(String(p.ah));
    if (sel.length === 0 || A.length !== B.length || !crypto.timingSafeEqual(A, B)) {
      this.usedTokens.set(p.cid, p.exp);                     // one attempt per picture
      const n = this._push(this.wrong, key, t, this.cfg.wrongWindowMs);
      if (n >= this.cfg.wrongCaptchaMax) { this.bans.set(key, t + this.cfg.banMs); this.onChange(); return this._reject('captcha_ban', 429, 'Too many wrong answers — try again in an hour.', { retryAt: t + this.cfg.banMs }); }
      return this._reject('captcha_wrong', 400, 'Wrong selection — please try the new picture.');
    }
    // proof of work
    if (!powVerify(p.ps, addr, b.powNonce, p.pb)) { this.usedTokens.set(p.cid, p.exp); return this._reject('pow_invalid', 400, 'Browser verification failed — please reload the page and try again.'); }
    // quotas
    if (this.inFlight.has('a:' + addr) || this.inFlight.has('i:' + key)) return this._reject('in_flight', 429, 'A claim is already in progress — please wait.');
    const ipTimes = (this.ipClaims.get(key) || []).filter(x => t - x < this.cfg.cooldownMs);
    if (ipTimes.length >= this.cfg.ipDailyMax) return this._reject('ip_cooldown', 429, 'This network (IP) already claimed in the last 24 hours — one claim per IP per day.', { secondsUntilNextClaim: Math.ceil((Math.min(...ipTimes) + this.cfg.cooldownMs - t) / 1000) });
    const fp = fingerprint(req, b.fp);
    const fpTimes = (this.fpClaims.get(fp) || []).filter(x => t - x < this.cfg.cooldownMs);
    if (fpTimes.length >= this.cfg.fpDailyMax) return this._reject('device_cooldown', 429, 'This device already claimed today — come back tomorrow.', { secondsUntilNextClaim: Math.ceil((Math.min(...fpTimes) + this.cfg.cooldownMs - t) / 1000) });
    if (this.day.d !== this._dayKey(t)) this.day = { d: this._dayKey(t), n: 0 };
    if (this.day.n >= this.cfg.globalDailyMax) return this._reject('global_daily', 503, 'The faucet reached its daily limit — please come back tomorrow.');
    const cur = Math.floor(t / 60000);
    if ((this.minute.get(cur) || 0) >= this.cfg.globalPerMinuteMax) return this._reject('global_minute', 503, 'The faucet is busy right now — please try again in a minute.');
    // reserve: the token is spent and the wallet/IP are locked until commit/abort
    this.usedTokens.set(p.cid, p.exp);
    this.inFlight.add('a:' + addr); this.inFlight.add('i:' + key);
    return { ok: true, addr, ipKey: key, fp, powBits: p.pb };
  }
  abort(r) { if (!r || !r.ok) return; this.inFlight.delete('a:' + r.addr); this.inFlight.delete('i:' + r.ipKey); }
  commit(r) {
    if (!r || !r.ok) return;
    const t = nowMs();
    this._push(this.ipClaims, r.ipKey, t, this.cfg.cooldownMs);
    this._push(this.fpClaims, r.fp, t, this.cfg.cooldownMs);
    if (this.day.d !== this._dayKey(t)) this.day = { d: this._dayKey(t), n: 0 };
    this.day.n += 1;
    const cur = Math.floor(t / 60000); this.minute.set(cur, (this.minute.get(cur) || 0) + 1);
    this.accepted += 1;
    this.abort(r);
    this.onChange();
  }
  unban(ip) { const k = ipKey(ip); const had = this.bans.delete(k); this.wrong.delete(k); if (had) this.onChange(); return had; }
  stats() {
    const t = nowMs();
    return {
      config: { ...this.cfg },
      acceptedSinceBoot: this.accepted, rejectsSinceBoot: { ...this.rejects },
      today: { ...this.day },
      ipsInCooldown: [...this.ipClaims.values()].filter(v => v.some(x => t - x < this.cfg.cooldownMs)).length,
      devicesInCooldown: [...this.fpClaims.values()].filter(v => v.some(x => t - x < this.cfg.cooldownMs)).length,
      activeBans: [...this.bans.values()].filter(v => v > t).length,
      pendingTokens: this.usedTokens.size, inFlight: this.inFlight.size,
    };
  }
}

module.exports = { FaucetGuard, DEFAULTS, realIp, ipKey, sign, verify, newCaptcha, normalizeCells, powVerify, powSolve, leadingZeroBits, uaVerdict, originVerdict, fingerprint, shortHash };
