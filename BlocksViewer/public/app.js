'use strict';
const $ = s => document.querySelector(s);
const EXPLORER = 'https://explorer.elyon.network';
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => n == null ? '—' : Number(n).toLocaleString('en-US');
const short = (h, a = 10, b = 6) => h ? `${h.slice(0, a)}…${h.slice(-b)}` : '—';
const gwei = w => w == null ? '—' : `${(Number(w) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 })} gwei`;
const age = t => { const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 90 ? `${s}s` : s < 5400 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
const when = t => new Date(t * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');

let blocks = [], network = null, labels = {};
function label(a) { const k = String(a || '').toLowerCase(); return labels[k] || short(a, 8, 6); }
function setLabels(v) { labels = {}; (v || []).forEach((a, i) => { labels[a.toLowerCase()] = i === 0 ? 'Elyon Node 1 (main)' : `Elyon Node ${i + 1}`; }); }

function row(b, fresh) {
  const gas = Math.min(100, b.gasPct);
  return `<tr data-n="${b.number}" class="${fresh ? 'fresh' : ''}"><td><a href="${EXPLORER}/block/${b.number}" rel="noopener" data-stop>${fmt(b.number)}</a></td>
    <td data-age="${b.timestamp}">${age(b.timestamp)}</td><td class="mono">${esc(short(b.hash))}</td>
    <td>${esc(label(b.producer))}<span class="tag ${b.inTurn ? 'turn' : 'back'}">${b.inTurn ? 'In turn' : 'Backup'}</span></td>
    <td class="r">${fmt(b.txCount)}</td><td class="r"><span class="gas"><i style="width:${gas.toFixed(1)}%"></i></span>${gas.toFixed(gas < 10 ? 1 : 0)}%</td>
    <td class="r">${b.spacing == null ? '—' : b.spacing + 's'}</td></tr>`;
}
function renderRows() { $('#rows').innerHTML = blocks.map(b => row(b, false)).join(''); }

function renderNetwork() {
  if (!network) return;
  const age0 = network.headTime ? Math.max(0, Math.floor(Date.now() / 1000) - network.headTime) : null;
  $('#k-head').textContent = fmt(network.head);
  $('#k-age').textContent = age0 == null ? '' : `${age0}s ago`;
  $('#k-time').textContent = network.avgBlockTime == null ? '—' : `${network.avgBlockTime.toFixed(2)}s`;
  $('#k-txs').textContent = fmt(network.txs);
  $('#k-tps').textContent = network.tps == null ? '' : `${network.tps.toFixed(1)} per second`;
  $('#k-gas').textContent = network.gasPct == null ? '—' : `${network.gasPct.toFixed(1)}%`;
  $('#k-val').textContent = fmt((network.validators || []).length);
  $('#k-stake').textContent = network.minStakeEln ? `minimum stake ${fmt(network.minStakeEln)} ELN` : 'entry managed by the network';
  $('#k-turn').textContent = network.inTurnShare == null ? '—' : `${(network.inTurnShare * 100).toFixed(0)}%`;
  const st = $('#status'), txt = $('#status-text');
  if (!network.rpcOk || age0 > 60) { st.className = 'status bad'; txt.textContent = 'Not receiving new blocks'; }
  else if (age0 > 20) { st.className = 'status warn'; txt.textContent = 'Slower than usual'; }
  else { st.className = 'status ok'; txt.textContent = 'Producing blocks'; }

  const counts = network.producedBy || {}, total = blocks.length || 1;
  const set = new Map((network.validators || []).map(a => [a.toLowerCase(), 0]));
  for (const [a, c] of Object.entries(counts)) set.set(a.toLowerCase(), c);
  $('#vals').innerHTML = [...set.entries()].map(([a, c]) => `<div class="val"><div class="row"><span>${esc(label(a))}</span><b>${fmt(c)}</b></div><div class="mono" style="color:var(--muted);font-size:11.5px">${esc(a)}</div><div class="bar"><i style="width:${(c / total * 100).toFixed(1)}%"></i></div></div>`).join('')
    || '<div class="val">—</div>';
}

function open(n) {
  const b = blocks.find(x => x.number === n);
  if (!b) return;
  $('#d-title').textContent = `Block ${fmt(b.number)}`;
  const f = (k, hint, v, mono) => `<dt>${k}${hint ? `<small>${hint}</small>` : ''}</dt><dd class="${mono ? 'mono' : ''}">${v}</dd>`;
  $('#d-body').innerHTML = `<dl>
    ${f('Height', 'Position in the chain', fmt(b.number))}
    ${f('Time', 'From the block header', esc(when(b.timestamp)))}
    ${f('Gap from previous', 'Target is 2 seconds', b.spacing == null ? '—' : b.spacing + ' s')}
    ${f('Block hash', '', esc(b.hash), 1)}
    ${f('Parent hash', 'Links this block to the one before', esc(b.parentHash), 1)}
    ${f('Produced by', 'Validator whose seal signs this block', `${esc(label(b.producer))}<br><span class="mono">${esc(b.producer)}</span>`)}
    ${f('Turn', '', b.inTurn ? 'In turn (difficulty 2)' : 'Backup, after a missed slot (difficulty 1)')}
    ${f('Total difficulty', 'Sum over the chain, used by fork choice', esc(b.totalDifficulty || '—'), 1)}
    ${f('Transactions', '', fmt(b.txCount))}
    ${f('Gas used', 'Of the block gas limit', `${fmt(b.gasUsed)} of ${fmt(b.gasLimit)} (${b.gasPct.toFixed(2)}%)`)}
    ${f('Base fee', 'Paid per unit of gas, in ELN', esc(gwei(b.baseFeePerGas)))}
    ${f('Size', '', `${fmt(b.size)} bytes`)}
    ${f('State root', 'Hash of all balances and contract storage after this block', esc(b.stateRoot), 1)}
    ${f('Transactions root', '', esc(b.transactionsRoot), 1)}
    ${f('Receipts root', '', esc(b.receiptsRoot), 1)}
    ${f('Client', 'Node software that built the block', esc(b.vanity || '—'))}
    ${f('Relayer attestations', 'RPC nodes credited for forwarding transactions in this block', fmt(b.attestations))}
    ${f('Seal', '65-byte signature of the producer', esc(b.seal || '—'), 1)}
    ${f('Uncles hash', '', esc(b.sha3Uncles), 1)}
    ${f('Mix hash', 'Always zero here', esc(b.mixHash), 1)}
    ${f('Nonce', '', esc(b.nonce), 1)}
    ${f('Logs bloom', '', esc(b.logsBloom), 1)}
    ${f('Extra data', 'Client name, attestations and seal', esc(b.extraData), 1)}
    ${f('Open in explorer', '', `<a href="${EXPLORER}/block/${b.number}" rel="noopener">Transactions and details →</a>`)}
  </dl>`;
  $('#drawer').hidden = false;
}

async function load() {
  const r = await fetch('/api/blocks', { cache: 'no-store' });
  const j = await r.json();
  blocks = j.blocks; network = j.network;
  setLabels(network.validators);
  renderRows(); renderNetwork();
}

function listen() {
  const es = new EventSource('/events');
  es.addEventListener('block', e => {
    const d = JSON.parse(e.data);
    network = d.network;
    if (blocks.length && d.block.number !== blocks[0].number + 1) return load();   // gap or reorg: reload
    setLabels(network.validators);
    blocks.unshift(d.block);
    if (blocks.length > 100) blocks.length = 100;
    const body = $('#rows');
    body.insertAdjacentHTML('afterbegin', row(d.block, true));
    while (body.children.length > 100) body.removeChild(body.lastElementChild);
    renderNetwork();
  });
  es.onerror = () => { $('#status').className = 'status warn'; $('#status-text').textContent = 'Reconnecting…'; };
}

$('#rows').addEventListener('click', e => { if (e.target.closest('[data-stop]')) return; const tr = e.target.closest('tr[data-n]'); if (tr) open(Number(tr.dataset.n)); });
$('#d-close').onclick = () => { $('#drawer').hidden = true; };
$('#drawer').addEventListener('click', e => { if (e.target.id === 'drawer') $('#drawer').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#drawer').hidden = true; });
setInterval(() => { document.querySelectorAll('[data-age]').forEach(td => { td.textContent = age(Number(td.dataset.age)); }); renderNetwork(); }, 1000);
load().then(listen).catch(() => { $('#status').className = 'status bad'; $('#status-text').textContent = 'Could not load'; setTimeout(() => location.reload(), 5000); });
