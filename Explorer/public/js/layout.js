// Renders the top utility strip, header (brand + nav + search + wallet),
// and footer. Pass `{ heroSearch: true }` on the home page to suppress the
// header's compact search (the home hero has its own larger one).

import { api, esc, fmtGwei, fmtNative } from './common.js';
import { initWallet } from './wallet.js';

export async function renderLayout(activePage, opts = {}) {
  const { heroSearch = false } = opts;

  // ─── Top utility strip ────────────────────────────────────────────
  const strip = document.createElement('div');
  strip.className = 'top-strip';
  strip.innerHTML = `
    <div class="container">
      <span class="ticker" id="ts-native"><span>ELN Price:</span> <strong>—</strong></span>
      <span class="ticker" id="ts-gas">⛽ <span>Gas:</span> <strong>—</strong></span>
      <span class="ticker"><span>Head:</span> <strong id="ts-block">—</strong></span>

      <div class="ts-tools">
        <!-- Settings -->
        <div class="ts-tool" id="ts-settings-wrap">
          <button class="ts-icon-btn" id="ts-settings-btn" aria-label="Settings" title="Settings">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="10" cy="10" r="3"/>
              <path d="M16.5 12.3l1.4.8-1.5 2.6-1.6-.5a6.7 6.7 0 0 1-1.8 1l-.3 1.7h-3l-.3-1.7a6.7 6.7 0 0 1-1.8-1l-1.6.5-1.5-2.6 1.4-.8a6.7 6.7 0 0 1 0-2l-1.4-.8 1.5-2.6 1.6.5a6.7 6.7 0 0 1 1.8-1L8.5 2h3l.3 1.7a6.7 6.7 0 0 1 1.8 1l1.6-.5 1.5 2.6-1.4.8a6.7 6.7 0 0 1 0 2z"/>
            </svg>
          </button>
          <div class="ts-pop" id="ts-settings-pop">
            <h5>Display</h5>
            <label class="ts-pop-row">
              <span>Page size</span>
              <select id="ts-pagesize">
                <option value="25">25</option><option value="50">50</option><option value="100">100</option>
              </select>
            </label>
            <label class="ts-pop-row">
              <span>Time format</span>
              <select id="ts-timefmt">
                <option value="relative">Relative</option><option value="utc">UTC</option>
              </select>
            </label>
            <label class="ts-pop-row">
              <span>Address checksum</span>
              <select id="ts-checksum">
                <option value="off">Lowercase</option><option value="on">EIP-55 checksum</option>
              </select>
            </label>
          </div>
        </div>

        <!-- Theme toggle -->
        <button class="ts-icon-btn" id="ts-theme-btn" aria-label="Toggle theme" title="Toggle light/dark theme">
          <svg id="ts-theme-sun" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="10" cy="10" r="3.5"/>
            <path d="M10 1.5v2M10 16.5v2M3.7 3.7l1.4 1.4M14.9 14.9l1.4 1.4M1.5 10h2M16.5 10h2M3.7 16.3l1.4-1.4M14.9 5.1l1.4-1.4"/>
          </svg>
          <svg id="ts-theme-moon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none">
            <path d="M16.5 11.5A6.5 6.5 0 0 1 8.5 3.5a6.5 6.5 0 1 0 8 8z"/>
          </svg>
        </button>

        <!-- Network selector -->
        <div class="ts-tool" id="ts-net-wrap">
          <button class="ts-icon-btn ts-net-btn" id="ts-net-btn" aria-label="Network" title="Network">
            <span class="net-dot"></span>
            <span class="net-label" id="ts-net-label">Elyon Chain</span>
            <span class="caret">▾</span>
          </button>
          <div class="ts-pop ts-pop-right" id="ts-net-pop">
            <h5>Network</h5>
            <a class="ts-net-item active" data-chain="mainnet">
              <span class="net-dot"></span>
              <div class="net-meta">
                <strong>Elyon Chain</strong>
                <span class="muted small" id="ts-net-id">chainId —</span>
              </div>
              <span class="badge ok small">Selected</span>
            </a>
            <div class="ts-pop-divider"></div>
            <a class="ts-pop-link" id="ts-add-network">Add Elyon to wallet →</a>
          </div>
        </div>
      </div>
    </div>`;
  document.body.prepend(strip);

  initTheme(strip);
  initSettings(strip);
  initNetworkPicker(strip);

  // Navigation tree — top-level entries with optional dropdown groups.
  const NAV = [
    { id: 'home', label: 'Home', href: '/' },
    { id: 'blockchain', label: 'Blockchain', groups: [
      { items: [
        { label: 'Transactions',    href: '/txs',           desc: 'Every transaction the indexer has seen.' },
        { label: 'Blocks',          href: '/blocks',        desc: 'Latest blocks and their producers.' },
        { label: 'Top Accounts',    href: '/top-accounts',  desc: 'Addresses ranked by tx involvement.' },
      ]},
      { items: [
        { label: 'Verified Contracts', href: '/verified-contracts', desc: 'Contracts with published source code.' },
        { label: 'URELAY1 Attestations', href: '/attestations',   desc: 'Operator fee attestations in extraData.' },
      ]},
    ]},
    { id: 'tokens', label: 'Tokens', groups: [
      { items: [
        { label: 'Top Tokens (ERC-20)',  href: '/tokens',         desc: 'Tokens ranked by transfer volume.' },
        { label: 'Token Transfers',      href: '/token-transfers', desc: 'Every ERC-20 Transfer event on the chain.' },
      ]},
    ]},
    { id: 'operators', label: 'Operators', groups: [
      { items: [
        { label: 'Earnings Leaderboard', href: '/top-accounts?role=operator', desc: 'Relayers ranked by operator share earned.' },
        { label: 'Recent Attestations',  href: '/attestations', desc: 'Latest URELAY1 records by block.' },
      ]},
    ]},
    { id: 'developers', label: 'Developers', groups: [
      { items: [
        { label: 'Verify Contract',     href: '/verify-contract', desc: 'Publish Solidity source for an address.' },
        { label: 'Broadcast Transaction', href: '/broadcast-tx',  desc: 'Submit a raw signed tx to the chain RPC.' },
      ]},
      { items: [
        { label: 'JSON-RPC endpoint',   href: 'https://mainnet.elyon.network/rpc', desc: 'Public operator RPC.', external: true },
        { label: 'API documentation',   href: '/learning-center', desc: 'Coming soon.' },
      ]},
    ]},
    { id: 'more', label: 'More', groups: [
      { items: [
        { label: 'elyonchain.com',  href: 'https://elyonchain.com', desc: 'Main Elyon Chain website.', external: true },
        { label: 'Explorer Admin',  href: '/admin',                desc: 'Domain + SSL + indexer state.' },
        { label: 'Contact',         href: 'mailto:info@botify.trade', desc: 'Reach the team.' },
      ]},
    ]},
  ];

  function renderNavItem(n) {
    if (!n.groups) {
      return `<a class="nav-link" data-nav="${esc(n.id)}" href="${esc(n.href)}">${esc(n.label)}</a>`;
    }
    const drop = n.groups.map(g => `
      <div class="nav-dd-group">
        ${g.items.map(it => `
          <a class="nav-dd-item" href="${esc(it.href)}"${it.external ? ' target="_blank" rel="noopener"' : ''}>
            <span class="nav-dd-label">${esc(it.label)}</span>
            ${it.desc ? `<span class="nav-dd-desc">${esc(it.desc)}</span>` : ''}
          </a>`).join('')}
      </div>`).join('');
    return `
      <div class="nav-drop" data-nav="${esc(n.id)}">
        <button class="nav-link nav-trigger" type="button">${esc(n.label)}<span class="caret">▾</span></button>
        <div class="nav-dd"><div class="nav-dd-inner">${drop}</div></div>
      </div>`;
  }

  // ─── Header ───────────────────────────────────────────────────────
  // Desktop layout: [brand] · [flex space or search] · [nav] · [wallet]
  // Mobile layout:  [brand] · [hamburger]  →  drawer
  const header = document.createElement('header');
  header.className = 'header';
  header.innerHTML = `
    <div class="container header-row">
      <a class="brand" href="/" aria-label="Elyon Explorer">
        <img class="brand-logo" src="/img/logo.png" alt="Elyon Explorer">
      </a>
      ${heroSearch
        ? '<div class="hdr-spacer"></div>'
        : `<div class="search-wrap hdr-search-mid">
             <span class="search-icon">⌕</span>
             <input id="hdr-search" type="search" placeholder="Search by address / txn hash / block / token…" autocomplete="off">
             <div class="search-results" id="hdr-results"></div>
           </div>`}
      <nav class="header-nav">${NAV.map(renderNavItem).join('')}</nav>
      <button class="wallet-btn hdr-wallet-desktop" id="hdr-wallet" style="margin-left:8px"><span class="dot"></span><span id="hdr-wallet-label">Connect Wallet</span></button>
      <button class="hamburger" id="hdr-burger" aria-label="Open menu" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16"/>
        </svg>
      </button>
    </div>`;
  strip.after(header);

  // Mobile drawer + backdrop. Built once; toggled via .open on both.
  const backdrop = document.createElement('div');
  backdrop.className = 'mobile-backdrop';
  document.body.append(backdrop);

  const drawer = document.createElement('aside');
  drawer.className = 'mobile-drawer';
  drawer.setAttribute('aria-label', 'Site navigation');
  drawer.innerHTML = `
    <div class="md-head">
      <a class="brand" href="/" aria-label="Elyon Explorer"><img class="brand-logo brand-logo-sm" src="/img/logo.png" alt="Elyon Explorer"></a>
      <button class="ts-icon-btn md-close" aria-label="Close menu">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="md-search-wrap">
      <svg class="md-search-icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <circle cx="9" cy="9" r="5.5"/>
        <path d="M13.5 13.5L17 17"/>
      </svg>
      <input id="md-search" type="search" placeholder="Search by address, tx, block, token…" autocomplete="off">
      <div class="search-results md-search-results" id="md-results"></div>
    </div>
    ${NAV.map(n => {
      if (!n.groups) return `<a class="md-leaf" href="${esc(n.href)}">${esc(n.label)}</a>`;
      const items = n.groups.map(g => g.items.map(it =>
        `<a class="md-item" href="${esc(it.href)}"${it.external ? ' target="_blank" rel="noopener"' : ''}>
           <strong>${esc(it.label)}</strong>
           ${it.desc ? `<span class="muted small">${esc(it.desc)}</span>` : ''}
         </a>`).join('')).join('');
      return `
        <details class="md-section">
          <summary class="md-section-head">
            <span class="md-section-label">${esc(n.label)}</span>
            <svg class="md-caret" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4"/>
            </svg>
          </summary>
          <div class="md-section-body">${items}</div>
        </details>`;
    }).join('')}
    <button class="wallet-btn" id="md-wallet" style="margin-top:14px;width:100%"><span class="dot"></span><span id="md-wallet-label">Connect Wallet</span></button>`;
  document.body.append(drawer);

  // Toggle wiring
  function openDrawer() {
    drawer.classList.add('open');
    backdrop.classList.add('open');
    header.querySelector('#hdr-burger').setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
    header.querySelector('#hdr-burger').setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }
  header.querySelector('#hdr-burger').addEventListener('click', () => {
    drawer.classList.contains('open') ? closeDrawer() : openDrawer();
  });
  drawer.querySelector('.md-close').addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  // Close drawer on any nav click — feels right and keeps the page clean.
  drawer.querySelectorAll('a').forEach(a => a.addEventListener('click', closeDrawer));

  // Drawer search uses the same wiring as the header search.
  wireSearch(drawer.querySelector('#md-search'), drawer.querySelector('#md-results'));

  // Drawer wallet button mirrors the header wallet — share the same state.
  initWallet(drawer.querySelector('#md-wallet'), drawer.querySelector('#md-wallet-label'));
  if (activePage) {
    const a = header.querySelector(`[data-nav="${activePage}"]`);
    if (a) a.classList.add('active');
  }

  // Header search (only when present)
  const inp = header.querySelector('#hdr-search');
  if (inp) wireSearch(inp, header.querySelector('#hdr-results'));

  // Dropdown menus: click-to-toggle + click-outside-to-close. Hover is
  // already wired via CSS; this layer makes mobile/touch usable and keeps
  // the dropdown open while the user moves the mouse to a sub-item.
  const drops = header.querySelectorAll('.nav-drop');
  drops.forEach(d => {
    const trigger = d.querySelector('.nav-trigger');
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      drops.forEach(o => { if (o !== d) o.classList.remove('open'); });
      d.classList.toggle('open');
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-drop')) drops.forEach(d => d.classList.remove('open'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') drops.forEach(d => d.classList.remove('open'));
  });

  // Wallet
  initWallet(header.querySelector('#hdr-wallet'), header.querySelector('#hdr-wallet-label'));

  // ─── Footer ───────────────────────────────────────────────────────
  const footer = document.createElement('footer');
  footer.className = 'footer';
  footer.innerHTML = `
    <div class="container">
      <div class="footer-grid">
        <div>
          <div class="brand" style="margin-bottom:10px"><img class="brand-logo brand-logo-sm" src="/img/logo.png" alt="Elyon Explorer"></div>
          <p class="muted" style="margin:0;max-width:380px">A block explorer for Elyon Chain. View blocks, transactions, addresses, tokens, contracts, and the in-block fee distribution paid to operators, contract owners, and token issuers.</p>
        </div>
        <div>
          <h4>Explorer</h4>
          <ul>
            <li><a href="/blocks">Blocks</a></li>
            <li><a href="/txs">Transactions</a></li>
            <li><a href="/tokens">Token tracker</a></li>
            <li><a href="/verify-contract">Verify contract</a></li>
          </ul>
        </div>
        <div>
          <h4>Network</h4>
          <ul>
            <li><a href="#" id="ft-add-network">Add Elyon to wallet</a></li>
            <li><a href="https://mainnet.elyon.network" target="_blank" rel="noopener">Admin node</a></li>
            <li><a href="/admin">Explorer admin</a></li>
          </ul>
        </div>
        <div>
          <h4>Resources</h4>
          <ul>
            <li><a href="https://elyonchain.com" target="_blank" rel="noopener">elyonchain.com</a></li>
            <li><a href="mailto:info@botify.trade">Contact</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <div>© ${new Date().getFullYear()} Elyon Chain. Block explorer for the Elyon network.</div>
        <div id="ft-chain" class="muted small">—</div>
      </div>
    </div>`;
  document.body.append(footer);

  // Populate ticker + footer chain info
  refreshStrip(strip);
  setInterval(() => refreshStrip(strip), 15_000);
  try {
    const ch = await api('/api/chain');
    footer.querySelector('#ft-chain').innerHTML =
      `${esc(ch.chainName)} · chainId ${ch.chainId} · ${esc(ch.rpcUrl)}` +
      (ch.clientVersion
        ? ` · <strong style="color:var(--accent)">Node client: ${esc(ch.clientVersion)}</strong>`
        : '');
    footer.querySelector('#ft-add-network').addEventListener('click', async (e) => {
      e.preventDefault();
      const { addNetwork } = await import('./wallet.js');
      addNetwork(ch);
    });
  } catch {}
}

async function refreshStrip(strip) {
  try {
    const s = await api('/api/stats');
    strip.querySelector('#ts-block').textContent = '#' + s.latestBlock.toLocaleString();
    strip.querySelector('#ts-gas').innerHTML =
      `⛽ <span>Gas:</span> <strong>${fmtGwei(s.medianGasPrice)}</strong>`;
    // ELN spot price, live from the on-chain ELN/USDT DEX pair.
    try {
      const p = await api('/api/eln-price');
      const px = (p && typeof p.priceUsdt === 'number') ? p.priceUsdt : null;
      strip.querySelector('#ts-native').innerHTML = px != null
        ? `<span>ELN Price:</span> <strong>$${px.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</strong> <span class="muted small">ELN/USDT</span>`
        : `<span>ELN Price:</span> <strong>—</strong>`;
    } catch {
      strip.querySelector('#ts-native').innerHTML = `<span>ELN Price:</span> <strong>—</strong>`;
    }
  } catch {}
}

// ─── Top-strip tools: theme toggle, settings popover, network picker ──

function initTheme(strip) {
  const btn  = strip.querySelector('#ts-theme-btn');
  const sun  = strip.querySelector('#ts-theme-sun');
  const moon = strip.querySelector('#ts-theme-moon');
  const stored = localStorage.getItem('elyon.theme');
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const initial = stored || (prefersDark ? 'dark' : 'light');
  apply(initial);
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('elyon.theme', next);
    apply(next);
  });
  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    sun.style.display  = theme === 'dark' ? 'none' : '';
    moon.style.display = theme === 'dark' ? '' : 'none';
  }
}

function initSettings(strip) {
  const wrap = strip.querySelector('#ts-settings-wrap');
  const btn  = strip.querySelector('#ts-settings-btn');
  const pop  = strip.querySelector('#ts-settings-pop');
  const $    = id => strip.querySelector(id);

  // Restore saved prefs.
  const saved = JSON.parse(localStorage.getItem('elyon.prefs') || '{}');
  $('#ts-pagesize').value = saved.pageSize || '25';
  $('#ts-timefmt') .value = saved.timeFormat || 'relative';
  $('#ts-checksum').value = saved.checksum || 'off';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPops(strip); wrap.classList.toggle('open');
  });
  wrap.addEventListener('click', e => e.stopPropagation());
  ['#ts-pagesize','#ts-timefmt','#ts-checksum'].forEach(sel => {
    $(sel).addEventListener('change', () => {
      const prefs = {
        pageSize:  $('#ts-pagesize').value,
        timeFormat:$('#ts-timefmt').value,
        checksum:  $('#ts-checksum').value,
      };
      localStorage.setItem('elyon.prefs', JSON.stringify(prefs));
      window.dispatchEvent(new CustomEvent('elyon-prefs', { detail: prefs }));
    });
  });
}

function initNetworkPicker(strip) {
  const wrap = strip.querySelector('#ts-net-wrap');
  const btn  = strip.querySelector('#ts-net-btn');
  const idEl = strip.querySelector('#ts-net-id');
  const addLink = strip.querySelector('#ts-add-network');

  // Resolve chain id from /api/chain — visible in the picker.
  api('/api/chain').then(ch => {
    idEl.textContent = `chainId ${ch.chainId} · ${ch.rpcUrl}`;
    // Use the real chain name from the API (e.g. "Elyon Chain Mainnet")
    // for the header pill + picker, instead of the hardcoded label.
    if (ch.chainName) {
      const labelEl  = strip.querySelector('#ts-net-label');
      const strongEl = strip.querySelector('.ts-net-item strong');
      if (labelEl)  labelEl.textContent  = ch.chainName;
      if (strongEl) strongEl.textContent = ch.chainName;
    }
    addLink.addEventListener('click', async (e) => {
      e.preventDefault();
      const { addNetwork } = await import('./wallet.js');
      addNetwork(ch);
    });
  }).catch(() => {});

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPops(strip); wrap.classList.toggle('open');
  });
  wrap.addEventListener('click', e => e.stopPropagation());
}

function closeAllPops(strip) {
  strip.querySelectorAll('.ts-tool.open').forEach(x => x.classList.remove('open'));
}

document.addEventListener('click', () => {
  document.querySelectorAll('.top-strip .ts-tool.open').forEach(x => x.classList.remove('open'));
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape')
    document.querySelectorAll('.top-strip .ts-tool.open').forEach(x => x.classList.remove('open'));
});

export function wireSearch(input, out) {
  let abort;
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (!v) { out.classList.remove('open'); out.innerHTML = ''; return; }
    if (abort) abort.abort();
    abort = new AbortController();
    fetch('/api/search?q=' + encodeURIComponent(v), { signal: abort.signal })
      .then(r => r.json())
      .then(r => {
        if (r.target) {
          out.innerHTML = `<a href="${r.target}">Go to ${r.kind} ${esc(v)}</a>`;
        } else if (r.kind === 'tokens') {
          out.innerHTML = r.results.map(t =>
            `<a href="/address/${t.addr}"><strong>${esc(t.symbol || '?')}</strong> — ${esc(t.name || 'Unknown token')}<br><span class="mono small muted">${esc(t.addr)}</span></a>`).join('');
        } else {
          out.innerHTML = `<div style="padding:10px 14px;color:var(--text-muted)">No matches</div>`;
        }
        out.classList.add('open');
      })
      .catch(() => {});
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const a = out.querySelector('a');
      if (a) location.href = a.getAttribute('href');
    }
  });
  document.addEventListener('click', e => {
    if (!input.parentElement.contains(e.target)) out.classList.remove('open');
  });
}
