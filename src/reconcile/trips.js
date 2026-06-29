/**
 * Trips + stop_times reconciliation.
 *
 * For each CSV departure `HH:MM` on a `(route, dir, service)` pattern:
 *   1. Resolve the pattern (seed → Tranzy → null; see `patterns.js`)
 *   2. Generate a canonical CTP-format trip_id
 *   3. Emit trips.txt row
 *   4. For each stop in the pattern, call `computeStopTimes()` to get
 *      arrival/departure seconds, then emit stop_times.txt row.
 *
 * Trip ID format (canonical CTP — matches `cluj-rt-feed.gtfs.ro`):
 *   `${route_id}_${dir}_${serviceId}_${seq}_${HHMMDigits}`
 *   e.g. `45_1_LV_9_0721`  (route 45, dir 1, LV service, 9th departure, 07:21)
 */

import { computeStopTimes } from '../lib/timing.js';

const DEFAULT_TIMING = {
  speedKmh: { peak: 14, offpeak: 22, night: 28 },
  peakWindows: [
    { from: '07:00', to: '09:30' },
    { from: '16:00', to: '19:00' },
  ],
  nightWindow: { from: '22:30', to: '05:30' },
  intermediateDwellSec: 20,
};

/**
 * @param {{
 *   byRouteService: Map<string, Map<string, {
 *     departures: { dir0: string[], dir1: string[] },
 *     inStopName: string,
 *     outStopName: string,
 *     routeLongName: string,
 *     warnings: any[],
 *   }>>,
 *   routesByRouteId: Map<string, { route_id, route_short_name, route_long_name, ... }>,
 *   stopsByStopId: Map<string, { stop_id, stop_lat, stop_lon, stop_name }>,
 *   seedPatterns: Map<string, { stops, shapeId, headsign, source }>,
 *   tranzyPatterns: Map<string, { stops, shapeId, headsign, source }>,
 *   shapesById: Map<string, Array<{lat, lon}>>,
 *   warnings: string[],
 *   timing?: typeof DEFAULT_TIMING,
 * }} input
 * @returns {{
 *   tripRows: Array<{route_id, service_id, trip_id, trip_headsign, direction_id, shape_id}>,
 *   stopTimeRows: Array<{trip_id, arrival_time, departure_time, stop_id, stop_sequence, shape_dist_traveled}>,
 *   tripDiagnostics: Array<{route_id, direction_id, service_id, count, bucket, speed_kmh}>,
 * }}
 */
export function reconcileTripsAndStopTimes(input) {
  const timing = input.timing ?? DEFAULT_TIMING;
  const tripRows = [];
  const stopTimeRows = [];
  const tripDiagnostics = [];
  /** @type {string[]} */
  const localWarnings = [];

  for (const [routeShortName, byService] of input.byRouteService.entries()) {
    // Find the route row matching this short name (CSV uses short name; rows use route_id).
    const routeRow = findRouteByShortName(input.routesByRouteId, routeShortName);
    if (!routeRow) {
      localWarnings.push(`CSV for ${routeShortName} but no route in seed/Tranzy; skipping`);
      continue;
    }
    const routeId = routeRow.route_id;

    for (const [serviceId, csv] of byService.entries()) {
      const dirs = [
        { dir: 0, departures: csv.departures.dir0, csvHeadsign: csv.outStopName },
        { dir: 1, departures: csv.departures.dir1, csvHeadsign: csv.inStopName },
      ];
      for (const { dir, departures, csvHeadsign } of dirs) {
        if (!departures || departures.length === 0) continue;
        const key = `${routeId}|${dir}`;
        const seedPattern = input.seedPatterns.get(key);
        const tranzyPattern = input.tranzyPatterns.get(key);
        const pattern = seedPattern ?? tranzyPattern;
        if (!pattern || pattern.stops.length === 0) {
          localWarnings.push(`No pattern for ${routeShortName} (${routeId}) dir=${dir} — dropping ${departures.length} departures`);
          continue;
        }
        const orderedStops = pattern.stops
          .map((s) => {
            const stop = input.stopsByStopId.get(s.stopId);
            if (!stop) return null;
            const lat = parseFloat(stop.stop_lat);
            const lon = parseFloat(stop.stop_lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            // Preserve the source's stop_sequence — it's the authoritative
            // value from the upstream GTFS source (Transitous seed or
            // Tranzy). Re-numbering with a sequential index would discard
            // any non-contiguous numbering the operator uses (e.g. gaps
            // for dwell-only stops, odd-numbered extras).
            return { stopId: stop.stop_id, sequence: s.sequence, lat, lon, name: stop.stop_name };
          })
          .filter(Boolean);
        if (orderedStops.length === 0) {
          localWarnings.push(`All stops for ${routeShortName} dir=${dir} missing coords; dropping`);
          continue;
        }

        // Validate CSV terminal-name label against the resolved pattern's
        // last stop. This is purely a NAMING consistency check — the
        // trip direction itself is determined by the CSV column index
        // (col 0 = dir 0, col 1 = dir 1), which never changes based on
        // this label. A mismatch here means CTP's CSV uses a shorter /
        // different spelling than the catalog (e.g. "P-ta Garii" vs
        // "P-ța Gării Nord") — same physical stop, different label.
        // We don't trust the CSV's terminal name as a headsign
        // fallback in that case, but the trip times stay with their
        // column-index-assigned direction.
        const expectedTerminalName = orderedStops[orderedStops.length - 1]?.name ?? null;
        const csvTerminalName = dir === 0 ? csv.outStopName : csv.inStopName;
        const csvTerminalTrustable = terminalNamesMatch(expectedTerminalName, csvTerminalName);
        if (!csvTerminalTrustable) {
          localWarnings.push(
            `CSV terminal label mismatch: ${routeShortName} dir=${dir} — ` +
            `pattern last stop is "${expectedTerminalName}", CSV header says "${csvTerminalName}". ` +
            `Skipping CSV terminal name as headsign fallback (likely a naming variant, not a direction issue).`,
          );
        }

        const shape = (pattern.shapeId && input.shapesById.get(pattern.shapeId)) || [];

        const headsign = pattern.headsign
          || (csvTerminalTrustable ? csvHeadsign : null)
          || routeRow.route_long_name
          || routeShortName;

        for (let i = 0; i < departures.length; i++) {
          const depTime = departures[i];
          const tripId = makeTripId(routeId, dir, serviceId, depTime);
          const shapeId = pattern.shapeId || `${routeId}_${dir}`;
          tripRows.push({
            route_id: routeId,
            service_id: serviceId,
            trip_id: tripId,
            trip_headsign: headsign,
            direction_id: String(dir),
            shape_id: shapeId,
          });

          const startSec = hhmmToSeconds(depTime);
          const { arrivals, departures: stopDeps, shapeDistTraveledM, bucket, speedKmh } = computeStopTimes({
            startSec,
            stops: orderedStops,
            shape,
            timing,
          });
          for (let k = 0; k < orderedStops.length; k++) {
            stopTimeRows.push({
              trip_id: tripId,
              arrival_time: formatGtfsTime(arrivals[k]),
              departure_time: formatGtfsTime(stopDeps[k]),
              stop_id: orderedStops[k].stopId,
              // Use the upstream source's stop_sequence (Transitous
              // seed or Tranzy) — not a re-numbered index. See comment
              // on orderedStops above.
              stop_sequence: String(orderedStops[k].sequence ?? k),
              shape_dist_traveled: shapeDistTraveledM[k] != null ? String(shapeDistTraveledM[k]) : '',
            });
          }

          if (i === 0) {
            tripDiagnostics.push({
              route_id: routeId,
              direction_id: dir,
              service_id: serviceId,
              count: departures.length,
              bucket,
              speed_kmh: speedKmh,
              pattern_source: pattern.source ?? 'seed',
            });
          }
        }
      }
    }
  }

  input.warnings.push(...localWarnings);
  return { tripRows, stopTimeRows, tripDiagnostics };
}

function findRouteByShortName(routesByRouteId, shortName) {
  for (const r of routesByRouteId.values()) {
    if (r.route_short_name === shortName) return r;
  }
  return null;
}

/**
 * Trip ID for this adapter's static feed.
 *
 * Format: `${routeId}_${dir}_${serviceId}_${HHMM}` — e.g. `M26_0_LV_0721`.
 *
 * Why this format (and why NOT the full `route_dir_service_run_HHMM`):
 *
 *   - **The reconciler in `neary` does NOT use trip_id for the JOIN.**
 *     `neary/src/lib/domain/reconcile.ts` matches live observations to
 *     scheduled trips by `(routeId, directionId, tripStartMin)` with
 *     adaptive tolerance — explicitly noting that static and GTFS-RT
 *     trip_ids drift ~23% of the time because Transitous, Tranzy, and
 *     the GTFS-RT feed each generate trip_ids from independent
 *     dispatch databases. See that file's header comment for context.
 *
 *   - **Neary's `parseLiveStartMin` does extract HHMM from trip_id
 *     tails** as a fallback when `TripDescriptor.start_time` is
 *     missing — `_(\d{3,4})$` regex on the suffix. So our static
 *     trip_ids ending in `_HHMM` lets neary's fallback work if it
 *     ever runs against our zip directly. The HHMM tail is the only
 *     structural requirement we have to satisfy.
 *
 *   - **Neary's `resolveDirectionId` parses direction from RT trip_ids**
 *     via `/^\d+_(\d)_/`. Our static trip_ids DON'T need to satisfy
 *     this — neary doesn't try to extract direction from static IDs.
 *
 *   - **No "matches cluj-rt-feed" claim.** The RT feed uses Tranzy's
 *     internal route_ids (e.g. `45` for route 45, `92` for M26) while
 *     our static feed uses Transitous's IDs (the same `45` for route
 *     45, but `M26` for M26). So even the same trip will have a
 *     different prefix in static vs RT — by design.
 *
 * The `${seq}` (run number) we used to include was never consumed by
 * anyone — dropped to keep trip_ids short and readable.
 *
 * @param {string} routeId
 * @param {number} dir
 * @param {string} serviceId
 * @param {string} depTime  "HH:MM" or "HH:MM:SS" or "HH+24:MM"
 */
export function makeTripId(routeId, dir, serviceId, depTime) {
  // depTime is "HH:MM" or "HH:MM:SS" (possibly "HH+24:MM" from post-midnight
  // wrap). Strip colons; strip the "+24" infix so 25:30 doesn't double up.
  const hhmm = depTime.replace(':', '').replace('+24', '');
  return `${routeId}_${dir}_${serviceId}_${hhmm}`;
}

function hhmmToSeconds(hhmm) {
  const parts = hhmm.split(':').map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  return h * 3600 + m * 60;
}

/**
 * Loose terminal-name match for CSV direction validation.
 *
 * CTP's CSV terminal names sometimes differ in casing, punctuation, or
 * a trailing "Statie"/"Piața" vs the seed's "Stația"/"Piața". We
 * normalize both to lowercase + digits only, then exact-match.
 *
 * Returns `true` when at least one side is empty (can't validate either
 * way — caller should treat the CSV terminal as "trustable enough").
 */
function terminalNamesMatch(a, b) {
  if (!a || !b) return true;
  // Normalize: lowercase + strip diacritics + keep only word characters.
  // Handles the common CTP catalog mismatch where the CSV uses a
  // shorter form ("P-ta Garii") and the catalog has the full form
  // ("P-ța Gării Nord") — same physical stop, different precision.
  const norm = (s) => s.toString().toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș/g, 's').replace(/ț/g, 't')
    .replace(/[^a-z0-9]/g, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return true; // empty after norm — treat as trustable
  if (na === nb) return true;
  // One contains the other (e.g. "ptagarii" ⊂ "ptagariinord").
  if (na.includes(nb) || nb.includes(na)) return true;
  // Share at least one significant token (≥ 4 chars). Catches
  // abbreviations like "Taberei" / "Statia Taberei" or
  // "Cluj-Napoca" / "Cluj Napoca".
  const tokensA = new Set(na.match(/.{4,}/g) ?? []);
  const tokensB = nb.match(/.{4,}/g) ?? [];
  for (const t of tokensB) {
    if (tokensA.has(t)) return true;
  }
  return false;
}

function formatGtfsTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function tripsToTxt(tripRows) {
  const headers = ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'trip_short_name', 'direction_id', 'block_id', 'shape_id', 'wheelchair_accessible', 'bikes_allowed'];
  const lines = [headers.join(',')];
  for (const t of tripRows) {
    lines.push([
      csvField(t.route_id),
      csvField(t.service_id),
      csvField(t.trip_id),
      csvField(t.trip_headsign),
      '', // trip_short_name
      csvField(t.direction_id),
      '', // block_id
      csvField(t.shape_id),
      '', // wheelchair_accessible
      '', // bikes_allowed
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

export function stopTimesToTxt(stopTimeRows) {
  const headers = ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'stop_headsign', 'pickup_type', 'drop_off_type', 'continuous_pickup', 'continuous_drop_off', 'shape_dist_traveled', 'timepoint'];
  const lines = [headers.join(',')];
  for (const s of stopTimeRows) {
    lines.push([
      csvField(s.trip_id),
      csvField(s.arrival_time),
      csvField(s.departure_time),
      csvField(s.stop_id),
      csvField(s.stop_sequence),
      '', // stop_headsign
      '', '', '', '',
      csvField(s.shape_dist_traveled),
      // timepoint: 0 = approximate/interpolated. Our per-stop arrival
      // and departure times come from computeStopTimes() which projects
      // the CSV's origin departure across the shape using peak/offpeak/
      // night speed buckets — they're synthesized, not authoritative.
      // Per GTFS spec, this is the canonical use case for timepoint=0.
      // See https://gtfs.org/schedule/reference/#stop_timestxt
      '0',
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

function csvField(v) {
  const s = (v ?? '').toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}