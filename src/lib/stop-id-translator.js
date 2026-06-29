/**
 * Transitous → Tranzy stop_id translation.
 *
 * The two sources use **different `stop_id` namespaces** for the same
 * physical stops:
 *   - Tranzy uses small numeric IDs (1, 2, 3, ...)
 *   - Transitous uses larger numeric IDs (247, 248, 215, ...)
 *
 * Since Tranzy is the primary catalog (per `docs/reconciliation-rules.md`),
 * `byStopId` is keyed by Tranzy's stop_ids. But Transitous's patterns
 * (`seedPatternsByRouteDir`) reference stops by Transitous's stop_ids.
 * Without translation, the pattern → orderedStops lookup in trips.js
 * silently misses for every trip and the CSV-driven output collapses
 * to ~342 trips instead of ~14,000.
 *
 * Match strategy:
 *   1. Normalize stop names (lowercase, strip diacritics + punctuation)
 *      and group both sources by normalized name.
 *   2. For each Transitous stop, find the Tranzy stop with the same
 *      normalized name AND a coordinate distance under `MAX_MATCH_M`.
 *   3. If multiple matches, pick the closest. If zero matches, leave
 *      unmapped (the Transitous stop is likely Tranzy-omitted).
 *
 * Heuristic thresholds (tunable):
 *   - MAX_MATCH_M = 50 — generous enough to catch stops that have been
 *     moved a few meters between snapshots of the operator's data.
 *   - NORMALIZE_STRIP_RE = non-word chars (keep letters + digits only)
 */

/**
 * Max coordinate distance (meters) for a Transitous→Tranzy stop match.
 * Larger than the typical GPS jitter but small enough to exclude the
 * "same name, different platform" cases.
 */
const MAX_MATCH_M = 50;

/** Normalize a stop name for fuzzy grouping. */
function normalizeName(s) {
  return (s ?? '').toString().toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș/g, 's').replace(/ț/g, 't')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Haversine distance in meters. */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Build a Map<transitousStopId, tranzyStopId> for the stops that
 * Transitous and Tranzy both publish under different ids. Stops that
 * one source omits (e.g. Tranzy-only newer metropolitan stops,
 * Transitous-only legacy stops) are unmapped.
 *
 * @param {Array<{stop_id, stop_name, stop_lat, stop_lon}>} tranzyStops
 * @param {Array<{stopId, name, lat, lon}>} transitousStops
 * @returns {Map<string, string>}
 */
export function buildTransitousToTranzyMap(tranzyStops, transitousStops) {
  const map = new Map();
  if (!Array.isArray(tranzyStops) || !Array.isArray(transitousStops)) return map;

  // Bucket Tranzy by normalized name for O(1) candidate lookup.
  const tranzyByName = new Map();
  for (const ts of tranzyStops) {
    const name = normalizeName(ts.stop_name);
    if (!name) continue;
    const lat = parseFloat(ts.stop_lat);
    const lon = parseFloat(ts.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!tranzyByName.has(name)) tranzyByName.set(name, []);
    tranzyByName.get(name).push({ id: String(ts.stop_id), lat, lon });
  }

  for (const xs of transitousStops) {
    const name = normalizeName(xs.name);
    if (!name) continue;
    const lat = parseFloat(xs.lat);
    const lon = parseFloat(xs.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const candidates = tranzyByName.get(name);
    if (!candidates || candidates.length === 0) continue;
    let best = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const d = haversineMeters(lat, lon, c.lat, c.lon);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    if (best && bestD <= MAX_MATCH_M) {
      map.set(String(xs.stopId), best.id);
    }
  }
  return map;
}