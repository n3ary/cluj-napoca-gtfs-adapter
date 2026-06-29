/**
 * CTP CSV timetable fetcher + parser.
 *
 * Scrapes `ctpcj.ro/orare/csv/orar_<routeShortName>_<serviceKey>.csv`
 * for every route × service combination. Returns a normalized
 * `Map<routeShortName, Map<serviceId, CtpCsvSchedule>>`.
 *
 * Ported from `neary-gtfs/feeds/cluj-napoca/build.js` (the `fetchCsv`
 * + `parseCtpCsv` + `fixPostMidnight` trio). Same WAF headers, same
 * sanity check (`startsWith('route_long_name,')`), same post-midnight
 * wrap fix. Adds explicit `warnings[]` per dropped non-HH:MM cell to
 * surface `neary-gtfs#15` (M26 frequency annotations).
 */

import { USER_AGENT } from '../lib/seed.js';

const DEFAULT_BASE_URL = 'https://ctpcj.ro/orare/csv/orar_{routeShortName}_{serviceId}.csv';

// ctpcj.ro's WAF treats default Node fetch headers as suspicious.
// These are the minimal set that produces clean CSV responses.
// (Verified 2026-06-29.)
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

const DEFAULT_SERVICE_KEYS = ['lv', 's', 'd'];
const DEFAULT_SERVICE_ID_MAP = { lv: 'LV', s: 'S', d: 'D' };

/**
 * @typedef {{
 *   routeLongName: string,
 *   serviceName: string,
 *   serviceStart: string,
 *   inStopName: string,
 *   outStopName: string,
 *   departures: { dir0: string[], dir1: string[] },
 *   frequencyAnnotations: {
 *     dir0: { ranges: Array<{start: string, end: string}>, headways: Array<{minSec: number, maxSec: number|null, avgSec: number}> },
 *     dir1: { ranges: Array<{start: string, end: string}>, headways: Array<{minSec: number, maxSec: number|null, avgSec: number}> },
 *   },
 *   warnings: Array<{row: number, col: number, value: string, reason: string}>,
 * }} CtpCsvSchedule
 */

/**
 * @param {string} text  raw CSV body
 * @returns {CtpCsvSchedule | null}
 */
export function parseCtpCsv(text) {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter((l) => l);
  if (lines.length < 6) return null;
  const routeLongName = lines[0].split(',').slice(1).join(',').replace(/"/g, '');
  const serviceName = lines[1].split(',').slice(1).join(',').replace(/"/g, '');
  const serviceStart = lines[2].split(',').slice(1).join(',').replace(/"/g, '');
  const inStopName = lines[3].split(',').slice(1).join(',').replace(/"/g, '');
  const outStopName = lines[4].split(',').slice(1).join(',').replace(/"/g, '');

  /** @type {{dir0: string[], dir1: string[]}} */
  const departures = { dir0: [], dir1: [] };
  const frequencyAnnotations = {
    dir0: { ranges: [], headways: [] },
    dir1: { ranges: [], headways: [] },
  };
  /** @type {Array<{row: number, col: number, value: string, reason: string}>} */
  const warnings = [];

  for (let i = 5; i < lines.length; i++) {
    const parts = lines[i].split(',').map((p) => p.trim());
    for (const [colIdx, colKey] of [[0, 'dir0'], [1, 'dir1']]) {
      const cell = parts[colIdx];
      if (!cell) continue;
      const cls = classifyCell(cell);
      if (cls.type === 'time') {
        departures[colKey].push(cls.value);
      } else if (cls.type === 'range') {
        frequencyAnnotations[colKey].ranges.push({ start: cls.start, end: cls.end });
      } else if (cls.type === 'headway') {
        frequencyAnnotations[colKey].headways.push({
          minSec: cls.minSec,
          maxSec: cls.maxSec,
          avgSec: cls.avgSec,
        });
      } else {
        warnings.push({
          row: i,
          col: colIdx,
          value: cell,
          reason: 'unrecognized cell format (neither HH:MM, range, nor headway)',
        });
      }
    }
  }
  fixPostMidnight(departures.dir0);
  fixPostMidnight(departures.dir1);
  return {
    routeLongName, serviceName, serviceStart,
    inStopName, outStopName, departures, frequencyAnnotations, warnings,
  };
}

/**
 * Classify a single CSV cell value.
 * @param {string} value
 * @returns {{type: 'time', value: string}
 *           | {type: 'range', start: string, end: string}
 *           | {type: 'headway', minSec: number, maxSec: number|null, avgSec: number}
 *           | {type: 'unknown'}}
 */
export function classifyCell(value) {
  // Specific time: HH:MM
  if (/^\d{1,2}:\d{2}$/.test(value)) {
    return { type: 'time', value };
  }
  // Range: HH:MM-HH:MM  (e.g. "05:05-22:40")
  const rangeMatch = value.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (rangeMatch) {
    return { type: 'range', start: rangeMatch[1], end: rangeMatch[2] };
  }
  // Headway with range: "10-20min", "5min", "30-40min", "10-20"
  const rangeMinMatch = value.match(/^(\d{1,2})-(\d{1,2})min$/);
  if (rangeMinMatch) {
    const lo = parseInt(rangeMinMatch[1], 10);
    const hi = parseInt(rangeMinMatch[2], 10);
    return { type: 'headway', minSec: lo * 60, maxSec: hi * 60, avgSec: Math.round((lo + hi) / 2 * 60) };
  }
  const singleMinMatch = value.match(/^(\d{1,2})min$/);
  if (singleMinMatch) {
    const lo = parseInt(singleMinMatch[1], 10);
    return { type: 'headway', minSec: lo * 60, maxSec: null, avgSec: lo * 60 };
  }
  const rangeNoUnit = value.match(/^(\d{1,2})-(\d{1,2})$/);
  if (rangeNoUnit) {
    const lo = parseInt(rangeNoUnit[1], 10);
    const hi = parseInt(rangeNoUnit[2], 10);
    // Plausibility guard: minutes go up to ~120. Anything above is suspicious.
    if (lo <= 120 && hi <= 120 && lo < hi) {
      return { type: 'headway', minSec: lo * 60, maxSec: hi * 60, avgSec: Math.round((lo + hi) / 2 * 60) };
    }
  }
  return { type: 'unknown' };
}

/**
 * Rewrite post-midnight times as HH+24 so they're monotonically
 * increasing within a single service day.
 *
 * Two cases:
 *   - Sequence has at least one late-evening time (>= 20:00) and a
 *     subsequent jump back: wrap the post-midnight entries.
 *     e.g. `[..., 23:55, 00:20, 00:45]` → `[..., 23:55, 24:20, 24:45]`
 *   - Entire sequence is early morning (max < 04:00): assume all entries
 *     are post-midnight of the previous day, wrap them all.
 *     e.g. `[00:20, 00:45]` → `[24:20, 24:45]`
 *
 * The `prevMinutes > 20 * 60` (20:00) guard in the first case prevents
 * the wrap from triggering when the operator genuinely has a backwards
 * jump in the schedule (rare but possible — early-morning routes with
 * intentional ordering changes).
 */
function fixPostMidnight(times) {
  if (times.length === 0) return;
  // Find the max time. If it's in the early morning (< 04:00), the entire
  // list is post-midnight.
  let maxMin = -1;
  for (const t of times) {
    const [h, m] = t.split(':').map(Number);
    const min = h * 60 + m;
    if (min > maxMin) maxMin = min;
  }
  if (maxMin < 4 * 60) {
    for (let i = 0; i < times.length; i++) {
      const [h, m] = times[i].split(':').map(Number);
      times[i] = `${h + 24}:${String(m).padStart(2, '0')}`;
    }
    return;
  }
  // Otherwise, wrap any backward jump from a late-evening time.
  let prevMinutes = -1;
  for (let i = 0; i < times.length; i++) {
    const [h, m] = times[i].split(':').map(Number);
    const minutes = h * 60 + m;
    if (minutes < prevMinutes && prevMinutes > 20 * 60) {
      times[i] = `${h + 24}:${String(m).padStart(2, '0')}`;
    }
    const [effH, effM] = times[i].split(':').map(Number);
    prevMinutes = effH * 60 + effM;
  }
}

/**
 * Fetch + parse one CSV.
 *
 * @param {string} routeShortName
 * @param {string} serviceKey
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetch]
 * @returns {Promise<CtpCsvSchedule | null>}
 */
export async function fetchCtpCsv(routeShortName, serviceKey, opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = baseUrl
    .replace('{routeShortName}', encodeURIComponent(routeShortName))
    .replace('{serviceId}', encodeURIComponent(serviceKey));
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { ...WAF_HEADERS, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.warn(`[ctp-csv] ${routeShortName}_${serviceKey}: ${err.message || err}`);
    return null;
  }
  if (!res.ok) {
    if (res.status !== 404) console.warn(`[ctp-csv] ${routeShortName}_${serviceKey}: HTTP ${res.status}`);
    return null;
  }
  const body = await res.text();
  // Sanity check: real CSV always starts with "route_long_name,". Anything
  // else (WAF challenge page, captcha HTML, etc.) is a soft failure.
  if (!body.startsWith('route_long_name,')) {
    console.warn(`[ctp-csv] ${routeShortName}_${serviceKey}: not CSV (got ${body.length}B starting "${body.slice(0, 40).replace(/\s+/g, ' ')}…")`);
    return null;
  }
  return parseCtpCsv(body);
}

/**
 * Fetch all (route, service) CSVs in parallel with bounded concurrency.
 *
 * @param {Array<{shortName: string}>} routes
 * @param {object} [opts]
 */
export async function fetchAllCsvSchedules(routes, opts = {}) {
  const serviceKeys = opts.serviceKeys ?? DEFAULT_SERVICE_KEYS;
  const serviceIdMap = opts.serviceIdMap ?? DEFAULT_SERVICE_ID_MAP;
  const concurrency = opts.concurrency ?? 4;

  /** @type {Array<() => Promise<void>>} */
  const tasks = [];
  /** @type {Map<string, Map<string, CtpCsvSchedule>>} */
  const byRouteService = new Map();
  /** @type {string[]} */
  const warnings = [];

  for (const route of routes) {
    for (const svcKey of serviceKeys) {
      const shortName = route.shortName;
      const serviceId = serviceIdMap[svcKey] ?? svcKey.toUpperCase();
      // Wrap in a function so the fetch only starts when the worker dequeues
      // it — otherwise all tasks would kick off concurrently before the
      // concurrency cap could bite.
      tasks.push(async () => {
        const parsed = await fetchCtpCsv(shortName, svcKey, opts);
        if (!parsed) {
          warnings.push(`CSV missing: ${shortName}_${svcKey}`);
          return;
        }
        if (!byRouteService.has(shortName)) byRouteService.set(shortName, new Map());
        byRouteService.get(shortName).set(serviceId, parsed);
      });
    }
  }

  // Bounded-concurrency runner.
  const queue = tasks.slice();
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (task) await task();
      }
    },
  );
  await Promise.all(workers);

  return { byRouteService, warnings };
}

export const CSV_BASE_URL = DEFAULT_BASE_URL;
export const CSV_SERVICE_KEYS = DEFAULT_SERVICE_KEYS;
export const CSV_SERVICE_ID_MAP = DEFAULT_SERVICE_ID_MAP;