import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'capture.mjs'), ...args], { encoding: 'utf8' });

test('daily snapshots record changes; a failed provider keeps its previous list as stale', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rl-'));
  const cache = path.join(dir, 'cache'), out = path.join(dir, 'out');
  const day3 = path.join(dir, 'day3');
  cpSync(path.join(FIX, 'day2'), day3, { recursive: true });
  unlinkSync(path.join(day3, 'fastly-0.txt'));                           // Fastly fails on day 3
  writeFileSync(path.join(day3, 'oracle-0.txt'), JSON.stringify({ regions: [] })); // Oracle returns nothing
  for (const [fx, now] of [[path.join(FIX, 'day1'), '2026-11-22T14:00:00Z'], [path.join(FIX, 'day2'), '2026-11-23T14:00:00Z'], [path.join(FIX, 'day2'), '2026-11-23T20:00:00Z'], [day3, '2026-11-24T14:00:00Z']]) {
    const r = run(['--fixtures', fx, '--cache', cache, '--out', out, '--now', now]);
    assert.equal(r.status, 0, r.stderr);
  }
  const index = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.snapshots.map((s) => s.id), ['2026-11-24', '2026-11-23', '2026-11-22']);
  const changes = JSON.parse(readFileSync(path.join(out, 'changes.json'), 'utf8'));
  assert.deepEqual(changes.filter((c) => c.date === '2026-11-23').map((c) => c.provider).sort(), ['aws', 'cloudflare', 'github'], 'same-day rerun does not double-count');
  const s3 = JSON.parse(readFileSync(path.join(out, 'snapshots', '2026-11-24.json'), 'utf8'));
  assert.match(s3.providers.fastly.status, /^stale: /);
  assert.equal(s3.providers.fastly.entries.length, 5);
  assert.match(s3.providers.oracle.status, /^stale: no prefixes/);
  assert.equal(readdirSync(path.join(out, 'snapshots')).length, 3);
});

test('too few providers refreshing publishes nothing and exits non-zero', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rl-'));
  const fx = path.join(dir, 'fx');
  cpSync(path.join(FIX, 'day1'), fx, { recursive: true });
  for (const f of ['aws-0.txt', 'google-cloud-0.txt', 'fastly-0.txt', 'oracle-0.txt']) unlinkSync(path.join(fx, f));
  const out = path.join(dir, 'out');
  const r = run(['--fixtures', fx, '--cache', path.join(dir, 'cache'), '--out', out]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /keeping the last good deployment/);
  assert.throws(() => readdirSync(out));
});
