import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../web/model.mjs';

const config = JSON.parse(readFileSync(new URL('../web/config.json', import.meta.url), 'utf8'));
const P = (id) => config.providers.find((p) => p.id === id);
const fx = (day, name) => readFileSync(new URL(`./fixtures/${day}/${name}`, import.meta.url), 'utf8');

test('addresses and CIDRs: v4, v6, compression, embedded v4, host bits, rejects', () => {
  assert.equal(M.parseIp('192.0.2.1').family, 4);
  assert.equal(M.parseIp('2001:db8::1').family, 6);
  assert.equal(M.parseIp('::ffff:192.0.2.1').value, M.parseIp('::ffff:c000:201').value);
  for (const bad of ['256.1.1.1', '1.2.3', 'x', '2001:db8:::1', '1::2::3', '12345::1']) assert.equal(M.parseIp(bad), null, bad);
  assert.equal(M.parseCidr('2600:1F18:0:0::/33').text, '2600:1f18::/33');
  assert.equal(M.parseCidr('192.0.2.77/24').text, '192.0.2.0/24');
  assert.equal(M.parseCidr('2001:db8::/129'), null);
  assert.equal(M.parseCidr('10.0.0.0/x'), null);
  assert.equal(M.parseCidr('0.0.0.0/0').text, '0.0.0.0/0');
  const c = M.parseCidr('15.156.0.0/15');
  assert.ok(M.contains(c, M.parseIp('15.157.255.255')));
  assert.ok(!M.contains(c, M.parseIp('15.158.0.0')));
  assert.ok(!M.contains(c, M.parseIp('::ffff:15.156.0.1')));
});

test('every provider format normalises, merging duplicate prefixes', () => {
  const aws = M.normalize(P('aws'), [fx('day1', 'aws-0.txt')]);
  assert.equal(aws.published, '2026-11-23T01:02:03Z');
  const ca = aws.entries.find((e) => e[0] === '15.156.0.0/15');
  assert.deepEqual(ca, ['15.156.0.0/15', 'ca-central-1', ['AMAZON', 'EC2']]);
  assert.ok(aws.entries.some((e) => e[0] === '2600:1f18::/33'));
  assert.deepEqual(M.counts(aws.entries), { v4: 4, v6: 2 });
  assert.equal(M.normalize(P('google-cloud'), [fx('day1', 'google-cloud-0.txt')]).published, '2026-11-22T23:00:00.000Z');
  assert.equal(M.normalize(P('cloudflare'), [fx('day1', 'cloudflare-0.txt'), fx('day1', 'cloudflare-1.txt')]).entries.length, 7);
  assert.equal(M.normalize(P('fastly'), [fx('day1', 'fastly-0.txt')]).entries.length, 5);
  const oracle = M.normalize(P('oracle'), [fx('day1', 'oracle-0.txt')]);
  assert.equal(M.normalize(P('oracle'), [JSON.stringify({ last_updated_timestamp: '2026-10-28T02:47:53.012304', regions: [{ region: 'x', cidrs: [{ cidr: '10.0.0.0/8' }] }] })]).published, '2026-10-28T02:47:53.012304Z');
  assert.deepEqual(oracle.entries.find((e) => e[1] === 'ca-toronto-1' && e[0].startsWith('134')), ['134.70.112.0/22', 'ca-toronto-1', ['OBJECT_STORAGE', 'OSN']]);
  const gh = M.normalize(P('github'), [fx('day1', 'github-0.txt')]);
  assert.equal(gh.entries.find((e) => e[0] === '192.30.252.0/22')[1], 'hooks, web, git');
  assert.ok(!gh.entries.some((e) => e[0] === '4.148.0.0/16'), 'actions is not a configured key');
  // v4 sorted before v6 and numerically.
  const fam = aws.entries.map((e) => e[0].includes(':'));
  assert.deepEqual(fam, [...fam].sort());
  assert.throws(() => M.normalize({ format: 'nope' }, ['']), /Unknown format/);
  assert.equal(M.normalize(P('cloudflare'), ['not-a-prefix\n10.0.0.0/8\n# comment', '']).invalid, 1);
});

test('diffs by prefix and scope; drop protection', () => {
  const before = [['1.0.0.0/24', 'a', []], ['2.0.0.0/24', 'a', []]];
  const after = [['2.0.0.0/24', 'b', []], ['3.0.0.0/24', 'a', []]];
  assert.deepEqual(M.diff(before, after), { added: [['2.0.0.0/24', 'b'], ['3.0.0.0/24', 'a']], removed: [['1.0.0.0/24', 'a'], ['2.0.0.0/24', 'a']] });
  const many = Array.from({ length: 100 }, (_, i) => [`10.0.${i}.0/24`, '', []]);
  assert.ok(M.suspiciousDrop(many, many.slice(0, 40), 0.5));
  assert.ok(!M.suspiciousDrop(many, many.slice(0, 60), 0.5));
  assert.ok(!M.suspiciousDrop(many.slice(0, 5), [], 0.5), 'tiny lists may legitimately change a lot');
});

test('lookup finds the longest match per provider and flags Canadian regions', () => {
  const snap = { providers: {
    aws: { entries: M.normalize(P('aws'), [fx('day2', 'aws-0.txt')]).entries.concat([['15.156.0.0/24', 'ca-central-1', ['S3']]]) },
    cloudflare: { entries: M.normalize(P('cloudflare'), [fx('day1', 'cloudflare-0.txt'), fx('day1', 'cloudflare-1.txt')]).entries },
  } };
  const r = M.lookup(snap, '15.156.0.9', config.providers);
  assert.deepEqual(r.matches.map((m) => [m.provider, m.prefix, m.canadian]), [['aws', '15.156.0.0/24', true]]);
  assert.equal(M.lookup(snap, '2606:4700::6810:84e5', config.providers).matches[0].name, 'Cloudflare');
  assert.deepEqual(M.lookup(snap, '198.51.100.1', config.providers).matches, []);
  assert.equal(M.lookup(snap, 'nope'), null);
});

test('filters and exports', () => {
  const aws = M.normalize(P('aws'), [fx('day2', 'aws-0.txt')]).entries;
  assert.deepEqual(M.filterEntries(aws, { canadianOnly: true, provider: P('aws') }).map((e) => e[0]), ['15.156.0.0/15', '16.52.0.0/16', '40.176.0.0/15', '2600:1f11::/36']);
  assert.equal(M.filterEntries(aws, { family: '6' }).length, 2);
  assert.equal(M.filterEntries(aws, { service: 'S3' }).length, 1);
  assert.equal(M.filterEntries(aws, { scope: 'ca-west-1' }).length, 1);
  const sample = [['192.0.2.0/24', 'x, y', ['A']]];
  assert.equal(M.exportList(sample, 'plain'), '192.0.2.0/24\n');
  assert.equal(M.exportList(sample, 'nginx', 'label'), '# label\nallow 192.0.2.0/24;\n');
  assert.equal(M.exportList(sample, 'csv'), 'prefix,scope,services\r\n192.0.2.0/24,"x, y",A\r\n');
});

test('change log keeps one entry per provider per day within the window', () => {
  let c = M.updateChanges([], '2026-01-01', 'aws', { added: [['1.0.0.0/24', '']], removed: [] }, 365);
  c = M.updateChanges(c, '2026-01-01', 'aws', { added: [['2.0.0.0/24', '']], removed: [] }, 365);
  assert.equal(c.length, 1);
  c = M.updateChanges(c, '2026-01-02', 'aws', { added: [], removed: [] }, 365);
  assert.equal(c.length, 1, 'no-change days are not recorded');
  c = M.updateChanges(c, '2027-06-01', 'fastly', { added: [['3.0.0.0/24', '']], removed: [] }, 365);
  assert.deepEqual(c.map((x) => x.date), ['2027-06-01']);
});

test('config: providers are complete, and an added provider needs only config', () => {
  for (const p of config.providers) assert.ok(p.id && p.name && p.format && p.urls.length, p.id);
  const extra = { id: 'mycdn', name: 'My CDN', format: 'text', urls: ['https://example.com/ips'] };
  assert.equal(M.normalize(extra, ['198.51.100.0/24\n2001:db8::/32']).entries.length, 2);
});
