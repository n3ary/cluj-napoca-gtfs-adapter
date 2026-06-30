/**
 * Route category classification + long_name cleanup.
 *
 * Single source of truth for which network each route belongs to and how
 * to clean up Tranzy's messy `route_long_name` into start-end format.
 * The classifier runs once at assemble time; consumers (neary) just read
 * the structured fields from `routes.txt` + `networks.txt` +
 * `route_networks.txt` and don't have to parse free-text signals.
 *
 * **Background**: see neary#125 for the design discussion. Briefly:
 *
 * - Tranzy exposes only basic route fields (no service-class column),
 *   so category info is buried as patterns in `route_short_name` (TE*,
 *   *N, *U, M*, CS, etc.) and trailing parentheticals in
 *   `route_long_name` / `route_desc` ("(untold)", "(traseu M21)").
 * - The adapter parses those patterns once here, writes the result as
 *   standard GTFS fields (`route_desc` for the human label,
 *   `networks.txt` + `route_networks.txt` for the structured mapping),
 *   and emits cleaned `route_long_name` in start-end format (with a
 *   stop_times-based fallback for routes where cleaning leaves it empty).
 * - `route_short_name` keeps Tranzy's value verbatim — the operator's
 *   chosen rider-facing identifier (e.g. `25N`, `TE1`, `M76A`) is the
 *   GTFS-spec way to carry service-class info, and we don't munge it.
 *
 * **Classification**: 1:1 with priority. Most-specific category wins.
 * `TE1` and `25N` are unambiguous (school / night respectively). Edge
 * cases (e.g. `M76A` whose `long_name` starts with `TE2 Floresti`) are
 * resolved by the school pattern's checks across all three fields.
 *
 * **Calendar windows** (school-year-only, festival-only) are *not*
 * tracked here — they're a property of the schedule view, orthogonal to
 * the route's category. See neary#129 for the ingestion work.
 */

/**
 * Categories, ordered most-specific first. First match wins.
 *
 * Each entry: `{ id, label, match(s, l, d) }` where
 *   - `id` is the network_id (machine-readable, kebab-case-ish)
 *   - `label` is the human-readable string that goes into `route_desc`
 *     AND into `networks.txt` `network_name`. Keeping these aligned
 *     means consumers reading `route_desc` directly get the same string
 *     they'd get from joining `route_networks.txt` → `networks.txt`.
 *     Labels are in Romanian to match the operator's terminology
 *     ("Noapte", "Metropolitana" — Cluj-CTP's own term for the
 *     suburban bus network is "Metropolitana" per ctpcj.ro).
 *   - `match` is a predicate over (route_short_name, route_long_name,
 *     route_desc). We check all three because Tranzy sometimes carries
 *     the signal in just one — e.g. "(untold)" annotation lands in
 *     route_desc for festival routes, "Transport Elevi X" lands in
 *     long_name for school buses. Case-insensitive substring matching
 *     on long_name and route_desc so operator-named variants work.
 *
 * Add new categories at the END of this list so existing priorities stay
 * stable. Bumping a category earlier = behavior change for routes that
 * match multiple patterns.
 *
 * **`commuter` was removed**: D51 (the only `D*`-prefixed route) is not
 * a commuter rail service — per ctpcj.ro it's an employee-only /
 * convention transport route, not a public commuter pattern. If a
 * future feed has a genuine commuter service, it can be re-added here
 * with a more specific pattern.
 */
export const CATEGORIES = [
  {
    id: 'special',
    label: 'Cursa Speciala',
    match: (s, l, d) =>
      s === 'CS' || /CURSA SPECIALA/i.test(l) || /CURSA SPECIALA/i.test(d),
  },
  {
    id: 'school',
    label: 'Transport Elevi',
    // School buses appear under two patterns in Tranzy:
    //   1. `TE*` short_name (urban: TE1..TE14, TE-OG)
    //   2. Any route whose short_name, long_name, or route_desc
    //      contains "elevi" case-insensitively — defensive against
    //      operator-named variants CTP may introduce later.
    //
    // Note: the M7x school-bus family (M75A..M79C) is metroline-shaped
    // (M* prefix). After PR review we dropped the M7x-specific short_name
    // regex — those routes fall through to `metroline` only. The "elevi"
    // substring check would catch them if their long_name ever explicitly
    // says "elevi"; until then they're classified as regular metroline
    // routes, which is also factually correct (they're Florești metroline
    // services that happen to also serve school destinations).
    match: (s, l, d) =>
      /^TE/i.test(s) ||
      /elevi/i.test(s) ||
      /elevi/i.test(l) ||
      /elevi/i.test(d),
  },
  {
    id: 'festival',
    label: 'Untold',
    // Festival services (Untold Music Festival in Cluj). The signal is
    // either:
    //   - `*U` suffix in short_name (`30U`, `M26U`)
    //   - "untold" substring in long_name or route_desc (Tranzy's
    //     parenthetical "(untold)" in long_name OR plain "Untold" in
    //     desc). Case-insensitive on both.
    match: (s, l, d) =>
      /U$/.test(s) ||
      /untold/i.test(l) ||
      /untold/i.test(d),
  },
  {
    id: 'night',
    label: 'Noapte',
    // Night services. Signal is `*N` suffix or "noapte" substring
    // (Romanian for "night"; Tranzy uses "Disp." prefix on headsigns
    // for depot-relative direction, but the long_name/desc sometimes
    // has "Noapte" explicitly).
    match: (s, l, d) =>
      /N$/.test(s) ||
      /noapte/i.test(l) ||
      /noapte/i.test(d),
  },
  {
    id: 'airport',
    label: 'Aeroport Express',
    match: (s, l, d) =>
      /^A\d/.test(s) ||
      /aeroport/i.test(l) ||
      /aeroport/i.test(d),
  },
  {
    id: 'metroline',
    label: 'Metropolitana',
    // Cluj-CTP's own term for the suburban/metroline bus network is
    // "Metropolitana" (per ctpcj.ro). Used in the consumer-facing label
    // because that's what riders search for on the agency site.
    match: (s) => /^M\d/.test(s),
  },
];

/**
 * Classify a single route, returning all matching categories in
 * priority order (CATEGORIES declaration order). Empty array for
 * regular urban routes that match nothing.
 *
 * **1:many is intentional**: a route can belong to multiple networks.
 * The classic case is `M76A` — short_name is `M7[5-9][A-Z]?` (matches
 * school) AND starts with `M\d` (matches metroline). One route, two
 * networks. `route_networks.txt` carries the n:m mapping natively.
 *
 * @param {{ route_short_name?: string, route_long_name?: string, route_desc?: string }} row
 * @returns {Array<{ id: string, label: string }>}
 */
export function classifyRoute(row) {
  const s = (row.route_short_name ?? '').toString();
  const l = (row.route_long_name ?? '').toString();
  const d = (row.route_desc ?? '').toString();
  const matches = [];
  for (const cat of CATEGORIES) {
    if (cat.match(s, l, d)) {
      matches.push({ id: cat.id, label: cat.label });
    }
  }
  return matches;
}

/**
 * Clean `route_long_name` into "Start - End" format via regex passes.
 *
 * Operations, in order:
 *
 *   1. CURSA SPECIALA (`CS`) → empty. No fixed endpoints — calling it
 *      "CURSA SPECIALA" in `route_long_name` is noise that consumers
 *      shouldn't have to special-case.
 *   2. Strip trailing parenthetical annotations: "(untold)", "(traseu
 *      M21)", "(traseu M21) (something else)". These are free-text
 *      notes Tranzy puts in; they belong in `route_desc` (as the
 *      category label, not the annotation) or nowhere.
 *   3. Strip "Transport Elevi -" / "Transport Elevi " prefix for school
 *      routes whose Tranzy `route_long_name` describes the service
 *      class rather than the endpoints ("Transport Elevi Manastur" →
 *      "Manastur"). For richer start-end extraction (e.g. "Primaverii
 *      - Onisifor Ghibu" for TE1) the CTP website source is required —
 *      tracked in neary#129.
 *   4. Strip remaining "TE\d+" / "TE-OG" prefix noise.
 *
 * **Note**: this function may return an empty string for routes like CS,
 * routes that were just annotations ("(untold)"), or routes where
 * Tranzy never published a long_name. The orchestrator should fall back
 * to `deriveLongNameFromStops()` in those cases.
 *
 * @param {{ route_short_name?: string, route_long_name?: string }} row
 * @returns {string} cleaned long_name (may be empty — see note above)
 */
export function cleanLongName(row) {
  const s = (row.route_short_name ?? '').toString();
  let l = (row.route_long_name ?? '').toString().trim();

  if (s === 'CS') return '';

  // Strip one or more trailing parentheticals. Examples:
  //   "Floresti Cetate - Emerson (traseu M21)" → "Floresti Cetate - Emerson"
  //   "Uzinei Electrice - Floresti / Cetate (untold)" → "Uzinei Electrice - Floresti / Cetate"
  // Greedy on the right edge; nested parens aren't expected in CTP data.
  l = l.replace(/\s*\([^)]*\)\s*$/g, '').trim();

  // "Transport Elevi -" / "Transport Elevi " prefix.
  //   "Transport Elevi Manastur" → "Manastur"
  //   "Transport Elevi-Manastur - Kogalniceanu" → "Manastur - Kogalniceanu"
  l = l.replace(/^Transport Elevi[- ]+/i, '');

  // "TE\d+ Floresti" prefix from Tranzy for the M7x school-bus family.
  // MUST run BEFORE the generic TE-prefix strip below — otherwise the
  // generic regex eats "TE2 " and leaves "Floresti ..." behind.
  //   "TE2 Floresti str. Somesului..." → "str. Somesului..."
  l = l.replace(/^TE\d+\s+Floresti\s*/i, '');

  // "TE\d+" / "TE-OG" leftover prefix (anything TE* that survived the
  // Floresti-specific strip above).
  //   "TE1 Manastur" → "Manastur"
  //   "TE-OG Sala Sporturilor" → "Sala Sporturilor"
  l = l.replace(/^TE-?[A-Z0-9]+[- ]+/i, '');

  return l.trim();
}

/**
 * Derive a "First stop - Last stop" `route_long_name` from stop_times
 * data. Used as the fallback when `cleanLongName()` leaves the field
 * empty (CS special-cases, annotation-only routes, routes Tranzy never
 * published a long_name for).
 *
 * Picks the **longest trip** for the route (most stop_times) so the
 * fallback reflects the canonical full-haul variant, not a truncated
 * short-turn service.
 *
 * @param {{
 *   routeId: string,
 *   allStopTimeRows: Array<{ trip_id: string, stop_id: string, stop_sequence: string|number }>,
 *   tripToRoute: Map<string, string>,
 *   stopsByStopId: Map<string, { stop_name?: string }>,
 * }} input
 * @returns {string} "<first stop name> - <last stop name>", or '' if no data
 */
export function deriveLongNameFromStops({ routeId, allStopTimeRows, tripToRoute, stopsByStopId }) {
  if (!allStopTimeRows || !tripToRoute || !stopsByStopId) return '';

  // Group stop_times by trip for this route.
  /** @type {Map<string, Array<{ stop_id: string, stop_sequence: number }>>} */
  const byTrip = new Map();
  for (const st of allStopTimeRows) {
    if (tripToRoute.get(String(st.trip_id)) !== routeId) continue;
    if (!byTrip.has(String(st.trip_id))) byTrip.set(String(st.trip_id), []);
    byTrip.get(String(st.trip_id)).push({
      stop_id: String(st.stop_id),
      stop_sequence: Number(st.stop_sequence),
    });
  }
  if (byTrip.size === 0) return '';

  // Pick the longest trip (most stop_times) — the canonical variant.
  let bestTrip = null;
  let bestCount = -1;
  for (const [tripId, sts] of byTrip) {
    if (sts.length > bestCount) {
      bestCount = sts.length;
      bestTrip = tripId;
    }
  }
  if (!bestTrip) return '';
  const sts = byTrip.get(bestTrip).sort((a, b) => a.stop_sequence - b.stop_sequence);
  if (sts.length < 2) return '';

  const first = stopsByStopId.get(String(sts[0].stop_id));
  const last = stopsByStopId.get(String(sts[sts.length - 1].stop_id));
  if (!first?.stop_name || !last?.stop_name) return '';

  // Avoid emitting "Same stop - Same stop" for circular / single-stop
  // services — those cases deserve a manually-curated long_name.
  if (first.stop_name === last.stop_name) return '';

  return `${first.stop_name} - ${last.stop_name}`;
}

/**
 * Apply classification + long_name cleanup + stop_times fallback to all
 * route rows in place. Single orchestrator-facing entry point.
 *
 * **Order matters** (and is intentional, not arbitrary):
 *
 *   1. Classify against the **original** Tranzy values, BEFORE cleanup.
 *      Why: `M76A`'s long_name `"TE2 Floresti str. Somesului - Liceul D.
 *      Tautan"` carries the school-bus signal (`M7x` short_name + the
 *      `^TE\d+\s+Floresti` substring). After cleanup strips that
 *      prefix, the signal is gone — and `M76A` would silently lose its
 *      school classification. So classify first.
 *
 *   2. Cleanup pass. Strip parentheticals, prefixes, etc. for the
 *      `route_long_name` the consumer sees.
 *
 *   3. Stop_times fallback. If cleanup leaves `route_long_name` empty
 *      (CS, annotation-only rows, Tranzy-missing), derive from
 *      `<first stop> - <last stop>` of the longest trip.
 *
 * **1:many semantics**: `route_desc` carries the comma-separated labels
 * of every matching category (`"Transport Elevi, Metropolitana"` for
 * M76A). `route_networks.txt` gets one row per category so the n:m
 * mapping is preserved in the GTFS-standard file.
 *
 * @param {{
 *   routes: Array<{ route_id: string, route_short_name: string, route_long_name: string, route_desc: string }>,
 *   allStopTimeRows?: Array<{ trip_id: string, stop_id: string, stop_sequence: string|number }>,
 *   tripToRoute?: Map<string, string>,
 *   stopsByStopId?: Map<string, { stop_name?: string }>,
 *   warnings: Array<{ severity: string, message: string }>,
 * }} input
 * @returns {{
 *   classifiedCount: number,
 *   multiNetworkCount: number,
 *   longNameCleanedCount: number,
 *   longNameDerivedCount: number,
 *   longNameUnresolvedCount: number,
 * }}
 */
export function applyRouteCategory({ routes, allStopTimeRows = [], tripToRoute, stopsByStopId, warnings }) {
  let classifiedCount = 0;
  let multiNetworkCount = 0;
  let longNameCleanedCount = 0;
  let longNameDerivedCount = 0;
  let longNameUnresolvedCount = 0;

  for (const row of routes) {
    // 1. Classify against the ORIGINAL row (pre-cleanup). The school
    //    pattern matches `M7x` in short_name, which survives cleanup —
    //    but also `^TE\d+\s+Floresti` in long_name, which cleanup
    //    strips. Order matters here.
    const categories = classifyRoute(row);
    if (categories.length > 0) classifiedCount++;
    if (categories.length > 1) multiNetworkCount++;
    row.route_desc = categories.map((c) => c.label).join(', ');

    // 2. Cleanup pass on long_name.
    const originalLongName = row.route_long_name ?? '';
    const cleaned = cleanLongName(row);
    if (cleaned !== originalLongName) longNameCleanedCount++;

    // 3. Fallback: if cleanup left it empty, derive from stop_times.
    let resolved = cleaned;
    if (!resolved) {
      const derived = deriveLongNameFromStops({
        routeId: row.route_id,
        allStopTimeRows,
        tripToRoute,
        stopsByStopId,
      });
      if (derived) {
        resolved = derived;
        longNameDerivedCount++;
      } else {
        longNameUnresolvedCount++;
      }
    }
    row.route_long_name = resolved;
  }

  // Build-log INFO summary. Per-row detail is in routes.txt + networks.txt;
  // this is the one-liner for the human reading the build log.
  if (classifiedCount > 0 || longNameCleanedCount > 0 || longNameDerivedCount > 0 || longNameUnresolvedCount > 0) {
    warnings.push({
      severity: 'info',
      message:
        `routes: classified ${classifiedCount} route(s), ${multiNetworkCount} with multiple networks, ` +
        `cleaned ${longNameCleanedCount}, derived-from-stops ${longNameDerivedCount} long_name(s)` +
        (longNameUnresolvedCount > 0 ? `, ${longNameUnresolvedCount} unresolved (no stop_times fallback)` : '') +
        ' — see networks.txt + route_networks.txt',
    });
  }

  return {
    classifiedCount,
    multiNetworkCount,
    longNameCleanedCount,
    longNameDerivedCount,
    longNameUnresolvedCount,
  };
}

/**
 * Get the canonical category list — for `networks.txt` emission in the
 * `emit/networks.js` module.
 */
export function getAllCategories() {
  return CATEGORIES.map(({ id, label }) => ({ id, label }));
}