import * as M from './model.mjs';

const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
  return el;
}
const fmt = new Intl.NumberFormat('en-CA');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '—');
const dayOnly = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

let config, index, snapshot, changes = [];
const meta = (id) => config.providers.find((p) => p.id === id) || { id, name: id };

async function getJson(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${r.status} for ${path}`);
  return r.json();
}

function renderProviders() {
  $('#providers').replaceChildren(
    h('thead', {}, h('tr', {}, ...['Provider', 'IPv4', 'IPv6', 'Canadian', 'Published', 'Status', 'Last change'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, ...config.providers.map((pm) => {
      const p = snapshot.providers[pm.id];
      if (!p) return h('tr', {}, h('td', {}, pm.name), h('td', { colspan: '6', class: 'muted' }, 'Not in this snapshot'));
      const ca = pm.canadian_scopes ? p.entries.filter((e) => M.isCanadian(pm, e[1])).length : null;
      const last = changes.find((c) => c.provider === pm.id);
      return h('tr', {},
        h('td', {}, pm.name), h('td', {}, fmt.format(p.v4 || 0)), h('td', {}, fmt.format(p.v6 || 0)),
        h('td', {}, ca === null ? '—' : fmt.format(ca)), h('td', {}, p.published ? when(p.published) : '—'),
        h('td', { class: p.status === 'ok' ? 'ok' : 'warn', title: p.status }, p.status === 'ok' ? 'Fresh' : p.status.startsWith('stale') ? `Stale (since ${when(p.retrieved)})` : 'Unavailable'),
        h('td', {}, last ? `${last.date}: +${last.added.length} −${last.removed.length}` : 'None recorded'));
    })));
}

function renderLookup(text) {
  const out = $('#lookup-result');
  if (!text.trim()) return out.replaceChildren();
  const r = M.lookup(snapshot, text, config.providers);
  if (!r) return out.replaceChildren(h('p', { class: 'warn' }, 'That isn’t a valid IPv4 or IPv6 address.'));
  if (!r.matches.length) return out.replaceChildren(h('p', {}, `${text.trim()} isn’t in any tracked provider’s published ranges in the ${snapshot.id} snapshot.`));
  out.replaceChildren(h('ul', { class: 'matches' }, ...r.matches.map((m) => h('li', {},
    h('strong', {}, m.name), ` · ${m.prefix}`,
    m.scope ? h('span', { class: 'muted' }, ` · ${meta(m.provider).scope_label || 'Scope'}: ${m.scope}`) : null,
    m.services.length ? h('span', { class: 'muted' }, ` · ${m.services.join(', ')}`) : null,
    m.canadian ? h('span', { class: 'tag ca' }, 'Canadian region') : null))));
}

function renderChanges() {
  const filter = $('#change-provider').value;
  const list = changes.filter((c) => !filter || c.provider === filter);
  const days = [...new Set(list.map((c) => c.date))];
  $('#changes').replaceChildren(...(days.length ? days.slice(0, 60).map((d) => h('div', { class: 'day' }, h('h3', {}, dayOnly(d)),
    ...list.filter((c) => c.date === d).map((c) => h('details', {},
      h('summary', {}, `${meta(c.provider).name}: `, h('span', { class: 'add' }, `+${c.added.length}`), ' ', h('span', { class: 'rem' }, `−${c.removed.length}`)),
      h('ul', { class: 'prefixes' },
        ...c.added.map(([p, s]) => h('li', { class: 'add' }, `+ ${p}`, s ? h('span', { class: 'muted' }, ` ${s}`) : null, M.isCanadian(meta(c.provider), s) ? h('span', { class: 'tag ca' }, 'Canadian') : null)),
        ...c.removed.map(([p, s]) => h('li', { class: 'rem' }, `− ${p}`, s ? h('span', { class: 'muted' }, ` ${s}`) : null))))))) : [h('p', { class: 'muted' }, index.snapshots.length < 2 ? 'Changes appear once there are two daily snapshots to compare.' : 'No changes recorded.')]));
}

function exportEntries() {
  const pm = meta($('#x-provider').value);
  const p = snapshot.providers[pm.id];
  return { pm, entries: M.filterEntries(p?.entries || [], { family: $('#x-family').value, scope: $('#x-scope').value, service: $('#x-service').value, canadianOnly: $('#x-canada').checked, provider: pm }) };
}
function fillExportOptions() {
  const pm = meta($('#x-provider').value);
  const entries = snapshot.providers[pm.id]?.entries || [];
  const scopes = [...new Set(entries.flatMap((e) => e[1].split(', ')).filter(Boolean))].sort();
  const services = [...new Set(entries.flatMap((e) => e[2]))].sort();
  $('#x-scope-label').firstChild.textContent = `${pm.scope_label || 'Scope'} `;
  $('#x-scope').replaceChildren(h('option', { value: '' }, 'Any'), ...scopes.map((s) => h('option', { value: s }, s)));
  $('#x-service').replaceChildren(h('option', { value: '' }, 'Any'), ...services.map((s) => h('option', { value: s }, s)));
  $('#x-service').disabled = !services.length;
  $('#x-canada').disabled = !pm.canadian_scopes;
  if (!pm.canadian_scopes) $('#x-canada').checked = false;
  renderExport();
}
function renderExport() {
  const { pm, entries } = exportEntries();
  const text = M.exportList(entries, $('#x-format').value, `${pm.name} ranges from the ${snapshot.id} Range Ledger snapshot (coolcode.ca/rangeledger)`);
  $('#x-count').textContent = `${fmt.format(entries.length)} prefixes from ${pm.name}, snapshot ${snapshot.id}.`;
  $('#x-preview').value = text.length > 200000 ? `${text.slice(0, 200000)}\n… (download for the full list)` : text;
}

async function show(id) {
  $('#snapshot-note').textContent = 'Loading…';
  try { snapshot = await getJson(`./data/snapshots/${encodeURIComponent(id)}.json`); } catch { $('#snapshot-note').textContent = `Couldn't load snapshot ${id}.`; return; }
  const n = Object.values(snapshot.providers).reduce((a, p) => a + (p.v4 || 0) + (p.v6 || 0), 0);
  $('#snapshot-note').textContent = `Retrieved ${when(snapshot.retrieved)} · ${fmt.format(n)} prefixes from ${Object.keys(snapshot.providers).length} providers`;
  renderProviders(); fillExportOptions();
  renderLookup($('#ip').value);
  try { const u = new URL(location.href); u.searchParams.set('snapshot', id); history.replaceState(null, '', u); } catch { /* ignore */ }
}

$('#lookup').addEventListener('submit', (e) => { e.preventDefault(); renderLookup($('#ip').value); });
$('#change-provider').addEventListener('change', renderChanges);
$('#x-provider').addEventListener('change', fillExportOptions);
for (const id of ['#x-family', '#x-scope', '#x-service', '#x-canada', '#x-format']) $(id).addEventListener('change', renderExport);
$('#x-download').addEventListener('click', () => {
  const { pm, entries } = exportEntries();
  const f = $('#x-format').value;
  const text = M.exportList(entries, f, `${pm.name} ranges from the ${snapshot.id} Range Ledger snapshot (coolcode.ca/rangeledger)`);
  const url = URL.createObjectURL(new Blob([text], { type: f === 'csv' ? 'text/csv' : 'text/plain' }));
  const a = h('a', { href: url, download: `${pm.id}-${snapshot.id}.${f === 'csv' ? 'csv' : f === 'nginx' ? 'conf' : 'txt'}` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#x-copy').addEventListener('click', async (e) => {
  try { await navigator.clipboard.writeText($('#x-preview').value); e.target.textContent = 'Copied'; } catch { $('#x-preview').select(); e.target.textContent = 'Select and copy'; }
  setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
});

try {
  config = await getJson('./config.json');
  for (const sel of ['#change-provider', '#x-provider']) $(sel).append(...config.providers.map((p) => h('option', { value: p.id }, p.name)));
  index = await getJson('./data/index.json');
  if (!index.snapshots?.length) throw new Error('no snapshots');
  try { changes = await getJson('./data/changes.json'); } catch { changes = []; }
  const sel = $('#snapshot');
  sel.replaceChildren(...index.snapshots.map((s, i) => h('option', { value: s.id }, `${s.id}${i === 0 ? ' (latest)' : ''}`)));
  const params = new URL(location.href).searchParams;
  sel.value = index.snapshots.some((s) => s.id === params.get('snapshot')) ? params.get('snapshot') : index.snapshots[0].id;
  sel.disabled = index.snapshots.length < 2;
  sel.addEventListener('change', () => show(sel.value));
  if (params.get('ip')) $('#ip').value = params.get('ip');
  renderChanges();
  await show(sel.value);
} catch (e) {
  $('#snapshot').replaceChildren(h('option', {}, 'None'));
  $('#snapshot-note').textContent = config ? 'No snapshot has been published yet. The daily build collects one.' : 'Configuration failed to load.';
  console.error(e);
}
