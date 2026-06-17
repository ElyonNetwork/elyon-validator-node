/* Elyon FX v4 — shared runtime that powers the animation + graphics layer on
   every page (public + /admin + /manager + /node). Dependency-free.
   It:
     1. injects the fixed light backdrop: grid mesh + two static aurora
        washes + the "living network constellation" canvas — ≤20 soft
        emerald nodes drifting slowly, distance-linked under 120px; every
        few seconds a "block" pulse travels a random edge path. Subtle
        pointer parallax only (no cursor-repulsion field). Pre-rendered
        sprites only; 24fps cap; pauses when the tab is hidden;
        prefers-reduced-motion gets the static gradient only.
        Pages can opt out of the canvas entirely with <body data-no-canvas>
        (a static CSS gradient backdrop remains).
     2. ensures Font Awesome is available for injected icons
     3. auto-decorates stat tiles + cards: contextual floating icon,
        accent bar, hover-lift, count-up of numeric values
     4. reveal-on-scroll for [data-reveal]/.fx-reveal + auto-tagged cards
        (v3: blur-to-sharp), gentle one-shot reveal for long table rows
     5. fades tab panels when switched
     6. [data-countup] (decimals/separators/suffix), 3D tilt + specular
        glow ([data-tilt]/.role-card/.tcard), magnetic buttons + click ripple,
        pill pulse-on-change, page-enter transition.
     7. v3: scroll-progress bar at the top of the page + animated SVG
        line-draw section dividers for .fx-divider elements.
   Opt-out: anything inside [data-no-fx] is left untouched.
   Purely additive — never moves or restyles existing content boxes. */
(function () {
  'use strict';
  if (window.__elyonFx) return; window.__elyonFx = true;

  /* ---------- global trackBtn helper ----------
     Several pages (e.g. /manager "Stake & become producer") call trackBtn(btn,
     fn, loadingText) in onclick but never defined it -> ReferenceError blocked
     the action before any request was sent. Provide a safe global fallback
     (guarded so pages that define their own keep theirs). */
  if (typeof window.trackBtn !== 'function') {
    window.trackBtn = async function (btn, fn, loadingText) {
      if (typeof fn !== 'function') return;
      if (!btn || btn.dataset.loading === '1') return fn();
      var orig = btn.innerHTML;
      btn.dataset.loading = '1'; btn.disabled = true;
      btn.innerHTML = '<span class="btn-spin" style="display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;vertical-align:-2px;margin-right:6px;animation:elxSpin .7s linear infinite"></span>' + (loadingText || 'Working…');
      try { return await fn(); }
      finally { delete btn.dataset.loading; btn.disabled = false; btn.innerHTML = orig; }
    };
    if (!document.getElementById('elx-trackbtn-kf')) {
      var st = document.createElement('style'); st.id = 'elx-trackbtn-kf';
      st.textContent = '@keyframes elxSpin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
  }

  /* ---------- shared flags / helpers ---------- */
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var TOUCH = ('ontouchstart' in window) && (window.matchMedia ? window.matchMedia('(hover: none)').matches : true);
  function noFx(el) { return !!(el && el.closest && el.closest('[data-no-fx]')); }

  /* ---------- deep-space backdrop shell ---------- */
  function injectBg() {
    if (document.getElementById('elyon-fx-bg')) return;
    var bg = document.createElement('div');
    bg.id = 'elyon-fx-bg';
    bg.setAttribute('data-fx-ignore', '1');
    bg.innerHTML = '<span class="fx-aur a"></span><span class="fx-aur b"></span><div class="fx-grid"></div>';
    document.body.insertBefore(bg, document.body.firstChild);
  }

  /* dark/light theme detection — the deep-space base + node brightness adapt
     to the page's body background so light dashboards stay light. */
  function themeDark() {
    try {
      var m = (getComputedStyle(document.body).backgroundColor || '').match(/(\d+)[^\d]+(\d+)[^\d]+(\d+)/);
      return m ? (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 150 : false;
    } catch (e) { return false; }
  }
  function applyTheme() {
    var host = document.getElementById('elyon-fx-bg');
    if (host) host.classList.toggle('fx-dark', themeDark());
  }

  /* ---------- v4: living network constellation canvas (perf-capped) ----
     ≤20 nodes drift; lines link under 120px; "block" pulses travel random
     edge paths. Pointer adds parallax ONLY (the cursor-repulsion field was
     removed — it cost an extra per-node distance pass every frame).
     Single cheap light variant (all pages are light now): pre-rendered
     emerald sprite, ~0.2 alpha, normal compositing. DPR<=1.5, 24fps cap,
     paused when hidden. Reduced motion or <body data-no-canvas>: no canvas
     at all — the static CSS gradient base stays. */
  function startConstellation() {
    applyTheme(); setTimeout(applyTheme, 1500);
    if (REDUCED || !window.requestAnimationFrame) return;
    if (document.body && document.body.hasAttribute('data-no-canvas')) return;
    var host = document.getElementById('elyon-fx-bg');
    if (!host || document.getElementById('elyon-fx-canvas')) return;
    var cv = document.createElement('canvas');
    cv.id = 'elyon-fx-canvas';
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    host.appendChild(cv);
    var ctx = cv.getContext('2d'); if (!ctx) return;

    var W = 0, H = 0, LINK = 120;
    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = window.innerWidth; H = window.innerHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      LINK = Math.max(90, Math.min(120, Math.min(W, H) * 0.17));
    }
    size();
    window.addEventListener('resize', size, { passive: true });

    /* single light variant — soft deep-emerald nodes/links at ~0.2 alpha,
       normal compositing (no additive blending, no per-frame shadowBlur). */
    var AMP = 0.2;

    /* pre-rendered glow sprite — drawImage is far cheaper than per-node
       radial gradients or shadowBlur. */
    var SPL = document.createElement('canvas'); SPL.width = SPL.height = 64;
    (function () {
      var c = SPL.getContext('2d'), g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(14,125,90,.9)');
      g.addColorStop(0.25, 'rgba(21,168,120,.40)');
      g.addColorStop(0.6, 'rgba(21,168,120,.10)');
      g.addColorStop(1, 'rgba(21,168,120,0)');
      c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    })();

    var N = Math.max(12, Math.min(20, Math.round(W * H / 60000)));
    var nodes = [];
    for (var i = 0; i < N; i++) nodes.push({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 16, vy: (Math.random() - 0.5) * 16,   // px/s — slow drift
      r: 1.1 + Math.random() * 1.6,
      ph: Math.random() * 6.283,
      d: 0.35 + Math.random() * 0.65,                                   // parallax depth
      hot: 0, px: 0, py: 0
    });

    var mx = 0, my = 0, tx = 0, ty = 0;
    window.addEventListener('pointermove', function (e) {
      tx = e.clientX / Math.max(1, W) - 0.5;
      ty = e.clientY / Math.max(1, H) - 0.5;
    }, { passive: true });

    /* "block" pulse: random-walk a 2-5 hop path along currently-linked nodes */
    var pulses = [], nextPulse = 1600;
    function spawnPulse() {
      var a = (Math.random() * N) | 0, path = [a], cur = a, prev = -1;
      for (var h = 0; h < 4; h++) {
        var opts = [];
        for (var j = 0; j < N; j++) {
          if (j === cur || j === prev) continue;
          var dx = nodes[j].x - nodes[cur].x, dy = nodes[j].y - nodes[cur].y;
          if (dx * dx + dy * dy < LINK * LINK) opts.push(j);
        }
        if (!opts.length) break;
        prev = cur; cur = opts[(Math.random() * opts.length) | 0]; path.push(cur);
      }
      if (path.length > 1) { nodes[a].hot = 1; pulses.push({ p: path, seg: 0, k: 0, v: LINK * 2.4 }); }
    }

    var raf = 0, last = 0;
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (t - last < 41) return;                       // ~24fps cap
      var dt = Math.min(80, t - last) / 1000; last = t;
      mx += (tx - mx) * 0.05; my += (ty - my) * 0.05;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      var i, j, n, a;

      /* drift + soft wrap + parallaxed draw position (no cursor repulsion) */
      for (i = 0; i < N; i++) {
        n = nodes[i];
        n.x += n.vx * dt; n.y += n.vy * dt;
        if (n.x < -30) n.x = W + 28; else if (n.x > W + 30) n.x = -28;
        if (n.y < -30) n.y = H + 28; else if (n.y > H + 30) n.y = -28;
        n.hot *= (1 - 2.2 * dt); if (n.hot < 0.01) n.hot = 0;
        n.px = n.x + mx * 34 * n.d; n.py = n.y + my * 24 * n.d;
      }

      /* distance links, breathing alpha; hot nodes brighten their links */
      var breathe = 0.78 + 0.22 * Math.sin(t * 0.0006);
      for (i = 0; i < N; i++) for (j = i + 1; j < N; j++) {
        var dx = nodes[i].px - nodes[j].px, dy = nodes[i].py - nodes[j].py, d2 = dx * dx + dy * dy;
        if (d2 > LINK * LINK) continue;
        a = (1 - Math.sqrt(d2) / LINK) * 0.30 * AMP * breathe + Math.min(0.5, (nodes[i].hot + nodes[j].hot) * 0.4);
        ctx.strokeStyle = 'rgba(14,125,90,' + a.toFixed(3) + ')';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(nodes[i].px, nodes[i].py); ctx.lineTo(nodes[j].px, nodes[j].py); ctx.stroke();
      }

      /* glowing nodes with twinkle */
      for (i = 0; i < N; i++) {
        n = nodes[i];
        var tw = 0.55 + 0.45 * Math.sin(t * 0.0011 + n.ph), s = n.r * 7 * (1 + n.hot);
        ctx.globalAlpha = Math.min(1, (0.5 + 0.5 * n.hot) * tw * AMP);
        ctx.drawImage(SPL, n.px - s / 2, n.py - s / 2, s, s);
        ctx.globalAlpha = Math.min(1, (0.85 * tw + n.hot) * AMP);
        ctx.fillStyle = 'rgba(14,125,90,1)';
        ctx.beginPath(); ctx.arc(n.px, n.py, n.r * (1 + 0.7 * n.hot), 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;

      /* travelling block pulses */
      nextPulse -= dt * 1000;
      if (nextPulse <= 0) { spawnPulse(); nextPulse = 2600 + Math.random() * 2200; }
      for (i = pulses.length - 1; i >= 0; i--) {
        var u = pulses[i];
        var A = nodes[u.p[u.seg]], B = nodes[u.p[u.seg + 1]];
        var sl = Math.max(1, Math.hypot(B.px - A.px, B.py - A.py));
        u.k += u.v * dt / sl;
        if (u.k >= 1) {
          B.hot = 1; u.seg++; u.k = 0;
          if (u.seg >= u.p.length - 1) { pulses.splice(i, 1); continue; }
          A = nodes[u.p[u.seg]]; B = nodes[u.p[u.seg + 1]];
        }
        var hx = A.px + (B.px - A.px) * u.k, hy = A.py + (B.py - A.py) * u.k;
        ctx.strokeStyle = 'rgba(14,125,90,' + (0.55 * AMP).toFixed(3) + ')';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(A.px, A.py); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.globalAlpha = AMP;
        ctx.drawImage(SPL, hx - 9, hy - 9, 18, 18);
        ctx.fillStyle = '#0e7d5a';
        ctx.beginPath(); ctx.arc(hx, hy, 1.8, 0, 6.283); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; }
      else if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
    });
    raf = requestAnimationFrame(frame);
  }

  /* ---------- v3: scroll progress bar ---------- */
  function scrollProgress() {
    if (document.getElementById('fx-scrollpro') || !document.body) return;
    var bar = document.createElement('div');
    bar.id = 'fx-scrollpro';
    bar.setAttribute('data-fx-ignore', '1');
    bar.innerHTML = '<span></span>';
    document.body.appendChild(bar);
    var sp = bar.firstChild, tick = false;
    function upd() {
      tick = false;
      var h = document.documentElement, max = Math.max(1, h.scrollHeight - h.clientHeight);
      sp.style.transform = 'scaleX(' + Math.min(1, (window.scrollY || h.scrollTop || 0) / max).toFixed(4) + ')';
    }
    window.addEventListener('scroll', function () { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
    window.addEventListener('resize', function () { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
    upd();
  }

  /* ---------- v3: animated SVG line-draw section dividers ----------
     <div class="fx-divider"></div> gets an injected gradient path that
     draws itself when scrolled into view. */
  function wireDividers() {
    document.querySelectorAll('.fx-divider:not([data-fxdv])').forEach(function (el) {
      el.setAttribute('data-fxdv', '1');
      if (noFx(el)) return;
      el.innerHTML = '<svg viewBox="0 0 1200 60" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><linearGradient id="fxdivg" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#15a878"/><stop offset=".5" stop-color="#0c8f68"/><stop offset="1" stop-color="#0e7d5a"/>' +
        '</linearGradient></defs>' +
        '<path d="M0,30 C200,6 340,54 600,30 S1000,8 1200,30" pathLength="1" fill="none" stroke="url(#fxdivg)" stroke-width="2"/>' +
        '<circle cx="600" cy="30" r="3.5"/></svg>';
      if (REDUCED) { el.classList.add('in'); return; }
      onSee(el, function () { el.classList.add('in'); });
    });
  }

  /* ---------- ensure Font Awesome ---------- */
  function ensureFA() {
    if (document.querySelector('link[href*="font-awesome"],link[href*="fontawesome"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css';
    document.head.appendChild(l);
  }

  /* ---------- contextual icon picker ---------- */
  var ICON_MAP = [
    [/token|listed|erc|coin/i, 'fa-coins'],
    [/volume|earn|revenue|fee|reward/i, 'fa-chart-line'],
    [/chain ?id|network/i, 'fa-link'],
    [/connect|wallet/i, 'fa-wallet'],
    [/block|height/i, 'fa-cube'],
    [/peer/i, 'fa-network-wired'],
    [/gas/i, 'fa-gas-pump'],
    [/consensus|apos|pos/i, 'fa-shield-halved'],
    [/balance/i, 'fa-sack-dollar'],
    [/validator|node/i, 'fa-server'],
    [/contract/i, 'fa-file-contract'],
    [/owner|account|address/i, 'fa-user'],
    [/stake|staking|package/i, 'fa-layer-group'],
    [/uptime|status|health/i, 'fa-heart-pulse'],
    [/month|epoch|time|date/i, 'fa-clock'],
    [/score|points|rank/i, 'fa-trophy'],
    [/faucet|drip/i, 'fa-faucet-drip'],
    [/tx|transaction/i, 'fa-right-left'],
  ];
  function pickIcon(text) {
    for (var i = 0; i < ICON_MAP.length; i++) if (ICON_MAP[i][0].test(text)) return ICON_MAP[i][1];
    return 'fa-circle-nodes';
  }

  /* ---------- numeric parsing + count-up (decimals/separators/suffix) */
  function parseVal(txt) {
    // "12,345.67 ELN" | "98.7%" | "$1,200" | "42" — full-string match only,
    // so addresses, dates and versions are never touched.
    var m = (txt || '').trim().match(/^([$€£]?\s*)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,12}(?:\.\d+)?)(\s*(?:%|[A-Za-z][A-Za-z\/.%-]{0,11})?)$/);
    if (!m) return null;
    var num = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(num)) return null;
    return { pre: m[1] || '', num: num, dec: (m[2].split('.')[1] || '').length, suf: m[3] || '' };
  }
  function countTo2(el, v, dur) {
    if (!v || !isFinite(v.num) || v.num <= 0) return;
    dur = dur || 1200;
    var t0 = performance.now();
    function fmt(n) {
      return v.pre + n.toLocaleString(undefined, { minimumFractionDigits: v.dec, maximumFractionDigits: v.dec }) + v.suf;
    }
    function step(t) {
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(v.num * e);
      if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(v.num);
    }
    if (REDUCED) { el.textContent = fmt(v.num); return; }
    requestAnimationFrame(step);
  }

  /* shared "run once when visible" observer */
  var seenMap = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var seenIO = ('IntersectionObserver' in window && seenMap) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var fn = seenMap.get(e.target);
      seenIO.unobserve(e.target);
      if (fn) { seenMap.delete(e.target); fn(e.target); }
    });
  }, { threshold: 0.3 }) : null;
  function onSee(el, fn) { if (seenIO) { seenMap.set(el, fn); seenIO.observe(el); } else fn(el); }

  /* ---------- decorate stat tiles + cards ---------- */
  function decorate() {
    // stat tiles across the various page conventions
    var tiles = document.querySelectorAll('.stat:not([data-fx]), .stat-card:not([data-fx])');
    tiles.forEach(function (el, idx) {
      el.setAttribute('data-fx', '1');
      if (noFx(el)) return;
      el.classList.add('fx-bar', 'fx-lift', 'fx-reveal');
      stagger(el, idx);
      var cs = getComputedStyle(el);
      if (cs.position === 'static') el.style.position = 'relative';
      el.style.overflow = el.style.overflow || 'hidden';
      // contextual floating icon, top-right, faint
      var labelEl = el.querySelector('.lbl, .stat-label, .label');
      var label = (labelEl ? labelEl.textContent : el.textContent) || '';
      var ic = document.createElement('i');
      ic.className = 'fa-solid ' + pickIcon(label) + ' fx-float';
      ic.setAttribute('data-fx-ignore', '1');
      ic.style.cssText = 'position:absolute;top:14px;right:16px;font-size:1.35rem;color:rgba(21,168,120,.26);pointer-events:none';
      el.appendChild(ic);
      // count-up numeric value (decimals + separators + suffix)
      var valEl = el.querySelector('.val, .stat-value, .value');
      if (valEl && !valEl.hasAttribute('data-fx-counted')) {
        var raw = (valEl.textContent || '').trim();
        if (raw.length <= 24 && raw.indexOf('0x') === -1) {
          var v = parseVal(raw);
          if (v && v.num > 0 && v.num < 1e12) { valEl.setAttribute('data-fx-counted', '1'); countTo2(valEl, v); }
        }
      }
    });
    // cards: reveal + lift
    document.querySelectorAll('.card:not([data-fx]), .token-card:not([data-fx]), .role-card:not([data-fx]), .choice-card:not([data-fx]), .card-glass:not([data-fx]), .fx-card-neo:not([data-fx])').forEach(function (el, idx) {
      el.setAttribute('data-fx', '1');
      if (noFx(el)) return;
      el.classList.add('fx-reveal');
      stagger(el, idx);
    });
    // section headings reveal
    document.querySelectorAll('main h1:not([data-fx]), main h2:not([data-fx]), section > h1:not([data-fx]), section > h2:not([data-fx]), .page-title:not([data-fx])').forEach(function (el) {
      el.setAttribute('data-fx', '1');
      if (noFx(el)) return;
      el.classList.add('fx-reveal');
    });
  }

  /* stagger — small per-batch transition delay, cleared after the
     reveal so it never slows hover transitions later */
  function stagger(el, idx) {
    if (REDUCED) return;
    el.style.transitionDelay = ((idx % 5) * 60) + 'ms';
    el.setAttribute('data-fxd', '1');
  }

  /* legacy count-up (kept for [data-count]) */
  function countTo(el, target) {
    if (!isFinite(target) || target <= 0) return;
    var dur = 1100, t0 = performance.now();
    function step(t) {
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.floor(target * e).toLocaleString();
      if (p < 1) requestAnimationFrame(step); else el.textContent = target.toLocaleString();
    }
    requestAnimationFrame(step);
  }

  /* ---------- reveal-on-scroll ---------- */
  var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var el = e.target;
      el.classList.add('visible', 'fx-in');
      io.unobserve(el);
      if (el.hasAttribute('data-fxd')) setTimeout(function () { el.style.transitionDelay = ''; el.removeAttribute('data-fxd'); }, 1100);
    });
  }, { threshold: 0.08 }) : null;
  function wireReveal() {
    var els = document.querySelectorAll('[data-reveal]:not([data-fxr]), .fx-reveal:not([data-fxr])');
    els.forEach(function (el) {
      el.setAttribute('data-fxr', '1');
      if (io) io.observe(el); else el.classList.add('visible', 'fx-in');
    });
  }

  /* ---------- gentle one-shot reveal for long table rows ----------
     Animation-based (not opacity-held), so re-rendered rows can never get
     stuck invisible. Applied once per table; skips [data-no-fx].
     A row is NEVER animated twice: a WeakSet + dataset.fxDone marker is
     checked before the animation class is (re-)applied, so rescans and
     re-renders can't make already-visible rows re-enter. */
  var rowSeen = (typeof WeakSet === 'function') ? new WeakSet() : null;
  function decorateRows() {
    if (REDUCED) return;
    document.querySelectorAll('table:not([data-fxtb])').forEach(function (tb) {
      if (noFx(tb)) return;
      var rows = tb.querySelectorAll('tbody tr');
      if (rows.length < 4) return;            // only long lists; retry on rescan
      tb.setAttribute('data-fxtb', '1');
      rows.forEach(function (r, i) {
        if (i > 17) return;
        if (r.dataset.fxDone === '1' || (rowSeen && rowSeen.has(r))) return;
        r.dataset.fxDone = '1'; if (rowSeen) rowSeen.add(r);
        r.style.setProperty('--fxd', (i * 45) + 'ms');
        r.classList.add('fx-rowin');
      });
    });
  }

  /* ---------- explicit [data-count] ---------- */
  function wireCounts() {
    document.querySelectorAll('[data-count]:not([data-fxc])').forEach(function (el) {
      el.setAttribute('data-fxc', '1');
      var v = parseFloat(el.getAttribute('data-count'));
      if (io) { var o = new IntersectionObserver(function (en) { en.forEach(function (e) { if (e.isIntersecting) { countTo(e.target, v); o.unobserve(e.target); } }); }, { threshold: 0.4 }); o.observe(el); }
      else countTo(el, v);
    });
  }

  /* ---------- [data-countup] — value from attribute or own text ---- */
  function wireCountups() {
    document.querySelectorAll('[data-countup]:not([data-fxcu])').forEach(function (el) {
      el.setAttribute('data-fxcu', '1');
      if (noFx(el)) return;
      var v = parseVal(el.getAttribute('data-countup') || el.textContent);
      if (!v || v.num <= 0) return;
      onSee(el, function () { countTo2(el, v); });
    });
  }

  /* ---------- 3D tilt + moving specular highlight ---------- */
  function wireTilt() {
    if (REDUCED || TOUCH) return;
    document.querySelectorAll('[data-tilt]:not([data-fxt]), .role-card:not([data-fxt]), .tcard:not([data-fxt])').forEach(function (el) {
      el.setAttribute('data-fxt', '1');
      if (noFx(el)) return;
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      var sp = document.createElement('span'); sp.className = 'fx-spec'; sp.setAttribute('data-fx-ignore', '1'); el.appendChild(sp);
      var raf = 0, px = 0, py = 0;
      el.addEventListener('pointermove', function (e) {
        px = e.clientX; py = e.clientY;
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = 0;
          var r = el.getBoundingClientRect();
          if (!r.width || !r.height) return;
          var x = (px - r.left) / r.width - 0.5, y = (py - r.top) / r.height - 0.5;
          el.style.transition = 'transform .14s ease-out';
          el.style.transform = 'perspective(750px) rotateX(' + (-y * 6).toFixed(2) + 'deg) rotateY(' + (x * 6).toFixed(2) + 'deg) translateY(-3px)';
          sp.style.opacity = '1';
          sp.style.setProperty('--fx-x', ((x + 0.5) * 100).toFixed(1) + '%');
          sp.style.setProperty('--fx-y', ((y + 0.5) * 100).toFixed(1) + '%');
        });
      });
      el.addEventListener('pointerleave', function () {
        el.style.transition = 'transform .55s cubic-bezier(.22,1.3,.36,1)';
        el.style.transform = '';
        sp.style.opacity = '0';
        setTimeout(function () { if (!el.style.transform) el.style.transition = ''; }, 600);
      });
    });
  }

  /* ---------- magnetic buttons + click ripple ---------- */
  function wireMagnet() {
    if (REDUCED || TOUCH) return;
    document.querySelectorAll('.btn:not([data-fxm]), .btn-primary:not([data-fxm])').forEach(function (b) {
      b.setAttribute('data-fxm', '1');
      if (noFx(b) || b.hasAttribute('data-fxt')) return;
      b.addEventListener('pointermove', function (e) {
        var r = b.getBoundingClientRect();
        if (!r.width) return;
        var dx = (e.clientX - r.left - r.width / 2) / r.width;
        var dy = (e.clientY - r.top - r.height / 2) / r.height;
        b.style.transition = 'transform .12s ease-out';
        b.style.transform = 'translate(' + (dx * 6).toFixed(1) + 'px,' + (dy * 4).toFixed(1) + 'px)';
      });
      b.addEventListener('pointerleave', function () {
        b.style.transition = 'transform .5s cubic-bezier(.22,1.4,.36,1)';
        b.style.transform = '';
        setTimeout(function () { if (!b.style.transform) b.style.transition = ''; }, 550);
      });
    });
  }
  function wireRipple() {
    document.addEventListener('click', function (e) {
      if (REDUCED || !e.clientX) return;
      var b = e.target && e.target.closest && e.target.closest('.btn, .btn-primary, .btn-secondary, .fx-btn-neo');
      if (!b || noFx(b)) return;
      var r = b.getBoundingClientRect();
      if (!r.width) return;
      if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
      b.classList.add('fx-riphost');
      var s = document.createElement('span'); s.className = 'fx-ripple';
      s.setAttribute('data-fx-ignore', '1');   // fx-injected: MutationObservers must skip it
      var d = Math.max(r.width, r.height) * 2;
      s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
      b.appendChild(s);
      setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 700);
    });
  }

  /* ---------- pill pulse-on-change (throttled MutationObserver) ----
     Mutations caused by the fx layer itself (ripple spans, spec
     highlights, injected icons — all tagged data-fx-ignore) are filtered
     out so a click ripple can never cascade into a pill pulse. */
  function fxOwnNode(nd) {
    return !!(nd && nd.nodeType === 1 && nd.hasAttribute &&
      (nd.hasAttribute('data-fx-ignore') ||
       (nd.classList && (nd.classList.contains('fx-ripple') || nd.classList.contains('fx-spec')))));
  }
  function wirePills() {
    if (REDUCED || !('MutationObserver' in window)) return;
    var mo = new MutationObserver(function (muts) {
      var now = Date.now();
      for (var i = 0; i < muts.length; i++) {
        var mu = muts[i], k, real;
        if (mu.type === 'childList') {        // skip fx-only insert/remove
          real = false;
          for (k = 0; k < mu.addedNodes.length && !real; k++) if (!fxOwnNode(mu.addedNodes[k])) real = true;
          for (k = 0; k < mu.removedNodes.length && !real; k++) if (!fxOwnNode(mu.removedNodes[k])) real = true;
          if (!real) continue;
        }
        var n = mu.target;
        if (n.nodeType !== 1) n = n.parentElement;
        if (!n || !n.closest) continue;
        if (n.closest('[data-fx-ignore]')) continue;  // change inside fx-injected node
        var p = n.closest('.pill');
        if (!p || noFx(p)) continue;
        if (p.__fxPulseAt && now - p.__fxPulseAt < 1500) continue;
        p.__fxPulseAt = now;
        p.classList.remove('fx-pillpulse'); void p.offsetWidth; p.classList.add('fx-pillpulse');
        (function (pp) { setTimeout(function () { pp.classList.remove('fx-pillpulse'); }, 1000); })(p);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /* ---------- page-enter transition ----------
     .elx-work pages already animate via elyon-app.css — skip those. */
  function pageEnter() {
    if (REDUCED || document.querySelector('.elx-work')) return;
    var m = document.querySelector('main');
    if (m && !noFx(m)) m.classList.add('fx-enter');
  }

  /* ---------- tab fade ----------
     Only fires on a genuine tab SWITCH:
     - the matched element must be a tab CONTROL (has data-tab, an
       onclick that calls switchTab, or the .nav-btn class — never a
       `.tab` content PANEL: /admin uses class="tab" for the panels
       themselves, so the old broad `.tab` match made ANY click inside
       the visible panel re-animate the whole page);
     - re-clicking the already-active control is a no-op (no fade, no
       rescan). */
  function wireTabFade() {
    document.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest && ev.target.closest('.nav-btn, [data-tab], [onclick*="switchTab"]');
      if (!t || noFx(t)) return;
      // content panels (e.g. /admin <div class="tab">) are not controls
      var isCtl = t.hasAttribute('data-tab') || t.classList.contains('nav-btn') ||
        /switchTab/.test(t.getAttribute('onclick') || '');
      if (!isCtl) return;
      // clicking the tab that is already open must not re-animate anything
      if (t.classList.contains('active') || t.getAttribute('aria-selected') === 'true') return;
      setTimeout(function () {
        document.querySelectorAll('.tab.active, section.active, .tab-content.active').forEach(function (p) {
          p.classList.remove('fx-tabfade'); void p.offsetWidth; p.classList.add('fx-tabfade');
        });
        rescan();   // newly-shown tab content
      }, 40);
    }, true);
  }

  function rescan() {
    decorate(); wireReveal(); wireCounts();
    wireCountups(); decorateRows(); wireTilt(); wireMagnet(); wireDividers();
  }

  function boot() {
    /* hard kill-switch: <body data-no-fx> disables the ENTIRE fx layer —
       backdrop/canvas, scroll bar, page-enter, reveals, count-ups, tilt,
       magnetic, ripple, pill pulse, row entrance, tab fade, dividers and
       the rescan loop. Only the window.trackBtn fallback above (which
       pages depend on) stays active. */
    if (document.body && document.body.hasAttribute('data-no-fx')) return;
    injectBg(); startConstellation(); ensureFA(); pageEnter(); scrollProgress();
    rescan(); wireTabFade(); wireRipple(); wirePills();
    // re-scan for content that renders after async data loads
    var n = 0, iv = setInterval(function () { rescan(); if (++n > 25) clearInterval(iv); }, 1200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
