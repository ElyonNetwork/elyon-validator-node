// Shared client-side utilities used by every page.

export const $  = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

export async function api(path, opts = {}) {
  const headers = { 'Accept': 'application/json', ...(opts.headers || {}) };
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    let err = res.statusText;
    try { err = (await res.json()).error || err; } catch {}
    throw new Error(err);
  }
  return res.json();
}

// Big-int formatting helpers (wei → ether, with reasonable precision).
const ten = (n) => 10n ** BigInt(n);
export function formatUnits(rawStr, decimals = 18, sig = 6) {
  if (rawStr == null) return '0';
  let v = BigInt(rawStr);
  const neg = v < 0n; if (neg) v = -v;
  const base = ten(decimals);
  const whole = v / base;
  const frac = v % base;
  let fracStr = frac.toString().padStart(decimals, '0').slice(0, sig).replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (fracStr ? '.' + fracStr : '');
}
export function fmtNative(rawWei, sig = 6) {
  return formatUnits(rawWei, 18, sig) + ' ELN';
}
export function fmtGwei(rawWei) {
  const v = BigInt(rawWei || '0');
  return formatUnits(v.toString(), 9, 4) + ' gwei';
}
export function fmtToken(rawAmt, decimals = 18, sig = 6) {
  return formatUnits(rawAmt, decimals, sig);
}

// Compact representation: 0xabcd…1234
export function short(addr, head = 6, tail = 4) {
  if (!addr) return '';
  if (!addr.startsWith('0x')) addr = '0x' + addr;
  if (addr.length <= head + tail + 1) return addr;
  return addr.slice(0, head) + '…' + addr.slice(-tail);
}

export function timeAgo(unixSeconds) {
  const t = Number(unixSeconds);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (d < 60) return d + ' sec' + (d === 1 ? '' : 's') + ' ago';
  const m = Math.floor(d / 60);
  if (m < 60) return m + ' min' + (m === 1 ? '' : 's') + ' ago';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' hr' + (h === 1 ? '' : 's') + ' ago';
  const days = Math.floor(h / 24);
  if (days < 30) return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  return new Date(t * 1000).toISOString().slice(0, 10);
}

export function timeFull(unixSeconds) {
  const t = Number(unixSeconds);
  if (!Number.isFinite(t) || t <= 0) return '';
  return new Date(t * 1000).toUTCString();
}

export function statusBadge(status) {
  if (status === 1) return '<span class="badge ok">Success</span>';
  if (status === 0) return '<span class="badge err">Failed</span>';
  return '<span class="badge gray">Pending</span>';
}

export function link(href, label, opts = {}) {
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  return `<a href="${href}"${cls}>${esc(label)}</a>`;
}
export function addrLink(addr, { trunc = true, hint = null } = {}) {
  if (!addr) return '<span class="muted">—</span>';
  const text = trunc ? short(addr) : addr;
  const title = hint || addr;
  return `<a class="mono" href="/address/${addr.toLowerCase()}" title="${esc(title)}">${esc(text)}</a>`;
}
export function txLink(hash, { trunc = true } = {}) {
  if (!hash) return '<span class="muted">—</span>';
  const text = trunc ? short(hash, 10, 6) : hash;
  return `<a class="mono" href="/tx/${hash.toLowerCase()}">${esc(text)}</a>`;
}
export function blockLink(num) {
  return `<a href="/block/${num}">${esc(String(num))}</a>`;
}

// Copy-to-clipboard helper for hash/address values.
export function copyButton(text) {
  return `<button class="btn ghost" style="padding:2px 6px;font-size:11px" onclick="navigator.clipboard.writeText('${esc(text)}');this.textContent='✓';setTimeout(()=>this.textContent='⧉',1200)">⧉</button>`;
}

// Method ID → friendly label (best-effort lookup table).
const KNOWN_METHODS = {
  '0xa9059cbb': 'transfer',
  '0x23b872dd': 'transferFrom',
  '0x095ea7b3': 'approve',
  '0x40c10f19': 'mint',
  '0x42966c68': 'burn',
  '0x70a08231': 'balanceOf',
  '0x18160ddd': 'totalSupply',
  '0xdd62ed3e': 'allowance',
  '0xa0712d68': 'mint',
  '0x6a627842': 'mint',
};
export function methodLabel(methodId) {
  if (!methodId) return '<span class="badge gray">Transfer</span>';
  const key = methodId.toLowerCase();
  const lbl = KNOWN_METHODS[key] || key.slice(0, 10);
  return `<span class="badge blue">${esc(lbl)}</span>`;
}
