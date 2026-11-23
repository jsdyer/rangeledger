// Pure logic for Range Ledger: CIDR parsing and matching, provider format normalisation,
// snapshot diffs, export formats. Shared by the page and scripts/capture.mjs; unit-tested.

// ---------------------------------------------------------------- addresses
export function parseIp(text) {
  const s = String(text || '').trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split('.').map(Number);
    if (parts.some((p) => p > 255)) return null;
    return { family: 4, value: parts.reduce((a, p) => (a << 8n) | BigInt(p), 0n), bits: 32 };
  }
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;
  let [head, tail = null] = s.split('::');
  if (s.split('::').length > 2) return null;
  const toGroups = (x) => (x ? x.split(':') : []);
  let hg = toGroups(head), tg = tail === null ? [] : toGroups(tail);
  // Embedded IPv4 tail (::ffff:192.0.2.1)
  const last = (tail === null ? hg : tg).at(-1);
  if (last && last.includes('.')) {
    const v4 = parseIp(last);
    if (!v4) return null;
    const pair = [Number(v4.value >> 16n).toString(16), Number(v4.value & 0xffffn).toString(16)];
    if (tail === null) hg = [...hg.slice(0, -1), ...pair]; else tg = [...tg.slice(0, -1), ...pair];
  }
  const fill = tail === null ? 0 : 8 - hg.length - tg.length;
  if (fill < 0 || (tail === null && hg.length !== 8)) return null;
  const groups = [...hg, ...Array(fill).fill('0'), ...tg];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return { family: 6, value: groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n), bits: 128 };
}

function formatV6(value) {
  const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt((7 - i) * 16)) & 0xffffn));
  let best = { s: -1, l: 0 };
  for (let i = 0; i < 8;) { if (groups[i]) { i++; continue; } let j = i; while (j < 8 && !groups[j]) j++; if (j - i > best.l) best = { s: i, l: j - i }; i = j; }
  const hex = groups.map((g) => g.toString(16));
  return best.l < 2 ? hex.join(':') : `${hex.slice(0, best.s).join(':')}::${hex.slice(best.s + best.l).join(':')}`;
}
const formatIp = (family, value) => (family === 4 ? [24n, 16n, 8n, 0n].map((s) => Number((value >> s) & 255n)).join('.') : formatV6(value));

/** Parse a CIDR (or bare address as /32 or /128). Returns canonical text with host bits cleared, or null. */
export function parseCidr(text) {
  const [addr, lenText] = String(text || '').trim().split('/');
  const ip = parseIp(addr);
  if (!ip) return null;
  const len = lenText === undefined ? ip.bits : Number(lenText);
  if (!Number.isInteger(len) || len < 0 || len > ip.bits || (lenText !== undefined && !/^\d+$/.test(lenText))) return null;
  const mask = len === 0 ? 0n : ((1n << BigInt(len)) - 1n) << BigInt(ip.bits - len);
  const network = ip.value & mask;
  return { family: ip.family, network, len, mask, text: `${formatIp(ip.family, network)}/${len}` };
}

export const contains = (cidr, ip) => cidr.family === ip.family && (ip.value & cidr.mask) === cidr.network;

// ---------------------------------------------------------------- provider formats
// Each normaliser returns { published, rows: [[prefix, scope, services[]]] }.
const textList = (bodies) => ({ published: null, rows: bodies.flatMap((b) => String(b).split(/\r?\n/)).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((p) => [p, l2(p), []]) });
function l2(p) { return p.includes(':') ? 'IPv6' : 'IPv4'; }

const FORMATS = {
  text: (bodies) => textList(bodies),
  aws: ([body]) => {
    const j = JSON.parse(body);
    const pub = j.createDate ? j.createDate.replace(/^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)$/, '$1-$2-$3T$4:$5:$6Z') : null;
    return { published: pub, rows: [...(j.prefixes || []).map((p) => [p.ip_prefix, p.region, [p.service]]), ...(j.ipv6_prefixes || []).map((p) => [p.ipv6_prefix, p.region, [p.service]])] };
  },
  google: ([body]) => {
    const j = JSON.parse(body);
    return { published: j.creationTime || null, rows: (j.prefixes || []).map((p) => [p.ipv4Prefix || p.ipv6Prefix, p.scope, p.service ? [p.service] : []]) };
  },
  fastly: ([body]) => {
    const j = JSON.parse(body);
    return { published: null, rows: [...(j.addresses || []), ...(j.ipv6_addresses || [])].map((p) => [p, l2(p), []]) };
  },
  oracle: ([body]) => {
    const j = JSON.parse(body);
    return { published: j.last_updated_timestamp || null, rows: (j.regions || []).flatMap((r) => (r.cidrs || []).map((c) => [c.cidr, r.region, c.tags || []])) };
  },
  github: ([body], provider) => {
    const j = JSON.parse(body);
    return { published: null, rows: (provider.github_keys || []).flatMap((k) => (Array.isArray(j[k]) ? j[k] : []).map((p) => [p, k, []])) };
  },
};

/**
 * Normalise a provider's raw response bodies: canonical prefixes, merged duplicates
 * (same prefix listed for several services), sorted v4 then v6.
 */
export function normalize(provider, bodies) {
  const fn = FORMATS[provider.format];
  if (!fn) throw new Error(`Unknown format ${provider.format}`);
  const raw = fn(bodies, provider);
  const rows = raw.rows;
  // Some providers omit the time zone; their timestamps are UTC.
  const published = raw.published && !/Z$|[+-]\d\d:?\d\d$/.test(raw.published) ? `${raw.published}Z` : raw.published;
  const byPrefix = new Map();
  let invalid = 0;
  for (const [raw, scope, services] of rows) {
    const c = parseCidr(raw);
    if (!c || !String(raw).includes('/')) { invalid++; continue; }
    const e = byPrefix.get(c.text);
    if (e) { for (const s of services) if (s && !e[2].includes(s)) e[2].push(s); if (scope && !e[1].split(', ').includes(scope)) e[1] += `, ${scope}`; }
    else byPrefix.set(c.text, [c.text, String(scope || ''), services.filter(Boolean).map(String)]);
  }
  const entries = [...byPrefix.values()].sort((a, b) => {
    const x = parseCidr(a[0]), y = parseCidr(b[0]);
    return x.family - y.family || (x.network < y.network ? -1 : x.network > y.network ? 1 : x.len - y.len);
  });
  entries.forEach((e) => e[2].sort());
  return { published, entries, invalid };
}

export function counts(entries) {
  let v4 = 0, v6 = 0;
  for (const [p] of entries) p.includes(':') ? v6++ : v4++;
  return { v4, v6 };
}

/** Added/removed prefixes (by prefix+scope, so a region move shows as remove+add). */
export function diff(before, after) {
  const key = (e) => `${e[0]}|${e[1]}`;
  const a = new Map((before || []).map((e) => [key(e), e])), b = new Map((after || []).map((e) => [key(e), e]));
  return {
    added: [...b].filter(([k]) => !a.has(k)).map(([, e]) => [e[0], e[1]]),
    removed: [...a].filter(([k]) => !b.has(k)).map(([, e]) => [e[0], e[1]]),
  };
}

/** Refuse an update that drops more than `ratio` of a provider's prefixes (likely a bad fetch). */
export function suspiciousDrop(before, after, ratio) {
  return before?.length > 20 && after.length < before.length * (1 - ratio);
}

/** Longest matching prefix per provider for an address. */
export function lookup(snapshot, ipText, providerMeta = []) {
  const ip = parseIp(ipText);
  if (!ip) return null;
  const out = [];
  for (const [id, p] of Object.entries(snapshot.providers)) {
    let best = null;
    for (const e of p.entries || []) {
      const c = parseCidr(e[0]);
      if (c && contains(c, ip) && (!best || c.len > best.c.len)) best = { c, e };
    }
    if (best) {
      const meta = providerMeta.find((m) => m.id === id) || {};
      out.push({ provider: id, name: meta.name || id, prefix: best.e[0], scope: best.e[1], services: best.e[2], canadian: isCanadian(meta, best.e[1]) });
    }
  }
  return { family: ip.family, matches: out };
}

export const isCanadian = (provider, scope) => Boolean(provider?.canadian_scopes?.some((s) => String(scope).split(', ').includes(s)));

export function filterEntries(entries, { family = 'all', scope = '', service = '', canadianOnly = false, provider } = {}) {
  return entries.filter((e) =>
    (family === 'all' || (family === '6') === e[0].includes(':'))
    && (!scope || e[1].split(', ').includes(scope))
    && (!service || e[2].includes(service))
    && (!canadianOnly || isCanadian(provider, e[1])));
}

/** Export a filtered list as plain prefixes, nginx allow rules, or CSV. */
export function exportList(entries, format, label = '') {
  if (format === 'nginx') return `# ${label}\n${entries.map((e) => `allow ${e[0]};`).join('\n')}\n`;
  if (format === 'csv') return `prefix,scope,services\r\n${entries.map((e) => [e[0], e[1], e[2].join(' ')].map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n')}\r\n`;
  return `${entries.map((e) => e[0]).join('\n')}\n`;
}

export function updateIndex(index, entry, keep) {
  const rest = (Array.isArray(index) ? index : []).filter((e) => e.id !== entry.id);
  const all = [entry, ...rest].sort((a, b) => b.id.localeCompare(a.id));
  return { kept: all.slice(0, keep), dropped: all.slice(keep) };
}

/** Change log: replace today's entry for a provider, keep `days` of history, newest first. */
export function updateChanges(changes, dateId, provider, d, days) {
  const cutoff = new Date(Date.parse(`${dateId}T00:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
  const rest = (changes || []).filter((c) => !(c.date === dateId && c.provider === provider) && c.date >= cutoff);
  if (d.added.length || d.removed.length) rest.push({ date: dateId, provider, added: d.added, removed: d.removed });
  return rest.sort((a, b) => b.date.localeCompare(a.date) || a.provider.localeCompare(b.provider));
}
