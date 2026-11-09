// Reusable paginated table renderer.
//
// Usage:
//   mountPager({
//     mount:    document.getElementById('pager-mount'),
//     fetchUrl: page => `/api/blocks?page=${page}&limit=25`,
//     rowsHtml: items => '<tr>...</tr>',
//     emptyHtml: 'No rows yet.',
//     columns:  [...],   // header HTML
//   });

import { api, esc } from './common.js';

export function mountPager(opts) {
  const {
    mount, fetchUrl, rowsHtml, emptyHtml = 'No rows yet.', columns = '',
    page = 0, limit = 25, header = '', footerExtra = '',
  } = opts;

  let cur = page, total = 0;

  mount.innerHTML = `
    <div class="card">
      ${header ? `<div class="card-header">${header}</div>` : ''}
      <div style="overflow-x:auto">
        <table class="t">
          <thead><tr>${columns}</tr></thead>
          <tbody id="pg-rows"><tr><td colspan="99" class="center muted" style="padding:18px"><span class="spin"></span> Loading…</td></tr></tbody>
        </table>
      </div>
      <div class="pagination">
        <div class="meta" id="pg-meta">—</div>
        <div class="controls">
          <button id="pg-first">«</button>
          <button id="pg-prev">‹</button>
          <span>Page <input type="number" id="pg-input" class="page-input" min="1" value="1"> of <strong id="pg-last">1</strong></span>
          <button id="pg-next">›</button>
          <button id="pg-end">»</button>
        </div>
      </div>
      ${footerExtra}
    </div>`;

  const rowsEl   = mount.querySelector('#pg-rows');
  const metaEl   = mount.querySelector('#pg-meta');
  const inputEl  = mount.querySelector('#pg-input');
  const lastEl   = mount.querySelector('#pg-last');
  const firstBtn = mount.querySelector('#pg-first');
  const prevBtn  = mount.querySelector('#pg-prev');
  const nextBtn  = mount.querySelector('#pg-next');
  const endBtn   = mount.querySelector('#pg-end');

  async function load() {
    rowsEl.innerHTML = `<tr><td colspan="99" class="center muted" style="padding:18px"><span class="spin"></span> Loading…</td></tr>`;
    try {
      const r = await api(fetchUrl(cur));
      total = r.total ?? r.items.length;
      const pageCount = Math.max(1, Math.ceil(total / limit));
      const start = total === 0 ? 0 : cur * limit + 1;
      const end   = Math.min(total, start + r.items.length - 1);
      metaEl.textContent = total === 0
        ? 'No rows'
        : `Showing ${start.toLocaleString()} – ${end.toLocaleString()} of ${total.toLocaleString()} entries`;
      inputEl.value = (cur + 1);
      lastEl.textContent = pageCount.toLocaleString();
      inputEl.max = pageCount;
      firstBtn.disabled = prevBtn.disabled = cur === 0;
      nextBtn.disabled  = endBtn.disabled  = cur >= pageCount - 1;
      if (!r.items.length) {
        rowsEl.innerHTML = `<tr><td colspan="99" class="center muted" style="padding:24px">${esc(emptyHtml)}</td></tr>`;
      } else {
        rowsEl.innerHTML = rowsHtml(r.items);
      }
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="99" class="center" style="padding:18px;color:var(--error)">${esc(e.message)}</td></tr>`;
    }
  }

  firstBtn.addEventListener('click', () => { cur = 0; load(); });
  prevBtn .addEventListener('click', () => { cur = Math.max(0, cur - 1); load(); });
  nextBtn .addEventListener('click', () => { cur = cur + 1; load(); });
  endBtn  .addEventListener('click', () => {
    const pageCount = Math.max(1, Math.ceil(total / limit));
    cur = pageCount - 1; load();
  });
  inputEl.addEventListener('change', () => {
    const v = parseInt(inputEl.value, 10);
    if (Number.isFinite(v) && v >= 1) { cur = v - 1; load(); }
  });

  load();
  return { reload: load };
}
