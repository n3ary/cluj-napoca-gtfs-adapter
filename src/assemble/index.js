/**
 * Assembler orchestrator. Pulls the three sources together into the
 * final in-memory GTFS structure, ready for the zip writer.
 *
 * Pipeline:
 *   1. seedPatterns  (src/sources/transitous/index.js)
 *   2. tranzyPatterns (this module's Tranzy-pattern extraction)
 *   3. routes        (src/assemble/merge/routes.js)
 *   4. stops         (src/assemble/merge/stops.js)
 *   5. shapes        (src/assemble/merge/shapes.js)
 *   6. trips+stop_times  (src/assemble/emit/trips.js)
 *   7. calendar      (src/assemble/derive/calendar.js)
 *   8. data quality  (src/assemble/check/data-quality.js)
 *
 * Returns everything the zip writer needs in `src/gtfs.js`.
 */

import { reconcileRoutes, routesToTxt } from './merge/routes.js';
import { reconcileStops, stopsToTxt } from './merge/stops.js';
import { reconcileShapes, shapesToTxt } from './merge/shapes.js';
import { reconcileTripsAndStopTimes, tripsToTxt, stopTimesToTxt } from './emit/trips.js';
import { reconcileFrequencies, frequenciesToTxt } from './derive/frequencies.js';
import { reconcileCalendar, calendarToTxt } from './derive/calendar.js';
import { runDataQualityChecks } from './check/data-quality.js';
import { tranzyPatternsByRouteDir, seedPatternsByRouteDir } from './derive/patterns.js';
import { reconcileTranzyFallback } from './emit/tranzy-fallback.js';
import { warnMsg } from '../lib/log-severity.js';

/**
 * @param {{
 *   seed: { agencyTxt: string, routes: any[], stops: any[], trips: any[], stopTimes: Map<string, any>, shapesById: Map<string, any> },
 *   tranzy: { routes: any[], stops: any[], trips: any[], shapes: any[], stop_times: any[] } | null,
 *   csv: { byRouteService: Map<string, Map<string, any>>, warnings: string[] },
 *   options?: { calendarDays?: number, buildDate?: Date, timing?: object },
 * }} input
 * @returns {{
 *   files: {
 *     'agency.txt': string,
 *     'routes.txt': string,
 *     'stops.txt': string,
 *     'shapes.txt': string,
 *     'trips.txt': string,
 *     'stop_times.txt': string,
 *     'calendar.txt': string,
 *     'feed_info.txt': string,
 *   },
 *   warnings: string[],
 *   stats: object,
 * }}
 */
export function reconcile({ seed, tranzy, csv, options = {} }) {
  const warnings = [];

  const { routes, byRouteId: routesByRouteId } = reconcileRoutes({ seed, tranzy, warnings });
  const { stops, byStopId: stopsByStopId, transitousToTranzy } = reconcileStops({ seed, tranzy, warnings });
  const { shapesById, rows: shapeRows } = reconcileShapes({ seed, tranzy, warnings });
  const seedPatterns = extractSeedPatterns(seed);
  const tranzyPatterns = tranzyPatternsByRouteDir(tranzy);
  const { tripRows, stopTimeRows, tripDiagnostics } = reconcileTripsAndStopTimes({
    byRouteService: csv.byRouteService,
    routesByRouteId,
    stopsByStopId,
    transitousToTranzy,
    seedPatterns,
    tranzyPatterns,
    shapesById,
    warnings,
    timing: options.timing,
  });

  // Frequencies — implements #15 fix for CSV annotations like "05:05-22:40"
  // and "10-20min". Emits anchor trips + frequencies.txt rows.
  const {
    tripRows: freqTripRows,
    stopTimeRows: freqStopTimeRows,
    frequencyRows,
  } = reconcileFrequencies({
    byRouteService: csv.byRouteService,
    routesByRouteId,
    stopsByStopId,
    seedPatterns,
    tranzyPatterns,
    shapesById,
    warnings,
    timing: options.timing,
  });

  // Tranzy /trips fallback — for routes with no CSV coverage at all
  // (typically the 60 Tranzy-only metropolitan lines that CTP doesn't
  // publish CSVs for). Emits trip rows with empty times + timepoint=0
  // so consumers see "this route exists with these trips" instead of
  // "no service". See `src/assemble/emit/tranzy-fallback.js` for rationale.
  const { tripRows: fallbackTripRows, stopTimeRows: fallbackStopTimeRows } =
    reconcileTranzyFallback({
      tranzy,
      routesByRouteId,
      byRouteService: csv.byRouteService,
      stopsByStopId,
      warnings,
    });

  // Calendar: derive from service_ids we actually generated trips for.
  const serviceIds = new Set([
    ...tripRows.map((t) => t.service_id),
    ...fallbackTripRows.map((t) => t.service_id),
  ]);
  const { rows: calendarRows, unknownServiceIds } = reconcileCalendar({
    serviceIds,
    daysAhead: options.calendarDays ?? 180,
    buildDate: options.buildDate ?? new Date(),
  });
  if (unknownServiceIds.length > 0) {
    warnings.push(warnMsg(`Unknown service_ids encountered: ${unknownServiceIds.join(', ')}`));
  }
  // (Was: emitted unconditionally even when empty, leaving a trailing
  // colon in the build log. Now guarded by the length check above.)

  // Trip count per route (for data-quality check).
  const tripCountByRouteId = new Map();
  for (const t of tripRows) {
    tripCountByRouteId.set(t.route_id, (tripCountByRouteId.get(t.route_id) ?? 0) + 1);
  }

  // Data-quality checks.
  runDataQualityChecks({
    agencyTxt: seed.agencyTxt,
    routes,
    csvByRoute: csv.byRouteService,
    tripCountByRouteId,
    warnings,
  });

  const agencyTxt = ensureAgencyTimezone(seed.agencyTxt, options.timezone ?? 'Europe/Bucharest');
  const allTripRows = [...tripRows, ...freqTripRows, ...fallbackTripRows];
  const allStopTimeRows = [...stopTimeRows, ...freqStopTimeRows, ...fallbackStopTimeRows];
  const files = {
    'agency.txt': agencyTxt,
    'routes.txt': routesToTxt(routes),
    'stops.txt': stopsToTxt(stops),
    'shapes.txt': shapeRows.length === 0 ? '' : shapesToTxt(shapeRows),
    'trips.txt': tripsToTxt(allTripRows),
    'stop_times.txt': stopTimesToTxt(allStopTimeRows),
    'calendar.txt': calendarToTxt(calendarRows),
    'frequencies.txt': frequenciesToTxt(frequencyRows),
    'feed_info.txt': feedInfoTxt({
      buildDate: options.buildDate ?? new Date(),
      startDate: calendarRows[0]?.start_date,
      endDate: calendarRows[0]?.end_date,
    }),
  };

  // Drop empty optional files.
  for (const [k, v] of Object.entries(files)) {
    if (!v) delete files[k];
  }

  const stats = {
    routes: routes.length,
    stops: stops.length,
    shapes: shapeRows.length === 0 ? 0 : new Set(shapeRows.map((r) => r.shape_id)).size,
    trips: allTripRows.length,
    stopTimes: allStopTimeRows.length,
    frequencyAnchors: frequencyRows.length,
    calendarServices: calendarRows.length,
    tripDiagnostics,
  };

  return { files, warnings, stats };
}

function extractSeedPatterns(seed) {
  // Re-export the canonical seed-pattern builder from `patterns.js`
  // (single source of truth — see `src/assemble/derive/patterns.js
  // seedPatternsByRouteDir` for the implementation). Both this alias
  // and `patterns.js` use the same function so URL/option conventions
  // can't drift.
  return seedPatternsByRouteDir(seed);
}

function ensureAgencyTimezone(seedAgencyTxt, tz) {
  // If the seed has an agency_timezone column, override to our config value.
  // GTFS agency.txt header: agency_id,agency_name,agency_url,agency_timezone,...
  const lines = seedAgencyTxt.split(/\r?\n/);
  if (lines.length < 2) return seedAgencyTxt;
  const header = lines[0].split(',').map((h) => h.trim());
  const tzIdx = header.indexOf('agency_timezone');
  if (tzIdx === -1) return seedAgencyTxt;
  const dataLines = lines.slice(1).map((line) => {
    const cols = line.split(',');
    while (cols.length < header.length) cols.push('');
    cols[tzIdx] = tz;
    return cols.join(',');
  });
  return [lines[0], ...dataLines].join('\n');
}

function feedInfoTxt({ buildDate, startDate, endDate }) {
  const yyyymmdd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const version = yyyymmdd(buildDate);
  return [
    'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version',
    `cluj-napoca-gtfs-adapter,https://github.com/ciotlosm/cluj-napoca-gtfs-adapter,ro,${startDate ?? version},${endDate ?? version},${version}`,
  ].join('\n') + '\n';
}