#!/usr/bin/env node
/**
 * CSV parse smoke test — full network scrape.
 *
 * Downloads every CTP CSV we know about (one per route × service key),
 * parses each through the production parser, and reports:
 *
 *   - routes with all CSVs missing (suspended / seasonal / unknown)
 *   - routes with frequency annotations (range / headway) — these are
 *     the cases the #15 fix is meant to handle
 *   - routes with UNRECOGNIZED cells — these indicate the parser is
 *     missing a classification the CTP website actually uses
 *
 * Exits non-zero if ANY route has an unrecognized cell. That makes the
 * "full parse of all csv files from ctp" verification the user asked
 * for: when CTP rolls out a new annotation type, this test fails and we
 * know to extend `classifyCell()`.
 *
 * Uses the Transitous seed to get the canonical route list. No
 * credentials needed.
 *
 * Configuration:
 *   TRANSITOUS_SEED_URL     override the seed URL (default: Transitous Cluj)
 *   CTP_CSV_BASE_URL        override the CSV URL pattern (default: ctpcj.ro)
 *   SMOKE_FAIL_ON_MISSING   if "1", also fail when >50% of routes have no
 *                           CSVs at all (would indicate a connectivity issue
 *                           rather than a real data state). Default: "0".
 *
 * Exit codes:
 *   0  every CSV was parsed cleanly (no unrecognized cells)
 *   1  at least one unrecognized cell was found
 *   2  connectivity issue (Transitous seed or CSV host unreachable)
 */

import { argv, env, exit } from 'node:process';

import { loadTransitousSeed } from '../src/sources/transitous.js';
import { parseCtpCsv, fetchCtpCsv, CSV_SERVICE_KEYS } from '../src/sources/ctp-csv.js';
import { USER_AGENT } from '../src/lib/seed.js';

const DEFAULT_TRANSITOUS_URL = 'https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip';
const DEFAULT_CSV_BASE = 'https://ctpcj.ro/orare/csv/orar_{routeShortName}_{serviceId}.csv';
const WAF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://ctpcj.ro/index.php/ro/orare-linii/linii-urbane',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

async function main() {
  const failOnMissing = env.SMOKE_FAIL_ON_MISSING !== '0';  // default ON
const failOnInfra = env.SMOKE_ALLOW_INFRA_FAILURES !== '1'; // default ON — any non-404 miss is a signal
const missingThresholdPct = Number(env.SMOKE_MISSING_THRESHOLD_PCT ?? 10); // % above which the build fails
  const seedUrl = env.TRANSITOUS_SEED_URL || DEFAULT_TRANSITOUS_URL;
  const csvBase = env.CTP_CSV_BASE_URL || DEFAULT_CSV_BASE;
  const fetchImpl = globalThis.fetch;

  console.log(`[smoke:csv] Transitous seed: ${seedUrl}`);
  console.log(`[smoke:csv] CTP CSV base: ${csvBase}`);
  console.log(`[smoke:csv] service keys: ${CSV_SERVICE_KEYS.join(', ')}`);

  let seed;
  try {
    seed = await loadTransitousSeed({ url: seedUrl });
  } catch (err) {
    console.error(`[smoke:csv] FATAL: Transitous seed unreachable: ${err.message || err}`);
    exit(2);
  }

  const routes = seed.routes;
  console.log(`[smoke:csv] scraping ${routes.length} routes × ${CSV_SERVICE_KEYS.length} service keys = ${routes.length * CSV_SERVICE_KEYS.length} CSVs`);

  /** @type {Map<string, {ok: number, missing: number, frequency: number, unknown: number, samples: Array<{route: string, value: string}>}>} */
  const stats = new Map();

  // Build all the fetch tasks first, then run with bounded concurrency.
  const tasks = [];
  for (const route of routes) {
    for (const svcKey of CSV_SERVICE_KEYS) {
      tasks.push({ route, svcKey });
    }
  }

  const concurrency = 8;
  let cursor = 0;
  let unrecognizedCount = 0;
  let unrecognizedSamples = [];

  async function worker() {
    while (cursor < tasks.length) {
      const myIdx = cursor++;
      const { route, svcKey } = tasks[myIdx];
      const key = `${route.shortName}`;
      if (!stats.has(key)) {
        stats.set(key, { ok: 0, notFound: 0, wafBlocked: 0, httpError: 0, networkError: 0, frequency: 0, unknown: 0, samples: [] });
      }
      const stat = stats.get(key);
      // Build URL by hand (don't reuse fetchCtpCsv so we can use the smoke fetcher
      // headers and pass through the raw body to the parser).
      const url = csvBase
        .replace('{routeShortName}', encodeURIComponent(route.shortName))
        .replace('{serviceId}', encodeURIComponent(svcKey));
      let res;
      try {
        res = await fetchImpl(url, {
          headers: { ...WAF_HEADERS, 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        // Timeout / DNS / TCP refused — transient infrastructure issue,
        // distinct from "CTP doesn't publish this CSV" (which is 404).
        stat.networkError++;
        continue;
      }
      if (res.status === 404) {
        // 404 = CTP doesn't publish this CSV. Permanent catalog gap,
        // not a connectivity issue.
        stat.notFound++;
        continue;
      }
      if (!res.ok) {
        // Other 4xx/5xx — server-side problem worth surfacing.
        console.warn(`[smoke:csv] ${route.shortName}_${svcKey}: HTTP ${res.status}`);
        stat.httpError++;
        continue;
      }
      const body = await res.text();
      if (!body.startsWith('route_long_name,')) {
        // WAF / captcha page — got 200 OK but the body isn't a CSV.
        // Distinct from both 404 (no such CSV) and HTTP errors
        // (server rejected us). Treated as transient — usually fixed
        // by retry with different headers or from a different IP.
        stat.wafBlocked++;
        continue;
      }
      const parsed = parseCtpCsv(body);
      if (!parsed) {
        stat.missing++;
        continue;
      }
      stat.ok++;
      const fa = parsed.frequencyAnnotations;
      if ((fa.dir0.ranges.length + fa.dir0.headways.length +
           fa.dir1.ranges.length + fa.dir1.headways.length) > 0) {
        stat.frequency++;
      }
      if (parsed.warnings && parsed.warnings.length > 0) {
        stat.unknown += parsed.warnings.length;
        unrecognizedCount += parsed.warnings.length;
        for (const w of parsed.warnings) {
          if (unrecognizedSamples.length < 10) {
            unrecognizedSamples.push({ route: `${route.shortName}_${svcKey}`, value: w.value });
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));

  // Report
  let totalOk = 0;
  let totalNotFound = 0;
  let totalWafBlocked = 0;
  let totalHttpError = 0;
  let totalNetworkError = 0;
  let totalFreq = 0;
  const routesWithNoCsv = [];
  for (const [shortName, s] of stats.entries()) {
    totalOk += s.ok;
    totalNotFound += s.notFound;
    totalWafBlocked += s.wafBlocked;
    totalHttpError += s.httpError;
    totalNetworkError += s.networkError;
    totalFreq += s.frequency;
    // Route has "no CSV" when ALL service-day fetches failed (no ok
    // results and at least one failure — could be all 404, all WAF,
    // a mix, or one catastrophic network error on every retry).
    if (s.ok === 0 && (s.notFound + s.wafBlocked + s.httpError + s.networkError) > 0) {
      routesWithNoCsv.push(shortName);
    }
  }
  const totalFetches = totalOk + totalNotFound + totalWafBlocked + totalHttpError + totalNetworkError;

  console.log('');
  console.log('=== CSV smoke test summary ===');
  console.log(`Total CSVs scraped:    ${totalFetches}`);
  console.log('');
  console.log('By fetch status:');
  console.log(`  Successfully parsed:  ${totalOk}`);
  console.log(`  Not found (404):      ${totalNotFound}    (CTP doesn't publish these CSVs)`);
  console.log(`  WAF-blocked:           ${totalWafBlocked}    (200 OK but body wasn't CSV)`);
  console.log(`  HTTP error:            ${totalHttpError}    (non-404 server error)`);
  console.log(`  Network error:         ${totalNetworkError}    (timeout/connect refused)`);
  console.log('');
  console.log('Route coverage:');
  console.log(`  Routes with ≥1 CSV:   ${stats.size - routesWithNoCsv.length}`);
  console.log(`  Routes with no CSV:    ${routesWithNoCsv.length}    (no service day fetched successfully)`);
  if (routesWithNoCsv.length > 0 && routesWithNoCsv.length <= 20) {
    console.log(`    → ${routesWithNoCsv.join(', ')}`);
  } else if (routesWithNoCsv.length > 20) {
    console.log(`    → ${routesWithNoCsv.slice(0, 20).join(', ')}, ... and ${routesWithNoCsv.length - 20} more`);
  }
  console.log('');
  console.log(`Frequency annotations found:   ${totalFreq}`);
  console.log(`Unrecognized cells:            ${unrecognizedCount}`);

  if (unrecognizedCount > 0) {
    console.error('');
    console.error(`[smoke:csv] FAIL: ${unrecognizedCount} unrecognized cell(s) — extend classifyCell() in src/sources/ctp-csv.js`);
    for (const s of unrecognizedSamples) {
      console.error(`  - ${s.route}: "${s.value}"`);
    }
    if (unrecognizedSamples.length < unrecognizedCount) {
      console.error(`  ... and ${unrecognizedCount - unrecognizedSamples.length} more (truncated)`);
    }
    exit(1);
  }

  const totalMissing = totalNotFound + totalWafBlocked + totalHttpError + totalNetworkError;
  const totalInfra = totalWafBlocked + totalHttpError + totalNetworkError;

  // Fail on ANY infrastructure miss (WAF / HTTP / network). 404s are
  // catalog gaps (operator never published those CSVs) and are OK in
  // moderation; the others indicate the smoke test couldn't actually
  // talk to CTP — which means we have NO signal on what the catalog
  // looks like. Opt-out: SMOKE_ALLOW_INFRA_FAILURES=1.
  if (failOnInfra && totalInfra > 0) {
    console.error('');
    console.error(`[smoke:csv] FAIL: ${totalInfra} CSV fetch(es) hit infrastructure issues — build has no real signal:`);
    if (totalWafBlocked > 0) console.error(`  - ${totalWafBlocked} WAF-blocked (got 200 OK but body wasn't CSV)`);
    if (totalHttpError > 0) console.error(`  - ${totalHttpError} HTTP error(s) (non-404 server error)`);
    if (totalNetworkError > 0) console.error(`  - ${totalNetworkError} network error(s) (timeout / connect refused)`);
    console.error('  Set SMOKE_ALLOW_INFRA_FAILURES=1 to skip this check (NOT recommended).');
    exit(2);
  }

  // Fail on total-miss ratio above threshold. 404s are allowed (catalog
  // gaps); but if the overall miss rate is high, something upstream
  // broke and we should investigate. Default threshold 10%.
  // Opt-out: SMOKE_FAIL_ON_MISSING=0.
  const threshold = Math.floor((routes.length * CSV_SERVICE_KEYS.length) * missingThresholdPct / 100);
  if (failOnMissing && totalMissing > threshold) {
    console.error('');
    console.error(`[smoke:csv] FAIL: ${totalMissing}/${routes.length * CSV_SERVICE_KEYS.length} CSVs missing (>${missingThresholdPct}% threshold)`);
    console.error(`  (${totalNotFound} not-found, ${totalInfra} infrastructure issues)`);
    console.error('  Set SMOKE_FAIL_ON_MISSING=0 to skip this check.');
    exit(2);
  }

  console.log('');
  console.log('[smoke:csv] OK — every CSV was parsed cleanly. The #15 fix handles real-world annotations.');
  exit(0);
}

main().catch((err) => {
  console.error(`[smoke:csv] unexpected error: ${err.stack || err.message || err}`);
  exit(2);
});

void argv;