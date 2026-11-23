#!/usr/bin/env node
// Take one dated Range Ledger snapshot: fetch every provider's published IP ranges,
// normalise, compare with the previous snapshot, and publish into web/data/.
//
//   node scripts/capture.mjs
//   node scripts/capture.mjs --fixtures tests/fixtures/day1 --now 2026-11-23T14:00:00Z --cache /tmp/rl
//
// A provider that fails, or whose list shrinks suspiciously, keeps its previous ranges
// (marked stale). If too few providers succeed the run exits non-zero and nothing is published.

import { mkdir, readFile, writeFile, readdir, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../web/model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const fixtures = opt('--fixtures') ? path.resolve(opt('--fixtures')) : null;
const CACHE = path.resolve(opt('--cache') || path.join(ROOT, '.cache', 'rangeledger'));
const OUT = path.resolve(opt('--out') || path.join(ROOT, 'web', 'data'));
const now = opt('--now') ? new Date(opt('--now')) : new Date();
const today = now.toISOString().slice(0, 10);
const config = JSON.parse(await readFile(path.join(ROOT, 'web', 'config.json'), 'utf8'));

async function body(provider, url, i) {
  if (fixtures) return readFile(path.join(fixtures, `${provider.id}-${i}.txt`), 'utf8');
  const res = await fetch(url, { headers: { 'User-Agent': 'coolcode.ca/rangeledger (github.com/jsdyer/rangeledger)', Accept: 'application/json, text/plain' }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

await mkdir(path.join(CACHE, 'snapshots'), { recursive: true });
let index = [], changes = [], previous = null;
try { index = JSON.parse(await readFile(path.join(CACHE, 'index.json'), 'utf8')); } catch { /* first run */ }
try { changes = JSON.parse(await readFile(path.join(CACHE, 'changes.json'), 'utf8')); } catch { /* first run */ }
// Compare with the newest snapshot from an earlier day (a same-day rerun replaces today's).
const prior = index.find((e) => e.id < today);
if (prior) { try { previous = JSON.parse(await readFile(path.join(CACHE, 'snapshots', `${prior.id}.json`), 'utf8')); } catch { /* missing */ } }

const snapshot = { id: today, retrieved: now.toISOString(), providers: {} };
let fresh = 0;
for (const p of config.providers) {
  const before = previous?.providers?.[p.id];
  try {
    const bodies = await Promise.all(p.urls.map((u, i) => body(p, u, i)));
    const { published, entries, invalid } = M.normalize(p, bodies);
    if (!entries.length) throw new Error('no prefixes in the response');
    if (M.suspiciousDrop(before?.entries, entries, config.max_drop_ratio)) throw new Error(`list shrank from ${before.entries.length} to ${entries.length}; keeping the previous list`);
    snapshot.providers[p.id] = { status: 'ok', retrieved: now.toISOString(), published, invalid, ...M.counts(entries), entries };
    fresh++;
    const d = before ? M.diff(before.entries, entries) : { added: [], removed: [] };
    changes = M.updateChanges(changes, today, p.id, d, config.history_days);
    console.log(`✓ ${p.id}: ${entries.length} prefixes${before ? ` (+${d.added.length} −${d.removed.length})` : ' (first snapshot)'}${invalid ? `, ${invalid} invalid skipped` : ''}`);
  } catch (e) {
    const reason = String(e.message || e).slice(0, 160);
    if (before) snapshot.providers[p.id] = { ...before, status: `stale: ${reason}` };
    else snapshot.providers[p.id] = { status: `unavailable: ${reason}`, entries: [], v4: 0, v6: 0 };
    console.error(`✗ ${p.id}: ${reason}`);
  }
}
if (fresh < config.min_providers) {
  console.error(`Only ${fresh} providers refreshed (need ${config.min_providers}); keeping the last good deployment.`);
  process.exit(1);
}

await writeFile(path.join(CACHE, 'snapshots', `${today}.json`), JSON.stringify(snapshot));
const entry = { id: today, retrieved: snapshot.retrieved, providers: Object.fromEntries(Object.entries(snapshot.providers).map(([k, v]) => [k, { status: v.status, v4: v.v4, v6: v.v6, published: v.published || null }])) };
const { kept, dropped } = M.updateIndex(index, entry, config.keep_snapshots);
for (const d of dropped) await rm(path.join(CACHE, 'snapshots', `${d.id}.json`), { force: true });
await writeFile(path.join(CACHE, 'index.json'), JSON.stringify(kept));
await writeFile(path.join(CACHE, 'changes.json'), JSON.stringify(changes));

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'snapshots'), { recursive: true });
const present = new Set(await readdir(path.join(CACHE, 'snapshots')));
const published = kept.filter((e) => present.has(`${e.id}.json`));
for (const e of published) await copyFile(path.join(CACHE, 'snapshots', `${e.id}.json`), path.join(OUT, 'snapshots', `${e.id}.json`));
await writeFile(path.join(OUT, 'changes.json'), JSON.stringify(changes));
const total = Object.values(snapshot.providers).reduce((n, p) => n + (p.v4 || 0) + (p.v6 || 0), 0);
await writeFile(path.join(OUT, 'index.json'), JSON.stringify({ built: now.toISOString(), latest: today, prefixes: total, snapshots: published }, null, 1));
console.log(`Published ${published.length} snapshot(s); ${total} prefixes; ${changes.length} change records.`);
