// ═══════════════════════════════════════════════════════════════════
// Elyon Chain — Wizard & Dashboard Server
// Step-by-step blockchain setup, explorer, PoS conversion, staking
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const { Web3 }= require('web3');
const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// BigInt JSON serialization
BigInt.prototype.toJSON = function () { return this.toString(); };

const app = express();

// ─────────────────────────────────────────────────────────────────────
// VALIDATOR NODE — default-DENY security guard (whitelist).
//
// This image is validator-only and must NEVER expose chain administration.
// A blacklist is fail-OPEN: any admin route someone forgets to list stays
// reachable. Instead we ALLOW only the validator / delegator / read / join /
// infrastructure endpoints this node legitimately needs and return 404 for
// everything else. The posture is fail-SAFE: a newly added admin route is
// denied automatically until it is explicitly and deliberately permitted, so
// a single omission can never silently expose chain-administration capability.
//
// This runs BEFORE requireAuth, so admin paths are blocked even during the
// pre-setup window when auth is not yet enforced (isProtectedMode() === false).
// ─────────────────────────────────────────────────────────────────────
const VALIDATOR_ALLOW = [
  // auth · status · RPC proxy · node infra
  /^\/api\/auth\//i,
  /^\/api\/rpc(\/|$)/i,
  /^\/api\/(status|role-info)(\/|$)/i,
  /^\/api\/operator\/config(\/|$)/i,
  /^\/api\/simple-admin\/config(\/|$)/i,
  /^\/api\/blocks\//i,
  /^\/api\/wallet\/send-native(\/|$)/i,
  // wizard: JOIN + READ only — NOT create-chain / convert-pos / sync-convert-pos /
  // force-activate-pos / sync-disconnect / deploy-staking / staking/*
  /^\/api\/wizard\/(status|sync-status|connect|bootstrap|generate-key|derive-address)(\/|$)/i,
  /^\/api\/wizard\/operator\//i,
  // apos: read endpoints
  /^\/api\/apos\/(info|mode|packages|tiers|validators|validator-by-code|vpackages|credits|handshake)(\/|$)/i,
  // apos: validator actions + per-validator read (/validator/:addr, /validator/apply, ...)
  /^\/api\/apos\/validator(\/|$)/i,
  // apos: delegator actions
  /^\/api\/apos\/(delegate|delegator-status|delegators|my-delegations|withdraw-position)(\/|$)/i,
  // apos: registry-pointer DISCOVERY only — NEVER deploy/apply/repair/cancel a pointer
  /^\/api\/apos\/(discover-pointer|use-pointer|sync-from-pointer|pointer-info|pointer-build)(\/|$)/i,
  // delegation desk · leaderboard reads · PoS block-producer staking (validator-side)
  /^\/api\/desk\//i,
  /^\/api\/lb\/(state|heartbeat)(\/|$)/i,
  /^\/api\/staking\/(status|active-validators|stake-producer|request-unstake|withdraw)(\/|$)/i,
];
const _deny = (res) => res.status(404).json({ error: 'not available on a validator node' });
app.use((req, res, next) => {
  let p = req.path;
  if (p === '/rpc') p = '/api/rpc';
  // Non-API requests (static assets, /manager, /node, pages) are not gated.
  if (!p.startsWith('/api/')) return next();
  // /api/admin-proxy/* forwards to the chain's ADMIN node — permit only the
  // read/bootstrap calls the join flow needs; never proxy an admin action.
  if (p.startsWith('/api/admin-proxy/')) {
    const inner = p.slice('/api/admin-proxy'.length);
    if (/^\/api\/(rpc|wizard\/(bootstrap|status)|apos\/(info|mode|packages|tiers|validators))(\/|$)/i.test(inner)) return next();
    return _deny(res);
  }
  // /api/proxy/* re-enters the LOCAL API — evaluate the effective inner path so
  // an admin route can't be tunnelled through the proxy.
  const eff = p.startsWith('/api/proxy/') ? p.slice('/api/proxy'.length) : p;
  if (VALIDATOR_ALLOW.some((re) => re.test(eff))) return next();
  return _deny(res);
});

// v7.0.3 SECURITY (audit I7): trust the loopback proxy so req.ip resolves
// from X-Forwarded-For when Caddy fronts the dashboard. Without this, ALL
// requests appear from 127.0.0.1, which the rate limiters skip — silently
// disabling login / RPC / faucet rate limiting.
app.set('trust proxy', 'loopback');
// v7.0.3 SECURITY (audit I6): restrict CORS. Same-origin browser flows work
// (the dashboard's own pages don't need CORS). Cross-origin requests from
// random sites can no longer probe state-changing endpoints. If the operator
// needs cross-origin (e.g. an external explorer), set DASHBOARD_CORS_ORIGINS
// to a comma-separated allowlist.
const _corsOrigins = (process.env.DASHBOARD_CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);              // same-origin / curl
    if (_corsOrigins.length === 0) return cb(null, false);
    return cb(null, _corsOrigins.includes(origin));
  },
  credentials: false,
}));
app.use(express.json({ limit: '50mb' }));

// ticket #9 (BUG-005): JSON-parse failures on /rpc and /api/rpc previously
// fell through to Express's default error page (HTML stack trace exposing
// __dirname / node_modules paths). Trap the body-parser SyntaxError here and
// emit a proper JSON-RPC Parse Error (-32700) for the RPC paths, and a
// generic JSON 400 for everything else — no internals leaked either way.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    const isRpc = req.path === '/rpc' || req.path === '/api/rpc';
    if (isRpc) {
      return res.status(200).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  return next(err);
});

// v7.0.9 (re-audit MEDIUM-2): security headers. The dashboard handles admin
// keys, change-password, faucet, wallet send-native — any stored XSS would
// be catastrophic. CSP scoped to allow inline scripts/styles since the SPA
// uses inline handlers; structural directives (base-uri/form-action/object-
// src/frame-ancestors 'none') still block the highest-impact bypasses.
// CSP is NOT applied to /api/wizard/bootstrap, /api/apos/info etc. (they
// already set their own CORS '*' headers and return JSON, not HTML).
app.use((req, res, next) => {
  // Skip CSP on JSON-RPC proxy port responses (handled by separate rpcApp).
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +  // v7.1.0: dropped 'unsafe-eval' (grep confirms no eval/Function use)
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' https: http: ws: wss:; " +          // Web3 + Caddy + RPC
    "img-src 'self' data:; " +
    "font-src 'self' data:; " +
    "base-uri 'none'; " +
    "form-action 'self'; " +
    "object-src 'none'; " +
    "frame-ancestors 'none';");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// v7.0.5: public read-only endpoints (bootstrap, apos info/tokens/packages)
// must permit cross-origin so any operator browser can fetch them. The strict
// allowlist above protects state-changing endpoints; these read-only ones
// expose only public chain metadata that anyone can read via RPC anyway.
const PUBLIC_READ_PATHS = [
  '/api/wizard/bootstrap',
  '/api/apos/info',
  '/api/apos/validators',
  '/api/apos/tiers',
  '/api/apos/packages',
];
app.use((req, res, next) => {
  if (PUBLIC_READ_PATHS.includes(req.path)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// ── Role-based routing for "/" ────────────────────────────────────
// When the chain is freshly spun up the wizard hasn't run yet — `/` must
// land on index.html (the wizard view). After install completes, `/` should
// land on site.html — the public-facing marketing/help website. The admin
// dashboard is always reachable at /admin.
//
// We keep this BEFORE express.static so it wins precedence over the
// default index.html served at "/".
function isWizardDone() {
  // Wizard is "done" once any chainId is recorded in config — that's the
  // universal signal that the install/setup flow finished, regardless of
  // mode (admin: 'created' | 'pos-converted' | 'apos-converted',
  // operator clones: 'node' | 'syncing', etc.).
  try {
    return !!(config && config.chainId);
  } catch { return false; }
}
app.get('/', (req, res) => {
  // Validator node: the only dashboard is the validator panel.
  return res.redirect(302, '/manager');
});
// The /admin wizard and /setup routes are intentionally REMOVED on a validator
// node — there is no admin dashboard in this distribution.
app.get(['/admin', '/setup'], (req, res) =>
  res.status(404).send('Not found — this is a validator node (no admin dashboard).'));

// v7.11.16 — unified domain routing. Previously the operator panel ran
// on :4000 and the simple-admin on :5000 with their own static-file
// servers. Each had its own domain config. The user wanted ONE domain
// (set on the main /admin wizard) to serve all three panels, with
// route prefixes:
//   /admin    → main wizard / full admin dashboard (this same page)
//   /manager  → simple-admin (Nodes / Send / Staking / Earnings / C&T)
//   /node     → operator portal (Explorer / Join / Earnings / My Node)
//
// The internal :4000 and :5000 servers stay running for backward-compat
// (existing bookmarks keep working), but the canonical entry point is
// https://<domain>/{admin,manager,node}. The operator panel's own
// "set domain" UI is being removed in this same release — domains are
// configured once via /admin → Settings.
// ticket #5 follow-up: send aggressive no-cache headers on the panel HTML
// so neither Cloudflare nor a browser can pin an old build. Without this,
// purging the CDN was a one-shot — any edge that re-fetched after a deploy
// could go stale again. Cloudflare honours Cache-Control: no-store on HTML
// by default; browsers obey it for the navigation request too.
function _noCacheHtml(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
}
app.get('/manager', (req, res) => {
  _noCacheHtml(res);
  res.sendFile(path.join(__dirname, 'public', 'simple-admin', 'index.html'));
});
app.get('/manager/', (req, res) => {
  _noCacheHtml(res);
  res.sendFile(path.join(__dirname, 'public', 'simple-admin', 'index.html'));
});
app.get('/node', (req, res) => {
  _noCacheHtml(res);
  res.sendFile(path.join(__dirname, 'public', 'operator', 'index.html'));
});
app.get('/node/', (req, res) => {
  _noCacheHtml(res);
  res.sendFile(path.join(__dirname, 'public', 'operator', 'index.html'));
});

// v7.13 — operator-image landing now lives inside the primary "/" handler
// above so it wins ahead of the wizard/site.html fallback. This stub is kept
// as documentation only.

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// Static assets referenced by the embedded panels — same files those
// panels' own :4000 / :5000 servers serve.
app.use('/manager', express.static(path.join(__dirname, 'public', 'simple-admin'), { index: false }));
app.use('/node',    express.static(path.join(__dirname, 'public', 'operator'),     { index: false }));

// ── Configuration ──────────────────────────────────────────────────
const PORT       = parseInt(process.env.DASHBOARD_PORT || '3000');
// Nethermind binds to 127.0.0.1:8540 (internal-only). The dashboard
// listens on 0.0.0.0:8545 and proxies JSON-RPC, pre-filtering txs that
// fall below the chain's APOS-derived gas-price floor. External clients
// that point at port 8545 hit the filter; raw Nethermind isn't reachable
// from outside the container.
const NETHERMIND_INTERNAL_RPC_PORT = 8540;
const RPC_PROXY_PORT = parseInt(process.env.RPC_PROXY_PORT || '8545');
let   RPC_URL    = process.env.RPC_URL || `http://127.0.0.1:${NETHERMIND_INTERNAL_RPC_PORT}`;
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const NM_PATH    = process.env.NETHERMIND_PATH || '/nethermind';
const STANDALONE = process.env.STANDALONE === 'true';
const CFG_FILE   = path.join(DATA_DIR, 'wizard-config.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// Make sure every persistent path the node uses is under DATA_DIR so the
// mounted volume captures DB, keystore, logs, chainspec, wizard config and
// fee tracker. Recreating the container against a new image keeps everything.
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'db'),       { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'keystore'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'logs'),     { recursive: true });
// v7.48 — user-submitted issue/feedback reports (text + photos). Stored on the
// admin node's persistent volume so they survive container recreates.
const FEEDBACK_DIR     = path.join(DATA_DIR, 'feedback');
const FEEDBACK_IMG_DIR = path.join(FEEDBACK_DIR, 'img');
const FEEDBACK_INDEX   = path.join(FEEDBACK_DIR, 'index.json');
fs.mkdirSync(FEEDBACK_IMG_DIR, { recursive: true });

// ── URL validation (SSRF guard) ────────────────────────────────────
// v7.0.3 SECURITY (audit I5/I9): block fetches from caller-supplied URLs to
// loopback / RFC1918 / link-local / non-http(s). Raw IP-only check —
// hostnames are accepted (operators legitimately use example.com etc); set
// SSRF_BLOCK_HOSTNAMES=1 to require IP literal as well.
function _isPrivateIP(ip) {
  if (!ip) return true;
  ip = ip.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '0.0.0.0') return true;
  // IPv4 private ranges
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;       // link-local (AWS IMDS, etc.)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; // CGNAT
  // IPv6 unique-local + link-local
  if (/^f[cd]/i.test(ip)) return true;
  if (/^fe80:/i.test(ip)) return true;
  return false;
}
function validateExternalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') throw new Error('URL required');
  let u;
  try { u = new URL(rawUrl); }
  catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('only http(s):// URLs allowed');
  }
  // Allow loopback ONLY when explicitly enabled (e.g. dev / docker-compose)
  if (process.env.ALLOW_LOOPBACK_FETCH !== '1' && _isPrivateIP(u.hostname)) {
    throw new Error('refusing to fetch from private/loopback address');
  }
  return u;
}

// ── Multer (file uploads) ──────────────────────────────────────────
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB max
});

// v7.48 — uploader for issue-report photos: images only, 8 MB each, ≤5 files.
const feedbackUpload = multer({
  dest: FEEDBACK_IMG_DIR,
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
function loadFeedback() {
  try { return JSON.parse(fs.readFileSync(FEEDBACK_INDEX, 'utf8')); } catch { return []; }
}
function saveFeedback(list) {
  try { fs.writeFileSync(FEEDBACK_INDEX, JSON.stringify(list, null, 2)); } catch (e) { console.warn('[feedback] save failed:', e.message); }
}

// ── Staking contract build (compiled from contracts/StakingContract.sol) ──
// Loaded from disk so we only have one source of truth for ABI + bytecode.
// MIN_STAKE is now a constructor argument (not constant) — admin sets it
// when the chain converts to PoS, and can update it later via setMinStake.
const STAKING_BUILD = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'staking-build.json'), 'utf8')); }
  catch (e) { console.warn('[wizard] staking-build.json missing — run: node apos-compile.js'); return { abi: [], bytecode: '0x' }; }
})();
const STAKING_ABI      = STAKING_BUILD.abi;
const STAKING_BYTECODE = STAKING_BUILD.bytecode;

// ── State ──────────────────────────────────────────────────────────
let web3 = new Web3(new Web3.providers.HttpProvider(RPC_URL));
// v7.22 — Elyon Chain (patched Nethermind PoA) doesn't support EIP-1559.
// Force legacy (type-0) txs globally so faucet / leaderboard / staking
// deploys don't trip "Eip1559NotSupportedError".
try {
  if (web3.defaultTransactionType !== undefined) web3.defaultTransactionType = '0x0';
  if (web3.eth && web3.eth.defaultTransactionType !== undefined) web3.eth.defaultTransactionType = '0x0';
  if (web3.eth) web3.eth.transactionBuilder = null;
} catch {}
let nodeProc = null;
// v7.1.6: `let config = loadConfig()` was called BEFORE _CFG_PASS was
// initialized further down — temporal dead zone error blew up the dashboard
// on boot. Initialize as null here; we re-load it after _CFG_PASS is ready.
let config = null;
// v7.0.4 self-heal moved below loadConfig() invocation post-_CFG_PASS init.

// Track sync progress across polling calls to avoid premature "sync complete"
let syncTracker = {
  highestBlockEverSeen: 0,  // max highestBlock reported by eth_syncing
  prevBlock: 0,             // block number at previous poll
  slowGrowthCount: 0,       // consecutive polls with < 10 block growth AND !syncing
};

// v7.1.0 (audit I-C1): encrypt validatorKey at rest. Persistent passphrase
// derived from a per-install file (mode 0600) under DATA_DIR; on first save,
// generate it. AES-256-GCM via the same scrypt KDF the stress-test uses.
const _CFG_PASS_FILE = path.join(DATA_DIR, '.config-passphrase');
function _getConfigPassphrase() {
  if (process.env.WIZARD_CONFIG_PASSPHRASE) return process.env.WIZARD_CONFIG_PASSPHRASE;
  try {
    if (fs.existsSync(_CFG_PASS_FILE)) return fs.readFileSync(_CFG_PASS_FILE, 'utf8').trim();
  } catch {}
  const fresh = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(_CFG_PASS_FILE, fresh, { mode: 0o600 }); } catch (e) {
    console.warn('[wizard] could not persist config passphrase:', e.message);
  }
  return fresh;
}
const _CFG_PASS = _getConfigPassphrase();
function _encryptKey(plain) {
  if (!plain || typeof plain !== 'string') return null;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(_CFG_PASS, salt, 32, { N: 2**14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return 'enc:v1:' + salt.toString('hex') + ':' + iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}
function _decryptKey(blob) {
  if (!blob || typeof blob !== 'string' || !blob.startsWith('enc:v1:')) return blob; // legacy plaintext
  const parts = blob.split(':');
  if (parts.length !== 6) return null;
  try {
    const salt = Buffer.from(parts[2], 'hex');
    const iv = Buffer.from(parts[3], 'hex');
    const tag = Buffer.from(parts[4], 'hex');
    const data = Buffer.from(parts[5], 'hex');
    const key = crypto.scryptSync(_CFG_PASS, salt, 32, { N: 2**14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch (e) {
    console.warn('[wizard] config key decrypt failed:', e.message);
    return null;
  }
}
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    // Decrypt encrypted fields back into plaintext for in-memory use.
    if (c && c.validatorKey) {
      const dec = _decryptKey(c.validatorKey);
      if (dec) c.validatorKey = dec;
    }
    return c;
  } catch { return null; }
}
function saveConfig(c) {
  config = c;
  // Encrypt validatorKey on disk so a stolen volume / docker cp / backup
  // doesn't leak the chain's signing key in plaintext.
  const onDisk = { ...c };
  if (onDisk.validatorKey && !String(onDisk.validatorKey).startsWith('enc:v1:')) {
    const enc = _encryptKey(onDisk.validatorKey);
    if (enc) onDisk.validatorKey = enc;
  }
  // mode 0o600 — readable only by container uid.
  fs.writeFileSync(CFG_FILE, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  // Defensive chmod — writeFileSync mode arg is honored on create only.
  try { fs.chmodSync(CFG_FILE, 0o600); } catch {}
}

// v7.1.6: load config NOW that _CFG_PASS / _decryptKey are defined.
config = loadConfig();
// v7.0.4 self-heal: normalize legacy un-prefixed validatorKey.
if (config && typeof config.validatorKey === 'string' &&
    /^[0-9a-fA-F]{64}$/.test(config.validatorKey) &&
    !config.validatorKey.startsWith('0x')) {
  config.validatorKey = '0x' + config.validatorKey;
  try { saveConfig(config); console.log('[wizard] self-heal: normalized validatorKey to 0x prefix'); }
  catch (e) { console.warn('[wizard] could not persist key normalization:', e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// SSL / domain module — REMOVED in v7.8-no-ssl
//
// Caddy auto-HTTPS and the /api/wizard/domain endpoints have been
// stripped out.  Operators front the dashboard with their own reverse
// proxy (nginx, cloud LB, etc.) and provision certs externally.
//
// Stubs are kept so old front-end code calling /api/wizard/domain just
// gets a polite 410 instead of a 404.
// ═══════════════════════════════════════════════════════════════════
async function startCaddy() { /* no-op — SSL module removed */ }
async function stopCaddy()  { /* no-op — SSL module removed */ }
function mountDomainEndpoints() {
  const gone = (_req, res) => res.status(410).json({
    error: 'domain / Caddy auto-HTTPS module removed in v7.8-no-ssl. Front the dashboard with your own reverse proxy (nginx, etc.).',
  });
  app.get('/api/wizard/domain',    gone);
  app.post('/api/wizard/domain',   gone);
  app.delete('/api/wizard/domain', gone);
}

// v7.1.0 (audit I-C2): CSRF defence. State-changing endpoints (everything
// behind requireAuth + the unauth wizard mutators) must include either a
// custom header (X-Requested-With) OR a JSON content-type. Both trigger the
// CORS preflight that simple form-POST attacks cannot send. Combined with
// the strict CORS allowlist + Bearer auth, this closes browser-based CSRF.
function _requireSafeOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const xrw = req.headers['x-requested-with'];
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (xrw === 'XMLHttpRequest' || ct.startsWith('application/json')) return next();
  return res.status(403).json({ error: 'CSRF: state-changing requests require X-Requested-With: XMLHttpRequest or application/json content-type' });
}
// Apply only to /api/* routes (Caddy/static assets are exempt).
app.use('/api', _requireSafeOrigin);

// ═══════════════════════════════════════════════════════════════════
// ADMIN AUTH  (password set at chain creation, 1-hour sessions)
// ═══════════════════════════════════════════════════════════════════
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour sliding
// v7.0: absolute max session lifetime — even if user is active, force re-auth
// after 12 hours. Mitigates token theft (XSS / device compromise) staying
// useful indefinitely.
const SESSION_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;
// v7.0: hard cap on concurrent sessions — protects against memory DoS via
// repeated logins.
const SESSION_MAX_COUNT = 200;
const sessions = new Map(); // token -> { expiresAt, createdAt }

// v7.0 SECURITY: scrypt KDF with high cost. 32-byte salt, 64-byte derived key.
// Old SHA-256 hashes are detected by the legacy 64-char-hex format and
// transparently re-hashed on next successful login.
const SCRYPT_N = 2 ** 15;   // CPU/memory cost (~75ms on a modern server)
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;
// Node's default scrypt maxmem is 32 MiB which is exactly 128*N*r at these
// params — OpenSSL rejects "at the limit" with "memory limit exceeded".
// Bump to 64 MiB so the call has headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
function hashPasswordScrypt(pw, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const dk = crypto.scryptSync(pw, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: SCRYPT_MAXMEM });
  return 'scrypt$' + SCRYPT_N + '$' + SCRYPT_r + '$' + SCRYPT_p + '$' + dk.toString('hex');
}
function hashPasswordLegacySha(pw, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pw).digest('hex');
}
// Unified verifier — supports both old SHA-256 hashes (legacy chains) and new
// scrypt hashes. Returns { match, isLegacy }.
// v7.0.8 (audit I3): use crypto.timingSafeEqual to avoid leaking the
// stored hash byte-by-byte through `===`. Length-check first since
// timingSafeEqual throws RangeError on mismatch.
function _ctEqStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  catch { return false; }
}
function verifyPassword(pw, storedHash, saltHex) {
  if (storedHash && storedHash.startsWith('scrypt$')) {
    return { match: _ctEqStr(hashPasswordScrypt(pw, saltHex), storedHash), isLegacy: false };
  }
  const computed = hashPasswordLegacySha(pw, saltHex || '');
  return { match: _ctEqStr(computed, storedHash), isLegacy: true };
}
// Compatibility shim — keeps any old call site working until next chain
// rebuild. New code paths call hashPasswordScrypt directly.
function hashPassword(pw, salt) { return hashPasswordLegacySha(pw, salt); }
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
function isValidToken(t) {
  if (!t) return false;
  const s = sessions.get(t);
  if (!s) return false;
  // Backward compat: old format stored just the expiresAt number directly.
  const expiresAt = (typeof s === 'object') ? s.expiresAt : s;
  const createdAt = (typeof s === 'object') ? s.createdAt : Date.now();
  const now = Date.now();
  if (now > expiresAt) { sessions.delete(t); return false; }
  // v7.0: enforce absolute max lifetime even with sliding expiry
  if (now > createdAt + SESSION_MAX_LIFETIME_MS) {
    sessions.delete(t);
    return false;
  }
  return true;
}
function createSession() {
  // v7.0: cap concurrent sessions; evict oldest if at limit
  if (sessions.size >= SESSION_MAX_COUNT) {
    const oldestKey = sessions.keys().next().value;
    if (oldestKey) sessions.delete(oldestKey);
  }
  const t = newToken();
  const now = Date.now();
  sessions.set(t, { expiresAt: now + SESSION_TTL_MS, createdAt: now });
  return t;
}
function getToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.headers['x-auth-token'] || null;
}
// "Protected mode" means the dashboard requires admin sign-in. The chain
// is in protected mode the moment a validator wallet exists on this node
// — that's the universal signal that setup has finished, regardless of
// whether the admin ever set a password (operator clones don't, but they
// still must require wallet/PK login). Pre-validator nodes (the wizard's
// first-time form) stay open so the wizard can run.
function isProtectedMode() {
  if (!config) return false;
  return !!(config.validatorAddress || config.validatorKey || config.adminPassHash);
}
// Middleware: require a valid admin session.
function requireAuth(req, res, next) {
  if (!isProtectedMode()) return next();
  const t = getToken(req);
  if (!isValidToken(t)) return res.status(401).json({ error: 'Auth required', needLogin: true });
  // Slide expiry — but absolute lifetime is checked in isValidToken().
  const s = sessions.get(t);
  if (s && typeof s === 'object') {
    s.expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(t, s);
  } else {
    sessions.set(t, { expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
  }
  next();
}

app.get('/api/auth/status', (req, res) => {
  const protectedMode = isProtectedMode();
  const t = getToken(req);
  const authed = protectedMode ? isValidToken(t) : true;
  res.json({ protected: protectedMode, authed, ttlMs: SESSION_TTL_MS });
});

// v7.0: per-IP rate limiter for login. After 5 failed attempts in 15 min,
// the IP gets a 15-min lockout. Bypass for trusted local IPs (loopback).
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAIL_MAX       = 5;
const LOGIN_LOCKOUT_MS     = 15 * 60 * 1000;
const loginFailures = new Map(); // ip -> { count, firstFailAt, lockedUntil }
function loginRateCheck(req) {
  const ip = (req.ip || req.connection?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  // v7.0.3 SECURITY (audit I7): only bypass for trusted_loopback when env
  // explicitly opts in. Default behaviour now rate-limits even loopback to
  // close the trust-proxy hole (Caddy fronts at 127.0.0.1, every request
  // appeared to be from there, all rate limits silently disabled).
  if (process.env.TRUST_LOOPBACK === '1' && (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost')) {
    return { allowed: true, ip };
  }
  const now = Date.now();
  const rec = loginFailures.get(ip);
  if (rec && rec.lockedUntil && rec.lockedUntil > now) {
    return { allowed: false, ip, retryAt: rec.lockedUntil };
  }
  return { allowed: true, ip };
}
function recordLoginFailure(ip) {
  const now = Date.now();
  let rec = loginFailures.get(ip);
  if (!rec || (rec.firstFailAt && now - rec.firstFailAt > LOGIN_FAIL_WINDOW_MS)) {
    rec = { count: 0, firstFailAt: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= LOGIN_FAIL_MAX) rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
  loginFailures.set(ip, rec);
  // Drop very old entries to bound memory
  if (loginFailures.size > 10000) {
    for (const [k, v] of loginFailures) {
      if (v.lockedUntil < now - LOGIN_LOCKOUT_MS) loginFailures.delete(k);
    }
  }
}
function clearLoginFailures(ip) { loginFailures.delete(ip); }

app.post('/api/auth/login', async (req, res) => {
  const rl = loginRateCheck(req);
  if (!rl.allowed) {
    const retryInSec = Math.ceil((rl.retryAt - Date.now()) / 1000);
    return res.status(429).json({ error: `Too many failed attempts. Retry in ${retryInSec}s.`, retryAt: rl.retryAt });
  }
  if (!config || !config.adminPassHash) {
    return res.status(400).json({ error: 'No admin password configured yet' });
  }
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const result = verifyPassword(password, config.adminPassHash, config.adminPassSalt || '');
  if (!result.match) {
    recordLoginFailure(rl.ip);
    return res.status(401).json({ error: 'Invalid password' });
  }
  // v7.0: legacy SHA-256 hashes are silently upgraded to scrypt on success.
  if (result.isLegacy) {
    try {
      // Generate a fresh strong salt and re-hash with scrypt
      const newSalt = crypto.randomBytes(32).toString('hex');
      const newHash = hashPasswordScrypt(password, newSalt);
      saveConfig({ ...config, adminPassSalt: newSalt, adminPassHash: newHash });
      console.log('[auth] legacy SHA-256 password upgraded to scrypt for chain admin');
    } catch (e) { console.warn('[auth] hash upgrade failed:', e.message); }
  }
  clearLoginFailures(rl.ip);
  const t = newToken();
  sessions.set(t, { expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
  res.json({ token: t, ttlMs: SESSION_TTL_MS });
});

app.post('/api/auth/logout', (req, res) => {
  const t = getToken(req);
  if (t) sessions.delete(t);
  res.json({ ok: true });
});

// ── Wallet-based admin login (MetaMask / Trust Wallet) ──
// Step 1: client requests a nonce; server stores it briefly.
// Step 2: client signs "Elyon Chain Admin Login\nAddress: <addr>\nNonce: <n>".
// Step 3: client posts {address, nonce, signature}; server verifies signature
//         AND checks that address matches config.validatorAddress.
const walletNonces = new Map(); // nonce -> {address, expires}
const NONCE_TTL_MS = 5 * 60 * 1000;
// v7.0 SECURITY: bounded size to prevent memory DoS via nonce spam
const NONCE_MAX_COUNT = 5000;
function clearExpiredNonces() {
  const now = Date.now();
  for (const [n, v] of walletNonces) if (v.expires < now) walletNonces.delete(n);
  // Hard cap: drop oldest insertion-order entries if still over the limit
  while (walletNonces.size > NONCE_MAX_COUNT) {
    const k = walletNonces.keys().next().value;
    if (!k) break;
    walletNonces.delete(k);
  }
}
// v7.0.8 (audit I4): per-IP rate limit on nonce issuance so an attacker
// can't flush legitimate nonces from the in-memory cache.
const _nonceRate = new Map(); // ip -> { count, windowStart }
const NONCE_RATE_WINDOW_MS = 60_000;
const NONCE_RATE_MAX = 30; // 30 nonces / minute / IP
app.post('/api/auth/wallet-nonce', (req, res) => {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  const now = Date.now();
  let r = _nonceRate.get(ip);
  if (!r || now - r.windowStart > NONCE_RATE_WINDOW_MS) r = { count: 0, windowStart: now };
  r.count += 1;
  _nonceRate.set(ip, r);
  if (r.count > NONCE_RATE_MAX) return res.status(429).json({ error: 'nonce rate limit exceeded' });
  if (_nonceRate.size > 50_000) {
    for (const [k, v] of _nonceRate) if (now - v.windowStart > NONCE_RATE_WINDOW_MS) _nonceRate.delete(k);
  }
  clearExpiredNonces();
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address required' });
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: 'invalid address' });
  const nonce = require('crypto').randomBytes(16).toString('hex');
  walletNonces.set(nonce, { address: address.toLowerCase(), expires: Date.now() + NONCE_TTL_MS });
  res.json({ nonce, message: `Elyon Chain Admin Login\nAddress: ${address}\nNonce: ${nonce}` });
});
// Build the set of admin-authorized addresses (lowercase) from config.
// Either matches a valid sign-in:
//   - validatorAddress (the chain sealer / wizard-imported key)
//   - adminWalletAddress (MetaMask wallet recorded during setup)
function authorizedAdminAddresses() {
  const set = new Set();
  if (config?.validatorAddress) set.add(config.validatorAddress.toLowerCase());
  if (config?.adminWalletAddress) set.add(config.adminWalletAddress.toLowerCase());
  return set;
}

// ── Private-key login (alternative to password / wallet) ──
// User pastes the validator/operator private key; server derives the address
// and confirms it matches one of the chain's authorized admin addresses.
app.post('/api/auth/key-login', (req, res) => {
  // v7.0.8 (audit I1): rate-limit key-login the same way as password login.
  const rl = loginRateCheck(req);
  if (!rl.allowed) {
    const retryInSec = Math.ceil((rl.retryAt - Date.now()) / 1000);
    return res.status(429).json({ error: `Too many failed attempts. Retry in ${retryInSec}s.`, retryAt: rl.retryAt });
  }
  try {
    let { privateKey } = req.body || {};
    if (!privateKey) { recordLoginFailure(rl.ip); return res.status(400).json({ error: 'privateKey required' }); }
    privateKey = privateKey.trim();
    if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) { recordLoginFailure(rl.ip); return res.status(400).json({ error: 'invalid private key format (need 32-byte hex)' }); }
    const acct = web3.eth.accounts.privateKeyToAccount(privateKey);
    const allowed = authorizedAdminAddresses();
    if (!allowed.size) return res.status(400).json({ error: 'No admin wallet configured' });
    if (!allowed.has(acct.address.toLowerCase())) {
      recordLoginFailure(rl.ip);
      // v7.0.8 (audit M8): drop the address-disclosure to prevent recon.
      return res.status(403).json({ error: 'key does not match an authorized admin address' });
    }
    clearLoginFailures(rl.ip);
    const t = newToken();
    sessions.set(t, { expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
    res.json({ token: t, ttlMs: SESSION_TTL_MS, address: acct.address });
  } catch (e) { recordLoginFailure(rl.ip); res.status(500).json({ error: 'login failed' }); }
});

// ── Native ELY transfer (uses the configured validator key) ──
// Lets a signed-in admin / operator move chain-native ELY from the
// validator wallet to any address.
//
// Implementation note: web3.js v4's sendSignedTransaction polls
// eth_getTransactionReceipt internally and surfaces Nethermind's
// "Pruned history unavailable" as a fatal error — even when the tx
// itself was accepted into the mempool and is being mined. We bypass
// that by submitting the raw tx via eth_sendRawTransaction directly
// (returns just the hash) and then polling for the receipt ourselves
// while swallowing the spurious "pruned history" race.
app.post('/api/wallet/send-native', requireAuth, async (req, res) => {
  try {
    const { to, amountUnp, gasPriceGwei } = req.body || {};
    if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) return res.status(400).json({ error: 'invalid recipient address' });
    if (!amountUnp || isNaN(Number(amountUnp))) return res.status(400).json({ error: 'amountUnp required' });
    if (!config || !config.validatorKey) return res.status(400).json({ error: 'no validator key configured' });
    const acct = web3.eth.accounts.privateKeyToAccount(config.validatorKey);
    const valueWei = web3.utils.toWei(String(amountUnp), 'ether');
    // v7.0.8 (audit M5): bound gas price between chain floor and 10x floor.
    // Caller can no longer pass a typo'd 1e18 gwei that drains the validator
    // wallet to a single tx fee.
    const minGasWei = BigInt(config.minGasPriceWei || '1000000000');
    const maxGasWei = minGasWei * 100n; // 100x cushion is plenty
    let gpWei = gasPriceGwei != null && gasPriceGwei !== ''
      ? BigInt(web3.utils.toWei(String(gasPriceGwei), 'gwei'))
      : (minGasWei * 11n) / 10n; // default = floor + 10% headroom
    if (gpWei < minGasWei) gpWei = minGasWei;
    if (gpWei > maxGasWei) return res.status(400).json({ error: `gasPriceGwei too high (max ${(Number(maxGasWei)/1e9)} gwei)` });
    const tx = {
      from: acct.address,
      to,
      value: valueWei,
      gas: 21000,
      gasPrice: gpWei.toString(),
      chainId: config.chainId
    };
    const signed = await acct.signTransaction(tx);
    // Submit the raw tx directly — DON'T let web3 poll for receipt.
    const submit = await fetch(RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [signed.rawTransaction], id: 1 }),
    }).then(r => r.json()).catch(e => ({ error: { message: e.message } }));
    if (submit.error) return res.status(400).json({ error: submit.error.message });
    const hash = submit.result;
    // Best-effort receipt poll. Block period is configurable down to 1 s,
    // default 5 s — give it ~20 s. Ignore "pruned history" responses;
    // they're a Nethermind quirk while the receipt index is still being
    // written, not a real failure.
    let receipt = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        receipt = await web3.eth.getTransactionReceipt(hash);
        if (receipt && receipt.blockNumber) break;
      } catch (e) {
        if (!/pruned history/i.test(e.message || '')) {
          console.warn('[send-native] receipt poll:', e.message);
        }
      }
    }
    res.json({
      ok: true,
      hash,
      from: acct.address,
      to,
      amountUnp,
      blockNumber: receipt?.blockNumber?.toString() || null,
      status: receipt ? (receipt.status === 1n || receipt.status === '0x1' ? 'success' : 'failed') : 'pending',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/wallet-verify', async (req, res) => {
  // v7.0.8 (audit I1): rate-limit wallet-verify too.
  const rl = loginRateCheck(req);
  if (!rl.allowed) {
    const retryInSec = Math.ceil((rl.retryAt - Date.now()) / 1000);
    return res.status(429).json({ error: `Too many failed attempts. Retry in ${retryInSec}s.`, retryAt: rl.retryAt });
  }
  try {
    const { address, nonce, signature } = req.body || {};
    if (!address || !nonce || !signature) { recordLoginFailure(rl.ip); return res.status(400).json({ error: 'missing fields' }); }
    const rec = walletNonces.get(nonce);
    if (!rec || rec.expires < Date.now()) { recordLoginFailure(rl.ip); return res.status(400).json({ error: 'nonce expired' }); }
    if (rec.address !== address.toLowerCase()) { recordLoginFailure(rl.ip); return res.status(400).json({ error: 'address mismatch' }); }
    const allowed = authorizedAdminAddresses();
    if (!allowed.size) return res.status(400).json({ error: 'No admin wallet configured' });
    if (!allowed.has(rec.address)) {
      recordLoginFailure(rl.ip);
      return res.status(403).json({ error: 'wallet not authorized' }); // M8: no disclosure
    }
    const message = `Elyon Chain Admin Login\nAddress: ${address}\nNonce: ${nonce}`;
    const recovered = web3.eth.accounts.recover(message, signature).toLowerCase();
    if (recovered !== rec.address) { recordLoginFailure(rl.ip); return res.status(401).json({ error: 'bad signature' }); }
    walletNonces.delete(nonce);
    clearLoginFailures(rl.ip);
    const t = newToken();
    sessions.set(t, { expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
    res.json({ token: t, ttlMs: SESSION_TTL_MS, address });
  } catch (e) { recordLoginFailure(rl.ip); res.status(500).json({ error: 'verify failed' }); }
});

// Allow the creator to (re)set the password from inside an authed session.
// v7.0.8 (audit C1): use scrypt for both verify AND new-hash storage.
// Previous code used legacy SHA-256 for both, regressing the v7.0.3 hardening
// after a single password change. Verify uses verifyPassword (handles legacy
// + scrypt). Storage always writes scrypt with 32-byte salt.
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  if (config.adminPassHash) {
    const result = verifyPassword(oldPassword || '', config.adminPassHash, config.adminPassSalt || '');
    if (!result.match) return res.status(401).json({ error: 'Old password incorrect' });
  }
  const salt = crypto.randomBytes(32).toString('hex'); // 32-byte scrypt salt
  saveConfig({ ...config, adminPassSalt: salt, adminPassHash: hashPasswordScrypt(newPassword, salt) });
  // Invalidate all other sessions
  sessions.clear();
  const t = newToken();
  sessions.set(t, { expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
  res.json({ ok: true, token: t });
});

// ═══════════════════════════════════════════════════════════════════
// CHAIN SETTINGS  (min gas price, etc. — editable post-launch)
// ═══════════════════════════════════════════════════════════════════
function currentSettings() {
  return {
    minGasPriceWei: config?.minGasPriceWei || '1000000000', // 1 gwei default
    blockPeriod:    config?.blockPeriod    || 5,
    transitionBlock:config?.transitionBlock|| 10000,
    chainName:      config?.chainName      || '',
    chainId:        config?.chainId        || 0,
  };
}

app.get('/api/settings', requireAuth, (req, res) => {
  res.json(currentSettings());
});

app.post('/api/settings', requireAuth, async (req, res) => {
  try {
    if (!config) return res.status(400).json({ error: 'No chain configured' });
    const { minGasPriceWei, minGasPriceGwei, blockPeriod } = req.body || {};

    const patch = {};
    if (minGasPriceGwei !== undefined && minGasPriceGwei !== null && minGasPriceGwei !== '') {
      const g = Number(minGasPriceGwei);
      if (!Number.isFinite(g) || g < 0) return res.status(400).json({ error: 'Invalid minGasPriceGwei' });
      patch.minGasPriceWei = (BigInt(Math.round(g * 1e9))).toString();
    } else if (minGasPriceWei !== undefined && minGasPriceWei !== null && minGasPriceWei !== '') {
      if (!/^\d+$/.test(String(minGasPriceWei))) return res.status(400).json({ error: 'Invalid minGasPriceWei' });
      patch.minGasPriceWei = String(minGasPriceWei);
    }
    if (blockPeriod !== undefined && blockPeriod !== null && blockPeriod !== '') {
      const bp = parseInt(blockPeriod);
      if (!Number.isFinite(bp) || bp < 1 || bp > 600) return res.status(400).json({ error: 'Invalid blockPeriod (1-600)' });
      patch.blockPeriod = bp;
    }

    const restart = !!(req.body && req.body.restart);
    saveConfig({ ...config, ...patch });

    let restarted = false;
    if (restart && STANDALONE && (config.mode === 'pos-converted' || config.mode === 'created')) {
      const specPath = path.join(DATA_DIR, 'chainspec.json');
      if (fs.existsSync(specPath) && config.validatorKey) {
        const extraArgs = config.stakingContract ? ['--PoS.StakingContractAddress', config.stakingContract] : [];
        await startNethermind(specPath, config.validatorKey, extraArgs);
        restarted = true;
      }
    }
    res.json({ ok: true, settings: currentSettings(), restarted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// TX FEE TRACKER  — validators earn ONLY transaction fees, so we
// accumulate (gasUsed * effectiveGasPrice) per block miner on every poll.
// ═══════════════════════════════════════════════════════════════════
const FEES_FILE = path.join(DATA_DIR, 'fee-tracker.json');
function loadFees() {
  try { return JSON.parse(fs.readFileSync(FEES_FILE, 'utf8')); }
  catch { return { lastScanned: -1, totalWei: '0', perValidator: {} }; }
}
function saveFees(f) { fs.writeFileSync(FEES_FILE, JSON.stringify(f, null, 2)); }
let feeState = loadFees();
let feeScanBusy = false;

async function scanFees() {
  if (feeScanBusy) return;
  feeScanBusy = true;
  try {
    if (!(await nodeAlive())) return;
    const latest = Number(await web3.eth.getBlockNumber());
    if (latest <= feeState.lastScanned) return;
    const startFrom = Math.max(0, feeState.lastScanned + 1);
    // Cap work per pass to avoid blocking
    const end = Math.min(latest, startFrom + 200);
    for (let n = startFrom; n <= end; n++) {
      let blk;
      try { blk = await web3.eth.getBlock(n, true); } catch { continue; }
      if (!blk) continue;
      const miner = (blk.miner || '').toLowerCase();
      if (!miner || !blk.transactions || blk.transactions.length === 0) {
        feeState.lastScanned = n; continue;
      }
      let blockFeeWei = 0n;
      for (const tx of blk.transactions) {
        if (!tx || tx.hash === undefined) continue;
        let rec;
        try { rec = await web3.eth.getTransactionReceipt(tx.hash); } catch { rec = null; }
        if (!rec) continue;
        const gasUsed = BigInt(rec.gasUsed || 0);
        // effectiveGasPrice present on EIP-1559 receipts; fallback to tx.gasPrice
        const gp = BigInt(rec.effectiveGasPrice || tx.gasPrice || 0);
        blockFeeWei += gasUsed * gp;
      }
      if (blockFeeWei > 0n) {
        feeState.totalWei = (BigInt(feeState.totalWei || '0') + blockFeeWei).toString();
        const cur = BigInt(feeState.perValidator[miner] || '0');
        feeState.perValidator[miner] = (cur + blockFeeWei).toString();
      }
      feeState.lastScanned = n;
    }
    saveFees(feeState);
  } catch (e) {
    console.log('[fees] scan error:', e.message);
  } finally {
    feeScanBusy = false;
  }
}
// Kick off periodic fee scanning
setInterval(scanFees, 15000);

// ── Sync watchdog ─────────────────────────────────────────────────
// Nethermind's sync engine has a quirk on this custom-PoS chain: after
// the initial handshake catches the node up to the peer's advertised
// head, it transitions into a "waiting for block" state and stops
// accepting subsequent blocks via gossip — even with Merge.Enabled=false.
// Net result: local stalls at block N while upstream advances to N+50.
//
// Detection: local's block number doesn't change for >30s while we have
// at least one connected peer. (We can't rely on peer.eth.head from
// admin_peers — Nethermind's wire-protocol stats often report it as
// null on this PoS chain, so a peer-head-based check would never fire.)
//
// Fix: restart Nethermind in sync mode WITHOUT clearing the DB. The
// fresh handshake re-learns peer's current head and downloads the gap.
let syncWatchdogBusy = false;
let syncWatchdogState = { lastBlock: -1, stillSinceMs: 0 };
// Convert flow stops Nethermind and restarts it as a PoS validator at the
// end. While that's running, the chain looks "stalled" from outside —
// we must NOT restart sync mid-convert or we'll race the convert flow.
let convertInProgress = false;
async function syncWatchdog() {
  if (syncWatchdogBusy) return;
  if (convertInProgress) return;
  if (!STANDALONE) return;
  if (!config || config.mode !== 'syncing') return;
  if (!config.enodeUrl) return;
  syncWatchdogBusy = true;
  try {
    const localHead = Number(await web3.eth.getBlockNumber().catch(() => 0));
    let peers = 0;
    try { peers = Number(await web3.eth.net.getPeerCount()); } catch {}

    // Track stagnation: if block number is unchanged AND we have a peer,
    // accumulate stall time. Reset if either changes.
    const now = Date.now();
    if (localHead !== syncWatchdogState.lastBlock) {
      syncWatchdogState.lastBlock = localHead;
      syncWatchdogState.stillSinceMs = now;
    }
    const stalledMs = (peers > 0) ? (now - syncWatchdogState.stillSinceMs) : 0;

    // 35 seconds of no progress with a peer connected → almost certainly
    // the post-handshake stall. Block period on these chains is 5s, so
    // 35s = ~7 missed blocks. Restart to re-trigger sync.
    const STALL_THRESHOLD_MS = 35_000;
    if (stalledMs > STALL_THRESHOLD_MS) {
      console.log(`[syncWatchdog] local stalled at ${localHead} for ${Math.round(stalledMs/1000)}s with ${peers} peer(s) → restarting Nethermind sync`);
      const specPath = path.join(DATA_DIR, 'chainspec.json');
      try {
        await startNethermindSyncOnly(specPath, config.enodeUrl, /*clearDb*/ false);
        // Reset state so we don't immediately re-trigger
        syncWatchdogState.lastBlock = -1;
        syncWatchdogState.stillSinceMs = Date.now();
      } catch (e) {
        console.warn('[syncWatchdog] restart failed:', e.message);
      }
    }
  } catch (e) {
    if (!String(e?.message || '').includes('connect')) {
      console.warn('[syncWatchdog] error:', e.message);
    }
  } finally {
    syncWatchdogBusy = false;
  }
}
setInterval(syncWatchdog, 10_000);

app.get('/api/fees', async (req, res) => {
  try {
    // Refresh opportunistically
    scanFees();
    const weiToEth = w => {
      try { return web3.utils.fromWei(String(w), 'ether'); } catch { return '0'; }
    };
    const perValidator = Object.entries(feeState.perValidator || {})
      .map(([addr, wei]) => ({ address: addr, feesWei: wei, feesEth: weiToEth(wei) }))
      .sort((a, b) => (BigInt(b.feesWei) > BigInt(a.feesWei) ? 1 : -1));
    res.json({
      lastScannedBlock: feeState.lastScanned,
      totalFeesWei: feeState.totalWei || '0',
      totalFeesEth: weiToEth(feeState.totalWei || '0'),
      perValidator,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function nodeAlive() {
  try { await web3.eth.getBlockNumber(); return true; }
  catch { return false; }
}

// Get a safe gas-price for outbound txs. `web3.eth.getGasPrice()` queries the
// local Nethermind, but on a sync-only node (no `--Blocks.MinGasPrice`) the
// reply is 0. Using gasPrice=0 makes the tx propagate to the producing peer
// where it sits in the mempool forever — the producer's MinGasPrice filter
// won't include it. Floor every tx at 1 gwei so this can't happen, and
// honor the chain-configured floor when one is known.
const DEFAULT_TX_GAS_PRICE = 1_000_000_000n; // 1 gwei
// v7.0.1: add 10% headroom above minGasPriceWei. Some Nethermind builds reject
// txs whose gasPrice is EXACTLY at the floor (`<=` not `<` comparison) — the
// tx propagates locally but peers silently drop it during gossip. The 10%
// buffer guarantees the tx is strictly above the floor on every node.
async function safeGasPrice() {
  let gp = 0n;
  try { gp = BigInt((await web3.eth.getGasPrice()).toString()); } catch {}
  const baseFloor = (config?.minGasPriceWei) ? BigInt(config.minGasPriceWei) : DEFAULT_TX_GAS_PRICE;
  // 10% headroom = floor * 11 / 10
  const floor = (baseFloor * 11n) / 10n;
  return gp >= floor ? gp : floor;
}

// Get the chain ID for transaction signing.
// IMPORTANT: eth_chainId RPC returns a hardcoded value from the custom PoS plugin
// (47382915) which does NOT match the actual chainspec networkID. Nethermind
// validates TX signatures against the chainspec networkID, so we MUST use
// config.chainId (which matches the generated chainspec) for signing.
// Only fall back to eth_chainId if no config exists.
async function realChainId() {
  if (config?.chainId) return String(config.chainId);
  try { return String(await web3.eth.getChainId()); }
  catch { return '1'; }
}

// Send a signed transaction using raw RPC broadcast, then wait & poll receipt.
// Nethermind prunes foreign history, so we CANNOT use web3.eth.sendSignedTransaction
// (it internally waits for a receipt which fails on pruned nodes).
// Instead: broadcast raw → wait >1 block time → poll receipt.
async function sendAndWait(signedRaw, maxWaitMs = 60000) {
  // The hash of the signed tx is deterministic from the raw bytes — we can
  // compute it locally so that even if the broadcast comes back with an
  // "AlreadyKnown" error (the user clicked submit twice; the tx is already
  // in the mempool from a previous click) we still know which tx to wait on.
  const localHash = web3.utils.keccak256(signedRaw);

  // v7.7.4: when this node is an operator, ALSO push the raw tx straight
  // to the admin's RPC. Operators run Nethermind with --OnlyStaticPeers
  // and Mining=false; our patched eth/68 build sometimes fails to gossip
  // NewPooledTransactionHashes back to the admin in time for inclusion,
  // leaving the tx pending forever in the operator's local mempool.
  // Forwarding via HTTP guarantees the admin sees every tx the operator
  // submits regardless of P2P-gossip state. Fire-and-forget — local
  // submission below is still the source of truth.
  try {
    if (config?.role === 'operator' && config?.adminBootstrapUrl) {
      // v7.9.7 — handle both URL shapes:
      //   * Plain http://host:3000  -> http://host:8545
      //   * Caddy-fronted https://host -> https://host/rpc  (Caddy routes
      //     /rpc to the RPC proxy on :8545; :8545 isn't publicly exposed)
      // Previous v7.7.4 only handled the http:port-substitution case, so
      // HTTPS-Caddy admins saw forwards land on /, which serves the
      // dashboard HTML and the tx never reached the RPC.
      const base = String(config.adminBootstrapUrl).replace(/\/+$/, '');
      const adminRpc = base.startsWith('https://')
        ? base + '/rpc'
        : base.replace(/:3000$/, ':8545');
      fetch(adminRpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [signedRaw], id: 1 }),
      }).then(r => r.json()).then(j => {
        if (j?.result) console.log('[sendAndWait] operator forwarded tx to admin:', j.result);
        else if (j?.error?.message && !/already known|AlreadyKnown/i.test(j.error.message))
          console.warn('[sendAndWait] admin forward rejected:', j.error.message);
      }).catch(() => {});
    }
  } catch {}

  // Step 1 — Broadcast via low-level eth_sendRawTransaction (fire-and-forget)
  let txHash;
  // STRICT match — only treat the literal "AlreadyKnown" / "already in pool"
  // family as success. Errors like "insufficient funds", "nonce too low",
  // "intrinsic gas too low" must surface to the user. Previous regex was
  // too loose and caught real failures.
  const looksAlreadyKnown = (msg) =>
    /^AlreadyKnown\b|already known|already exists|already in the (pool|mempool)|already queued/i.test(msg || '');
  // Failure patterns that must NEVER be silently swallowed.
  const looksFatal = (msg) =>
    /insufficient (funds|balance)|nonce too low|underpriced|intrinsic gas too low|gas price (too low|below minimum)|invalid signature|exceeds block gas limit/i.test(msg || '');
  try {
    const response = await web3.currentProvider.request({
      method: 'eth_sendRawTransaction',
      params: [signedRaw],
    });
    // Provider returns full JSON-RPC response: {jsonrpc, result, id} or
    // {jsonrpc, error, id}. Handle both, plus the case where the provider
    // returns just the hash string.
    if (typeof response === 'string') {
      txHash = response;
    } else if (response?.result) {
      txHash = response.result;
    } else if (response?.error) {
      // Nethermind returns code -32010 + message "AlreadyKnown" when the
      // exact same signed tx was previously submitted. That's not an error
      // for our purposes — the tx is in the mempool / already mined.
      // Fall through to receipt polling using the locally-computed hash.
      // BUT: fatal errors (insufficient funds, nonce too low, etc.) must
      // ALWAYS surface — the previous regex was too permissive.
      const code = response.error.code;
      const msg  = response.error.message || '';
      if (looksFatal(msg)) {
        // Hard failure — the tx will never enter the mempool. Surface it.
        throw new Error(msg ? `${msg} (code ${code})` : ('JSON-RPC error code ' + code));
      } else if (code === -32010 || looksAlreadyKnown(msg)) {
        txHash = localHash;
        console.log(`[sendAndWait] tx already known to node, using local hash ${localHash}`);
      } else {
        throw new Error(msg ? `${msg} (code ${code})` : ('JSON-RPC error code ' + code));
      }
    } else {
      throw new Error('Unexpected provider response: ' + JSON.stringify(response));
    }
  } catch (err) {
    const msg = err?.message || String(err);
    if (looksFatal(msg)) {
      // Hard failure — re-throw with the original message preserved.
      throw err;
    }
    // Provider library may bubble up "AlreadyKnown" as a plain Error too.
    if (looksAlreadyKnown(msg)) {
      const m = msg.match(/0x[0-9a-fA-F]{64}/);
      txHash = m ? m[0] : localHash;
      console.log(`[sendAndWait] tx already known (caught), using hash ${txHash}`);
    } else {
      throw err;
    }
  }
  console.log(`[sendAndWait] TX broadcast OK, hash: ${txHash}`);

  // Step 2 — Wait 8 seconds (block period is 5s, give extra margin)
  console.log('[sendAndWait] Waiting 8s for block inclusion...');
  await new Promise(r => setTimeout(r, 8000));

  // Step 3 — Poll for receipt with retries
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const receipt = await web3.eth.getTransactionReceipt(txHash);
      if (receipt) {
        console.log(`[sendAndWait] Receipt found for ${txHash}`);
        return receipt;
      }
    } catch (e) {
      const msg = e?.message || '';
      if (msg.includes('pruned') || msg.includes('not found') || msg.includes('foreign')) {
        // Receipt was pruned — TX was mined but history is gone
        console.log(`[sendAndWait] Receipt pruned for ${txHash}, returning minimal receipt`);
        return { transactionHash: txHash, contractAddress: null, status: 1n, _pruned: true };
      }
    }
    // Wait another block period before retrying
    await new Promise(r => setTimeout(r, 5000));
  }
  // Timed out but TX was definitely sent
  console.log(`[sendAndWait] Timed out waiting for receipt of ${txHash}`);
  return { transactionHash: txHash, contractAddress: null, status: 1n, _pruned: true };
}

// Deterministic CREATE-address derivation. The EVM computes the address of
// a contract deployed via CREATE as keccak256(rlp([sender, nonce]))[-20:].
// We use this when a deploy succeeded but the receipt didn't surface the
// contractAddress field (Nethermind sometimes prunes or returns the receipt
// before the deploy is fully indexed).
// Note: `rlp` is required further down at module load and is therefore
// available by the time any HTTP handler invokes this helper.
function computeCreateAddress(sender, nonce) {
  const senderBytes = Buffer.from(String(sender).replace(/^0x/i, ''), 'hex');
  if (senderBytes.length !== 20) throw new Error('sender must be a 20-byte address');
  const nonceBig = BigInt(nonce);
  let nonceBytes;
  if (nonceBig === 0n) {
    nonceBytes = Buffer.alloc(0); // RLP encodes 0 as the empty byte string
  } else {
    let h = nonceBig.toString(16);
    if (h.length % 2) h = '0' + h;
    nonceBytes = Buffer.from(h, 'hex');
  }
  const encoded = Buffer.from(rlp.encode([senderBytes, nonceBytes]));
  const hash = web3.utils.keccak256('0x' + encoded.toString('hex'));
  return web3.utils.toChecksumAddress('0x' + hash.slice(-40));
}

// ── Chainspec Generation ───────────────────────────────────────────
function makeChainspec(o) {
  const cid  = '0x' + parseInt(o.chainId).toString(16);
  const addr = o.validatorAddr.toLowerCase().replace('0x','');
  const extra = '0x' + '00'.repeat(32) + addr + '00'.repeat(65);
  const bal  = '0x' + (BigInt(o.initialBalance) * 10n**18n).toString(16);
  return {
    name: o.chainName,
    engine: { pos: { params: {
      period: parseInt(o.blockPeriod),
      epoch: 30000,
      transitionBlock: parseInt(o.transitionBlock),
      // Block-creation reward is ZERO. Per the APOS design, validators do
      // not earn anything for producing blocks — they earn only their share
      // of transaction fees, distributed by the UNPRegistry contract after
      // they apply, stake, and the admin approves them.
      reward: "0x0",
      // v7.11.3 — enable relayer-attribution from block 1. Without this,
      // _relayerAttributionBlock stays 0 in APOSFeeDistributor and the
      // entire URELAY1/attestation pipeline is bypassed (every tx falls
      // back to equal-split among active validators).
      relayerAttributionBlock: 1
    }}},
    params: {
      accountStartNonce:"0x0",eip98Transition:"0x0",eip140Transition:"0x0",
      eip145Transition:"0x0",eip150Transition:"0x0",eip155Transition:"0x0",
      eip158Transition:"0x0",eip160Transition:"0x0",eip161abcTransition:"0x0",
      eip161dTransition:"0x0",eip211Transition:"0x0",eip214Transition:"0x0",
      eip658Transition:"0x0",eip1014Transition:"0x0",eip1052Transition:"0x0",
      eip1283Transition:"0x0",gasLimitBoundDivisor:"0x400",
      homesteadTransition:"0x0",kip4Transition:"0x0",kip6Transition:"0x0",
      maxCodeSize:"0x100000",maxCodeSizeTransition:"0x0",
      // v8.0 — default Ethereum gas system. Istanbul + Berlin + London all
      // active from genesis: EIP-1559 base-fee market (base fee BURNED like
      // mainnet; producer keeps only the priority tip, which the APOS hook
      // then splits validator-tier/admin), BASEFEE opcode, access-list txs,
      // CHAINID opcode, modern gas metering. Shanghai/PUSH0 intentionally
      // NOT enabled — system contracts are compiled for evmVersion=paris.
      // NOTE: do NOT add eip1706Transition alongside eip2200Transition —
      // Nethermind rejects the pair ("same meaning") and refuses the spec.
      eip1344Transition:"0x0",eip1884Transition:"0x0",
      eip2028Transition:"0x0",eip2200Transition:"0x0",eip2565Transition:"0x0",
      eip2929Transition:"0x0",eip2930Transition:"0x0",
      eip1559Transition:"0x0",eip3198Transition:"0x0",
      eip3529Transition:"0x0",eip3541Transition:"0x0",
      // v7.3.1: bumped from 0x100 (256B) to 0x10000 (65 KB) to accommodate
      // the relayer-attestation prefix inside block.ExtraData. Each
      // attestation is 117 bytes; 65 KB headroom = up to ~559 attestations
      // per block (= up to 559 relayer-attributed txs per block).
      maximumExtraDataSize:"0x10000",minGasLimit:"0x1388",
      networkID: cid, validateReceipts:true,
      validateReceiptsTransition:"0x0",wasmActivationTransition:"0x0"
    },
    genesis: {
      difficulty:"0x1", gasLimit:"0x2FAF080",
      // EIP-1559 active at genesis → genesis block declares its base fee
      // (1 gwei, the Ethereum London launch default; adjusts per-block by
      // the standard +-12.5% rule afterwards).
      baseFeePerGas:"0x3B9ACA00",
      parentHash:"0x"+"0".repeat(64),
      timestamp:"0x"+Math.floor(Date.now()/1000).toString(16),
      extraData: extra,
      seal:{ethereum:{nonce:"0x0000000000000000",mixHash:"0x"+"0".repeat(64)}}
    },
    nodes: [],
    accounts: { [o.validatorAddr.toLowerCase()]: { balance: bal } }
  };
}

// ── Start Nethermind (standalone) ──────────────────────────────────
function stopNode() {
  return new Promise((resolve) => {
    if (!nodeProc) return resolve();
    const proc = nodeProc;
    const timeout = setTimeout(() => {
      console.log('[wizard] Force-killing old Nethermind (timeout)');
      try { proc.kill('SIGKILL'); } catch {}
      resolve();
    }, 15000);
    proc.once('exit', () => { clearTimeout(timeout); resolve(); });
    try { proc.kill('SIGTERM'); } catch {}
    nodeProc = null;
  });
}

async function startNethermind(specPath, validatorKey, extraArgs = []) {
  await stopNode();
  // Small extra delay to ensure DB locks are fully released
  await new Promise(r => setTimeout(r, 2000));
  const key = validatorKey.replace('0x','');
  const minGasPriceWei = (config && config.minGasPriceWei) ? String(config.minGasPriceWei) : '1000000000';
  // Make sure every Nethermind-written path lives under DATA_DIR so a
  // single mounted volume (/data) captures DB, keystore, logs, and the
  // P2P node-key. This is what makes "recreate the container with a new
  // image and DB persists" actually work.
  const keystoreDir = path.join(DATA_DIR, 'keystore');
  const logDir      = path.join(DATA_DIR, 'logs');
  fs.mkdirSync(keystoreDir, { recursive: true });
  fs.mkdirSync(logDir,      { recursive: true });

  // Derive the validator's address from the key and make sure Nethermind
  // has an unlocked keystore entry for it. Without BlockAuthorAccount the
  // PoS engine has nothing to sign blocks AS — Nethermind silently mines
  // zero blocks. (The create-chain flow accidentally works because the
  // chainspec's genesis ExtraData lists the validator address; the
  // sync-convert-pos flow does NOT, because the genesis came from the
  // foreign PoA chain.)
  const acct = web3.eth.accounts.privateKeyToAccount('0x' + key);
  const validatorAddr = acct.address;
  // v7.1.0 (audit I-C3): random per-install keystore password instead of the
  // 3-char dictionary literal 'unp'. The password is persisted to a 0600
  // file under DATA_DIR. Anyone who can read the volume now has to brute-
  // force a 32-byte random string (infeasible) instead of a 3-char word.
  const pwdFile = path.join(DATA_DIR, '.kspwd');
  let ksPwd;
  try {
    if (fs.existsSync(pwdFile)) {
      ksPwd = fs.readFileSync(pwdFile, 'utf8').trim();
    }
  } catch {}
  if (!ksPwd || ksPwd === 'unp' || ksPwd.length < 16) {
    ksPwd = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(pwdFile, ksPwd, { mode: 0o600 }); } catch {}
    try { fs.chmodSync(pwdFile, 0o600); } catch {}
  }
  // Drop a V3 keystore JSON if one for this address isn't already on disk.
  // IMPORTANT: web3.eth.accounts.encrypt() is async in web3.js v4 — earlier
  // builds (v1.7, v1.8) wrote `JSON.stringify(<Promise>)` = `"{}"`, which
  // Nethermind then rejected with "Cannot deserialize key", crashing the
  // PoS block producer. We delete any such broken files first, then write
  // a real V3 JSON via `await`.
  try {
    const lower = validatorAddr.toLowerCase().slice(2);
    const matching = fs.readdirSync(keystoreDir).filter(f => f.toLowerCase().endsWith(lower));
    for (const f of matching) {
      const full = path.join(keystoreDir, f);
      let isBroken = false;
      try {
        const obj = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!obj || !obj.crypto || !obj.crypto.ciphertext || !obj.crypto.kdfparams) isBroken = true;
      } catch { isBroken = true; }
      if (isBroken) {
        console.log('[wizard] Removing broken keystore file:', f);
        try { fs.unlinkSync(full); } catch {}
      }
    }
    const stillExisting = fs.readdirSync(keystoreDir).find(f => f.toLowerCase().endsWith(lower));
    if (!stillExisting) {
      const v3 = await web3.eth.accounts.encrypt('0x' + key, ksPwd);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '0Z');
      const filename = `UTC--${ts}--${lower}`;
      fs.writeFileSync(path.join(keystoreDir, filename), JSON.stringify(v3));
      console.log('[wizard] Wrote validator keystore:', filename);
    }
  } catch (e) { console.warn('[wizard] keystore write failed:', e.message); }

  const args = [
    path.join(NM_PATH, 'nethermind.dll'),
    '--config','none',
    '--Init.ChainSpecPath', specPath,
    '--Init.BaseDbPath', path.join(DATA_DIR, 'db'),
    '--Init.LogDirectory', logDir,
    '--Init.EnableUnsecuredDevWallet','true',
    '--Init.IsMining','true',
    '--JsonRpc.Enabled','true',
    '--JsonRpc.Host','127.0.0.1',
    '--JsonRpc.Port', String(NETHERMIND_INTERNAL_RPC_PORT),
    '--JsonRpc.EnabledModules','eth,net,web3,personal,admin,debug,clique',
    '--Mining.Enabled','true',
    '--Blocks.MinGasPrice', minGasPriceWei,
    // v7.1.10: Hybrid pruning keeps state pruning aggressive (disk savings) but
    // preserves full receipt history. The apos-fee worker queries
    // eth_getTransactionReceipt for blocks within its scan window; under the
    // default Full pruning Nethermind would prune receipts too eagerly and
    // drop them mid-scan, causing orphan-credits. Hybrid keeps receipts and
    // the worker can credit reliably.
    '--Pruning.Mode','Hybrid',
    '--KeyStore.KeyStoreDirectory', keystoreDir,
    '--KeyStore.TestNodeKey', key,
    // Tell Nethermind the validator address: who to sign blocks as.
    '--KeyStore.BlockAuthorAccount', validatorAddr,
    '--KeyStore.UnlockAccounts',     validatorAddr,
    '--KeyStore.PasswordFiles',      pwdFile,
    '--Network.DiscoveryPort','30303',
    '--Network.P2PPort','30303',
    // Admin's standalone-but-listenable mode:
    //   - PeerManagerEnabled:true  — required so the node listens on
    //     port 30303 (operators must be able to dial in) and so
    //     `admin_nodeInfo` returns the enode for the bootstrap endpoint.
    //   - DiscoveryEnabled:false   — don't run devp2p / DHT auto-discovery.
    //     This was the main vector for the foreign PoA peer to keep finding
    //     us via global discovery.
    //   - OnlyStaticPeers:false    — accept inbound from anyone who knows
    //     our enode. Operators get the enode via `/api/wizard/bootstrap`,
    //     so this is how they connect. Foreign peer can still find us
    //     ONLY if they cached our enode from before — see the next note.
    //   - We clear /data/db/peers on startup (below) so the previously
    //     cached foreign peer entry is gone and admin doesn't auto-dial it.
    '--Network.OnlyStaticPeers','false',
    '--Init.DiscoveryEnabled','false',
    '--Init.PeerManagerEnabled','true',
    // CRITICAL: disable Nethermind's built-in Merge plugin. It's enabled
    // by default and assumes Ethereum mainnet's PoW->PoS merge: it expects
    // a beacon client (Prysm/Lighthouse) on the Engine API to push blocks.
    // Our chain uses engine.pos in chainspec, which Nethermind detects as
    // post-merge — without a beacon client, gossip-based sync stalls
    // after the initial handshake (the node accepts the snapshot then
    // refuses subsequent blocks). Our custom PoSPlugin handles all PoS
    // logic locally; Merge is dead weight.
    '--Merge.Enabled','false',
    ...extraArgs,
  ];

  // Clear cached peers DB so we don't auto-reconnect to old (foreign) peers
  // from before the chain was converted. Peers will be discovered fresh
  // via inbound dials only (operators connecting via our published enode).
  try {
    const peersPath = path.join(DATA_DIR, 'db', 'peers');
    if (fs.existsSync(peersPath)) {
      fs.rmSync(peersPath, { recursive: true, force: true });
      console.log('[wizard] Cleared cached peers DB at', peersPath);
    }
  } catch (e) { console.warn('[wizard] failed to clear peers DB:', e.message); }
  console.log('[wizard] Validator address (BlockAuthor):', validatorAddr);
  // v7.0.3 SECURITY (audit C4): redact validator private key from log output.
  // The arg list contains --KeyStore.TestNodeKey <hex> in plaintext; logs
  // are persisted on the volume and exposed via /api/wizard/node-logs.
  const _redacted = args.map((a, i) =>
    (i > 0 && /^(0x)?[0-9a-f]{64}$/i.test(a) && /KeyStore|TestNodeKey|Password/i.test(args[i-1]))
      ? '<redacted>' : a);
  console.log('[wizard] Starting Nethermind with args:', _redacted.join(' '));
  nodeProc = spawn('dotnet', args, { stdio: 'pipe', cwd: NM_PATH });
  nodeProc.stdout.on('data', d => process.stdout.write('[node] ' + d));
  nodeProc.stderr.on('data', d => process.stderr.write('[node] ' + d));
  nodeProc.on('exit', code => { console.log(`[node] exit ${code}`); nodeProc = null; });
}

// Start Nethermind in sync-only mode (no mining, connects to bootnode)
async function startNethermindSyncOnly(specPath, bootnode, clearDb = true) {
  await stopNode();
  await new Promise(r => setTimeout(r, 2000));

  // Only clear database on fresh sync start, not on resume
  if (clearDb) {
    const dbPath = path.join(DATA_DIR, 'db');
    if (fs.existsSync(dbPath)) {
      console.log('[wizard] Clearing old database at', dbPath);
      fs.rmSync(dbPath, { recursive: true, force: true });
    }
  }

  // Copy the user's chainspec over the built-in foundation.json so Nethermind
  // uses the correct networkID regardless of how config files resolve internally
  const foundationPath = path.join(NM_PATH, 'chainspec', 'foundation.json');
  try {
    fs.copyFileSync(specPath, foundationPath);
    console.log('[wizard] Copied chainspec to', foundationPath);
  } catch (e) {
    console.log('[wizard] Warning: could not copy chainspec to foundation.json:', e.message);
  }

  // Generate a throwaway key for sync mode
  const acct = web3.eth.accounts.create();
  const tempKey = acct.privateKey.replace('0x','');
  const keystoreDir = path.join(DATA_DIR, 'keystore');
  const logDir      = path.join(DATA_DIR, 'logs');
  fs.mkdirSync(keystoreDir, { recursive: true });
  fs.mkdirSync(logDir,      { recursive: true });
  const args = [
    path.join(NM_PATH, 'nethermind.dll'),
    '--config','none',
    '--Init.ChainSpecPath', specPath,
    '--Init.BaseDbPath', path.join(DATA_DIR, 'db'),
    '--Init.LogDirectory', logDir,
    '--Init.EnableUnsecuredDevWallet','true',
    '--Init.IsMining','false',
    '--JsonRpc.Enabled','true',
    '--JsonRpc.Host','127.0.0.1',
    '--JsonRpc.Port', String(NETHERMIND_INTERNAL_RPC_PORT),
    '--JsonRpc.EnabledModules','eth,net,web3,personal,admin,debug',
    '--Mining.Enabled','false',
    // v7.1.10: Hybrid pruning — see startNethermind for rationale (preserve receipts for apos-fee worker).
    '--Pruning.Mode','Hybrid',
    '--KeyStore.KeyStoreDirectory', keystoreDir,
    '--KeyStore.TestNodeKey', tempKey,
    '--Network.DiscoveryPort','30303',
    '--Network.P2PPort','30303',
    '--Network.MaxActivePeers','50',
    '--Network.StaticPeers', bootnode,
    '--Network.OnlyStaticPeers','true',
    '--Discovery.Bootnodes', bootnode,
    // See startNethermind: same Merge-plugin-stalls-PoS-gossip rationale.
    // Without this, the local node syncs to whatever block the peer
    // advertised at handshake time and then permanently stops accepting
    // new blocks (peer is alive, gossip arrives, but node refuses to
    // advance because it's waiting for a non-existent beacon client).
    '--Merge.Enabled','false',
    // Same reason as in startNethermindOperator: fast/snap sync use
    // PowForwardHeaderProvider which can't find a common ancestor for
    // PoS-signed blocks. Force full sync so each block is downloaded
    // sequentially and validated through our PoSSealValidator.
    '--Sync.FastSync','false',
    '--Sync.SnapSync','false',
    '--Sync.FastBlocks','false',
  ];
  console.log('[wizard] Starting Nethermind in SYNC mode with bootnode:', bootnode);
  nodeProc = spawn('dotnet', args, { stdio: 'pipe', cwd: NM_PATH });
  nodeProc.stdout.on('data', d => process.stdout.write('[node] ' + d));
  nodeProc.stderr.on('data', d => process.stderr.write('[node] ' + d));
  nodeProc.on('exit', code => { console.log(`[node] exit ${code}`); nodeProc = null; });
}

// ═══════════════════════════════════════════════════════════════════
// WIZARD API
// ═══════════════════════════════════════════════════════════════════

// Status — is chain configured? node running?
app.get('/api/wizard/status', async (req, res) => {
  const alive = await nodeAlive();
  let blockNumber = 0, chainId = 0;
  if (alive) {
    try { blockNumber = Number(await web3.eth.getBlockNumber()); } catch {}
    try { chainId     = Number(await web3.eth.getChainId()); } catch {}
  }
  res.json({
    configured: !!config,
    nodeRunning: alive,
    standalone: STANDALONE,
    blockNumber, chainId,
    role: (config && config.role) || process.env.NODE_ROLE || 'admin',
    nodeLabel: (config && config.nodeLabel) || process.env.NODE_LABEL || 'Validator Node',
    rpcUrl: RPC_URL,
    config: config ? {
      chainName: config.chainName, chainId: config.chainId,
      blockPeriod: config.blockPeriod, transitionBlock: config.transitionBlock,
      initialBalance: config.initialBalance, validatorAddress: config.validatorAddress,
      stakingContract: config.stakingContract || null,
      registryAddress: config.registryAddress || null,
      mode: config.mode || 'created',
      role: config.role || 'admin',
      nodeLabel: config.nodeLabel || 'Validator Node',
      clonedFromAdmin: config.clonedFromAdmin || null,
      clonedAt: config.clonedAt || null,
    } : null,
  });
});

// Generate Key
// v7.0.3 SECURITY (audit C1): protect after install. Pre-install the wizard
// flow needs this to seed an initial key — requireAuth auto-bypasses when
// !isProtectedMode().
app.post('/api/wizard/generate-key', requireAuth, (req, res) => {
  const acct = web3.eth.accounts.create();
  res.json({ address: acct.address, privateKey: acct.privateKey });
});

// Create new chain
// v7.0.3 SECURITY (audit C1): post-install reuse of this endpoint would
// rewrite chainspec + validator key. requireAuth auto-bypasses pre-install.
app.post('/api/wizard/create-chain', requireAuth, async (req, res) => {
  try {
    // v7.0 SECURITY: bootstrap-token gate. If WIZARD_BOOTSTRAP_TOKEN env var
    // is set, the wizard's create-chain endpoint requires that token in the
    // request header. Closes the race-condition where a publicly-exposed
    // pre-setup dashboard could be hijacked before the operator finishes
    // the wizard. If env var is unset, behaviour is unchanged (legacy / dev).
    const expected = process.env.WIZARD_BOOTSTRAP_TOKEN;
    if (expected) {
      const got = req.headers['x-wizard-token'] || req.body?.bootstrapToken || '';
      if (got !== expected) {
        return res.status(403).json({ error: 'Wizard requires X-Wizard-Token header (set WIZARD_BOOTSTRAP_TOKEN env var)' });
      }
    }
    const { chainName, chainId, blockPeriod, transitionBlock, initialBalance,
            validatorAddress, adminWalletAddress, adminPassword } = req.body;
    let { validatorKey } = req.body;
    if (!chainName || !chainId || !validatorAddress || !validatorKey)
      return res.status(400).json({ error: 'Missing required fields' });
    // v7.0.4: normalize validatorKey to 0x-prefixed hex. Without this, the
    // apos-fee worker's web3.eth.accounts.privateKeyToAccount(...) throws
    // InvalidPrivateKeyError on every tick — fees never get auto-credited.
    if (typeof validatorKey === 'string' && !validatorKey.startsWith('0x')) {
      validatorKey = '0x' + validatorKey;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(validatorKey))
      return res.status(400).json({ error: 'Invalid validatorKey — must be 32-byte hex (with or without 0x prefix)' });
    // Admin password is optional when an MetaMask admin-wallet address is
    // provided — the chain's admin sign-in is then bound to that wallet
    // (server verifies the signed nonce against it). Either auth method
    // alone is sufficient. If NEITHER is provided, refuse — the chain
    // would have no admin login at all.
    const mmAddr = (adminWalletAddress || '').toString().trim();
    const hasMm = /^0x[0-9a-fA-F]{40}$/.test(mmAddr);
    const hasPwd = adminPassword && String(adminPassword).length >= 4;
    if (!hasMm && !hasPwd)
      return res.status(400).json({ error: 'Need either a MetaMask admin wallet OR an admin password (min 4 chars)' });

    const spec = makeChainspec({ chainName, chainId, blockPeriod: blockPeriod||5,
      transitionBlock: transitionBlock||10000, validatorAddr: validatorAddress,
      initialBalance: initialBalance||1000 });
    const specPath = path.join(DATA_DIR, 'chainspec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

    // v7.5.1: auto-detect publicHost from the Host header the user reached
    // the wizard with. The /bootstrap endpoint can't trust Host blindly
    // (eclipse risk per audit C2), but here the admin is the authenticated
    // request originator so it's safe — and it spares them having to set
    // PUBLIC_HOST env var to stop bootstrap from publishing the docker
    // bridge IP (172.17.0.X) to operators.
    const _hostHeader = String(req.headers.host || '').split(':')[0].trim();
    const _publicHostGuess = (_hostHeader && _hostHeader !== 'localhost' && _hostHeader !== '127.0.0.1')
                              ? _hostHeader : null;
    const cfg = { mode:'created', chainName, chainId:parseInt(chainId),
      blockPeriod:parseInt(blockPeriod||5), transitionBlock:parseInt(transitionBlock||10000),
      initialBalance: String(initialBalance||1000),
      validatorAddress, validatorKey, createdAt:Date.now(),
      minGasPriceWei: '1000000000',
      publicHost: req.body?.publicHost || _publicHostGuess || null,
      // v7.5.1: bridge role can be set during initial wizard. The Bridge
      // tab still works for post-setup edits.
      bridgeMode:     (req.body?.bridgeMode === 'L1' || req.body?.bridgeMode === 'L2') ? req.body.bridgeMode : null,
      bridgePeerHost: (req.body?.bridgePeerHost || '').toString().replace(/^https?:\/\//,'').replace(/:.*$/,'').replace(/\/+$/,'') || null,
      bridgeSecret:   req.body?.bridgeSecret || null,
      bridgePollMs:   Math.max(1000, Math.min(60000, parseInt(req.body?.bridgePollMs || '5000', 10) || 5000)),
    };
    if (hasPwd) {
      // v7.0 SECURITY: scrypt with 32-byte salt + N=2^15 cost. ~75ms per
      // attempt, fully resistant to offline GPU brute-force at typical
      // password lengths.
      const salt = crypto.randomBytes(32).toString('hex');
      cfg.adminPassSalt = salt;
      cfg.adminPassHash = hashPasswordScrypt(String(adminPassword), salt);
    }
    if (hasMm) cfg.adminWalletAddress = mmAddr.toLowerCase();
    saveConfig(cfg);

    // Issue an initial session token so the creator stays logged in
    const token = newToken();
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });

    if (STANDALONE) await startNethermind(specPath, validatorKey);
    res.json({ success: true, token, ttlMs: SESSION_TTL_MS });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Join an existing chain as a NODE OPERATOR (third wizard option).
// Body: {
//   enodeUrl:        admin's enode (for P2P sync),
//   chainspecJson:   the chain's chainspec JSON (paste from admin),
//   privateKey:      optional — operator's signing key, used later for
//                    applying to APOS UNPRegistry as a node.
// }
//
// Starts a LOCAL Nethermind that:
//   - syncs all blocks from admin via P2P
//   - stays connected as a static peer to keep receiving new blocks
//   - is NOT a consensus validator (mining disabled — only the admin /
//     StakingContract validators sign blocks)
//
// The operator's only ways to earn rewards:
//   1. Apply to UNPRegistry as a node (>= minNodeStake), get admin to
//      approve, then earn `feePercentBps` of every tx fee that flows
//      through their RPC.
//   2. Or just run the node as a private RPC with no APOS registration —
//      they earn nothing, which is also fine.
// v7.0.3 SECURITY (audit C1): require auth post-install.
app.post('/api/wizard/connect', requireAuth, async (req, res) => {
  try {
    const { enodeUrl, chainspecJson, privateKey, adminWalletAddress,
            adminBootstrapUrl, stakingContract, aposRegistry,
            minGasPriceWei,
            startNode } = req.body || {};
    if (!enodeUrl) return res.status(400).json({ error: 'Admin enode URL is required (enode://...@host:30303)' });
    if (!enodeUrl.startsWith('enode://')) return res.status(400).json({ error: 'Invalid enode URL — must start with enode://' });
    if (!chainspecJson) return res.status(400).json({ error: 'Chainspec JSON is required (copy it from the admin node)' });

    // Validate + save chainspec
    let spec;
    try { spec = JSON.parse(chainspecJson); }
    catch (e) { return res.status(400).json({ error: 'Invalid chainspec JSON: ' + e.message }); }
    const specPath = path.join(DATA_DIR, 'chainspec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

    // Validator/operator key (optional — only needed for APOS staking later)
    let cleanKey = null;
    if (privateKey) {
      const k = privateKey.replace(/^0x/i, '').trim();
      if (!/^[0-9a-f]{64}$/i.test(k)) return res.status(400).json({ error: 'Invalid private key — must be 64 hex chars' });
      cleanKey = '0x' + k;
    }

    const nid = spec?.params?.networkID || spec?.params?.chainId;
    const networkId = nid ? parseInt(nid, 16) : 0;
    const period = spec?.engine?.pos?.params?.period
                || spec?.engine?.clique?.params?.period
                || spec?.engine?.aura?.params?.stepDuration || 5;

    // v7.5.1: auto-detect publicHost so this operator's bootstrap endpoint
    // (and any future operators that join via /api/wizard/operator/refresh-from-admin)
    // get a routable enode instead of the docker bridge IP.
    const _hostHeader = String(req.headers.host || '').split(':')[0].trim();
    const _publicHostGuess = (_hostHeader && _hostHeader !== 'localhost' && _hostHeader !== '127.0.0.1')
                              ? _hostHeader : null;
    const cfg = {
      mode: 'node',
      role: 'operator',
      nodeLabel: 'Node Operator',
      chainName: spec?.name || 'Joined Chain',
      chainId: networkId,
      blockPeriod: parseInt(period),
      publicHost: req.body?.publicHost || _publicHostGuess || null,
      adminEnode: enodeUrl,
      adminBootstrapUrl: adminBootstrapUrl || null,
      // Inherit admin's contract addresses so the operator's Staking and
      // APOS-apply flows know where to point. Caller may pass them
      // explicitly, or we resolve them via the admin's bootstrap URL.
      stakingContract: stakingContract || null,
      aposRegistry: aposRegistry || null,
      // Inherit the chain's enforced minimum gas price so operator's
      // Nethermind boots with --Blocks.MinGasPrice and rejects sub-min
      // txs at the RPC layer rather than letting them rot in mempool.
      minGasPriceWei: (minGasPriceWei && /^\d+$/.test(String(minGasPriceWei))) ? String(minGasPriceWei) : null,
      validatorKey: cleanKey,
      validatorAddress: cleanKey ? web3.eth.accounts.privateKeyToAccount(cleanKey).address : null,
      // Optional MetaMask address — when present, /admin sign-in for THIS
      // operator node accepts the MetaMask wallet (in addition to whichever
      // sealer key, if any, was provided). Server side authorizedAdminAddresses()
      // pulls this in.
      adminWalletAddress: (adminWalletAddress && /^0x[0-9a-fA-F]{40}$/.test(adminWalletAddress))
        ? adminWalletAddress.toLowerCase()
        : null,
      connectedAt: Date.now(),
    };
    saveConfig(cfg);

    // Start a local Nethermind that syncs from the admin's enode.
    // Mining is OFF — operator nodes don't sign blocks (only the admin /
    // staked validators do). Peer discovery / manager are also OFF;
    // the only peer is the admin, configured statically.
    // Caller may pass startNode:false to defer start (e.g. when the next
    // step is /clone-from-admin which will stop the node, wipe the DB,
    // and start Nethermind itself with the cloned data).
    if (STANDALONE && startNode !== false) {
      await startNethermindOperator(specPath, enodeUrl);
    }

    res.json({ success: true, mode: 'node', role: 'operator',
               chainName: cfg.chainName, chainId: cfg.chainId });
  } catch (err) { res.status(500).json({ error: 'Cannot connect: ' + err.message }); }
});

// Start Nethermind as an operator/observer node. Syncs from the admin's
// enode and stays connected (static peers only). No mining — the operator
// is not a consensus validator.
async function startNethermindOperator(specPath, adminEnode) {
  await stopNode();
  await new Promise(r => setTimeout(r, 2000));

  const keystoreDir = path.join(DATA_DIR, 'keystore');
  const logDir      = path.join(DATA_DIR, 'logs');
  fs.mkdirSync(keystoreDir, { recursive: true });
  fs.mkdirSync(logDir,      { recursive: true });

  // v7.4.3: operator's validatorKey is now ALSO the block-sealing key when
  // they stake into the StakingContract. PoSSealer.CanSeal returns false
  // when operator isn't in activeValidators, so it's safe to set up the
  // signer eagerly — Nethermind just doesn't produce blocks until stake
  // happens, then it joins the round-robin without restart.
  let validatorKey = config?.validatorKey || null;
  if (validatorKey && String(validatorKey).startsWith('enc:v1:')) {
    try { validatorKey = _decryptKey(validatorKey); } catch { validatorKey = null; }
  }
  const validatorAddr = config?.validatorAddress || null;
  const miningEnabled = !!(validatorKey && validatorAddr);

  // Write the validator's keystore file + password if we have a key.
  let pwdFile = null;
  if (miningEnabled) {
    try {
      const acct = web3.eth.accounts.privateKeyToAccount(validatorKey);
      const kspass = config?.validatorKeyPassphrase || 'unpchain';
      const ksJson = await acct.encrypt(kspass);
      const ksFile = path.join(keystoreDir, `UTC--${new Date().toISOString().replace(/[:.]/g, '-')}--${acct.address.slice(2).toLowerCase()}`);
      try { fs.writeFileSync(ksFile, JSON.stringify(ksJson)); } catch {}
      pwdFile = path.join(keystoreDir, '.password.txt');
      try { fs.writeFileSync(pwdFile, kspass, { mode: 0o600 }); } catch {}
    } catch (e) {
      console.warn('[operator] keystore setup failed:', e.message);
    }
  }

  // P2P node key — separate from the validator key, just used for libp2p identity.
  const tempAccount = web3.eth.accounts.create();
  const nodeKey = tempAccount.privateKey.replace('0x','');

  const args = [
    path.join(NM_PATH, 'nethermind.dll'),
    '--config','none',
    '--Init.ChainSpecPath', specPath,
    '--Init.BaseDbPath', path.join(DATA_DIR, 'db'),
    '--Init.LogDirectory', logDir,
    '--Init.EnableUnsecuredDevWallet','true',
    '--Init.IsMining', miningEnabled ? 'true' : 'false',
    '--Mining.Enabled', miningEnabled ? 'true' : 'false',
    '--JsonRpc.Enabled','true',
    '--JsonRpc.Host','127.0.0.1',
    '--JsonRpc.Port', String(NETHERMIND_INTERNAL_RPC_PORT),
    '--JsonRpc.EnabledModules','eth,net,web3,personal,admin,debug,clique',
    // v7.1.10: Hybrid pruning — preserve receipts for apos-fee worker (operator
    // also runs the worker; without this, operator's worker hits "Pruned history
    // unavailable" on lookback and orphans credits the same way admin would).
    '--Pruning.Mode','Hybrid',
    '--KeyStore.KeyStoreDirectory', keystoreDir,
    '--KeyStore.TestNodeKey', nodeKey,
    '--Network.DiscoveryPort','30303',
    '--Network.P2PPort','30303',
    '--Network.MaxActivePeers','25',
    '--Network.StaticPeers', adminEnode,
    '--Network.OnlyStaticPeers','true',
    '--Discovery.Bootnodes', adminEnode,
  ];
  // v7.4.3: signer setup for operator-as-producer.
  if (miningEnabled) {
    args.push('--KeyStore.BlockAuthorAccount', validatorAddr);
    args.push('--KeyStore.UnlockAccounts',     validatorAddr);
    if (pwdFile) args.push('--KeyStore.PasswordFiles', pwdFile);
  }
  args.push(...[
    // Force FULL SYNC. Nethermind's auto-selected fast/snap sync paths
    // use PowForwardHeaderProvider, which can't find a common ancestor
    // for our custom-PoS-signed blocks (it expects PoW total-difficulty
    // semantics). Forcing FullSync makes the operator download every
    // block sequentially via BlockDownloader, validating each through
    // our PoSSealValidator — which DOES understand the engine.
    '--Sync.FastSync', 'false',
    '--Sync.SnapSync', 'false',
    '--Sync.FastBlocks', 'false',
    // See startNethermind/startNethermindSyncOnly for the rationale:
    // Merge plugin assumes a beacon client and stalls gossip-based sync
    // on PoS chains without one. Disable so live syncing keeps working.
    '--Merge.Enabled','false',
  ]);
  // Inherit the chain's min gas price so the operator's RPC enforces it
  // for incoming eth_sendRawTransaction. Without this, sub-minimum txs
  // get accepted into the operator's mempool and propagated to admin,
  // who then refuses to include them — they sit pending forever.
  const opMinGas = (config && config.minGasPriceWei) ? String(config.minGasPriceWei) : null;
  if (opMinGas) {
    args.push('--Blocks.MinGasPrice', opMinGas);
  }
  console.log('[wizard] Starting Nethermind in OPERATOR mode, peering with admin:', adminEnode, opMinGas ? `(MinGasPrice=${opMinGas})` : '(no MinGasPrice configured)');
  nodeProc = spawn('dotnet', args, { stdio: 'pipe', cwd: NM_PATH });
  nodeProc.stdout.on('data', d => process.stdout.write('[node] ' + d));
  nodeProc.stderr.on('data', d => process.stderr.write('[node] ' + d));
  nodeProc.on('exit', code => { console.log(`[node] exit ${code}`); nodeProc = null; });
}

// ──────────────────────────────────────────────────────────────────
// Sync with PoA Blockchain & Convert to PoS — Workflow Endpoints
// User enters a PoA peer enode URL → sync all blocks → deploy
// staking contract → generate wallet → transfer ETH → stake →
// disconnect from PoA → continue as independent PoS validator.
// ──────────────────────────────────────────────────────────────────

// Step 1: Start syncing from a PoA peer
// v7.0.3 SECURITY (audit C1): require auth post-install.
app.post('/api/wizard/sync-start', requireAuth, async (req, res) => {
  try {
    const { enodeUrl, chainspecJson } = req.body;
    if (!enodeUrl) return res.status(400).json({ error: 'Enode URL is required' });
    if (!chainspecJson) return res.status(400).json({ error: 'Chainspec JSON is required' });

    // Validate enode URL format
    if (!enodeUrl.startsWith('enode://'))
      return res.status(400).json({ error: 'Invalid enode URL. Must start with enode://' });

    // Save the chainspec
    let spec;
    try { spec = JSON.parse(chainspecJson); } catch (e) {
      return res.status(400).json({ error: 'Invalid chainspec JSON: ' + e.message });
    }
    const specPath = path.join(DATA_DIR, 'chainspec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

    // Extract chain info
    const nid = spec?.params?.networkID || spec?.params?.chainId;
    const networkId = nid ? parseInt(nid, 16) : 0;
    const name = spec?.name || 'Synced Chain';
    const period = spec?.engine?.clique?.params?.period ||
                   spec?.engine?.pos?.params?.period ||
                   spec?.engine?.aura?.params?.stepDuration || 5;

    // Save initial config
    const cfg = {
      mode: 'syncing',
      chainName: name,
      chainId: networkId,
      blockPeriod: parseInt(period),
      enodeUrl,
      syncStartedAt: Date.now(),
    };
    saveConfig(cfg);

    // Reset sync tracker for fresh sync
    syncTracker = { highestBlockEverSeen: 0, prevBlock: 0, slowGrowthCount: 0 };

    // Start Nethermind in sync-only mode
    if (STANDALONE) await startNethermindSyncOnly(specPath, enodeUrl);

    res.json({ success: true, chainName: name, chainId: networkId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 2: Check sync progress.
//
// Bug history: an earlier version declared "synced" after 30 seconds of
// `eth_syncing == false` + slow block growth. That is wrong — Nethermind
// returns `false` during peer handshake, between batches, and while it's
// catching up to the head, NOT only when it actually IS at the head. On a
// chain with 1M+ blocks the wizard would falsely report "100%, sync complete!"
// at block 6503 the moment the node paused for ~30s.
//
// Fix: only declare synced when we have OBSERVED a real network head
// (via `eth_syncing.highestBlock` or a peer's advertised head) AND our
// local block number has caught up to within 5 of it. If we never see
// a real head, we keep saying "syncing..." rather than lie.
async function getPeerHighestBlock() {
  // Best-effort query of `admin_peers` to get the highest block any peer
  // is advertising. Nethermind exposes it via `protocols.eth.head` (a
  // block hash) — we then resolve the hash to a block number. Geth-style
  // peers may expose `protocols.eth.number` directly. Returns 0 if we
  // can't determine.
  try {
    const r = await web3.currentProvider.request({ method: 'admin_peers', params: [] });
    const peers = Array.isArray(r) ? r : (r?.result || []);
    let max = 0;
    for (const p of peers) {
      const eth = p?.protocols?.eth;
      if (!eth) continue;
      // Some implementations expose `number` directly
      if (eth.number !== undefined) {
        const n = (typeof eth.number === 'string' && eth.number.startsWith('0x'))
          ? parseInt(eth.number, 16) : Number(eth.number);
        if (Number.isFinite(n) && n > max) max = n;
        continue;
      }
      // Nethermind: `head` is the block hash; resolve to number if we have it
      const head = eth.head || eth.headBlock;
      if (head && typeof head === 'string' && head.startsWith('0x') && head.length >= 60) {
        try {
          const blk = await web3.eth.getBlock(head);
          if (blk && blk.number !== undefined) {
            const n = Number(blk.number);
            if (Number.isFinite(n) && n > max) max = n;
          }
        } catch { /* peer's head isn't in our DB yet */ }
      }
    }
    return max;
  } catch { return 0; }
}

app.get('/api/wizard/sync-status', async (req, res) => {
  try {
    const alive = await nodeAlive();
    if (!alive) return res.json({ syncing: false, alive: false, currentBlock: 0, highestBlock: 0, isSynced: false });

    const currentBlock = Number(await web3.eth.getBlockNumber());
    let reportedHighest = currentBlock;
    let syncing = false;
    let peers = 0;
    try { peers = Number(await web3.eth.net.getPeerCount()); } catch {}
    try {
      const syncState = await web3.eth.isSyncing();
      if (syncState && typeof syncState === 'object') {
        syncing = true;
        reportedHighest = Number(syncState.highestBlock || currentBlock);
      }
    } catch {}

    // Update our running max from any source that gives us a real number.
    if (reportedHighest > syncTracker.highestBlockEverSeen) {
      syncTracker.highestBlockEverSeen = reportedHighest;
    }
    // Best-effort: ask peers what they think the head is.
    try {
      const peerHead = await getPeerHighestBlock();
      if (peerHead > syncTracker.highestBlockEverSeen) {
        syncTracker.highestBlockEverSeen = peerHead;
      }
    } catch {}

    syncTracker.prevBlock = currentBlock;

    // Track first-time we saw a peer connection. On a brand-new peer
    // handshake the peer might briefly report a stale head (its own
    // startup state) before announcing the real chain head. Give it
    // 60 seconds to settle before we trust any "we're caught up" signal.
    if (peers > 0 && syncTracker.firstPeerSeenAt === undefined) {
      syncTracker.firstPeerSeenAt = Date.now();
    }
    const peerSettledForMs = syncTracker.firstPeerSeenAt
      ? (Date.now() - syncTracker.firstPeerSeenAt) : 0;
    const PEER_SETTLE_MS = 60_000;
    const peerSettled = peerSettledForMs >= PEER_SETTLE_MS;

    const target = syncTracker.highestBlockEverSeen;
    // We require a real, larger-than-current target before we can ever say "done".
    // Otherwise we'd be claiming success against an unknown head.
    const haveTarget = target > Math.max(0, currentBlock - 5);
    const atHead = haveTarget && currentBlock >= target - 5;
    // Synced when:
    //   - we have a peer and have given it time to settle (60s)
    //   - we are within 5 blocks of the highest reported head
    //   - eth_syncing currently returns false (Nethermind agrees)
    // Drops the previous "target stable for 30s" check, which never
    // converged on a chain that produces a block every 15s — the head
    // kept advancing legitimately, resetting the timer forever.
    const isSynced = alive && peers > 0 && !syncing && atHead && peerSettled;

    // Progress: only meaningful when we have a target. While we don't know
    // the head yet, return null so the UI shows an indeterminate spinner
    // instead of a fake 100%.
    let progress = null;
    if (haveTarget) {
      progress = Math.min(100, Math.max(0, Math.round((currentBlock / target) * 100)));
    }

    res.json({
      alive: true,
      syncing,
      isSynced,
      currentBlock,
      highestBlock: target || currentBlock,
      knownTarget: haveTarget,
      peerSettledSec: Math.floor(peerSettledForMs / 1000),
      peerSettleRequiredSec: Math.floor(PEER_SETTLE_MS / 1000),
      peers,
      progress,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 3: Generate a new validator wallet
// v7.0.3 SECURITY (audit C1): require auth post-install.
app.post('/api/wizard/sync-generate-wallet', requireAuth, (req, res) => {
  try {
    const acct = web3.eth.accounts.create();
    res.json({ address: acct.address, privateKey: acct.privateKey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 3b: Derive address from an imported private key
// v7.20 — auth no longer required. The caller already holds the private key
// (they supplied it in the body), so requiring an admin session on top added
// nothing security-wise while breaking the operator key-file sign-in flow
// on already-bootstrapped nodes.
app.post('/api/wizard/derive-address', (req, res) => {
  try {
    let { privateKey } = req.body;
    if (!privateKey) return res.status(400).json({ error: 'Private key is required' });
    let clean = privateKey.replace(/^0x/i, '').trim();
    if (!/^[0-9a-f]{64}$/i.test(clean))
      return res.status(400).json({ error: 'Invalid private key. Must be 64 hex characters.' });
    const account = web3.eth.accounts.privateKeyToAccount('0x' + clean);
    res.json({ address: account.address });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 4: Check balance of an address (used for polling after transfer)
app.get('/api/wizard/sync-check-balance/:address', async (req, res) => {
  try {
    const balance = await web3.eth.getBalance(req.params.address);
    const ethBalance = web3.utils.fromWei(balance.toString(), 'ether');
    res.json({ address: req.params.address, balance: ethBalance, balanceWei: balance.toString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 5: Disconnect all peers (cut ties with PoA network)
// v7.0.3 SECURITY (audit C1): require auth post-install.
app.post('/api/wizard/sync-disconnect', requireAuth, async (req, res) => {
  try {
    let removedCount = 0;
    // Get all connected peers
    try {
      const peersResponse = await web3.currentProvider.request({
        method: 'admin_peers', params: []
      });
      const peers = (typeof peersResponse === 'object' && Array.isArray(peersResponse))
        ? peersResponse
        : (peersResponse?.result || []);
      for (const peer of peers) {
        const enode = peer.enode || peer.id;
        if (enode) {
          try {
            await web3.currentProvider.request({
              method: 'admin_removePeer', params: [enode]
            });
            removedCount++;
          } catch {}
        }
      }
    } catch (e) { console.log('[sync-disconnect] admin_peers error:', e.message); }

    res.json({ success: true, removedPeers: removedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 6: Convert synced node to PoS — stop node, restart as validator with mining.
// Admin MUST provide minStakeEther: the floor every future validator (including
// the admin themselves) has to lock to be allowed to produce blocks. The admin's
// own stake is at least this amount (defaults to exactly minStakeEther).
// v7.0.3 SECURITY (audit C1): require auth post-install — without this an
// unauth caller can rewrite validatorAddress/validatorKey → chain takeover.
app.post('/api/wizard/sync-convert-pos', requireAuth, async (req, res) => {
  // Suspend the sync watchdog for the entire convert flow — it must not
  // restart Nethermind underneath us while we're in the middle of
  // deploying contracts, switching engines, or rewriting chainspec.
  convertInProgress = true;
  try {
    const { privateKey, stakeAmount, minStakeEther, adminWalletAddress } = req.body;
    if (!privateKey) return res.status(400).json({ error: 'Validator private key is required' });
    if (minStakeEther === undefined || minStakeEther === null || minStakeEther === '')
      return res.status(400).json({ error: 'Minimum validator stake (minStakeEther) is required' });
    const minStakeNum = Number(minStakeEther);
    if (!Number.isFinite(minStakeNum) || minStakeNum <= 0)
      return res.status(400).json({ error: 'minStakeEther must be a positive number' });
    // Admin is exempt from the MIN_STAKE floor (auto-active in the contract
    // constructor), so stakeAmount defaults to 0 — admin doesn't need to lock
    // any tokens to be a validator. Subsequent validators must stake
    // >= minStakeEther; the contract enforces that itself.
    const adminStakeNum = (stakeAmount === undefined || stakeAmount === '') ? 0 : Number(stakeAmount);
    if (!Number.isFinite(adminStakeNum) || adminStakeNum < 0)
      return res.status(400).json({ error: `stakeAmount must be >= 0 (admin is exempt from MIN_STAKE)` });

    const cleanKey = privateKey.replace(/^0x/i, '').trim();
    if (!/^[0-9a-f]{64}$/i.test(cleanKey))
      return res.status(400).json({ error: 'Invalid private key. Must be 64 hex characters.' });

    // v7.1.3: refuse to convert while still syncing. Nethermind in sync mode
    // doesn't propagate new mempool entries to peers, so the deploy tx sits
    // on the local node forever and never reaches the producing PoA peer.
    // User has to wait for sync to complete before the deploy can land.
    try {
      const syncing = await web3.eth.isSyncing();
      if (syncing && syncing !== false) {
        const cur = Number(syncing.currentBlock || 0);
        const tgt = Number(syncing.highestBlock || 0);
        return res.status(409).json({
          error: `Local node is still syncing (${cur} / ${tgt}). Wait for sync to complete before converting — Nethermind in sync mode does not propagate tx pool entries to peers, so the deploy tx would never land. Refresh and click Convert again once block height matches the PoA peer's head.`
        });
      }
    } catch { /* if isSyncing RPC fails, proceed (fail-open) */ }

    const account = web3.eth.accounts.privateKeyToAccount('0x' + cleanKey);
    const gasPrice = await safeGasPrice();

    // Step A: Deploy staking contract with admin-set MIN_STAKE
    const minStakeWei = web3.utils.toWei(String(minStakeNum), 'ether');
    // (transitionBlock buffer is set later — see "Step D" below)
    const contract = new web3.eth.Contract(STAKING_ABI);
    const deployData = contract.deploy({ data: STAKING_BYTECODE, arguments: [minStakeWei] }).encodeABI();
    const cid = await realChainId();
    const n1 = await web3.eth.getTransactionCount(account.address);
    const deployGas = 5000000n;
    const adminStakeWeiNum = adminStakeNum > 0
      ? BigInt(web3.utils.toWei(String(adminStakeNum), 'ether'))
      : 0n;
    // Pre-flight balance check. The wizard previously ran the deploy tx
    // even when the validator wallet was empty, the tx sat in the mempool
    // and never mined, but the wizard still proceeded to disconnect peers
    // and restart as PoS — leaving the chain frozen with no validators.
    // Refuse early with a clear message.
    const balWei = BigInt(await web3.eth.getBalance(account.address));
    const minNeeded = deployGas * BigInt(gasPrice.toString())
                    + adminStakeWeiNum
                    // small headroom for the optional stake() tx (300k gas)
                    + (adminStakeNum > 0 ? 300000n * BigInt(gasPrice.toString()) : 0n);
    if (balWei < minNeeded) {
      return res.status(400).json({
        error: `Validator wallet ${account.address} has only ${web3.utils.fromWei(balWei.toString(), 'ether')} ELN — needs at least ${web3.utils.fromWei(minNeeded.toString(), 'ether')} ELN for gas${adminStakeNum > 0 ? ' + stake' : ''}. Fund the validator on the upstream PoA chain (so the funds sync down) before retrying.`
      });
    }
    const dtx = {
      from: account.address, data: deployData, gas: deployGas.toString(),
      gasPrice: gasPrice.toString(), nonce: n1.toString(), chainId: cid
    };
    const ds = await web3.eth.accounts.signTransaction(dtx, '0x' + cleanKey);

    // v7.1.7: derive the upstream PoA RPC URL from the stored enode and
    // ALSO broadcast the deploy tx there. Admin's local Nethermind, while
    // it has been the upstream peer for a sync, doesn't reliably propagate
    // its own mempool entries to the PoA peer (this is a Nethermind sync
    // mode quirk). Without an upstream-side broadcast, the deploy tx can
    // sit in admin's local mempool indefinitely while PoA never sees it.
    // We send to BOTH so whichever path works, the tx mines.
    let upstreamRpcUrl = null;
    try {
      // enode://<id>@<host>:<port>  →  http://<host>:8545
      const enodeMatch = (config?.enodeUrl || '').match(/@([^:]+):/);
      if (enodeMatch) upstreamRpcUrl = `http://${enodeMatch[1]}:8545`;
    } catch {}
    if (upstreamRpcUrl) {
      try {
        const upstreamWeb3 = new (require('web3').Web3 || require('web3'))(upstreamRpcUrl);
        await upstreamWeb3.currentProvider.request({
          method: 'eth_sendRawTransaction', params: [ds.rawTransaction]
        }).catch(e => {
          // AlreadyKnown is expected on retries — swallow it. Other errors
          // we just log and continue with the local-broadcast path.
          const msg = e?.message || e?.error?.message || String(e);
          if (!/already|known|exists/i.test(msg)) {
            console.warn('[sync-convert-pos] upstream broadcast failed:', msg);
          }
        });
        console.log('[sync-convert-pos] deploy tx forwarded to upstream PoA RPC', upstreamRpcUrl);
      } catch (e) {
        console.warn('[sync-convert-pos] upstream web3 init failed:', e.message);
      }
    }
    const dr = await sendAndWait(ds.rawTransaction);
    let contractAddr = dr.contractAddress;
    if (!contractAddr) {
      await new Promise(r => setTimeout(r, 8000));
      try {
        const r2 = await web3.eth.getTransactionReceipt(dr.transactionHash);
        if (r2) contractAddr = r2.contractAddress;
      } catch {}
    }
    // Fallback: receipt sometimes lacks contractAddress when Nethermind
    // returns a pruned-history view or the deploy tx is still in the
    // mempool. CREATE addresses are deterministic from sender+nonce, so
    // we can derive it locally — that's what the EVM itself does.
    if (!contractAddr) {
      try {
        contractAddr = computeCreateAddress(account.address, n1);
        console.log('[sync-convert-pos] derived contract address from sender+nonce:', contractAddr);
      } catch (e) {
        console.warn('[sync-convert-pos] CREATE-address fallback failed:', e.message);
      }
    }
    if (!contractAddr) throw new Error('Could not get contract address. TX: ' + dr.transactionHash);

    // CRITICAL: verify the contract actually exists on-chain before we
    // touch chainspec / disconnect peers / restart as PoS. The deploy tx
    // can sit in the mempool indefinitely if the network is slow or the
    // PoA peer rejected it; if we proceed without a real contract, the
    // PoS engine has no validators to read and the chain freezes.
    //
    // v7.1.7: extended from 30s → 180s. The deploy tx is also sent to the
    // upstream PoA RPC (above), but admin still polls its own local node
    // for the mined block (which arrives via P2P sync). End-to-end:
    //   PoA mines (5s block period) → P2P announce → admin imports block.
    // 30s was too tight when the network was slow; 180s comfortably covers
    // worst case while still surfacing real failures.
    let codePresent = false;
    for (let attempt = 0; attempt < 36; attempt++) {
      try {
        const code = await web3.eth.getCode(contractAddr);
        if (code && code !== '0x' && code !== '0x0') { codePresent = true; break; }
      } catch (e) {
        console.warn('[sync-convert-pos] eth_getCode error:', e.message);
      }
      // Also check the upstream PoA RPC — admin's local view may be
      // pruned/lagging while PoA already has the contract.
      if (upstreamRpcUrl) {
        try {
          const upstreamWeb3 = new (require('web3').Web3 || require('web3'))(upstreamRpcUrl);
          const upCode = await upstreamWeb3.eth.getCode(contractAddr);
          if (upCode && upCode !== '0x' && upCode !== '0x0') { codePresent = true; break; }
        } catch {}
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!codePresent) {
      return res.status(500).json({
        error: `Deploy tx ${dr.transactionHash} did not mine — no contract at ${contractAddr} after 180s. Common causes: validator wallet had insufficient gas, PoA peer offline, or chain stuck. The local chain has NOT been switched to PoS — fix the underlying issue and retry.`
      });
    }

    // Step B (optional): admin stakes some additional amount.
    // The contract's constructor already auto-activates the admin as a
    // validator with zero stake, so this step is purely OPTIONAL — admin
    // only needs to call stake() if they explicitly want to top up their
    // stake. New (non-admin) validators have to stake >= MIN_STAKE; the
    // contract enforces that.
    const sc = new web3.eth.Contract(STAKING_ABI, contractAddr);
    let sr = { transactionHash: null };
    if (adminStakeNum > 0) {
      const n2 = await web3.eth.getTransactionCount(account.address);
      const stx = {
        from: account.address, to: contractAddr,
        data: sc.methods.stake().encodeABI(),
        value: web3.utils.toWei(String(adminStakeNum), 'ether'),
        gas: '300000', gasPrice: gasPrice.toString(),
        nonce: n2.toString(), chainId: cid
      };
      const ss = await web3.eth.accounts.signTransaction(stx, '0x' + cleanKey);
      sr = await sendAndWait(ss.rawTransaction);
    }

    // Step C: Disconnect all peers
    try {
      const peersResponse = await web3.currentProvider.request({
        method: 'admin_peers', params: []
      });
      const peers = Array.isArray(peersResponse) ? peersResponse : (peersResponse?.result || []);
      for (const peer of peers) {
        const enode = peer.enode || peer.id;
        if (enode) {
          try { await web3.currentProvider.request({ method: 'admin_removePeer', params: [enode] }); } catch {}
        }
      }
    } catch {}

    // Step D: Stop node and restart as PoS validator
    const specPath = path.join(DATA_DIR, 'chainspec.json');
    // Read and update chainspec: change engine to PoS, set transitionBlock to
    // current+1 so the very next block produced is the first PoS block. The
    // old +5 buffer caused the chain to FREEZE here: after we disconnect from
    // the PoA peers (above) no new PoA blocks ever arrive, so the chain
    // couldn't reach the transition block and our local validator never got
    // to mine. With +1 the local validator immediately mines the first PoS
    // block.
    let spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const currentBlock = Number(await web3.eth.getBlockNumber());
    const transitionBlock = currentBlock + 1;

    // Convert engine from clique/aura to pos
    const oldPeriod = spec?.engine?.clique?.params?.period ||
                      spec?.engine?.aura?.params?.stepDuration ||
                      spec?.engine?.pos?.params?.period || 5;
    // Preserve the foreign chain's block reward so historical Clique blocks
    // re-execute to the same state root they had on the foreign chain. The
    // PoSRewardCalculator applies this reward ONLY for blocks before
    // transitionBlock; post-transition validators earn only tx fees.
    const foreignReward =
      spec?.engine?.clique?.params?.blockReward
      || spec?.engine?.aura?.params?.blockReward
      || spec?.engine?.pos?.params?.reward
      || spec?.params?.blockReward
      || '0x0'; // many Clique chains have zero block reward — that's fine
    spec.engine = {
      pos: {
        params: {
          period: parseInt(oldPeriod),
          epoch: 30000,
          transitionBlock: transitionBlock,
          reward: foreignReward,
          // v7.3.0 Layer 2 — relayer attribution active from the moment APOS
          // is enabled. Hook only fires post-transitionBlock anyway, so '1'
          // simply means "always on once APOS engages." Operators that don't
          // attach attestations to their txs still work — those txs fall back
          // to equal-split per the L2 hook's per-tx logic. So this enables
          // the new feature without breaking any backwards-compat assumption.
          relayerAttributionBlock: 1,
        }
      }
    };
    // Clear nodes array to remove PoA bootnodes (no longer needed in PoS)
    spec.nodes = [];
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

    // Update config — remove enodeUrl since we no longer sync from PoA
    const nid = spec?.params?.networkID || spec?.params?.chainId;
    const networkId = nid ? parseInt(nid, 16) : 0;
    const cfg = {
      mode: 'pos-converted',
      chainName: spec?.name || config?.chainName || 'Converted Chain',
      chainId: networkId || config?.chainId,
      blockPeriod: parseInt(oldPeriod),
      transitionBlock,
      validatorAddress: account.address,
      validatorKey: '0x' + cleanKey,
      stakingContract: contractAddr,
      validatorMinStakeWei: minStakeWei,
      validatorMinStakeEther: String(minStakeNum),
      // Carry the existing admin password so admins don't need to re-set it.
      adminPassSalt: config?.adminPassSalt,
      adminPassHash: config?.adminPassHash,
      // Carry the existing MetaMask admin wallet (or set a new one if the
      // operator picked the MetaMask path during sync setup).
      adminWalletAddress: (adminWalletAddress && /^0x[0-9a-fA-F]{40}$/.test(adminWalletAddress))
        ? adminWalletAddress.toLowerCase()
        : (config?.adminWalletAddress || null),
      convertedAt: Date.now(),
      // enodeUrl intentionally omitted — PoS runs independently
    };
    saveConfig(cfg);

    // Restart Nethermind as PoS validator (with mining enabled, no bootnodes)
    if (STANDALONE) {
      await startNethermind(specPath, '0x' + cleanKey, [
        '--PoS.StakingContractAddress', contractAddr,
      ]);
    }

    res.json({
      success: true,
      contractAddress: contractAddr,
      deployTx: dr.transactionHash,
      stakeTx: sr.transactionHash,
      transitionBlock,
      validatorAddress: account.address,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { convertInProgress = false; }
});

// Deploy Staking Contract
// Body: { privateKey?, minStakeEther }  — minStakeEther is REQUIRED.
// v7.0.3 SECURITY (audit C1): require auth post-install.
app.post('/api/wizard/deploy-staking', requireAuth, async (req, res) => {
  try {
    const key = req.body.privateKey || config?.validatorKey;
    const { minStakeEther } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Private key required' });
    if (minStakeEther === undefined || minStakeEther === null || minStakeEther === '')
      return res.status(400).json({ error: 'minStakeEther is required' });
    const minStakeNum = Number(minStakeEther);
    if (!Number.isFinite(minStakeNum) || minStakeNum <= 0)
      return res.status(400).json({ error: 'minStakeEther must be a positive number' });
    const minStakeWei = web3.utils.toWei(String(minStakeNum), 'ether');

    const account = web3.eth.accounts.privateKeyToAccount(key);
    const nonce = await web3.eth.getTransactionCount(account.address);
    const gasPrice = await safeGasPrice();
    const contract = new web3.eth.Contract(STAKING_ABI);
    const deployData = contract.deploy({ data: STAKING_BYTECODE, arguments: [minStakeWei] }).encodeABI();
    const cid = await realChainId();
    const tx = { from:account.address, data:deployData, gas:'5000000',
                 gasPrice:gasPrice.toString(), nonce:nonce.toString(),
                 chainId: cid };
    const signed = await web3.eth.accounts.signTransaction(tx, key);
    const receipt = await sendAndWait(signed.rawTransaction);
    // If receipt was pruned, try fetching receipt again after another block
    let contractAddr = receipt.contractAddress;
    if (!contractAddr && receipt._pruned) {
      // Wait another block period and try fetching receipt again
      await new Promise(r => setTimeout(r, 8000));
      try {
        const r2 = await web3.eth.getTransactionReceipt(receipt.transactionHash);
        if (r2) contractAddr = r2.contractAddress;
      } catch {}
    }
    if (!contractAddr) {
      // Deterministic CREATE-address fallback: keccak256(rlp([sender, nonce]))[-20:]
      try {
        contractAddr = computeCreateAddress(account.address, nonce);
        console.log('[deploy-staking] derived contract address from sender+nonce:', contractAddr);
      } catch (e) {
        console.warn('[deploy-staking] CREATE-address fallback failed:', e.message);
      }
    }
    if (config && contractAddr) {
      config.stakingContract = contractAddr;
      config.validatorMinStakeWei = minStakeWei;
      config.validatorMinStakeEther = String(minStakeNum);
      saveConfig(config);
    }
    res.json({ success:true, contractAddress:contractAddr,
               minStakeWei, minStakeEther: String(minStakeNum),
               txHash:receipt.transactionHash });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stake ETH
// v7.0.3 SECURITY (audit C1): require auth post-install.
app.post('/api/wizard/stake', requireAuth, async (req, res) => {
  try {
    const { amount, privateKey } = req.body;
    const key = privateKey || config?.validatorKey;
    if (!key) return res.status(400).json({ error: 'Private key required' });
    if (!config?.stakingContract) return res.status(400).json({ error: 'No staking contract deployed' });
    const account = web3.eth.accounts.privateKeyToAccount(key);
    const contract = new web3.eth.Contract(STAKING_ABI, config.stakingContract);
    const nonce = await web3.eth.getTransactionCount(account.address);
    const gasPrice = await safeGasPrice();
    const cid = await realChainId();
    const tx = { from:account.address, to:config.stakingContract,
                 data:contract.methods.stake().encodeABI(),
                 value:web3.utils.toWei(String(amount),'ether'),
                 gas:'300000', gasPrice:gasPrice.toString(),
                 nonce:nonce.toString(),
                 chainId: cid };
    const signed = await web3.eth.accounts.signTransaction(tx, key);
    const receipt = await sendAndWait(signed.rawTransaction);
    res.json({ success:true, txHash:receipt.transactionHash });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── v7.4.3: Block-Producer Staking (independent of APOS fee-recipient) ───
//
// Two SEPARATE roles:
//   * BLOCK PRODUCER — gated by StakingContract.activeValidators (slot 3).
//     Anyone who stakes >= MIN_STAKE becomes a block producer immediately,
//     no admin approval. PoSSealValidator reads this list at every block.
//
//   * FEE RECIPIENT — gated by UNPRegistry.nodes (slot 18). Requires:
//     (a) operator stakes into one of admin's packages,
//     (b) operator calls applyAsNodeViaPackage,
//     (c) admin calls approveNode.
//     Only then does the L2 hook credit the operator's node-share.
//
// These are intentionally decoupled: you can be a producer without earning
// fees (bare minimum decentralisation), earn fees without producing (passive
// stake), or both (typical operator).

// Stake into the staking contract as a block producer. Requires private key
// (passed in body OR taken from config.validatorKey for self-staking on
// the operator's own dashboard).
app.post('/api/staking/stake-producer', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const { privateKey } = b;
    // ticket #5 follow-up: accept the legacy `amountEther` field name too
    // so older cached clients still validate.
    const amount = b.amount != null ? b.amount : b.amountEther;
    if (!config?.stakingContract) return res.status(400).json({ error: 'No staking contract configured on this chain' });
    if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'amount (ELN) required' });
    let key = privateKey;
    if (!key && config?.validatorKey) {
      key = String(config.validatorKey).startsWith('enc:v1:')
        ? _decryptKey(config.validatorKey)
        : config.validatorKey;
    }
    if (!key) return res.status(400).json({ error: 'privateKey required (or login as the validator)' });
    const contract = new web3.eth.Contract(STAKING_ABI, config.stakingContract);
    const account = web3.eth.accounts.privateKeyToAccount(key);
    const nonce = await web3.eth.getTransactionCount(account.address);
    const gasPrice = await safeGasPrice();
    const cid = await realChainId();
    const tx = {
      from: account.address, to: config.stakingContract,
      data: contract.methods.stake().encodeABI(),
      value: web3.utils.toWei(String(amount), 'ether'),
      gas: '300000', gasPrice: gasPrice.toString(),
      nonce: nonce.toString(), chainId: cid,
    };
    const signed = await web3.eth.accounts.signTransaction(tx, key);
    const receipt = await sendAndWait(signed.rawTransaction);
    // v7.4.3: if this is THIS node's own validator becoming a producer for
    // the first time, restart Nethermind in mining mode so it starts
    // producing on its round-robin turn.
    let restarted = false;
    try {
      if (account.address.toLowerCase() === String(config?.validatorAddress || '').toLowerCase()
          && config?.mode === 'node') {
        setTimeout(() => {
          autoRestartNode({ force: true }).catch(e =>
            console.warn('[staking] restart-after-stake failed:', e?.message));
        }, 500);
        restarted = true;
      }
    } catch {}
    res.json({ success: true, txHash: receipt.transactionHash, staker: account.address, nodeRestartScheduled: restarted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request unstake (begins UNSTAKE_DELAY countdown).
app.post('/api/staking/request-unstake', requireAuth, async (req, res) => {
  try {
    const { privateKey } = req.body || {};
    if (!config?.stakingContract) return res.status(400).json({ error: 'No staking contract' });
    let key = privateKey;
    if (!key && config?.validatorKey) {
      key = String(config.validatorKey).startsWith('enc:v1:')
        ? _decryptKey(config.validatorKey)
        : config.validatorKey;
    }
    if (!key) return res.status(400).json({ error: 'privateKey required' });
    const contract = new web3.eth.Contract(STAKING_ABI, config.stakingContract);
    const account = web3.eth.accounts.privateKeyToAccount(key);
    const nonce = await web3.eth.getTransactionCount(account.address);
    const gasPrice = await safeGasPrice();
    const cid = await realChainId();
    const tx = {
      from: account.address, to: config.stakingContract,
      data: contract.methods.requestUnstake().encodeABI(),
      gas: '200000', gasPrice: gasPrice.toString(),
      nonce: nonce.toString(), chainId: cid,
    };
    const signed = await web3.eth.accounts.signTransaction(tx, key);
    const receipt = await sendAndWait(signed.rawTransaction);
    res.json({ success: true, txHash: receipt.transactionHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read-only: status of one validator in the StakingContract.
app.get('/api/staking/status/:address', async (req, res) => {
  try {
    if (!config?.stakingContract) return res.json({ deployed: false });
    const contract = new web3.eth.Contract(STAKING_ABI, config.stakingContract);
    const v = await contract.methods.validators(req.params.address).call();
    const minStake = await contract.methods.MIN_STAKE().call();
    // ticket #7 (BUG-003): the manager's PoS Staking tab reads stakeWei /
    // minStakeWei; the original response only exposed stake / minStake, so
    // the Your Stake / Min Stake fields rendered "—". Emit both names.
    res.json({
      deployed: true,
      address: req.params.address,
      contractAddress: config.stakingContract,   // lets wallet-connected pages stake client-side
      stake:        String(v.stake),
      stakeWei:     String(v.stake),
      active: Boolean(v.active),
      unstakeRequestBlock: String(v.unstakeRequestBlock),
      minStake:     String(minStake),
      minStakeWei:  String(minStake),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read-only: the full active-validators list. Used by admin's nodes tab to
// cross-reference which APOS-registered nodes are also block producers.
app.get('/api/staking/active-validators', async (req, res) => {
  try {
    if (!config?.stakingContract) return res.json({ deployed: false, validators: [] });
    const contract = new web3.eth.Contract(STAKING_ABI, config.stakingContract);
    // Read activeValidators[] length from slot 3, then enumerate.
    const lenHex = await web3.eth.getStorageAt(config.stakingContract, 3);
    const len = Number(BigInt(lenHex));
    const addrs = [];
    if (len > 0 && len <= 1000) {
      const baseHash = web3.utils.keccak256('0x' + '0000000000000000000000000000000000000000000000000000000000000003');
      for (let i = 0; i < len; i++) {
        const slot = '0x' + (BigInt(baseHash) + BigInt(i)).toString(16);
        const v = await web3.eth.getStorageAt(config.stakingContract, slot);
        const addr = '0x' + v.slice(-40);
        if (addr !== '0x0000000000000000000000000000000000000000') addrs.push(addr);
      }
    }
    // ticket #6 (BUG-002): clients render {address, stakeWei, active} per row,
    // so resolve each address against the StakingContract validators() view.
    const out = [];
    for (const address of addrs) {
      try {
        const v = await contract.methods.validators(address).call();
        out.push({ address, stakeWei: String(v.stake), active: Boolean(v.active) });
      } catch { out.push({ address, stakeWei: '0', active: false }); }
    }
    const minStake = await contract.methods.MIN_STAKE().call();
    res.json({ deployed: true, count: out.length, validators: out, minStake: String(minStake) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full PoS Conversion (deploy + stake in one call)
// Body: { privateKey?, minStakeEther, stakeAmount? }
//   - minStakeEther is REQUIRED — deployed into the StakingContract floor.
//   - stakeAmount defaults to minStakeEther; must be >= minStakeEther.
// v7.0.3 SECURITY (audit C1): require auth post-install.
app.post('/api/wizard/convert-pos', requireAuth, async (req, res) => {
  try {
    const { privateKey, stakeAmount, minStakeEther } = req.body;
    const key = privateKey || config?.validatorKey;
    if (!key) return res.status(400).json({ error: 'Private key required' });
    if (minStakeEther === undefined || minStakeEther === null || minStakeEther === '')
      return res.status(400).json({ error: 'minStakeEther is required' });
    const minStakeNum = Number(minStakeEther);
    if (!Number.isFinite(minStakeNum) || minStakeNum <= 0)
      return res.status(400).json({ error: 'minStakeEther must be a positive number' });
    // Admin is exempt from MIN_STAKE (auto-active in constructor); 0 default.
    const adminStakeNum = (stakeAmount === undefined || stakeAmount === '') ? 0 : Number(stakeAmount);
    if (!Number.isFinite(adminStakeNum) || adminStakeNum < 0)
      return res.status(400).json({ error: 'stakeAmount must be >= 0 (admin is exempt from MIN_STAKE)' });
    const minStakeWei = web3.utils.toWei(String(minStakeNum), 'ether');

    const account = web3.eth.accounts.privateKeyToAccount(key);
    const gasPrice = await safeGasPrice();

    // Step 1 — Deploy with admin-set MIN_STAKE
    const contract = new web3.eth.Contract(STAKING_ABI);
    const deployData = contract.deploy({ data: STAKING_BYTECODE, arguments: [minStakeWei] }).encodeABI();
    const cid = await realChainId();
    const n1 = await web3.eth.getTransactionCount(account.address);
    const deployGas = 5000000n;
    const adminStakeWeiNum = adminStakeNum > 0
      ? BigInt(web3.utils.toWei(String(adminStakeNum), 'ether'))
      : 0n;
    // Pre-flight balance check — see sync-convert-pos for context.
    const balWei = BigInt(await web3.eth.getBalance(account.address));
    const minNeeded = deployGas * BigInt(gasPrice.toString())
                    + adminStakeWeiNum
                    + (adminStakeNum > 0 ? 300000n * BigInt(gasPrice.toString()) : 0n);
    if (balWei < minNeeded) {
      return res.status(400).json({
        error: `Validator wallet ${account.address} has only ${web3.utils.fromWei(balWei.toString(), 'ether')} ELN — needs at least ${web3.utils.fromWei(minNeeded.toString(), 'ether')} ELN for gas${adminStakeNum > 0 ? ' + stake' : ''}.`
      });
    }
    const dtx = { from:account.address, data:deployData, gas: deployGas.toString(),
                  gasPrice:gasPrice.toString(), nonce:n1.toString(),
                  chainId: cid };
    const ds = await web3.eth.accounts.signTransaction(dtx, key);
    const dr = await sendAndWait(ds.rawTransaction);
    console.log('[convert-pos] Deploy TX result:', JSON.stringify({hash: dr.transactionHash, contractAddress: dr.contractAddress, pruned: !!dr._pruned}));
    let contractAddr = dr.contractAddress;
    // If receipt was pruned, wait another block and try again
    if (!contractAddr) {
      console.log('[convert-pos] No contractAddress in receipt, waiting 8s and retrying...');
      await new Promise(r => setTimeout(r, 8000));
      try {
        const r2 = await web3.eth.getTransactionReceipt(dr.transactionHash);
        console.log('[convert-pos] Retry receipt:', JSON.stringify({hash: r2?.transactionHash, contractAddress: r2?.contractAddress}));
        if (r2) contractAddr = r2.contractAddress;
      } catch (retryErr) {
        console.log('[convert-pos] Retry receipt error:', retryErr?.message);
      }
    }
    if (!contractAddr) {
      // Deterministic CREATE-address fallback: keccak256(rlp([sender, nonce]))[-20:]
      try {
        contractAddr = computeCreateAddress(account.address, n1);
        console.log('[convert-pos] derived contract address from sender+nonce:', contractAddr);
      } catch (e) {
        console.warn('[convert-pos] CREATE-address fallback failed:', e.message);
      }
    }
    if (!contractAddr) throw new Error('Could not get contract address. TX: ' + String(dr.transactionHash) + '. Please retry.');

    // Verify the contract actually exists on-chain. If the deploy tx is
    // still in the mempool the EVM-derived address points to empty code,
    // and writing it into config would leave the chain unable to read its
    // validator set after the PoS engine restarts.
    let codePresent = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const code = await web3.eth.getCode(contractAddr);
        if (code && code !== '0x' && code !== '0x0') { codePresent = true; break; }
      } catch (e) {
        console.warn('[convert-pos] eth_getCode error:', e.message);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!codePresent) {
      return res.status(500).json({
        error: `Deploy tx ${dr.transactionHash} did not mine — no contract at ${contractAddr} after 30s. The chain has NOT been switched to PoS.`
      });
    }

    if (config) {
      config.stakingContract = contractAddr;
      config.validatorMinStakeWei = minStakeWei;
      config.validatorMinStakeEther = String(minStakeNum);
      saveConfig(config);
    }

    // Step 2 (optional) — Admin tops up their stake. The contract already
    // auto-activates the admin in its constructor with zero stake, so this
    // call is only needed if the admin explicitly set stakeAmount > 0.
    const sc = new web3.eth.Contract(STAKING_ABI, contractAddr);
    let sr = { transactionHash: null };
    if (adminStakeNum > 0) {
      const n2 = await web3.eth.getTransactionCount(account.address);
      const stx = { from:account.address, to:contractAddr,
                    data:sc.methods.stake().encodeABI(),
                    value:web3.utils.toWei(String(adminStakeNum),'ether'),
                    gas:'300000', gasPrice:gasPrice.toString(),
                    nonce:n2.toString(), chainId: cid };
      const ss = await web3.eth.accounts.signTransaction(stx, key);
      sr = await sendAndWait(ss.rawTransaction);
    }

    res.json({ success:true, contractAddress:contractAddr,
               deployTx:dr.transactionHash, stakeTx:sr.transactionHash });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Force-activate PoS: when sync-convert-pos was run on an older build that
// set transitionBlock = currentBlock + 5, the chain can freeze short of
// transition because (a) we disconnected from PoA peers so no more PoA
// blocks arrive, and (b) PoS doesn't kick in until transitionBlock is
// reached. This endpoint rewrites the on-disk chainspec so transitionBlock
// = current head + 1 and restarts Nethermind, making the local validator
// mine the very next block as PoS.
app.post('/api/wizard/force-activate-pos', requireAuth, async (req, res) => {
  try {
    if (!config) return res.status(400).json({ error: 'No chain configured' });
    if (config.mode !== 'pos-converted')
      return res.status(400).json({ error: 'Only valid in pos-converted mode (mode=' + config.mode + ')' });
    if (!config.validatorKey) return res.status(400).json({ error: 'No validator key in config' });
    const specPath = path.join(DATA_DIR, 'chainspec.json');
    if (!fs.existsSync(specPath)) return res.status(400).json({ error: 'Chainspec not found' });

    const currentBlock = Number(await web3.eth.getBlockNumber()).valueOf();
    let spec;
    try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
    catch (e) { return res.status(500).json({ error: 'Bad chainspec: ' + e.message }); }

    const newTransition = currentBlock + 1;
    if (!spec.engine || !spec.engine.pos) {
      // Chain isn't in PoS mode in the chainspec — fix that too.
      // Reward = 0: validators earn no block-creation reward; all chain
      // economics live in the APOS UNPRegistry post-transition.
      const period = spec?.engine?.clique?.params?.period || spec?.engine?.aura?.params?.stepDuration || config?.blockPeriod || 5;
      spec.engine = { pos: { params: {
        period: parseInt(period), epoch: 30000,
        transitionBlock: newTransition, reward: '0x0',
      } } };
    } else {
      spec.engine.pos.params = spec.engine.pos.params || {};
      spec.engine.pos.params.transitionBlock = newTransition;
    }
    spec.nodes = []; // peers no longer matter
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
    config.transitionBlock = newTransition;
    saveConfig(config);

    if (STANDALONE) {
      const extraArgs = config.stakingContract
        ? ['--PoS.StakingContractAddress', config.stakingContract]
        : [];
      await startNethermind(specPath, config.validatorKey, extraArgs);
    }
    res.json({ success: true, currentBlock, newTransitionBlock: newTransition });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: update the minimum validator stake on a deployed StakingContract.
// Body: { newMinEther, privateKey? }  — privateKey defaults to validator key.
app.post('/api/wizard/staking/set-min-stake', requireAuth, async (req, res) => {
  try {
    const { newMinEther, privateKey } = req.body || {};
    if (!config?.stakingContract) return res.status(400).json({ error: 'No staking contract deployed' });
    if (newMinEther === undefined || newMinEther === null || newMinEther === '')
      return res.status(400).json({ error: 'newMinEther required' });
    const newNum = Number(newMinEther);
    if (!Number.isFinite(newNum) || newNum <= 0)
      return res.status(400).json({ error: 'newMinEther must be a positive number' });
    const key = privateKey || config?.validatorKey;
    if (!key) return res.status(400).json({ error: 'Private key required' });
    const account = web3.eth.accounts.privateKeyToAccount(key);
    const sc = new web3.eth.Contract(STAKING_ABI, config.stakingContract);
    const newWei = web3.utils.toWei(String(newNum), 'ether');
    const cid = await realChainId();
    const nonce = await web3.eth.getTransactionCount(account.address);
    const gasPrice = await safeGasPrice();
    const tx = {
      from: account.address, to: config.stakingContract,
      data: sc.methods.setMinStake(newWei).encodeABI(),
      gas: '120000', gasPrice: gasPrice.toString(),
      nonce: nonce.toString(), chainId: cid,
    };
    const signed = await web3.eth.accounts.signTransaction(tx, key);
    const receipt = await sendAndWait(signed.rawTransaction);
    if (config) {
      config.validatorMinStakeWei = newWei;
      config.validatorMinStakeEther = String(newNum);
      saveConfig(config);
    }
    res.json({ success: true, txHash: receipt.transactionHash, newMinStakeWei: newWei });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DESTRUCTIVE: wipe the chain DB + wizard config and start over fresh.
// Required when a sync-converted chain is stuck below the transition block
// (see PoSRewardCalculator vs. foreign-chain-state mismatch — fixing the
// state in place would require rewriting the consensus plugin). Body must
// include {confirm:"WIPE"} to avoid accidents.
app.post('/api/wizard/reset-chain', requireAuth, async (req, res) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== 'WIPE') {
      return res.status(400).json({ error: 'Pass {"confirm":"WIPE"} to confirm — this destroys the chain DB and config.' });
    }
    console.log('[wizard] RESET-CHAIN requested — stopping node and wiping /data...');
    try { await stopNode(); } catch (e) { console.warn('[wizard] stopNode error:', e?.message); }
    // Brief pause to let RocksDB release locks
    await new Promise(r => setTimeout(r, 2000));

    // Wipe everything inside DATA_DIR — but DON'T delete DATA_DIR itself
    // because Docker volume mounts can't be re-created from inside.
    let removed = [];
    try {
      for (const entry of fs.readdirSync(DATA_DIR)) {
        const full = path.join(DATA_DIR, entry);
        try {
          fs.rmSync(full, { recursive: true, force: true });
          removed.push(entry);
        } catch (e) { console.warn('[wizard] failed to remove', entry, e.message); }
      }
    } catch (e) { return res.status(500).json({ error: 'wipe failed: ' + e.message }); }

    // Re-create the empty subdirs so subsequent writes work
    fs.mkdirSync(path.join(DATA_DIR, 'db'),       { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'keystore'), { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'logs'),     { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'uploads'),  { recursive: true });

    // Drop the in-memory config so future GET /api/wizard/status reports unconfigured
    config = null;
    sessions.clear();

    console.log('[wizard] RESET-CHAIN complete. Removed:', removed.join(', '));
    res.json({ success: true, removed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Diagnostics: image version (so we can tell if a server is running the
// right image after `docker pull`).
app.get('/api/wizard/version', (req, res) => {
  let version = process.env.IMAGE_VERSION || 'unknown';
  try { version = fs.readFileSync('/image-version', 'utf8').trim() || version; } catch {}
  res.json({
    version,
    standalone: STANDALONE,
    dataDir: DATA_DIR,
    nethermindPath: NM_PATH,
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
  });
});

// v7.5.0 — Bridge config (Transaction-Mirror Bridge between L1 ↔ L2).
//
// GET returns current config (secret redacted); POST persists.
// Both are admin-only because the secret authenticates peer requests.
app.get('/api/wizard/bridge-config', requireAuth, (req, res) => {
  const cfg = config || {};
  res.json({
    bridgeMode:     cfg.bridgeMode     || null,   // 'L1' | 'L2' | null
    bridgePeerHost: cfg.bridgePeerHost || '',     // IP/hostname of peer
    bridgeSecret:   cfg.bridgeSecret ? '***' : '',
    bridgePollMs:   parseInt(cfg.bridgePollMs || '5000', 10),
    bridgePoaAdminL1: cfg.bridgePoaAdminL1 || '', // L1-mode: POA admin addr
    bridgeAdminL2:    cfg.bridgeAdminL2    || '', // L2-mode: L1's bridgeMiner addr to authorize on L2 (informational)
  });
});

app.post('/api/wizard/bridge-config', requireAuth, async (req, res) => {
  try {
    if (!config) return res.status(400).json({ error: 'No config — finish wizard first' });
    const b = req.body || {};
    const mode = b.bridgeMode === 'L1' || b.bridgeMode === 'L2' ? b.bridgeMode
               : b.bridgeMode === null || b.bridgeMode === '' || b.bridgeMode === 'None' ? null
               : null;
    let host = (b.bridgePeerHost || '').trim();
    host = host.replace(/^https?:\/\//, '').replace(/:.*$/, '').replace(/\/+$/, '');
    // Secret: only update if a non-mask value was sent. Empty string clears it.
    let secret = config.bridgeSecret || null;
    if (typeof b.bridgeSecret === 'string' && b.bridgeSecret !== '***') {
      secret = b.bridgeSecret.length > 0 ? b.bridgeSecret : null;
    }
    const pollMs = Math.max(1000, Math.min(60000, parseInt(b.bridgePollMs || '5000', 10) || 5000));
    const poaAdminL1 = (b.bridgePoaAdminL1 || '').trim() || null;
    const adminL2    = (b.bridgeAdminL2    || '').trim() || null;
    saveConfig({
      ...config,
      bridgeMode: mode,
      bridgePeerHost: host || null,
      bridgeSecret: secret,
      bridgePollMs: pollMs,
      bridgePoaAdminL1: poaAdminL1,
      bridgeAdminL2: adminL2,
    });
    res.json({ success: true, bridgeMode: mode, bridgePeerHost: host || null, bridgePollMs: pollMs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostics: read recent Nethermind log lines so the user can paste them
// for debugging without shelling into the container.
app.get('/api/wizard/node-logs', requireAuth, (req, res) => {
  try {
    const lines = Math.min(2000, Math.max(10, parseInt(req.query.lines || '300')));
    const logDir = path.join(DATA_DIR, 'logs');
    let files = [];
    try { files = fs.readdirSync(logDir).filter(f => f.endsWith('.txt') || f.endsWith('.log')); } catch {}
    if (files.length === 0) return res.json({ logs: '(no log files in ' + logDir + ' yet — node may not have written any output)', files: [] });
    // Pick newest log file
    files.sort((a, b) => {
      const sa = fs.statSync(path.join(logDir, a)).mtimeMs;
      const sb = fs.statSync(path.join(logDir, b)).mtimeMs;
      return sb - sa;
    });
    const newest = files[0];
    const content = fs.readFileSync(path.join(logDir, newest), 'utf8');
    const tail = content.split(/\r?\n/).slice(-lines).join('\n');
    res.json({ file: newest, files, lines, logs: tail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Operator-side: re-fetch the latest contract addresses from the admin's
// bootstrap URL. Useful if the admin has deployed APOS UNPRegistry or
// updated the staking contract since this operator joined.
// v7.0.3 SECURITY (audit C1+I5): require auth + URL allowlist (SSRF).
app.post('/api/wizard/operator/refresh-from-admin', requireAuth, async (req, res) => {
  try {
    if (!config) return res.status(400).json({ error: 'No config' });
    if (config.role !== 'operator') return res.status(400).json({ error: 'Only valid in operator mode' });
    const url = (req.body?.adminBootstrapUrl || config.adminBootstrapUrl || '').replace(/\/+$/, '');
    if (!url) return res.status(400).json({ error: 'No admin URL on file — pass adminBootstrapUrl' });
    // v7.0.3 SECURITY (audit I5): block SSRF to internal services.
    try { validateExternalUrl(url); }
    catch (e) { return res.status(400).json({ error: 'adminBootstrapUrl rejected: ' + e.message }); }
    const r = await fetch(url + '/api/wizard/bootstrap');
    if (!r.ok) return res.status(502).json({ error: 'Admin bootstrap fetch failed: HTTP ' + r.status });
    const data = await r.json();
    const updated = {
      ...config,
      stakingContract: data.stakingContract || config.stakingContract || null,
      aposRegistry:    data.aposRegistry    || config.aposRegistry    || null,
      validatorMinStakeWei: data.validatorMinStakeWei || config.validatorMinStakeWei || null,
      adminBootstrapUrl: url,
    };
    saveConfig(updated);
    res.json({
      success: true,
      stakingContract: updated.stakingContract,
      aposRegistry:    updated.aposRegistry,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC bootstrap endpoint for new operators. Returns everything an
// operator needs to join this chain: the chainspec on disk + this node's
// enode (queried from local RPC). Auth-free so the operator can fetch
// without admin credentials.
app.get('/api/wizard/bootstrap', async (req, res) => {
  try {
    const specPath = path.join(DATA_DIR, 'chainspec.json');
    let chainspec = null;
    if (fs.existsSync(specPath)) {
      try { chainspec = JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch {}
    }
    let enode = null;
    try {
      const r = await web3.currentProvider.request({ method: 'admin_nodeInfo', params: [] });
      enode = r?.enode || r?.result?.enode || null;
    } catch {}

    // Nethermind's admin_nodeInfo reports the *listen* address (0.0.0.0),
    // not the externally-reachable IP. If we forward that verbatim to an
    // operator, the operator stores `enode://...@0.0.0.0:30303` and tries
    // to connect to its own localhost — TCP connects (it sees its own
    // listener) but the eth/68 handshake never completes (peers stays 0,
    // logs say "Waiting for peers..." forever).
    //
    // Fix: rewrite the host part to whatever hostname the operator used to
    // reach this endpoint (req.hostname). That's by definition admin's
    // externally-reachable address from the operator's network position.
    // v7.0.8 (audit C2): no longer trust req.hostname (the request's Host
    // header) to choose the enode emitted to other operators. An attacker
    // could reach this public endpoint with a forged Host and poison the
    // returned enode → operators peer with attacker → eclipse attack.
    //
    // Trust order:
    //   1. PUBLIC_HOST env var (operator-set; explicit, deploy-time)
    //   2. config.publicHost (saved at create-chain time)
    //   3. config.domain (Caddy-managed HTTPS hostname)
    //   4. As a LAST resort, req.hostname — but ONLY if the request came
    //      from a loopback IP (admin running setup locally). Public requests
    //      get the un-rewritten 0.0.0.0 enode and a clear note.
    // v7.2.4: also rewrite when Nethermind reports a private-range IP
    // (e.g. docker-bridge 172.17.0.X, 10.x, 192.168.x). These are not
    // reachable from outside the host and produce the same broken-peer
    // failure mode as the 0.0.0.0 case.
    const _isNonRoutable = (h) => {
      if (!h) return false;
      if (h === '0.0.0.0' || h === '127.0.0.1' || h === '::' || h === '[::]' || h === '::1') return true;
      const m4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (!m4) return false;
      const a = +m4[1], b = +m4[2];
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true; // link-local
      return false;
    };
    // v7.7.3: latch publicHost on the first bootstrap fetched from an
    // external, routable IP. Without this fix, any deployment path that
    // doesn't go through /api/wizard/create-chain or /connect (notably
    // /sync-start used by Card 2 — APOS from POA) leaves config.publicHost
    // unset, and the rewrite below falls through to the docker-bridge IP.
    // The audit-C2 eclipse-attack mitigation is preserved: we ONLY latch
    // when the request's TCP remote is non-loopback AND req.headers.host
    // is a non-private routable address. Once latched, subsequent calls
    // (potentially with forged Host headers) can't change it.
    try {
      if (!config?.publicHost && config) {
        const rawHost = String(req.headers.host || '').split(':')[0].trim();
        const remoteIp = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
        const remoteIsExternal = remoteIp && !_isNonRoutable(remoteIp);
        const hostIsExternal   = rawHost && !_isNonRoutable(rawHost) && rawHost !== 'localhost';
        if (remoteIsExternal && hostIsExternal) {
          config.publicHost = rawHost;
          try { saveConfig(config); console.log('[wizard] auto-latched publicHost =', rawHost); }
          catch (e) { console.warn('[wizard] auto-latch publicHost failed:', e.message); }
        }
      }
    } catch {}

    if (enode) {
      const m = enode.match(/^(enode:\/\/[0-9a-f]+@)([^:]+)(:\d+)$/i);
      if (m) {
        const host = m[2];
        if (_isNonRoutable(host)) {
          let trustedHost = process.env.PUBLIC_HOST
                          || config?.publicHost
                          || config?.domain
                          || null;
          // v7.2.3: use the server's bound interface IP as a trust source.
          // req.socket.localAddress is set by the kernel from the accepted
          // TCP connection — the remote client cannot forge it. When admin
          // listens directly on a public IP (no reverse proxy), this is
          // exactly the address operators need to peer with. Behind a proxy
          // it returns loopback, which we filter out.
          if (!trustedHost) {
            const local = (req.socket?.localAddress || '').replace(/^::ffff:/, '');
            const isLoopback = local === '127.0.0.1' || local === '::1' || local === '0.0.0.0' || local === '::';
            if (local && !isLoopback) {
              trustedHost = local;
            }
          }
          if (!trustedHost) {
            const ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
            if (ip === '127.0.0.1' || ip === '::1') {
              trustedHost = req.hostname && req.hostname !== 'localhost' ? req.hostname : null;
            }
          }
          if (trustedHost) {
            enode = m[1] + trustedHost + m[3];
          }
          // else: leave enode with 0.0.0.0; operator must paste manually
          // or admin must set PUBLIC_HOST/config.publicHost/config.domain.
        }
      }
    }

    res.json({
      chainName: chainspec?.name || config?.chainName || null,
      chainId: config?.chainId || null,
      blockPeriod: config?.blockPeriod || null,
      mode: config?.mode || null,
      adminEnode: enode,
      // Admin-deployed contract addresses — operators inherit these so
      // their Staking tab and Apply-as-Node flow can find the right
      // contracts without needing the admin to share them out-of-band.
      stakingContract: config?.stakingContract || null,
      aposRegistry: config?.aposRegistry || null,
      validatorMinStakeWei: config?.validatorMinStakeWei || null,
      // Min gas price the chain enforces. Operators inherit this so their
      // RPC rejects sub-minimum txs at submission instead of accepting them
      // into the mempool where they sit forever (admin won't include them).
      minGasPriceWei: config?.minGasPriceWei || null,
      chainspec,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DB Snapshot / Clone ──────────────────────────────────────────
// When forward-sync gets stuck (chain-specific edge cases in Nethermind's
// PowForwardHeaderProvider for our PoS chainspec), the operator can skip
// sync entirely by cloning the admin's chain DB. Admin streams a tar.gz
// of /data/db; operator downloads, extracts, restarts. After clone, the
// operator only needs to receive new gossiped blocks from admin — which
// always works regardless of forward-sync bugs.

// Admin endpoint: streams the chain DB as a tar.gz. Public — operators
// fetch this without auth, like /api/wizard/bootstrap.
//
// Implementation note: a tar of a *live* RocksDB captures inconsistent
// MANIFEST/WAL/SST relationships, which makes the resulting DB recover to
// a slightly-different head than admin's view. The operator's eth/68
// Status handshake then fails (admin doesn't recognise operator's head
// hash for that block) and gossip never delivers new blocks.
//
// Fix: stop Nethermind, tar the quiesced DB to a temp file, restart
// Nethermind, then stream the temp file out. Block production pauses for
// the duration of the local tar (typically 10-60s for a multi-GB DB),
// not for the duration of the network transfer. Operator gets a
// byte-consistent DB and eth handshake works post-clone.
let snapshotInProgress = false;
const _snapshotIpRate = new Map(); // ip -> lastAtMs
// v7.0.3 SECURITY (audit C3): the snapshot endpoint pauses Nethermind for
// 10-60s while it tars a multi-GB DB. Unauth public access lets any caller
// halt block production at will. Two-layer gate now:
//   (1) Optional shared-secret token via DB_SNAPSHOT_TOKEN env (operator
//       gives this to legitimate peers). Bypasses requireAuth.
//   (2) Otherwise requireAuth (admin session) is required.
// Plus a 60s per-IP cooldown to throttle even authorized callers.
function _snapshotAuthGate(req, res, next) {
  const ip = (req.ip || req.connection?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  const now = Date.now();
  const last = _snapshotIpRate.get(ip) || 0;
  if (now - last < 60_000) {
    return res.status(429).json({ error: 'snapshot rate-limited (1/min/IP)', retryAt: last + 60_000 });
  }
  const expected = process.env.DB_SNAPSHOT_TOKEN;
  if (expected) {
    const got = req.headers['x-snapshot-token'] || '';
    // v7.0.8 (audit I2): constant-time compare so the token can't be
    // recovered via response-time side channel from a remote attacker.
    if (_ctEqStr(got, expected)) { _snapshotIpRate.set(ip, now); return next(); }
  }
  // Fall through to admin session auth
  if (!isProtectedMode()) { _snapshotIpRate.set(ip, now); return next(); }
  const t = getToken(req);
  if (!isValidToken(t)) return res.status(401).json({ error: 'Auth required (admin session or X-Snapshot-Token)', needLogin: true });
  _snapshotIpRate.set(ip, now);
  next();
}
app.get('/api/wizard/admin/db-snapshot', _snapshotAuthGate, async (req, res) => {
  if (snapshotInProgress) return res.status(429).json({ error: 'Another snapshot is already in progress' });
  snapshotInProgress = true;
  let tempPath = null;
  let nethermindWasRunning = false;
  try {
    if (!STANDALONE) { snapshotInProgress = false; return res.status(400).json({ error: 'Snapshot only available in standalone (containerized) mode' }); }
    const dbDir = path.join(DATA_DIR, 'db');
    if (!fs.existsSync(dbDir)) { snapshotInProgress = false; return res.status(404).json({ error: 'No chain DB found at ' + dbDir }); }

    nethermindWasRunning = !!nodeProc;
    if (nethermindWasRunning) {
      console.log('[db-snapshot] stopping Nethermind for clean snapshot...');
      await stopNode();
      await new Promise(r => setTimeout(r, 3000));
    }

    tempPath = path.join(DATA_DIR, `db-snapshot-${Date.now()}.tar.gz`);
    console.log(`[db-snapshot] tarring ${dbDir} -> ${tempPath} (Nethermind paused)`);
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-czf', tempPath, '-C', DATA_DIR, 'db']);
      let stderr = '';
      tar.stderr.on('data', d => { stderr += d.toString(); });
      tar.on('error', reject);
      tar.on('exit', code => code === 0 ? resolve() : reject(new Error(`tar exit ${code}: ${stderr.slice(0, 500)}`)));
    });
    const stat = fs.statSync(tempPath);
    console.log(`[db-snapshot] tar complete (${(stat.size/1e9).toFixed(2)} GB), restarting Nethermind`);

    if (nethermindWasRunning) {
      autoRestartNode();
      // Don't await — let Nethermind boot in background while we stream.
    }

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="unpchain-db.tar.gz"');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('X-Snapshot-Bytes', String(stat.size));
    res.setHeader('X-Snapshot-Created-At', new Date().toISOString());

    const stream = fs.createReadStream(tempPath);
    stream.pipe(res);
    await new Promise((resolve) => {
      stream.on('end', resolve);
      stream.on('error', resolve);
      res.on('close', resolve);
    });
  } catch (e) {
    console.error('[db-snapshot] error:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
    if (nethermindWasRunning && !nodeProc) { try { autoRestartNode(); } catch {} }
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); console.log('[db-snapshot] cleaned up', tempPath); } catch {}
    }
    snapshotInProgress = false;
  }
});

// Operator endpoint: download admin's snapshot, extract over /data/db,
// restart Nethermind. Tracks progress so the UI can show a bar.
let cloneState = { phase: 'idle', downloaded: 0, total: 0, message: '', startedAt: null, finishedAt: null, error: null };
app.get('/api/wizard/operator/clone-status', (req, res) => res.json(cloneState));

// v7.0.3 SECURITY (audit C2+I5): require admin session; validate admin URL
// against SSRF; pass safe tar args to prevent path-traversal during extract.
app.post('/api/wizard/operator/clone-from-admin', requireAuth, async (req, res) => {
  try {
    if (!STANDALONE) return res.status(400).json({ error: 'Clone only available in standalone mode' });
    if (cloneState.phase !== 'idle' && cloneState.phase !== 'done' && cloneState.phase !== 'error')
      return res.status(409).json({ error: 'Clone already in progress: ' + cloneState.phase });

    const adminUrl = (req.body?.adminUrl) || config?.adminBootstrapUrl;
    if (!adminUrl) return res.status(400).json({ error: 'adminUrl is required — pass in body or run /api/wizard/connect first so it is in config.adminBootstrapUrl' });
    try { validateExternalUrl(adminUrl); }
    catch (e) { return res.status(400).json({ error: 'adminUrl rejected: ' + e.message }); }

    // v7.0.6: snapshot endpoint requires admin's DB_SNAPSHOT_TOKEN. Operator
    // gets it out-of-band from admin and passes it here.
    const snapshotToken = (req.body?.snapshotToken || '').trim();

    const baseUrl = adminUrl.replace(/\/+$/, '');
    const snapshotUrl = baseUrl + '/api/wizard/admin/db-snapshot';

    // Reply immediately — clone runs in background, UI polls /clone-status.
    res.json({ success: true, snapshotUrl });

    cloneState = { phase: 'starting', downloaded: 0, total: 0, message: 'Stopping local node...', startedAt: Date.now(), finishedAt: null, error: null };

    (async () => {
      try {
        await stopNode();
        await new Promise(r => setTimeout(r, 2000));

        cloneState.phase = 'wiping';
        cloneState.message = 'Removing old DB...';
        const dbDir = path.join(DATA_DIR, 'db');
        if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
        fs.mkdirSync(dbDir, { recursive: true });

        cloneState.phase = 'downloading';
        cloneState.message = 'Downloading + extracting from ' + snapshotUrl;

        // Stream HTTP body straight into `tar -xz` — never write the full
        // archive to disk (could be many GB). Track bytes as they flow.
        const http  = require('http');
        const https = require('https');
        const lib   = snapshotUrl.startsWith('https://') ? https : http;

        await new Promise((resolve, reject) => {
          // v7.0.3 SECURITY (audit C2): safer tar extraction. The archive is
          // user-fetched from a remote URL — without these flags a malicious
          // archive containing `../../etc/cron.d/x` would write outside DATA_DIR
          // (RCE). `--no-overwrite-dir` prevents replacing existing dirs;
          // `--no-same-permissions --no-same-owner` strip uid/perm metadata;
          // explicitly limiting to `db` constrains where files can land.
          const tar = spawn('tar', [
            '-xz',
            '--no-overwrite-dir',
            '--no-same-permissions',
            '--no-same-owner',
            '-C', DATA_DIR,
            'db',
          ], { stdio: ['pipe', 'inherit', 'pipe'] });
          let tarStderr = '';
          tar.stderr.on('data', d => { tarStderr += d.toString(); });
          tar.on('error', reject);
          tar.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`tar -xz exited with code ${code}: ${tarStderr.slice(0, 500)}`));
          });

          const reqOpts = new URL(snapshotUrl);
          const headers = snapshotToken ? { 'X-Snapshot-Token': snapshotToken } : {};
          lib.get(snapshotUrl, { headers }, response => {
            if (response.statusCode !== 200) {
              tar.kill('SIGTERM');
              return reject(new Error(`Admin returned HTTP ${response.statusCode}` + (response.statusCode === 401 ? ' — DB_SNAPSHOT_TOKEN missing or wrong' : '')));
            }
            const totalHeader = response.headers['content-length'];
            cloneState.total = totalHeader ? parseInt(totalHeader) : 0;

            response.on('data', chunk => {
              cloneState.downloaded += chunk.length;
              if (cloneState.total > 0) {
                const pct = Math.round((cloneState.downloaded / cloneState.total) * 100);
                cloneState.message = `Downloading... ${(cloneState.downloaded/1e9).toFixed(2)} GB / ${(cloneState.total/1e9).toFixed(2)} GB (${pct}%)`;
              } else {
                cloneState.message = `Downloading... ${(cloneState.downloaded/1e9).toFixed(2)} GB (admin didn't report total size)`;
              }
            });
            response.on('error', err => { tar.kill('SIGTERM'); reject(err); });
            response.pipe(tar.stdin);
          }).on('error', err => { tar.kill('SIGTERM'); reject(err); });
        });

        cloneState.phase = 'restarting';
        cloneState.message = 'Restarting Nethermind with cloned DB...';

        // Kick off the operator-mode Nethermind so it picks up where admin's
        // DB left off and keeps receiving new blocks via gossip.
        const specPath = path.join(DATA_DIR, 'chainspec.json');
        if (config?.adminEnode && fs.existsSync(specPath)) {
          await startNethermindOperator(specPath, config.adminEnode);
        }

        cloneState.phase = 'done';
        cloneState.finishedAt = Date.now();
        cloneState.message = `Clone complete — ${(cloneState.downloaded/1e9).toFixed(2)} GB transferred.`;

        // Mark the config so subsequent page loads skip the sync gate. The
        // cloned operator has admin's full chain locally and is functional
        // for RPC queries even with 0 peers (peers only matter for new
        // gossiped blocks). Without this, init() would call sync-status
        // which requires peers>0+60s settle, and on flaky P2P that never
        // fires — leaving the user stuck on the syncing page after refresh.
        try {
          config.clonedFromAdmin = adminUrl;
          config.clonedAt = Date.now();
          config.clonedBytes = cloneState.downloaded;
          saveConfig(config);
        } catch (e) { console.warn('[clone] could not persist clone marker:', e.message); }
      } catch (err) {
        cloneState.phase = 'error';
        cloneState.finishedAt = Date.now();
        cloneState.error = err.message;
        cloneState.message = 'Clone failed: ' + err.message;
        console.error('[clone-from-admin]', err);
        // v7.0.5 FALLBACK: clone failed (auth, CORS, network, whatever) — do
        // NOT leave the operator stranded with no node. Fall back to a
        // normal gossip-based operator launch using the saved adminEnode.
        // Sync may take longer block-by-block but the chain is reachable.
        try {
          const specPath2 = path.join(DATA_DIR, 'chainspec.json');
          if (config?.adminEnode && fs.existsSync(specPath2)) {
            console.log('[clone-from-admin] fallback: starting Nethermind in operator/gossip mode');
            await startNethermindOperator(specPath2, config.adminEnode);
            cloneState.message = 'Clone failed; falling back to gossip-only sync (slower, but works). Error was: ' + err.message;
            cloneState.phase = 'fallback-gossip';
          }
        } catch (e2) {
          console.warn('[clone-from-admin] fallback start also failed:', e2.message);
        }
      }
    })();
  } catch (err) {
    cloneState.phase = 'error';
    cloneState.error = err.message;
    res.status(500).json({ error: err.message });
  }
});

// Diagnostics: read the current chainspec on disk
app.get('/api/wizard/chainspec', requireAuth, (req, res) => {
  try {
    const specPath = path.join(DATA_DIR, 'chainspec.json');
    if (!fs.existsSync(specPath)) return res.status(404).json({ error: 'chainspec.json not found' });
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    res.json({
      path: specPath,
      name: spec?.name,
      networkId: spec?.params?.networkID,
      engine: spec?.engine,
      genesisExtraData: spec?.genesis?.extraData,
      nodes: (spec?.nodes || []).length,
      accounts: Object.keys(spec?.accounts || {}).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PoS info
app.get('/api/wizard/pos-info', async (req, res) => {
  try {
    if (!config?.stakingContract) return res.json({ deployed:false });
    const c = new web3.eth.Contract(STAKING_ABI, config.stakingContract);
    const [validators, minStake, delay] = await Promise.all([
      c.methods.getActiveValidators().call(),
      c.methods.MIN_STAKE().call(),
      c.methods.UNSTAKE_DELAY().call(),
    ]);
    const info = await Promise.all(validators.map(async a => {
      const s = await c.methods.getStake(a).call();
      return { address:a, stake:web3.utils.fromWei(s.toString(),'ether') };
    }));
    res.json({ deployed:true, contractAddress:config.stakingContract,
               validators:info, minStake:web3.utils.fromWei(minStake.toString(),'ether'),
               unstakeDelay:delay.toString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// EXPLORER API
// ═══════════════════════════════════════════════════════════════════

app.get('/api/status', async (req, res) => {
  try {
    const [bn, cid, gp, syncing, peers] = await Promise.all([
      web3.eth.getBlockNumber(), web3.eth.getChainId(),
      web3.eth.getGasPrice(), web3.eth.isSyncing(), web3.eth.net.getPeerCount(),
    ]);
    res.json({ blockNumber:bn.toString(), chainId:cid.toString(),
               gasPrice:gp.toString(), syncing, peers:peers.toString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/blocks', async (req, res) => {
  try {
    const latest = Number(await web3.eth.getBlockNumber());
    const count = Math.min(parseInt(req.query.count||'15'), 50);
    const blocks = [];
    for (let i = latest; i >= Math.max(0, latest-count+1); i--) {
      try {
        const b = await web3.eth.getBlock(i);
        if (b) blocks.push({ number:b.number.toString(), hash:b.hash, miner:b.miner,
          timestamp:b.timestamp.toString(), transactions:b.transactions.length,
          gasUsed:b.gasUsed.toString(), difficulty:b.difficulty.toString() });
      } catch (blockErr) {
        // Block may be pruned — skip it silently
        continue;
      }
    }
    res.json(blocks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/block/:id', async (req, res) => {
  try {
    const b = await web3.eth.getBlock(req.params.id, true);
    if (!b) return res.status(404).json({ error:'Not found' });
    res.json(b);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tx/:hash', async (req, res) => {
  try {
    const [tx, receipt] = await Promise.all([
      web3.eth.getTransaction(req.params.hash),
      web3.eth.getTransactionReceipt(req.params.hash).catch(()=>null),
    ]);
    if (!tx) return res.status(404).json({ error:'Not found' });
    res.json({ ...tx, receipt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/balance/:address', async (req, res) => {
  try {
    const bal = await web3.eth.getBalance(req.params.address);
    res.json({ address:req.params.address,
               balance:web3.utils.fromWei(bal,'ether'), wei:bal.toString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List all txs sent FROM or TO :address in the last `?maxBlocks=N` blocks
// (default 1000). Returns one row per matching tx with hash, block, gas
// used and total fee. This is intentionally a server-side scan because
// Nethermind's eth_getLogs / address-indexed queries don't apply here —
// we scan blocks linearly. Capped at 5000 blocks per request to avoid
// pinning the dashboard for minutes on busy chains.
const TX_HISTORY_MAX = 5000;
app.get('/api/wallet/transactions/:address', async (req, res) => {
  try {
    const addr = String(req.params.address || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      return res.status(400).json({ error: 'invalid address' });
    }
    let maxBlocks = Number(req.query.maxBlocks || 1000);
    if (!Number.isFinite(maxBlocks) || maxBlocks <= 0) maxBlocks = 1000;
    if (maxBlocks > TX_HISTORY_MAX) maxBlocks = TX_HISTORY_MAX;

    const head = Number(await web3.eth.getBlockNumber().catch(() => 0));
    const from = Math.max(0, head - maxBlocks + 1);
    const out = [];
    for (let n = head; n >= from && out.length < 200; n--) {
      const blk = await web3.eth.getBlock(n, true).catch(() => null);
      if (!blk?.transactions?.length) continue;
      for (const tx of blk.transactions) {
        const isFrom = tx.from && tx.from.toLowerCase() === addr;
        const isTo   = tx.to   && tx.to.toLowerCase()   === addr;
        if (!isFrom && !isTo) continue;
        // Receipt for gasUsed
        const rec = await web3.eth.getTransactionReceipt(tx.hash).catch(() => null);
        const gasUsed = rec ? BigInt(rec.gasUsed) : 0n;
        const gasPrice = BigInt(tx.effectiveGasPrice ?? tx.gasPrice ?? 0n);
        const feeWei = gasUsed * gasPrice;
        out.push({
          hash: tx.hash,
          blockNumber: Number(blk.number),
          timestamp: Number(blk.timestamp),
          from: tx.from,
          to: tx.to || null,
          direction: isFrom ? 'OUT' : 'IN',
          valueWei: BigInt(tx.value || 0).toString(),
          gasUsed: gasUsed.toString(),
          gasPriceWei: gasPrice.toString(),
          feeWei: feeWei.toString(),
          status: rec ? Number(rec.status) : null,
          contractAddress: rec?.contractAddress || null,
        });
      }
    }
    res.json({ address: addr, head, scanned: head - from + 1, count: out.length, transactions: out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Return APOS earnings for an address — v8 model: a wallet earns as a
// VALIDATOR only (tier-driven gas-fee share). Includes pool + delegation
// detail so the panels render one call per refresh.
app.get('/api/apos/earnings/:address', async (req, res) => {
  try {
    if (!config?.aposRegistry) return res.json({ deployed: false });
    const addr = String(req.params.address || '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      return res.status(400).json({ error: 'invalid address' });
    }
    const aposBuild = require('./apos-registry-build.json');
    const c = new web3.eth.Contract(aposBuild.abi, config.aposRegistry);
    let v = null;
    try { v = await c.methods.getValidatorInfo(addr).call(); } catch {}
    if (!v || Number(v.status) === 0) {
      return res.json({
        deployed: true, address: addr, isValidator: false,
        validatorStatus: 0, accumulatedFeesWei: '0', totalAccumulatedFeesWei: '0',
      });
    }
    const selfStake = BigInt(v.selfStake.toString());
    const delegated = BigInt(v.delegatedTotal.toString());
    let delegatorCount = 0;
    try { delegatorCount = Number(await c.methods.getDelegatorCount(addr).call()); } catch {}
    res.json({
      deployed: true,
      address: addr,
      isValidator: true,
      validatorStatus: Number(v.status),
      code: v.code || '',
      selfStakeWei: selfStake.toString(),
      delegatedTotalWei: delegated.toString(),
      poolWei: (selfStake + delegated).toString(),
      selectedPackageId: Number(v.selectedPackageId),
      gasShareBps: Number(v.gasShareBps),
      aprBps: Number(v.aprBps),
      delegatorCount,
      accumulatedFeesWei: v.accumulatedFees.toString(),
      totalAccumulatedFeesWei: v.accumulatedFees.toString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/network', async (req, res) => {
  try {
    const [peers, cid, listening] = await Promise.all([
      web3.eth.net.getPeerCount(), web3.eth.getChainId(), web3.eth.net.isListening(),
    ]);
    res.json({ peers:peers.toString(), chainId:cid.toString(), listening });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// ROLE INFO + FAUCET (v2 — ELNTST on-chain rate-limited token faucet)
//
//   /api/role-info                — public; tells the FE what node it is,
//                                   chain network-type, faucet status, etc.
//   /api/faucet/v2/*              — new ELNTST faucet endpoints
//                                   (info, status/:addr, captcha, claim,
//                                    admin/deploy, admin/amounts, admin/cap)
//   /api/role-info/network-type   — admin: set chain network-type label.
//
// Note: the legacy /api/faucet/request endpoint (one-time 10 ELY airdrop)
// is kept for backwards-compat but now short-circuits a "deprecated"
// response.  All new clients use the v2 surface and the new on-chain
// rate-limited contract.
// ═══════════════════════════════════════════════════════════════════

// Wire the new faucet module. It registers the /api/faucet/v2/* routes.
// v7.25 — accept validatorKey with or without the 0x prefix. The wizard
// normalizes to 0x-prefixed before persisting, so the old check
// (/^[0-9a-fA-F]{64}$/) silently rejected every freshly-bootstrapped node and
// every admin-signed deploy failed with "admin signer not available".
const _adminWalletGetter = () => {
  if (!config?.validatorKey) return null;
  const raw = String(config.validatorKey).replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  return web3.eth.accounts.privateKeyToAccount('0x' + raw);
};
// VALIDATOR NODE — the faucet is an admin-node service and is intentionally
// NOT bundled here (faucet-v2.js is removed; /api/faucet/* is hard-disabled).

// v7.10 — APOS Leaderboard module: registers /api/lb/* routes and starts
// the per-node uptime bot.
const { mountLeaderboard: _mountLb } = require('./leaderboard.js');
_mountLb(app, { web3, requireAuth, getAdminWallet: _adminWalletGetter, getConfig: () => config });

// v7.39 — operator liveness heartbeat. An operator node POSTs its validator
// address to the admin's /api/lb/heartbeat every 60 s; the admin's uptime bot
// samples these and writes the monthly uptime % into the leaderboard contract.
// Admin nodes don't heartbeat (they're not ranked). Uses the raw-IP admin URL
// so it bypasses Cloudflare Bot Fight Mode.
function startLeaderboardHeartbeat() {
  setInterval(async () => {
    try {
      const cfg = config || {};
      if ((cfg.role || process.env.NODE_ROLE || '').toLowerCase() !== 'operator') return;
      const addr = cfg.validatorAddress;
      if (!addr) return;
      const base = String(cfg.adminBootstrapUrl || process.env.ADMIN_URL || '').replace(/\/+$/, '');
      if (!base) return;
      await fetch(base + '/api/lb/heartbeat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      }).catch(() => {});
    } catch {}
  }, 60_000);
}
startLeaderboardHeartbeat();

const FAUCET_AMOUNT_UNP = '20';                                     // v7.11 — bumped from 10 → 20 ELY per claim
const FAUCET_RECORDS_PATH = path.join(DATA_DIR, 'faucet-records.json');
function loadFaucetRecords() {
  try { return JSON.parse(fs.readFileSync(FAUCET_RECORDS_PATH, 'utf8')); }
  catch { return { recipients: {}, totalSent: '0' }; }
}
function saveFaucetRecords(r) {
  try { fs.writeFileSync(FAUCET_RECORDS_PATH, JSON.stringify(r, null, 2)); } catch {}
}

app.get('/api/role-info', async (req, res) => {
  try {
    const cfg = config || {};
    const wizardDone = !!cfg.chainId;
    const role = (cfg.role || process.env.NODE_ROLE || 'admin').toLowerCase();
    const networkType = (cfg.networkType || 'testnet').toLowerCase();
    let head = 0;
    try { head = Number(await web3.eth.getBlockNumber().catch(() => 0)); } catch {}
    const f = loadFaucetRecords();
    res.json({
      wizardDone,
      role,                               // "admin" | "operator"
      networkType,                        // "testnet" | "mainnet"
      domain: cfg.domain || null,
      chainId: cfg.chainId || null,
      chainName: cfg.chainName || 'Elyon Chain',
      rpcUrl: cfg.domain ? ('https://' + cfg.domain + '/rpc') : null,
      blockHeight: head,
      aposRegistry: cfg.aposRegistry || null,
      aposPointer: cfg.aposPointer || null,
      // ticket #7 (BUG-003): PoS Staking tab uses these to populate the
      // StakingContract / Your Stake / Status fields. Previously the
      // response omitted them, so all four cards rendered "—".
      stakingContract:  cfg.stakingContract  || null,
      validatorAddress: cfg.validatorAddress || null,
      adminAddress:     cfg.adminAddress     || cfg.validatorAddress || null,
      faucet: {
        enabled: networkType === 'testnet' && wizardDone,
        amountUnp: FAUCET_AMOUNT_UNP,
        totalSentRecipients: Object.keys(f.recipients || {}).length,
        totalSentUnp: f.totalSent || '0',
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin-only: set the chain's network-type label. Affects what the public
// website shows (banner color, faucet visibility, default copy).
app.post('/api/role-info/network-type', requireAuth, async (req, res) => {
  try {
    const t = String((req.body || {}).networkType || '').toLowerCase();
    if (t !== 'testnet' && t !== 'mainnet') return res.status(400).json({ error: 'networkType must be "testnet" or "mainnet"' });
    const cfg = config || {};
    saveConfig({ ...cfg, networkType: t });
    config = cfg; config.networkType = t;
    res.json({ success: true, networkType: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public: testnet-only faucet. Transfers FAUCET_AMOUNT_UNP from the admin
// validator wallet to the requested address ONCE per address (forever).
//
// Anti-abuse: cooldown is per-address (any IP can submit a request, but
// once that address has been served the JSON record blocks subsequent
// requests). Validates address format. Refuses if the admin wallet would
// drop below 1 ELY. Refuses on mainnet networks. Requires a deployed
// validator wallet (config.validatorKey).
// v7.0 SECURITY: faucet per-IP daily cap + global daily cap.
// Stops a single attacker from draining the testnet admin wallet by
// generating millions of fresh addresses.
const FAUCET_PER_IP_DAILY_MAX   = 3;       // 3 addresses per IP per day
const FAUCET_GLOBAL_DAILY_MAX_UNP = 5000;  // 500 addresses × 10 ELY cap chain-wide
const faucetIpCounts = new Map();          // ip -> { count, windowStart }
function faucetIpAllow(req) {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!ip) return { allowed: true, ip: 'unknown' };
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let r = faucetIpCounts.get(ip);
  if (!r || now - r.windowStart > dayMs) r = { count: 0, windowStart: now };
  if (r.count >= FAUCET_PER_IP_DAILY_MAX) {
    return { allowed: false, ip, retryAt: r.windowStart + dayMs };
  }
  return { allowed: true, ip, record: r };
}
function recordFaucetIp(ip, record) {
  record.count += 1;
  faucetIpCounts.set(ip, record);
  if (faucetIpCounts.size > 100_000) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [k, v] of faucetIpCounts) if (v.windowStart < cutoff) faucetIpCounts.delete(k);
  }
}

// v7.1.0 (audit Inf-I1): in-flight set guards faucet TOCTOU. Two concurrent
// requests for the same address used to both pass the recipients-check and
// both broadcast 10 ELY. Mutex via a Set: first request claims the address;
// subsequent ones get 429 until the first completes.
const _faucetInFlight = new Set();
// v7.11 — native-ELY faucet RE-ENABLED with a 24-hour cooldown per address
// (was previously "once forever per address" until v7.8, then disabled in
// v7.8-faucet-v2). One claim of FAUCET_AMOUNT_UNP ELY per 24 h.  The ELNTST
// faucet at /api/faucet/v2/* is the on-chain version and still exists for
// the explicit test-token use case.
const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000;
app.post('/api/faucet/request', async (req, res) => {
  try {
    const cfg = config || {};
    const networkType = (cfg.networkType || 'testnet').toLowerCase();
    if (networkType !== 'testnet') return res.status(400).json({ error: 'faucet is only enabled on testnet' });
    if (!cfg.validatorKey) return res.status(400).json({ error: 'admin wallet not configured on this node' });
    const addr = String((req.body || {}).address || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return res.status(400).json({ error: 'invalid address (expected 0x + 40 hex chars)' });
    const lockKey = addr.toLowerCase();
    if (_faucetInFlight.has(lockKey)) {
      return res.status(429).json({ error: 'another faucet request for this address is in-flight' });
    }
    _faucetInFlight.add(lockKey);
    // Wrap the rest in try/finally to release the lock no matter what.
    try {
      return await _faucetRequest(req, res, addr, cfg);
    } finally {
      _faucetInFlight.delete(lockKey);
    }
  } catch (e) { res.status(500).json({ error: 'faucet error' }); }
});
async function _faucetRequest(req, res, addr, cfg) {
  try {
    // v7.0: per-IP daily cap
    const ipCheck = faucetIpAllow(req);
    if (!ipCheck.allowed) {
      const retryHrs = Math.ceil((ipCheck.retryAt - Date.now()) / 3_600_000);
      return res.status(429).json({ error: `faucet daily limit reached for your IP (${FAUCET_PER_IP_DAILY_MAX}/day). Retry in ~${retryHrs}h.` });
    }
    const r = loadFaucetRecords();
    // v7.0: global daily cap
    const dayMs = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - dayMs;
    let dailySent = 0;
    for (const [, rec] of Object.entries(r.recipients || {})) {
      const t = rec.at ? Date.parse(rec.at) : 0;
      if (t > cutoff) dailySent += Number(rec.amountUnp || FAUCET_AMOUNT_UNP);
    }
    if (dailySent >= FAUCET_GLOBAL_DAILY_MAX_UNP) {
      return res.status(429).json({ error: 'faucet global daily cap reached; try again tomorrow' });
    }
    const key = addr.toLowerCase();
    // v7.11: per-address 24 h cooldown (was: once-forever).
    if (r.recipients && r.recipients[key]) {
      const last = Date.parse(r.recipients[key].at || 0);
      const nextOk = last + FAUCET_COOLDOWN_MS;
      if (Date.now() < nextOk) {
        const remainingMin = Math.ceil((nextOk - Date.now()) / 60_000);
        return res.status(429).json({
          error: `this address claimed within the last 24 h — try again in ~${remainingMin} min`,
          lastReceivedAt: r.recipients[key].at,
          nextEligibleAt: new Date(nextOk).toISOString(),
        });
      }
    }
    // Guard the admin wallet — keep at least 1 ELY for gas.
    const admin = web3.eth.accounts.privateKeyToAccount(cfg.validatorKey);
    const balanceWei = BigInt(await web3.eth.getBalance(admin.address));
    const oneUnpWei  = 1_000_000_000_000_000_000n;
    const payoutWei  = BigInt(FAUCET_AMOUNT_UNP) * oneUnpWei;
    if (balanceWei < payoutWei + oneUnpWei) {
      return res.status(503).json({ error: 'admin wallet too low for faucet right now — try again later' });
    }
    const nonce = await web3.eth.getTransactionCount(admin.address, 'pending');
    const gp = await web3.eth.getGasPrice();
    const cid = await web3.eth.getChainId();
    const signed = await admin.signTransaction({
      to: addr, value: payoutWei.toString(),
      gas: '21000', gasPrice: gp.toString(),
      nonce: nonce.toString(), chainId: Number(cid),
    });
    const submission = await fetch(RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [signed.rawTransaction], id: 1 }),
    }).then(r => r.json()).catch(() => null);
    if (!submission || submission.error) {
      return res.status(500).json({ error: 'broadcast failed: ' + (submission?.error?.message || 'unknown') });
    }
    const txHash = submission.result;
    r.recipients = r.recipients || {};
    r.recipients[key] = { at: new Date().toISOString(), txHash, amountUnp: FAUCET_AMOUNT_UNP };
    r.totalSent = String(Number(r.totalSent || '0') + Number(FAUCET_AMOUNT_UNP));
    // v7.0: rotate old recipient records (older than 90 days) to bound file size
    const rotateCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    for (const [k, rec] of Object.entries(r.recipients)) {
      const t = rec.at ? Date.parse(rec.at) : 0;
      if (t > 0 && t < rotateCutoff) delete r.recipients[k];
    }
    saveFaucetRecords(r);
    if (ipCheck.record) recordFaucetIp(ipCheck.ip, ipCheck.record);
    console.log('[faucet] sent', FAUCET_AMOUNT_UNP, 'ELY to', addr, 'tx', txHash);
    res.json({ success: true, address: addr, amountUnp: FAUCET_AMOUNT_UNP, txHash });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ═══════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════
if (config && STANDALONE && (config.mode === 'created' || config.mode === 'imported')) {
  const sp = path.join(DATA_DIR, 'chainspec.json');
  if (fs.existsSync(sp) && config.validatorKey) {
    console.log(`[wizard] Auto-starting Nethermind from saved config (${config.mode})...`);
    startNethermind(sp, config.validatorKey);
  }
}

// ── Auto-restart node on server boot if already configured ────────
// Self-heal config on startup: derive minGasPriceWei from the on-chain
// UNPRegistry's txFeeWei (the admin-set flat per-tx fee floor) so the
// node enforces it via --Blocks.MinGasPrice. The contract spec says
// every tx must satisfy `gasPrice * gasLimit >= txFeeWei`; with the
// 21000-gas baseline that means `gasPrice >= txFeeWei / 21000`. Without
// this, --Blocks.MinGasPrice falls back to Nethermind's 1-Gwei default
// and the operator's RPC accepts sub-fee txs that admin then refuses
// to mine — they sit in mempool forever.
async function ensureMinGasPriceFromRegistry() {
  try {
    if (!config) return;
    // v7.50 — Testnet gas must be cheap & Ethereum-like. Older chains derived a
    // ~50 gwei floor from the APOS txFeeWei, so a token deploy (~106k gas) cost
    // ~0.005 ELN and, next to a 20 ELN *stake*, MetaMask's "Total: 20.005" read
    // like a 20-ELN fee. Fees are purely gasPrice×gasUsed (APOSFeeDistributor),
    // so lowering the floor just scales fees down. One-time cap at 1 gwei; the
    // admin can re-raise it later via Settings.
    if (!config._gasFloorCappedV750) {
      try {
        const cap = 1_000_000_000n; // 1 gwei
        if (config.minGasPriceWei && BigInt(config.minGasPriceWei) > cap) {
          console.log('[boot] v7.50: lowering minGasPriceWei from ' + (Number(config.minGasPriceWei) / 1e9) + ' gwei to 1 gwei (testnet cheap gas)');
          config.minGasPriceWei = cap.toString();
        }
      } catch {}
      config._gasFloorCappedV750 = true;
      saveConfig(config);
    }
    if (config.minGasPriceWei) return; // already configured, leave it alone

    const registry = config.aposRegistry;
    if (!registry) {
      // No APOS deployed yet (e.g. fresh chain pre-conversion). Use
      // Nethermind's hardcoded default so behaviour matches old releases.
      config.minGasPriceWei = '1000000000'; // 1 Gwei
      saveConfig(config);
      console.log('[boot] No aposRegistry yet, defaulted minGasPriceWei to 1 Gwei');
      return;
    }

    // Read txFeeWei via direct eth_call — Nethermind isn't running yet
    // when this is invoked at startup, so use a fresh provider that
    // points at the local RPC port (Nethermind will be up shortly after
    // autoRestartNode kicks in; if not, we just retry below).
    const SELECTOR_TX_FEE = '0xcb9156ee'; // bytes4(keccak256("txFeeWei()"))
    const r = await fetch(RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
                              params: [{ to: registry, data: SELECTOR_TX_FEE }, 'latest'] }),
    }).then(r => r.json()).catch(() => null);
    const hex = r?.result;
    if (hex && hex.length >= 66) {
      const txFeeWei = BigInt(hex);
      const minGas = txFeeWei / 21000n;
      config.minGasPriceWei = minGas.toString();
      saveConfig(config);
      console.log(`[boot] Read APOS txFeeWei=${txFeeWei}, set minGasPriceWei=${minGas} (= txFeeWei/21000 = ${Number(minGas)/1e9} Gwei)`);
    } else {
      // RPC not up yet — defer, autoRestartNode will reschedule us.
      config.minGasPriceWei = '1000000000';
      saveConfig(config);
      console.log('[boot] Could not query APOS yet, fell back to 1 Gwei (will refresh on next boot)');
    }
  } catch (e) {
    console.warn('[boot] ensureMinGasPriceFromRegistry failed:', e.message);
  }
}

async function autoRestartNode(opts) {
  if (!STANDALONE || !config) return;
  const force = opts && opts.force === true;
  // If a Nethermind process is already running and force is not set,
  // do NOT spawn another. Two concurrent Nethermind processes fight
  // over the RocksDB lock and BOTH crash with "IO error: ... LOCK:
  // Resource temporarily unavailable".
  //
  // v7.2.5: when force=true (called after chainspec mutation such as
  // baking aposPointer), stop the running process first so the new
  // process loads the updated chainspec. The previous behaviour
  // skipped the restart silently, leaving the running Nethermind
  // with a stale in-memory chainspec and producing a Layer-2 hook
  // configuration mismatch vs. operator nodes that booted with the
  // updated chainspec — manifesting as a state-root mismatch at
  // the block containing the proposeRegistry tx.
  if (nodeProc && !force) {
    console.log('[boot] autoRestartNode: Nethermind already running (pid ' + nodeProc.pid + '), skipping');
    return;
  }
  if (nodeProc && force) {
    console.log('[boot] autoRestartNode(force=true): stopping running Nethermind (pid ' + nodeProc.pid + ') to reload chainspec');
    try { await stopNode(); } catch (e) { console.warn('[boot] stopNode during forced restart failed:', e?.message); }
    // Brief settle so RocksDB releases its LOCK before the new process opens it.
    await new Promise(r => setTimeout(r, 2000));
  }
  const specPath = path.join(DATA_DIR, 'chainspec.json');
  if (!fs.existsSync(specPath)) return;

  // Make sure config has minGasPriceWei before launching Nethermind so the
  // --Blocks.MinGasPrice flag gets passed. On a node where Nethermind is
  // already running (e.g. dashboard restart only), the eth_call below
  // succeeds against the live RPC. On a cold start (image-recreate), we
  // fall back to 1 Gwei and a *second* boot cycle will pick up the real
  // value once Nethermind is up.
  await ensureMinGasPriceFromRegistry();

  if (config.mode === 'pos-converted' || config.mode === 'apos-converted' || config.mode === 'created') {
    const key = config.validatorKey;
    if (!key) { console.log('[boot] No validator key in config, skipping auto-restart'); return; }
    console.log('[boot] Auto-restarting Nethermind in PoS/mining mode...');
    const extraArgs = config.stakingContract
      ? ['--PoS.StakingContractAddress', config.stakingContract]
      : [];
    startNethermind(specPath, key, extraArgs);
  } else if (config.mode === 'syncing' && config.enodeUrl) {
    console.log('[boot] Auto-restarting Nethermind in sync mode...');
    startNethermindSyncOnly(specPath, config.enodeUrl, false); // false = don't clear DB on resume
  } else if (config.mode === 'node' && config.adminEnode) {
    console.log('[boot] Auto-restarting Nethermind in operator mode (peering with admin)...');
    startNethermindOperator(specPath, config.adminEnode);
  }
}

// Deferred refresh: poll Nethermind RPC until it answers, then re-read
// APOS txFeeWei in case the cold-start path wrote a fallback value.
// If the real value differs from what's in config, persist it AND
// restart Nethermind so the new --Blocks.MinGasPrice takes effect
// without a manual second restart.
async function deferredFeeRefresh() {
  if (!STANDALONE) return;
  // Wait up to 5 minutes for Nethermind RPC + a successful eth_call.
  const SELECTOR_TX_FEE = '0xcb9156ee';
  let txFeeWei = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    if (!config?.aposRegistry) continue;
    try {
      const r = await fetch(RPC_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
                                params: [{ to: config.aposRegistry, data: SELECTOR_TX_FEE }, 'latest'] }),
      }).then(r => r.json()).catch(() => null);
      const hex = r?.result;
      if (hex && hex.length >= 66) {
        const candidate = BigInt(hex);
        if (candidate > 0n) { txFeeWei = candidate; break; }
      }
    } catch {}
  }
  if (txFeeWei === null) {
    console.log('[boot] deferredFeeRefresh: could not read txFeeWei after 5 min; leaving config as-is');
    return;
  }
  // v7.50 — testnet gas must stay Ethereum-cheap. The APOS txFeeWei implies a
  // floor of txFeeWei/21000 (≈50 gwei here), which made deploys look costly.
  // Fees are gasPrice×gasUsed (APOSFeeDistributor), so capping the floor at
  // 1 gwei just scales the cost down — it doesn't break fee accounting. Admin
  // can still raise it in Settings (which sets minGasPriceWei directly).
  const GAS_FLOOR_CAP = 1_000_000_000n; // 1 gwei
  let derived = txFeeWei / 21000n;
  if (derived > GAS_FLOOR_CAP) derived = GAS_FLOOR_CAP;
  const minGas = derived.toString();
  if (config.minGasPriceWei === minGas) {
    console.log(`[boot] deferredFeeRefresh: minGasPriceWei already ${minGas} (capped at 1 gwei), no action`);
    return;
  }
  console.log(`[boot] deferredFeeRefresh: APOS txFeeWei=${txFeeWei}; setting minGasPriceWei ${config.minGasPriceWei} -> ${minGas} (capped at 1 gwei for cheap testnet gas) and restarting Nethermind`);
  config.minGasPriceWei = minGas;
  saveConfig(config);
  // Restart Nethermind so the new --Blocks.MinGasPrice takes effect.
  // autoRestartNode handles all modes (validator/operator/sync).
  try { await stopNode(); } catch {}
  await new Promise(r => setTimeout(r, 2000));
  try { await autoRestartNode(); } catch (e) { console.warn('[boot] auto-restart after fee refresh failed:', e.message); }
}

// API to restart node (used by frontend when node crashed)
app.post('/api/wizard/restart-node', requireAuth, async (req, res) => {
  try {
    if (!config) return res.status(400).json({ error: 'No config found' });
    const specPath = path.join(DATA_DIR, 'chainspec.json');
    if (!fs.existsSync(specPath)) return res.status(400).json({ error: 'No chainspec found' });

    if (config.mode === 'pos-converted' || config.mode === 'apos-converted' || config.mode === 'created') {
      const key = config.validatorKey;
      if (!key) return res.status(400).json({ error: 'No validator key in config' });
      const extraArgs = config.stakingContract
        ? ['--PoS.StakingContractAddress', config.stakingContract]
        : [];
      await startNethermind(specPath, key, extraArgs);
      res.json({ success: true, message: 'Node restarted in PoS mode' });
    } else {
      res.status(400).json({ error: 'Cannot auto-restart in mode: ' + config.mode });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API to restart node in sync mode (used by frontend on page reload during sync)
app.post('/api/wizard/restart-sync', requireAuth, async (req, res) => {
  try {
    if (!config) return res.status(400).json({ error: 'No config found' });
    if (config.mode !== 'syncing') return res.status(400).json({ error: 'Not in syncing mode' });
    if (!config.enodeUrl) return res.status(400).json({ error: 'No enode URL in config' });
    const specPath = path.join(DATA_DIR, 'chainspec.json');
    if (!fs.existsSync(specPath)) return res.status(400).json({ error: 'No chainspec found' });
    // Reset sync tracker
    syncTracker = { highestBlockEverSeen: 0, prevBlock: 0, slowGrowthCount: 0 };
    await startNethermindSyncOnly(specPath, config.enodeUrl, false); // false = don't clear DB
    res.json({ success: true, message: 'Node restarted in sync mode' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// APOS — UNPRegistry endpoints (deploy, admin approvals, packages, fees)
// ═══════════════════════════════════════════════════════════════════
try {
  const apos = require('./apos');
  apos.mount(app, {
    web3Ref:     () => web3,
    requireAuth,
    dataDir:     DATA_DIR,
    getConfig:   () => config,
    saveConfig,
    sendAndWait,
    realChainId,
    safeGasPrice,           // floored at minGasPriceWei so fresh chains never sign gasPrice=0 txs
    validateExternalUrl,    // v7.0.3 SSRF guard for adminUrl-style fetches
    // v7.2.2: expose restartNode so /api/apos/deploy-pointer can restart Nethermind
    // after baking aposPointer into chainspec. The C# Layer-2 fee-distributor reads
    // engine.pos.params.aposPointer at startup; without a restart it would still
    // be using the (null) value from boot.
    restartNode: autoRestartNode,
    // v7.11.11 — expose nodeAlive so apos.js can wait for Nethermind to
    // come back after a chainspec-restart before submitting txs that
    // would otherwise be swallowed by the discarded pre-restart mempool.
    nodeAlive,
    log:         (...a) => console.log('[apos]', ...a),
  });
} catch (e) {
  console.warn('[apos] mount failed:', e.message);
}

// v7.5.0 — Bridge orchestrator (L1 mirror ↔ L2 source-of-truth).
// Activated by config.bridgeMode = 'L1' | 'L2'. Both modes are no-ops
// until the user fills in the bridge configuration via the wizard.
let _bridgeApi = null;
try {
  const bridge = require('./bridge');
  _bridgeApi = bridge.init(app, {
    web3Ref: () => web3,
    getConfig: () => config,
    DATA_DIR,
    decryptKey: _decryptKey,
    log: (...a) => console.log('[bridge]', ...a),
  });
} catch (e) {
  console.warn('[bridge] init failed:', e.message);
}

// Forward Docker's stop signal (SIGTERM/SIGINT) to Nethermind so it can flush
// the DB cleanly before the container disappears. Without this, RocksDB
// shuts down hard and the next container boot gets stuck in "Syncing
// previously downloaded blocks from DB" forever.
let _shuttingDown = false;
async function gracefulShutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[wizard] Received ${sig} — flushing Nethermind & exiting...`);
  try { await stopNode(); } catch (e) { console.warn('[wizard] stopNode error:', e?.message); }
  // Give RocksDB a moment after the SIGTERM finishes
  await new Promise(r => setTimeout(r, 1500));
  console.log('[wizard] Bye.');
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Elyon Chain Wizard Dashboard`);
  console.log(`  Mode:       ${STANDALONE ? 'Standalone (manages node)' : 'Connected to ' + RPC_URL}`);
  console.log(`  Panel:      http://localhost:${PORT}`);
  console.log(`  Persistent: ${DATA_DIR}  (DB, keystore, logs, chainspec, wizard-config, fees)`);
  console.log(`              -> mount this path as a Docker volume to keep data across container recreates\n`);
  // Auto-restart after a brief delay so the server is fully ready
  setTimeout(autoRestartNode, 2000);
  setTimeout(deferredFeeRefresh, 0);
  setTimeout(aposFeeDistributorWorker, 30_000);
  // v7.8-no-ssl: domain endpoints are now 410 stubs; Caddy is gone entirely.
  try { mountDomainEndpoints(); } catch (e) { console.warn('[no-ssl] mount stubs failed:', e.message); }
});

// ─── APOS Fee Distributor Worker ───────────────────────────────────
// Per spec section 5: every transaction's gas fee should be forwarded to
// UNPRegistry.creditTxFee(sender, target) so the contract distributes it
// per the BPS policy (10% to ACTIVE node operators, 5% to ACTIVE contract
// owners, 3% to ACTIVE token issuers, residual ~82% to admin).
//
// The proper Nethermind-level implementation (system-call hook in the
// block processor) is documented in APOSFeeDistributor.cs but not wired.
// This worker is the dashboard-side shim called out in the comment of
// that file: "for tests / dev nets, an off-chain shim in dashboard/server.js
// handles the forwarding while this in-process queue is integrated."
//
// Caveats:
//   - Only runs on the validator/admin node (has validatorKey).
//   - Validator pays gas for each credit tx (~80k gas). For low-volume
//     chains this is a small operational cost; for high volume it's
//     amortised.
//   - Credit txs themselves are skipped (`to == aposRegistry`) to prevent
//     feedback loops.
const CREDIT_TX_FEE_SELECTOR = '0xd5eb88a2'; // bytes4(keccak256("creditTxFee(address,address)"))
function encodeCreditCalldata(sender, target) {
  const s = sender.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const t = target.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return CREDIT_TX_FEE_SELECTOR + s + t;
}

async function aposFeeDistributorWorker() {
  if (!STANDALONE) return;
  // v7.2.0: Layer 2 (consensus-level state-mutation hook in BlockProcessor)
  // is now the source of truth for fee distribution. The off-chain worker is
  // disabled to prevent double-counting. Re-enable by setting env var
  // APOS_LEGACY_WORKER=1 (e.g. on a chain that hasn't been rebuilt with v7.2.0
  // Nethermind binaries).
  if (process.env.APOS_LEGACY_WORKER !== '1') {
    console.log('[apos-fee] worker disabled — Layer 2 (consensus hook) handles fee distribution');
    return;
  }
  // Persistent-state design (durable across restarts):
  //   - relayedTxHashes  : txs proxied through us, NOT yet credited
  //   - creditedTxHashes : txs we already submitted creditTxFee for
  //   - lastScannedBlock : highest block we've fully scanned
  //
  // Each iteration scans from max(lastScannedBlock+1 - SAFETY, 0) to head.
  // The look-back window of SAFETY=50 blocks ensures any tx that was
  // relayed but not credited (e.g. credit submission failed transiently)
  // is retried automatically. Idempotency is guaranteed by checking
  // creditedTxHashes — a tx already credited is skipped.
  //
  // We re-read config.aposRegistry every iteration so registry upgrades
  // via the pointer take effect within ~8s.
  //
  // v7.1.9: do NOT exit if validatorKey/aposRegistry are missing at
  // startup — they get populated later when the wizard runs convert-pos
  // and deploy-apos. The worker enters its idle loop and re-checks every
  // 8 s; once both are set, it lazily derives the validator account and
  // starts crediting. Previously this function returned at boot and
  // never recovered, leaving fees uncredited until a container restart.
  console.log('[apos-fee] worker started; will credit txs relayed through THIS RPC');

  let validator = null;
  let lastValidatorKey = null;
  const SAFETY_LOOKBACK = 50; // blocks
  let lastLoggedRegistry = null;
  let loggedDisabled = false;

  while (true) {
    try {
      await new Promise(r => setTimeout(r, 8000));
      if (!nodeProc) continue;
      // v7.1.9: late-binding of validator key. The wizard sets validatorKey
      // during convert-pos AFTER the dashboard (and this worker) started.
      // Re-derive whenever the configured key changes.
      if (!config?.validatorKey) {
        if (!loggedDisabled) {
          console.log('[apos-fee] no validatorKey in config yet — idling, will retry every 8s');
          loggedDisabled = true;
        }
        continue;
      }
      if (config.validatorKey !== lastValidatorKey) {
        validator = web3.eth.accounts.privateKeyToAccount(config.validatorKey);
        lastValidatorKey = config.validatorKey;
        loggedDisabled = false;
        console.log('[apos-fee] validatorKey loaded; crediting from', validator.address);
      }
      const registry = (config?.aposRegistry || '').toLowerCase();
      if (!registry) continue;
      if (registry !== lastLoggedRegistry) {
        console.log('[apos-fee] now crediting fees to registry', registry,
          lastLoggedRegistry ? '(was ' + lastLoggedRegistry + ' — upgraded via pointer)' : '');
        lastLoggedRegistry = registry;
      }
      const head = Number(await web3.eth.getBlockNumber().catch(() => -1));
      if (head < 0) continue;
      // v7.1.11: update cached head so recordRelayedTx can pin properly.
      cachedHead = head;
      // First-time / fresh-state startup: begin from current head so we
      // don't try to retro-credit ancient blocks. After the first tick,
      // lastScannedBlock advances normally and the SAFETY_LOOKBACK keeps
      // recently-seen blocks under retry.
      // v7.0.4: env-tunable backfill. Set APOS_FEE_RETROCREDIT_FROM=N to
      // make the worker scan from block N forward on first tick — useful
      // after recovering from a worker crash that lost relayed-tx state.
      if (lastScannedBlock < 0) {
        const backfillFrom = parseInt(process.env.APOS_FEE_RETROCREDIT_FROM || '', 10);
        if (Number.isFinite(backfillFrom) && backfillFrom >= 0 && backfillFrom < head) {
          lastScannedBlock = Math.max(0, backfillFrom - 1);
          console.log(`[apos-fee] retro-credit enabled: scanning from block ${backfillFrom} forward (env APOS_FEE_RETROCREDIT_FROM)`);
        } else {
          lastScannedBlock = head;
        }
        persistRelayedTxState();
      }
      const fromBlock = Math.max(0, lastScannedBlock + 1 - SAFETY_LOOKBACK);
      // Cap per-iteration work so we don't stall on a long catch-up.
      const toBlock = Math.min(head, lastScannedBlock + 200);
      for (let bn = fromBlock; bn <= toBlock; bn++) {
        await processBlockForFeeDistribution(bn, validator, registry);
      }
      // v7.1.10 FIX (orphan-credit bug): do NOT advance lastScannedBlock past
      // any block that still contains an uncredited relayed tx. Otherwise the
      // SAFETY_LOOKBACK window scrolls past those blocks and the worker can
      // never re-scan them — credit lost forever.
      //
      // For each relayed-tx, processBlockForFeeDistribution() now records the
      // block it was found in (entry.block). The advance ceiling is
      //   min(entry.block - 1)  over all UNCREDITED relayed entries.
      // If no uncredited entries have a known block (yet), we may advance
      // freely — the safety lookback still re-scans recent blocks.
      // v7.1.11: pin advance based on EITHER known block (entry.block) OR the
      // recorded-at-block snapshot (entry.recordedAtBlock). Without the second
      // fallback, txs that race mining-vs-relay get orphaned forever — their
      // entry.block never gets set because the worker scanned past their
      // mining block before recordRelayedTx was called.
      let safeAdvance = toBlock;
      for (const [hash, entry] of relayedTxHashes) {
        if (creditedTxHashes.has(hash)) continue;
        let pin = null;
        if (typeof entry?.block === 'number') {
          pin = entry.block - 1;
        } else if (typeof entry?.recordedAtBlock === 'number' && entry.recordedAtBlock > 0) {
          // Tx must be in a block ≥ recordedAtBlock - SAFETY_LOOKBACK (allowing
          // for slight clock skew between record-time head and mining).
          pin = Math.max(0, entry.recordedAtBlock - SAFETY_LOOKBACK) - 1;
        }
        if (pin !== null && pin < safeAdvance) safeAdvance = pin;
      }
      if (safeAdvance > lastScannedBlock) {
        if (safeAdvance < toBlock) {
          // Pinned by an uncredited tx — log first time it happens to flag
          // operator attention.
          if (!loggedPinned) {
            console.warn(`[apos-fee] lastScannedBlock pinned at ${safeAdvance} (head=${head}); ${countUncredited()} uncredited relayed txs are awaiting credit`);
            loggedPinned = true;
          }
        } else {
          loggedPinned = false;
        }
        lastScannedBlock = safeAdvance;
        persistRelayedTxState();
      }

      // v7.1.10: TTL relayed entries so a permanently-evicted-from-mempool tx
      // doesn't pin lastScannedBlock forever. After 24 h with no block sighting,
      // the entry is dropped.
      const RELAYED_TTL_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      for (const [hash, entry] of relayedTxHashes) {
        if (creditedTxHashes.has(hash)) continue;
        if (typeof entry?.block === 'number') continue; // sighted in a block — keep
        if (entry?.acceptedAt && (now - entry.acceptedAt) > RELAYED_TTL_MS) {
          relayedTxHashes.delete(hash);
          console.warn(`[apos-fee] dropping unmined relayed tx after 24h: ${hash}`);
        }
      }
    } catch (e) {
      console.warn('[apos-fee] loop error:', e.message);
    }
  }
}

function countUncredited() {
  let n = 0;
  for (const [h] of relayedTxHashes) if (!creditedTxHashes.has(h)) n++;
  return n;
}
let loggedPinned = false;

async function processBlockForFeeDistribution(blockNum, validator, registry) {
  const block = await web3.eth.getBlock(blockNum, true).catch(() => null);
  if (!block?.transactions) return;
  const valLower = (validator?.address || '').toLowerCase();
  for (const tx of block.transactions) {
    if (!tx.to) continue; // contract creation, skip (no target → no contract-owner share)
    // Skip ONLY the worker's own creditTxFee feedback txs (validator → registry).
    // Every OTHER user tx — even one targeting the registry directly
    // (stakeInPackage / applyAsXxxViaPackage / withdrawNodeFees / etc.) —
    // is a legitimate fee-bearing tx and gets credited.
    const fromLower = (tx.from || '').toLowerCase();
    if (tx.to.toLowerCase() === registry && fromLower === valLower) continue;

    // Only credit txs we relayed AND haven't already credited.
    const txHash = tx.hash.toLowerCase();
    const entry = relayedTxHashes.get(txHash);
    if (!entry) continue;
    if (creditedTxHashes.has(txHash)) {
      // Already credited in a prior iteration. Cleanup straggler entry.
      relayedTxHashes.delete(txHash);
      persistRelayedTxState();
      continue;
    }

    // v7.1.10: pin entry.block as soon as we see the tx in any block — this is
    // what gates lastScannedBlock advancement so the worker is forced to keep
    // re-scanning this block until the tx is either credited or 24h-TTL'd.
    if (entry.block !== blockNum) {
      entry.block = blockNum;
      persistRelayedTxState();
    }

    const receipt = await web3.eth.getTransactionReceipt(tx.hash).catch(e => ({_err: e?.message || String(e)}));
    if (!receipt || receipt._err) {
      // Pruning hits us here. Receipt unavailable. We MUST NOT advance past
      // this block — the lastScannedBlock cap upstream now enforces that
      // because entry.block is set above. Next scan tick we'll retry.
      if (receipt?._err && !/pruned history/i.test(receipt._err)) {
        console.warn(`[apos-fee] receipt fetch error block=${blockNum} tx=${tx.hash.slice(0,10)}: ${receipt._err.slice(0,120)}`);
      }
      continue;
    }
    const gasPrice = BigInt(tx.effectiveGasPrice ?? tx.gasPrice ?? 0n);
    const gasUsed  = BigInt(receipt.gasUsed);
    const fee      = gasUsed * gasPrice;
    if (fee === 0n) {
      // Zero-fee tx — nothing to distribute. Mark credited so we don't keep retrying.
      creditedTxHashes.add(txHash);
      relayedTxHashes.delete(txHash);
      persistRelayedTxState();
      continue;
    }

    try {
      const nonce = await web3.eth.getTransactionCount(validator.address, 'pending');
      const data  = encodeCreditCalldata(validator.address, tx.to);
      const signed = await validator.signTransaction({
        to: config.aposRegistry,
        data,
        value: fee,
        gas: 200000n,
        gasPrice: BigInt(config.minGasPriceWei || '50000000000'),
        nonce: BigInt(nonce),
        chainId: Number(config.chainId),
      });
      const sub = await fetch(RPC_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [signed.rawTransaction], id: 1 }),
      }).then(r => r.json()).catch(() => null);
      if (sub?.error) throw new Error(sub.error.message);
      // Atomic transition relayed → credited (ONLY after successful submit).
      // If we crash here, next scan retries naturally because the tx is
      // still in `relayedTxHashes` and absent from `creditedTxHashes`.
      creditedTxHashes.add(txHash);
      relayedTxHashes.delete(txHash);
      persistRelayedTxState();
      console.log(`[apos-fee] credited ${fee} wei (block ${blockNum} tx ${tx.hash.slice(0, 10)})`);
    } catch (e) {
      const msg = e.message || String(e);
      // v7.1.10: bump retry budget on this entry. After 10 failures, stop
      // retrying this specific tx and flag it for manual review (rare —
      // usually a contract revert, registry pause, or insufficient gas).
      entry.creditFails = (entry.creditFails || 0) + 1;
      if (!/pruned history/i.test(msg)) {
        console.warn(`[apos-fee] credit failed for tx ${tx.hash} (attempt ${entry.creditFails}): ${msg.slice(0, 200)}`);
      }
      if (entry.creditFails >= 10) {
        console.error(`[apos-fee] giving up on tx ${tx.hash} after 10 credit attempts (last error: ${msg.slice(0,120)})`);
        // Move to credited (with a marker) so it stops blocking lastScannedBlock advance.
        creditedTxHashes.add(txHash);
        relayedTxHashes.delete(txHash);
      }
      persistRelayedTxState();
    }
  }
}

// ─── JSON-RPC proxy with min-fee enforcement ─────────────────────────
// Nethermind binds 127.0.0.1:8540 (internal). Externally-visible 8545
// is this proxy, which inspects every eth_sendRawTransaction and rejects
// transactions whose effective gasPrice is below the chain's APOS-derived
// floor (config.minGasPriceWei = txFeeWei / 21000). Everything else is
// pass-through.
const { RLP: rlp } = require('@ethereumjs/rlp');

function bytesToBigInt(buf) {
  if (!buf || buf.length === 0) return 0n;
  return BigInt('0x' + Buffer.from(buf).toString('hex'));
}

// Returns the effective gas-price floor the tx is offering. For legacy
// (type-0) and 2930 (type-1) tx the field is `gasPrice`. For 1559
// (type-2) tx, the floor is `maxFeePerGas` — that's the most the sender
// is willing to pay; admin can include up to that. For our chain, both
// floors must be >= minGasPriceWei.
function decodeTxFloor(rawTxHex) {
  if (!rawTxHex || typeof rawTxHex !== 'string' || !rawTxHex.startsWith('0x')) {
    throw new Error('rawTx must be 0x-prefixed hex');
  }
  const bytes = Buffer.from(rawTxHex.slice(2), 'hex');
  if (bytes.length === 0) throw new Error('empty rawTx');
  const first = bytes[0];
  if (first >= 0xc0) {
    // Legacy: RLP([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
    const dec = rlp.decode(bytes);
    return { type: 0, gasPrice: bytesToBigInt(dec[1]) };
  }
  if (first === 0x01) {
    // 2930: 0x01 || RLP([chainId, nonce, gasPrice, gasLimit, to, value, data, accessList, v, r, s])
    const dec = rlp.decode(bytes.slice(1));
    return { type: 1, gasPrice: bytesToBigInt(dec[2]) };
  }
  if (first === 0x02) {
    // 1559: 0x02 || RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, v, r, s])
    const dec = rlp.decode(bytes.slice(1));
    return { type: 2, gasPrice: bytesToBigInt(dec[3]) };
  }
  throw new Error(`unsupported tx type: 0x${first.toString(16)}`);
}

const rpcApp = express();
rpcApp.use(express.json({ limit: '10mb' }));
rpcApp.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
// ticket #9 (BUG-005): trap body-parser SyntaxError on the public RPC proxy
// so a malformed JSON body returns -32700 Parse error instead of Express's
// default HTML stack trace (which leaked __dirname / node_modules paths).
rpcApp.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(200).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  return next(err);
});

async function forwardToNethermind(body) {
  const r = await fetch(RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// ════════════════════════════════════════════════════════════════════
// Persistent relayed-tx state.
//
// The fee-distribution worker depends on knowing "which txs did THIS RPC
// proxy relay?" — a question with no on-chain answer. The original
// implementation kept that set in memory only, which made it disappear
// on every container restart, and credited each tx exactly once before
// the credit on-chain succeeded (so any transient credit failure also
// dropped the tx forever). Both modes lost real earnings.
//
// The fix below persists three things to disk under DATA_DIR:
//   relayedTxHashes  — txs proxied through this node, NOT yet credited
//                      on-chain. Survives restarts.
//   creditedTxHashes — txs we already submitted creditTxFee for. Used to
//                      idempotently skip on retries.
//   lastScannedBlock — highest block we've fully scanned. The worker
//                      always re-scans the last 50 blocks on startup so
//                      anything that hadn't been credited before crash/
//                      restart gets retried.
//
// Crash semantics: a tx is removed from `relayedTxHashes` ONLY after the
// `creditTxFee` submission has been accepted by Nethermind (we have the
// tx hash). Even partial work — credit submitted but receipt not yet
// confirmed — is durable: next scan won't re-submit because the tx is
// already in `creditedTxHashes`.
// ════════════════════════════════════════════════════════════════════
const RELAYED_STATE_PATH = path.join(DATA_DIR, 'relayed-tx-state.json');
const RELAYED_TX_CAP = 50000; // generous — entries are tiny

const relayedTxHashes = new Map();   // txHash -> { acceptedAt: ms, sender }
const creditedTxHashes = new Set();  // txHash strings (lowercase)
let   lastScannedBlock = -1;

// Cap creditedTxHashes so the on-disk state stays bounded over months.
// We only need to remember a tx as "credited" until lastScannedBlock has
// moved past block(tx) + SAFETY (~50 blocks). 100k entries is a couple of
// weeks of high-volume activity at our settings.
const CREDITED_CAP = 100000;
function trimCreditedSet() {
  if (creditedTxHashes.size <= CREDITED_CAP) return;
  const it = creditedTxHashes.values();
  while (creditedTxHashes.size > CREDITED_CAP) {
    const v = it.next().value;
    if (v === undefined) break;
    creditedTxHashes.delete(v);
  }
}
let _persistTimer = null;
function persistRelayedTxState() {
  // Debounce: cluster multiple updates into one fs write within 1s.
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      trimCreditedSet();
      const tmp = RELAYED_STATE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        relayed: Array.from(relayedTxHashes.entries()),
        credited: Array.from(creditedTxHashes),
        lastScannedBlock,
        savedAt: Date.now(),
      }));
      fs.renameSync(tmp, RELAYED_STATE_PATH); // atomic on POSIX & NTFS
    } catch (e) { console.warn('[apos-fee] persist failed:', e.message); }
  }, 1000);
}
function loadRelayedTxState() {
  try {
    if (!fs.existsSync(RELAYED_STATE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(RELAYED_STATE_PATH, 'utf8'));
    if (Array.isArray(raw.relayed)) for (const [k, v] of raw.relayed) relayedTxHashes.set(k, v);
    if (Array.isArray(raw.credited)) for (const k of raw.credited) creditedTxHashes.add(k);
    if (Number.isFinite(raw.lastScannedBlock)) lastScannedBlock = raw.lastScannedBlock;
    console.log('[apos-fee] state restored: relayed=' + relayedTxHashes.size +
      ' credited=' + creditedTxHashes.size + ' lastScannedBlock=' + lastScannedBlock);
  } catch (e) {
    console.warn('[apos-fee] state load failed (starting fresh):', e.message);
  }
}
function recordRelayedTx(txHash, senderHint) {
  if (!txHash || typeof txHash !== 'string') return;
  const k = txHash.toLowerCase();
  // If we already credited this hash there's no point re-tracking it.
  if (creditedTxHashes.has(k)) return;
  if (relayedTxHashes.size >= RELAYED_TX_CAP) {
    const oldest = relayedTxHashes.keys().next().value;
    if (oldest) relayedTxHashes.delete(oldest);
  }
  // v7.1.11: capture cached head at record-time. If the tx mines BEFORE the
  // worker's next scan (race we hit during high-volume tests), we still know
  // the earliest block it could have appeared in — used by the pin logic to
  // force a re-scan far enough back to find it. cachedHead is updated by
  // the apos-fee worker on each iteration.
  relayedTxHashes.set(k, {
    acceptedAt: Date.now(),
    sender: senderHint || null,
    recordedAtBlock: cachedHead,
  });
  persistRelayedTxState();
}
// v7.1.11: shared between RPC proxy and worker. Worker writes here every tick.
let cachedHead = 0;
loadRelayedTxState();
function localHashFromRaw(rawHex) {
  try { return web3.utils.keccak256(rawHex); } catch { return null; }
}

// ─── v7.3.0 Layer 2 — Relayer Attestation ──────────────────────────
// When a tx arrives via THIS node's RPC, sign a 117-byte attestation
// claiming "RPC X received this tx first" and drop it in
// /data/attestations/<txHash>.bin. The block producer (patched
// PoSBlockProducer) reads these files when assembling blocks and
// embeds the attestations in block.ExtraData. The L2 hook then
// credits the attested relayer the FULL 10% node-share for that tx.
//
// Without this attestation, the L2 hook falls back to equal-split.
// So nodes that don't run this dashboard, OR txs that aren't relayed
// via this RPC, get equal-split (v7.2.x behaviour) — preserves
// backwards compatibility.
//
// File format (binary, 117 bytes):
//   txHash    (32 bytes)
//   relayer   (20 bytes — this node's validator address)
//   signature (65 bytes — secp256k1 r||s||v over digest, V=27/28)
//
// Signing digest:
//   keccak256("ELY-RELAY-V1" ‖ chainId(8 BE) ‖ txHash ‖ relayer)
const ATTESTATION_DIR = path.join(DATA_DIR, 'attestations');
try { fs.mkdirSync(ATTESTATION_DIR, { recursive: true }); } catch {}

let _noble = null;
function _loadNoble() {
  if (_noble) return _noble;
  try {
    const { secp256k1 } = require('@noble/curves/secp256k1');
    const { keccak_256 } = require('@noble/hashes/sha3');
    _noble = { secp256k1, keccak_256 };
  } catch (e) {
    console.warn('[apos-relay] @noble libs unavailable; attestation disabled:', e.message);
    _noble = false;
  }
  return _noble;
}

function _computeRelayDigest(chainId, txHashHex, relayerAddrHex) {
  const noble = _loadNoble();
  if (!noble) return null;
  // v7.11.3 CRITICAL: domain MUST match Nethermind's
  // RelayerAttestationCodec.ComputeDigest which uses the literal
  // "UNP-RELAY-V1". This was previously renamed to "ELY-RELAY-V1" in
  // the dashboard during the Elyon rebrand, but the C# verifier was
  // never updated — every attestation signature failed verification,
  // the L2 hook dropped them all, and operator-relayed user txs fell
  // back to equal-split among active validators. DO NOT change this
  // string without simultaneously rebuilding the patched Nethermind.
  const domain = Buffer.from('UNP-RELAY-V1', 'ascii');
  // chainId 8 bytes big-endian
  const cidBuf = Buffer.alloc(8);
  let cid = BigInt(chainId);
  for (let i = 7; i >= 0; i--) { cidBuf[i] = Number(cid & 0xFFn); cid >>= 8n; }
  // txHash 32 bytes
  const txBuf = Buffer.from(txHashHex.replace(/^0x/, ''), 'hex');
  if (txBuf.length !== 32) return null;
  // relayer 20 bytes
  const addrBuf = Buffer.from(relayerAddrHex.replace(/^0x/, ''), 'hex');
  if (addrBuf.length !== 20) return null;
  const buf = Buffer.concat([domain, cidBuf, txBuf, addrBuf]);
  return Buffer.from(noble.keccak_256(buf));
}

// v7.11.0 — admin-side receiver. Operators POST 117-byte attestation
// records here; we drop them into the local /data/attestations/ dir so
// the patched Nethermind's FileSystemWatcher imports them into the
// RelayerAttestationPool. The signature is RE-VERIFIED inside Nethermind
// before any block uses it, so we don't need to validate here.
app.post('/api/internal/relayer-attestation', express.raw({type: '*/*', limit: '256kb'}), (req, res) => {
  try {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length !== 117) {
      return res.status(400).json({ error: 'expected 117-byte raw attestation' });
    }
    const hashHex = String(req.headers['x-tx-hash'] || '').replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hashHex)) return res.status(400).json({ error: 'X-Tx-Hash header missing/invalid' });
    const onDiskHash = buf.subarray(0, 32).toString('hex');
    if (onDiskHash !== hashHex) return res.status(400).json({ error: 'hash mismatch with payload' });
    if (!fs.existsSync(ATTESTATION_DIR)) fs.mkdirSync(ATTESTATION_DIR, { recursive: true });
    const filePath = path.join(ATTESTATION_DIR, hashHex + '.bin');
    fs.writeFileSync(filePath, buf);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function _signAndStoreAttestation(txHashHex) {
  try {
    const noble = _loadNoble();
    if (!noble) return false;
    if (!config?.validatorAddress || !config?.validatorKey) return false;
    if (!config?.chainId) return false;
    const pkRaw = String(config.validatorKey).startsWith('enc:v1:')
      ? _decryptKey(config.validatorKey)
      : config.validatorKey;
    const pk = Buffer.from(pkRaw.replace(/^0x/, ''), 'hex');
    if (pk.length !== 32) return false;
    const relayerAddr = config.validatorAddress.toLowerCase();
    const digest = _computeRelayDigest(config.chainId, txHashHex, relayerAddr);
    if (!digest) return false;
    const sig = noble.secp256k1.sign(digest, pk);
    // Pack r||s||v (V = 27 + recoveryBit)
    const r = sig.r.toString(16).padStart(64, '0');
    const s = sig.s.toString(16).padStart(64, '0');
    const v = 27 + (sig.recovery & 1);
    const sigBytes = Buffer.concat([
      Buffer.from(r, 'hex'),
      Buffer.from(s, 'hex'),
      Buffer.from([v]),
    ]);
    // Attestation record = txHash(32) || relayer(20) || sig(65) = 117 bytes
    const rec = Buffer.concat([
      Buffer.from(txHashHex.replace(/^0x/, ''), 'hex'),
      Buffer.from(relayerAddr.replace(/^0x/, ''), 'hex'),
      sigBytes,
    ]);
    if (rec.length !== 117) return false;
    const filePath = path.join(ATTESTATION_DIR, txHashHex.replace(/^0x/, '').toLowerCase() + '.bin');
    fs.writeFileSync(filePath, rec);
    // v7.11.0 — operator forwards the attestation to admin's dashboard
    // so admin's block producer can pick it up locally. Without this,
    // attestations stay on the operator's disk and the admin's L2 hook
    // falls back to equal-split among all active nodes.
    // v7.11.1: AWAIT the forward (with a tight 2s timeout) so the
    // attestation lands on admin's disk BEFORE the calling RPC handler
    // forwards the tx into the mempool — guarantees admin's block producer
    // can find the attestation by the time it builds the next block.
    try {
      if (config?.role === 'operator' && config?.adminBootstrapUrl) {
        const base = String(config.adminBootstrapUrl).replace(/\/+$/, '');
        const url  = base + '/api/internal/relayer-attestation';
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        try {
          await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              // v7.11.2: needed to bypass admin's CSRF gate. The gate
              // accepts either X-Requested-With: XMLHttpRequest OR a JSON
              // content-type; octet-stream alone was 403'd silently.
              'X-Requested-With': 'XMLHttpRequest',
              'X-Tx-Hash': txHashHex.replace(/^0x/, '').toLowerCase(),
            },
            body: rec,
            signal: ctrl.signal,
          });
        } catch {}
        clearTimeout(t);
      }
    } catch {}
    return true;
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[apos-relay] attestation failed:', e.message);
    return false;
  }
}

// Background cleanup: delete attestation files older than 1 hour. Block
// producer will have included them by then; if not, the tx didn't make it.
setInterval(() => {
  try {
    if (!fs.existsSync(ATTESTATION_DIR)) return;
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const f of fs.readdirSync(ATTESTATION_DIR)) {
      const fp = path.join(ATTESTATION_DIR, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}, 5 * 60 * 1000); // every 5 min

// v7.0 SECURITY: per-IP rate limit on the public RPC proxy. Prevents trivial
// DoS by spamming JSON-RPC calls. Trusted local IPs bypass the limit.
const RPC_RATE_WINDOW_MS = 60_000;
// v7.0.3.1: env-tunable. Default 600/min/IP (~10 rps). Stress tests on a
// single source IP need much higher; bump via RPC_RATE_MAX env var.
const RPC_RATE_MAX       = parseInt(process.env.RPC_RATE_MAX || '600', 10);
const rpcRateMap = new Map();            // ip -> { count, windowStart }
function rpcRateCheck(req) {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  // v7.0.3 SECURITY (audit I7): rate-limit loopback unless explicitly trusted.
  if (!ip) return true;
  if (process.env.TRUST_LOOPBACK === '1' && (ip === '127.0.0.1' || ip === '::1')) return true;
  const now = Date.now();
  let r = rpcRateMap.get(ip);
  if (!r || now - r.windowStart > RPC_RATE_WINDOW_MS) {
    r = { count: 0, windowStart: now };
  }
  r.count += 1;
  rpcRateMap.set(ip, r);
  if (rpcRateMap.size > 50_000) {
    // Bound memory under spam
    for (const [k, v] of rpcRateMap) {
      if (now - v.windowStart > RPC_RATE_WINDOW_MS) rpcRateMap.delete(k);
    }
  }
  return r.count <= RPC_RATE_MAX;
}

// v7.0 SECURITY: explicit allowlist of JSON-RPC methods. Anything outside the
// list is rejected (covers debug_*, admin_*, personal_*, miner_*, etc.).
const RPC_METHOD_ALLOWLIST = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getBlockTransactionCountByNumber', 'eth_getBlockTransactionCountByHash',
  'eth_getTransactionByHash', 'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByBlockHashAndIndex', 'eth_getTransactionReceipt',
  'eth_getTransactionCount', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt',
  'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_feeHistory', 'eth_maxPriorityFeePerGas',
  'eth_sendRawTransaction', 'eth_getLogs', 'eth_subscribe', 'eth_unsubscribe',
  'eth_syncing', 'eth_accounts', 'eth_mining', 'eth_hashrate', 'eth_protocolVersion',
  'eth_getProof', 'eth_getUncleByBlockHashAndIndex', 'eth_getUncleByBlockNumberAndIndex',
  'eth_getUncleCountByBlockHash', 'eth_getUncleCountByBlockNumber',
  'net_version', 'net_listening', 'net_peerCount',
  'web3_clientVersion', 'web3_sha3',
  // Allow batch / RPC pings used by wallets:
  'rpc_modules',
]);

async function handleRpcCall(call) {
  const { method, params, id } = call || {};
  // v7.0: method allowlist
  if (method && !RPC_METHOD_ALLOWLIST.has(method)) {
    return rpcError(id, -32601, 'Method ' + method + ' is not exposed by this RPC. Allowed methods: ' + RPC_METHOD_ALLOWLIST.size + ' eth_/net_/web3_ entries (no debug_/admin_/personal_/miner_).');
  }
  if (method === 'eth_sendRawTransaction') {
    const minWei = config?.minGasPriceWei ? BigInt(config.minGasPriceWei) : 0n;
    if (minWei > 0n) {
      try {
        const { gasPrice, type } = decodeTxFloor(params?.[0]);
        if (gasPrice < minWei) {
          const minGwei = Number(minWei) / 1e9;
          const sentGwei = Number(gasPrice) / 1e9;
          return rpcError(id, -32000,
            `transaction underpriced: ${sentGwei} Gwei < chain minimum ${minGwei} Gwei ` +
            `(= APOS txFeeWei / 21000). Type-${type} tx rejected by node RPC; bump gasPrice` +
            (type === 2 ? '/maxFeePerGas' : '') + ' and retry.');
        }
      } catch (e) {
        return rpcError(id, -32602, 'failed to decode rawTx: ' + e.message);
      }
    }
    // Forward FIRST, then on success record the hash. We use the locally-
    // computed hash so we have it even if Nethermind returns a JSON-RPC
    // error for a tx that's actually already known.
    const localHash = localHashFromRaw(params?.[0]);
    // v7.3.0: sign + store a relayer attestation BEFORE forwarding, so the
    // file is on disk by the time the local block producer (if this node
    // proposes the next block) picks the tx from its mempool. Failure
    // (no validator key, no chainId, etc.) is non-fatal — we still forward
    // and the L2 hook will fall back to equal-split for this tx.
    if (localHash) {
      // v7.11.1: await the attestation pipeline (sign+store+forward) so it
      // lands on admin's disk BEFORE the tx hits admin's mempool.
      try { await _signAndStoreAttestation(localHash); } catch {}
    }
    // v7.5.0: if this dashboard is configured as bridgeMode=L1, also
    // forward the rawTx to the L2 peer so both chains mine the same tx.
    // Same chainId on both sides means the signed tx is valid on each.
    // Fire-and-forget; L2 forwarding failure must not break L1 ingress.
    if (config?.bridgeMode === 'L1' && _bridgeApi && typeof _bridgeApi.forwardTxToL2 === 'function') {
      _bridgeApi.forwardTxToL2(params?.[0]).catch(() => {});
    }
    const resp = await forwardToNethermind(call);
    if (localHash) recordRelayedTx(localHash, null);
    return resp;
  }
  return forwardToNethermind(call);
}

rpcApp.post('/', async (req, res) => {
  // v7.0: per-IP rate limit
  if (!rpcRateCheck(req)) {
    return res.status(429).json(rpcError(req.body?.id, -32005, 'rate limit exceeded; reduce request frequency'));
  }
  try {
    const body = req.body;
    if (Array.isArray(body)) {
      // Batch size limit prevents memory DoS via huge batches
      if (body.length > 50) {
        return res.status(413).json(rpcError(null, -32600, 'batch too large (max 50)'));
      }
      const out = await Promise.all(body.map(handleRpcCall));
      res.json(out);
    } else {
      const out = await handleRpcCall(body);
      res.json(out);
    }
  } catch (e) {
    // ticket #9 (BUG-005): never echo the raw e.message to the client — log it
    // here and return a generic JSON-RPC internal-error envelope instead.
    console.warn('[rpc-proxy] internal error:', e && e.message);
    res.status(500).json(rpcError(req.body?.id, -32603, 'Internal error'));
  }
});

rpcApp.listen(RPC_PROXY_PORT, '0.0.0.0', () => {
  console.log(`  RPC proxy:  http://0.0.0.0:${RPC_PROXY_PORT}  ->  Elyon node ${RPC_URL}`);
  console.log(`              filters eth_sendRawTransaction by config.minGasPriceWei\n`);
});

// v7.8.5: expose JSON-RPC behind /api/rpc on the main dashboard port
// (3000) so operator-panel (:4000) + simple-admin (:5000) can call
// eth_* / net_* via /api/proxy/api/rpc without browsers needing to
// talk to port 8545. Same handler as the public RPC proxy above.
//
// v7.42: ALSO serve the bare /rpc path. MetaMask rejects http:// RPC URLs
// and refuses ":8545" cross-origin, so dapps + the explorer advertise the
// HTTPS public endpoint https://<domain>/rpc (see line ~3681 / owner.html).
// nginx-proxy forwards everything to :3000, so /rpc must exist here or
// "Could not fetch chain ID" breaks every wallet network-add.
app.post(['/api/rpc', '/rpc'], async (req, res) => {
  try {
    const body = req.body;
    if (Array.isArray(body)) {
      const out = await Promise.all(body.map(handleRpcCall));
      res.json(out);
    } else {
      const out = await handleRpcCall(body);
      res.json(out);
    }
  } catch (e) {
    // ticket #9 (BUG-005): generic envelope to the client; details logged here.
    console.warn('[rpc] internal error:', e && e.message);
    res.status(500).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: 'Internal error' } });
  }
});

// ─── v7.48: User issue/feedback reports ──────────────────────────────
// Anyone can submit an observed bug / UX problem / optimization idea with a
// description + at least one screenshot. Stored on the admin node's volume.
// Admin reads them (auth-gated) to triage and fix.
app.post('/api/feedback', feedbackUpload.array('photos', 5), async (req, res) => {
  try {
    const b = req.body || {};
    const message = String(b.message || '').trim();
    const files = req.files || [];
    if (message.length < 5) return res.status(400).json({ error: 'Please describe the problem (at least a few words).' });
    if (!files.length)      return res.status(400).json({ error: 'Please attach at least one screenshot of the problem.' });
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const photos = files.map(f => ({ file: path.basename(f.path), name: f.originalname || 'image', size: f.size, mime: f.mimetype }));
    const entry = {
      id,
      createdAt: new Date().toISOString(),
      category: String(b.category || 'Bug').slice(0, 40),
      message: message.slice(0, 8000),
      contact: String(b.contact || '').slice(0, 200),
      page:    String(b.page || '').slice(0, 300),
      walletAddress: String(b.walletAddress || '').slice(0, 60),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(),
      status: 'new',
      photos,
    };
    const list = loadFeedback();
    list.unshift(entry);
    saveFeedback(list);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Could not save your report: ' + e.message });
  }
});

// Admin: list all reports (newest first).
app.get('/api/feedback', requireAuth, (req, res) => {
  try {
    const list = loadFeedback().map(e => ({
      ...e,
      photoUrls: (e.photos || []).map(p => '/api/feedback/img/' + encodeURIComponent(p.file)),
    }));
    res.json({ count: list.length, items: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: serve a report image (filename is validated to stay inside the dir).
app.get('/api/feedback/img/:file', requireAuth, (req, res) => {
  const safe = path.basename(String(req.params.file || ''));
  const p = path.join(FEEDBACK_IMG_DIR, safe);
  if (!p.startsWith(FEEDBACK_IMG_DIR) || !fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// Admin: update a report's status (new | triaged | fixed | wontfix).
app.post('/api/feedback/:id/status', requireAuth, (req, res) => {
  try {
    const status = String((req.body || {}).status || '').toLowerCase();
    if (!['new', 'triaged', 'fixed', 'wontfix'].includes(status)) return res.status(400).json({ error: 'bad status' });
    const list = loadFeedback();
    const e = list.find(x => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    e.status = status;
    saveFeedback(list);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// v7.11.17 — single-listener mode. Previously the operator panel had its
// own listener on :4000 and the simple-admin on :5000 (both in this same
// Node process). The user wants everything served from the canonical
// :3000 routes /admin, /manager, /node. We still need the modules'
// API route handlers (/api/operator/config, /api/proxy/*,
// /api/admin-proxy/*, /api/simple-admin/config) mounted on the main
// :3000 app, but we skip the standalone listen() — the static HTML
// served at /manager and /node is already wired by server.js earlier.
try {
  const opPanel = require('./operator-panel');
  if (typeof opPanel.wireRoutes === 'function') {
    opPanel.wireRoutes(app, { localApiPort: PORT });
    console.log('[operator-panel] routes mounted on :' + PORT + ' (/node served from /node; standalone :4000 listener DISABLED in v7.11.17)');
  }
} catch (e) {
  console.warn('[operator-panel] wire failed:', e.message);
}
try {
  const simpleAdmin = require('./simple-admin');
  if (typeof simpleAdmin.wireConfigRoute === 'function') {
    simpleAdmin.wireConfigRoute(app);
    console.log('[simple-admin] /api/simple-admin/config mounted on :' + PORT + ' (/manager served from /manager; standalone :5000 listener DISABLED in v7.11.17)');
  }
} catch (e) {
  console.warn('[simple-admin] wire failed:', e.message);
}
