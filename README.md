# Range Ledger

A daily record of the IP address ranges that major cloud and CDN providers publish, with what was added or removed each day, a lookup for any address, and allowlist exports. Published at **https://coolcode.ca/rangeledger/**.

| Provider | Published file | Grouped by |
|---|---|---|
| Cloudflare | `www.cloudflare.com/ips-v4`, `/ips-v6` | IPv4 / IPv6 list |
| Amazon Web Services | `ip-ranges.amazonaws.com/ip-ranges.json` | Region and service |
| Google Cloud | `www.gstatic.com/ipranges/cloud.json` | Region |
| Fastly | `api.fastly.com/public-ip-list` | IPv4 / IPv6 list |
| Oracle Cloud | `docs.oracle.com/iaas/tools/public_ip_ranges.json` | Region and tags |
| GitHub | `api.github.com/meta` (hooks, web, api, git, pages, packages, importer) | Service |

Canadian regions are highlighted: AWS `ca-central-1` and `ca-west-1`, Google Cloud `northamerica-northeast1` and `-2`, and Oracle `ca-toronto-1` and `ca-montreal-1`.

## Reading the results

<!-- coolcode:guide -->
Paste an address into "Check an address" to see which provider publishes it, in which region or service, and whether that region is Canadian. "What changed" lists, by day, every prefix a provider added or removed. A move between regions shows as one removal and one addition. "Build an allowlist" turns a provider's current list, filtered by family, region, service or Canadian regions, into plain text, nginx `allow` rules or CSV. Rebuild from the newest snapshot before you rely on one. A provider marked "stale" couldn't be refreshed that day and shows its last good list.
<!-- /coolcode:guide -->

- Prefixes are shown in canonical form (lowercase IPv6, host bits cleared). Duplicate listings, such as an AWS prefix published for both `AMAZON` and `EC2`, merge into one row with both services.
- "Published" is the provider's own timestamp where its file has one (AWS, Google Cloud and Oracle). Otherwise only the retrieval time is known.
- Changes start from the first snapshot. Each day is compared with the newest snapshot from an earlier day, so re-running the same day doesn't double-count.

## Expand or customize

Settings live in **`web/config.json`**:

| Key | Meaning |
|---|---|
| `providers` | Each provider: `id`, `name`, `format` (`text`, `aws`, `google`, `fastly`, `oracle`, `github`), `urls`, `scope_label`, optional `canadian_scopes`, and for GitHub `github_keys` (which lists from `/meta` to track). |
| `keep_snapshots` | Full daily snapshots kept and selectable (default 14). |
| `history_days` | How long the change log is kept (default 365). |
| `max_drop_ratio` | If a provider's list suddenly shrinks by more than this share (default 0.5), the update is refused and the previous list is kept as stale. |
| `min_providers` | A snapshot needs at least this many fresh providers to publish (default 3). |

Any provider that publishes a plain list of prefixes, one per line, can be added with the `text` format. For example: `{ "id": "mycdn", "name": "My CDN", "format": "text", "urls": ["https://example.com/ips.txt"], "scope_label": "List" }`. To track GitHub Actions runners, add `"actions"` to `github_keys`; it's several thousand prefixes. Adding a Canadian region, such as a new AWS one, means appending it to `canadian_scopes`.

**Refresh and publish:** the workflow runs daily at 14:41 UTC and on every push to `main`: tests, today's snapshot, build, deploy. To refresh without pushing, use **Actions → Browser tool · Check and publish → Run workflow**. Snapshots and the change log persist in the Actions cache. Configuration changes apply from the next snapshot, and earlier snapshots keep the providers they were taken with.

## Develop and test

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
node scripts/capture.mjs --fixtures tests/fixtures/day1 --now 2026-11-22T14:00:00Z
node scripts/capture.mjs --fixtures tests/fixtures/day2 --now 2026-11-23T14:00:00Z
python3 scripts/build.py
python3 -m http.server 8000 --directory dist
```

`tests/fixtures/day1` and `day2` hold small files in each provider's real format. `tests/browser_smoke.py` checks snapshot switching, the lookup, the change log, the allowlist export and the mobile layout at `/rangeledger/`.

<!-- schedule-reliability -->
## Schedule reliability

Public GitHub repositories can have scheduled workflows disabled after 60 days of inactivity. A separate weekly [schedule guard](.github/workflows/schedule-guard.yml) calls GitHub's enable-workflow API for an explicit list of refresh workflows and itself. It can restore workflows disabled for inactivity, preserves manually disabled workflows, and runs independently of collection failures.

This is an interim mitigation, not a scheduling guarantee: GitHub does not document active-workflow renewal as a permanent exemption, and scheduled runs can be delayed or dropped. A scheduler on our own Linux server is the planned independent trigger. The guard does not collect data, create dummy commits, or change source/check timestamps; successful collection and published data freshness still need monitoring.
<!-- /schedule-reliability -->
