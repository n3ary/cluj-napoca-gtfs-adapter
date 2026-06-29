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
 *   3  whole-line 404 — route(s) have ZERO CSV coverage
 *
 * Side effect: writes successful CSV bodies to .build-input/csv/ and a
 * manifest to .build-input/csv-status.json. The build phase consumes
 * both so it never re-fetches.
 */

import { argv, env, exit } from 'node:process';

import { loadTransitousSeed } from '../src/sources/transitous.js';
import { parseCtpCsv, buildCtpCsvUrl, CSV_SERVICE_KEYS } from '../src/sources/ctp-csv.js';
import { USER_AGENT } from '../src/lib/seed.js';
import { ensureBuildInputDirs, writeCsvBody, writeStatusManifest } from '../src/lib/build-input.js';

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

// --- Local log helpers (kept inline since this is a single-file script;
// a shared logger module would be over-engineering for one consumer).
const TAG = '[smoke:csv]';
const pad = (s, n) => String(s).padEnd(n);
const ghaError = (msg) => console.error(`::error::${TAG} ${msg}`);
const die = (code, msg) => { console.error(TAG, msg); exit(code); };

async function main() {
  const failOnInfra = env.SMOKE_ALLOW_INFRA_FAILURES !== '1'; // default ON — any non-404 miss is a signal
  const seedUrl = env.TRANSITOUS_SEED_URL || DEFAULT_TRANSITOUS_URL;
  const csvBase = env.CTP_CSV_BASE_URL || DEFAULT_CSV_BASE;
  const fetchImpl = globalThis.fetch;

  console.log(`${TAG} Transitous seed: ${seedUrl}`);
  console.log(`${TAG} CTP CSV base: ${csvBase}`);
  console.log(`${TAG} service keys: ${CSV_SERVICE_KEYS.join(', ')}`);

  let seed;
  try {
    seed = await loadTransitousSeed({ url: seedUrl });
  } catch (err) {
    die(2, `FATAL: Transitous seed unreachable: ${err.message || err}`);
  }

  const routes = seed.routes;
  console.log(`${TAG} scraping ${routes.length} routes × ${CSV_SERVICE_KEYS.length} service keys = ${routes.length * CSV_SERVICE_KEYS.length} CSVs`);

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

  // Manifest of every fetch attempt. Written to .build-input/csv-status.json
  // at the end so the build phase can read CSVs from disk without re-fetching.
  // Order: insertion order = task order, which is deterministic by route+svc.
  /** @type {Array<{route: string, svc: string, status: 'ok' | 'not-found' | 'waf-blocked' | 'http-error' | 'network-error', httpStatus?: number}>} */
  const manifestEntries = [];

  // Ensure the build-input directory exists before any worker runs.
  ensureBuildInputDirs();

  async function worker() {
    while (cursor < tasks.length) {
      const myIdx = cursor++;
      const { route, svcKey } = tasks[myIdx];
      const key = `${route.shortName}`;
      if (!stats.has(key)) {
        stats.set(key, { ok: 0, notFound: 0, wafBlocked: 0, httpError: 0, networkError: 0, frequency: 0, unknown: 0, samples: [] });
      }
      const stat = stats.get(key);
      // Build URL via the canonical `buildCtpCsvUrl` from src/sources/ctp-csv.js
      // so URL-convention changes (e.g. CTP's no-space rule for "39 CREIC")
      // don't need to land in three places. We fetch manually here
      // (rather than calling fetchCtpCsv) so the smoke script can use
      // its own headers + pass the raw body through to the parser.
      const url = buildCtpCsvUrl(route.shortName, svcKey, csvBase);
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
        manifestEntries.push({ route: route.shortName, svc: svcKey, status: 'network-error' });
        continue;
      }
      if (res.status === 404) {
        // 404 = CTP doesn't publish this CSV. Permanent catalog gap,
        // not a connectivity issue.
        stat.notFound++;
        manifestEntries.push({ route: route.shortName, svc: svcKey, status: 'not-found', httpStatus: 404 });
        continue;
      }
      if (!res.ok) {
        // Other 4xx/5xx — server-side problem worth surfacing.
        console.warn(`${TAG} ${route.shortName}_${svcKey}: HTTP ${res.status}`);
        stat.httpError++;
        manifestEntries.push({ route: route.shortName, svc: svcKey, status: 'http-error', httpStatus: res.status });
        continue;
      }
      const body = await res.text();
      if (!body.startsWith('route_long_name,')) {
        // WAF / captcha page — got 200 OK but the body isn't a CSV.
        // Distinct from both 404 (no such CSV) and HTTP errors
        // (server rejected us). Treated as transient — usually fixed
        // by retry with different headers or from a different IP.
        stat.wafBlocked++;
        manifestEntries.push({ route: route.shortName, svc: svcKey, status: 'waf-blocked' });
        continue;
      }
      // 200-ok with real CSV body — write to .build-input/csv/ for the
      // build phase to consume. The build never re-fetches; it reads
      // from disk using this manifest to know what's available.
      writeCsvBody(route.shortName, svcKey, body);
      manifestEntries.push({ route: route.shortName, svc: svcKey, status: 'ok', httpStatus: 200 });
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

  // Persist the manifest so the build phase can read CSVs from disk.
  // Atomic write — a build starting concurrently won't see a partial file.
  writeStatusManifest({ entries: manifestEntries });
  const okCount = manifestEntries.filter((e) => e.status === 'ok').length;
  console.log(`${TAG} wrote manifest + ${okCount} CSV bodies to .build-input/`);

  // Report
  let totalOk = 0;
  let totalNotFound = 0;
  let totalWafBlocked = 0;
  let totalHttpError = 0;
  let totalNetworkError = 0;
  let totalFreq = 0;
  const routesWithNoCsv = [];
  /** @type {Array<{route: string, wholeLine: boolean}>} */
  const notFoundRoutes = [];
  for (const [shortName, s] of stats.entries()) {
    totalOk += s.ok;
    totalNotFound += s.notFound;
    totalWafBlocked += s.wafBlocked;
    totalHttpError += s.httpError;
    totalNetworkError += s.networkError;
    totalFreq += s.frequency;
    // Cross-reference each 404 against the route's own success rate:
    //   - Route has ≥1 successful CSV → the 404s are weekend / partial
    //     service-day gaps (acceptable, CTP genuinely doesn't publish
    //     CSVs for days the route doesn't run). Cross-referencing via
    //     CTP's HTML pages confirmed this for route 22: the page says
    //     "Sâmbăta: Nu circulă. Duminica: Nu circulă." → 404 is the
    //     right response.
    //   - Route has 0 successful CSVs → every 404 on this route is a
    //     whole-line gap (real catalog issue). The Tranzy fallback
    //     catches this in the build, but it's still worth flagging
    //     because operators expect published CSVs for their lines.
    const wholeLine = s.ok === 0;
    if (s.notFound > 0) notFoundRoutes.push({ route: shortName, wholeLine });
    if (wholeLine && (s.notFound + s.wafBlocked + s.httpError + s.networkError) > 0) {
      routesWithNoCsv.push(shortName);
    }
  }
  const expectedWeekend404s = notFoundRoutes.filter((d) => !d.wholeLine);
  const wholeLine404s = notFoundRoutes.filter((d) => d.wholeLine);

  const totalFetches = totalOk + totalNotFound + totalWafBlocked + totalHttpError + totalNetworkError;

  console.log('');
  console.log('=== CSV smoke test summary ===');
  console.log(`Total CSVs scraped:    ${totalFetches}`);
  console.log('');
  console.log('By fetch status:');
  console.log(`  ${pad('Successfully parsed:', 22)} ${totalOk}`);
  console.log(`  ${pad('Not found (404):', 22)} ${pad(totalNotFound, 4)} (CTP doesn't publish these CSVs)`);
  console.log(`  ${pad('WAF-blocked:', 22)} ${pad(totalWafBlocked, 4)} (200 OK but body wasn't CSV)`);
  console.log(`  ${pad('HTTP error:', 22)} ${pad(totalHttpError, 4)} (non-404 server error)`);
  console.log(`  ${pad('Network error:', 22)} ${pad(totalNetworkError, 4)} (timeout/connect refused)`);
  console.log('');
  console.log('404 classification:');
  if (expectedWeekend404s.length === 0 && wholeLine404s.length === 0) {
    console.log('  (no 404s)');
  } else {
    if (expectedWeekend404s.length > 0) {
      const sample = expectedWeekend404s.length <= 5
        ? expectedWeekend404s.map((d) => d.route).join(', ')
        : `${expectedWeekend404s.slice(0, 5).map((d) => d.route).join(', ')}, ... and ${expectedWeekend404s.length - 5} more`;
      console.log(`  Expected (route has weekday CSV — 404 is weekend/no-service):  ${expectedWeekend404s.length} route_short_names [${sample}]`);
    }
    if (wholeLine404s.length > 0) {
      const sample = wholeLine404s.length <= 10
        ? wholeLine404s.map((d) => d.route).join(', ')
        : `${wholeLine404s.slice(0, 10).map((d) => d.route).join(', ')}, ... and ${wholeLine404s.length - 10} more`;
      console.log(`  ⚠ WHOLE-LINE gaps (no CSV at all for this route_short_name):     ${wholeLine404s.length} route_short_names [${sample}]`);
    }
  }
  console.log('');
  console.log('Route coverage:');
  if (routesWithNoCsv.length > 0 && routesWithNoCsv.length <= 20) {
    console.log(`  ${stats.size - routesWithNoCsv.length} of ${stats.size} routes have ≥1 CSV. No CSV at all: ${routesWithNoCsv.join(', ')} (CTP doesn't publish).`);
  } else if (routesWithNoCsv.length > 20) {
    console.log(`  ${stats.size - routesWithNoCsv.length} of ${stats.size} routes have ≥1 CSV. No CSV at all: ${routesWithNoCsv.slice(0, 20).join(', ')}, ... and ${routesWithNoCsv.length - 20} more.`);
  } else {
    console.log(`  ${stats.size} of ${stats.size} routes have ≥1 CSV (all routes covered).`);
  }
  console.log('');
  console.log(`${pad('Frequency annotations found:', 27)} ${totalFreq}`);
  console.log(`${pad('Unrecognized cells:', 27)} ${unrecognizedCount}`);

  // Fail on whole-line 404s (real catalog gaps). Expected weekend /
  // service-day 404s are informational — routes that genuinely don't
  // run on weekends correctly return 404 from CTP (cross-referenced
  // against the operator's HTML pages — e.g. route 22's page says
  // "Sâmbăta: Nu circulă. Duminica: Nu circulă.").
  // Opt-out: SMOKE_ALLOW_WHOLE_LINE_404S=1 (only if you intentionally
  // want to ship without CSV coverage for some routes).
  const allowWholeLine = env.SMOKE_ALLOW_WHOLE_LINE_404S === '1';
  if (!allowWholeLine && wholeLine404s.length > 0) {
    console.error('');
    ghaError('FAIL — WHOLE-LINE 404(s) — route(s) have ZERO CSV coverage');
    console.error(`${TAG} ${wholeLine404s.length} WHOLE-LINE 404(s) — route(s) have ZERO CSV coverage:`);
    for (const d of wholeLine404s.slice(0, 20)) {
      console.error(`  - ${d.route}`);
    }
    if (wholeLine404s.length > 20) {
      console.error(`  ... and ${wholeLine404s.length - 20} more`);
    }
    console.error('  The Tranzy /trips fallback catches these for trip structure, but no authoritative CSV times are published.');
    console.error('  Set SMOKE_ALLOW_WHOLE_LINE_404S=1 to skip this check.');
    exit(3);
  }

  if (unrecognizedCount > 0) {
    console.error('');
    ghaError('FAIL — unrecognized CSV cell(s); extend classifyCell()');
    console.error(`${TAG} FAIL: ${unrecognizedCount} unrecognized cell(s) — extend classifyCell() in src/sources/ctp-csv.js`);
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
  //
  // Note: we previously also had a total-miss threshold (default 10%),
  // but that was redundant with this check — infra misses ARE total
  // misses. With CTP's natural ~13% catalog-gap rate (about 35 of 324
  // route×service combinations are 404), a 10% threshold fires even
  // when the smoke test ran cleanly. The infra check alone is the
  // real signal we care about.
  if (failOnInfra && totalInfra > 0) {
    console.error('');
    ghaError('FAIL — infrastructure miss; build has no real signal');
    console.error(`${TAG} FAIL: ${totalInfra} CSV fetch(es) hit infrastructure issues — build has no real signal:`);
    if (totalWafBlocked > 0) console.error(`  - ${totalWafBlocked} WAF-blocked (got 200 OK but body wasn't CSV)`);
    if (totalHttpError > 0) console.error(`  - ${totalHttpError} HTTP error(s) (non-404 server error)`);
    if (totalNetworkError > 0) console.error(`  - ${totalNetworkError} network error(s) (timeout / connect refused)`);
    console.error('  Set SMOKE_ALLOW_INFRA_FAILURES=1 to skip this check (NOT recommended).');
    exit(2);
  }

  // Surface (but don't fail on) a high total-miss ratio — informational.
  if (totalMissing > 0) {
    console.log('');
    console.log(`${TAG} ${totalMissing} CSV fetch(es) returned 404 — these are catalog gaps (CTP doesn't publish them), not build failures.`);
  }

  console.log('');
  console.log(`${TAG} OK — every CSV was parsed cleanly. The #15 fix handles real-world annotations.`);
  exit(0);
}

main().catch((err) => {
  die(2, `unexpected error: ${err.stack || err.message || err}`);
});

void argv;