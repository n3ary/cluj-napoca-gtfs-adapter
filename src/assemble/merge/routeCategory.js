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
 * Apply the standard cleanup regex passes to a free-text value (long_name
 * OR desc). Shared between `cleanLongName` and `cleanDesc` so the two
 * fields stay in sync — if we strip a parenthetical on one, we strip it
 * on the other.
 *
 * Operations, in order:
 *
 *   1. CURSA SPECIALA (`CS`) → empty. No fixed endpoints — calling it
 *      "CURSA SPECIALA" is noise that consumers shouldn't have to
 *      special-case.
 *   2. Strip trailing parenthetical annotations: "(untold)", "(traseu
 *      M21)", "(traseu M21) (something else)". These are free-text
 *      notes Tranzy puts in; they belong in `route_desc` (as the
 *      category label, not the annotation) or nowhere.
 *   3. Strip "Transport Elevi -" / "Transport Elevi " prefix for school
 *      routes whose Tranzy data describes the service class rather than
 *      the endpoints ("Transport Elevi Manastur" → "Manastur"). For
 *      richer start-end extraction (e.g. "Primaverii - Onisifor Ghibu"
 *      for TE1) the CTP website source is required — tracked in
 *      neary#129.
 *   4. Strip "TE\d+ Floresti" prefix from Tranzy for the M7x school-bus
 *      family. MUST run BEFORE the generic TE-prefix strip below.
 *   5. Strip remaining "TE\d+" / "TE-OG" prefix noise.
 *
 * **Returns** the cleaned string. May be empty for CS, annotation-only
 * values ("(untold)"), or empty inputs. Callers handle empty fallbacks.
 *
 * @param {{ route_short_name?: string }} row
 * @param {string} value  the field to clean (long_name OR desc text)
 * @returns {string}
 */
function cleanText(row, value) {
  const s = (row?.route_short_name ?? '').toString();
  let t = (value ?? '').toString().trim();

  if (s === 'CS') return '';

  // Strip one or more trailing parentheticals.
  //   "Floresti Cetate - Emerson (traseu M21)" → "Floresti Cetate - Emerson"
  //   "Uzinei Electrice - Floresti / Cetate (untold)" → "Uzinei Electrice - Floresti / Cetate"
  t = t.replace(/\s*\([^)]*\)\s*$/g, '').trim();

  // "Transport Elevi -" / "Transport Elevi " prefix.
  t = t.replace(/^Transport Elevi[- ]+/i, '');

  // "TE\d+ Floresti" prefix (M7x school-bus family).
  //   "TE2 Floresti str. Somesului..." → "str. Somesului..."
  t = t.replace(/^TE\d+\s+Floresti\s*/i, '');

  // "TE\d+" / "TE-OG" leftover prefix.
  //   "TE1 Manastur" → "Manastur"
  //   "TE-OG Sala Sporturilor" → "Sala Sporturilor"
  t = t.replace(/^TE-?[A-Z0-9]+[- ]+/i, '');

  return t.trim();
}

/**
 * Clean `route_long_name` into "Start - End" format via regex passes.
 * Thin wrapper around `cleanText` that pulls the value off the row.
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
  return cleanText(row, row?.route_long_name ?? '');
}

/**
 * Clean `route_desc` with the same regex passes as `cleanLongName`.
 *
 * Tranzy's `route_desc` carries the same kind of free-text noise as
 * `route_long_name` does — parenthetical annotations, "Transport Elevi"
 * prefixes, etc. Cleaning it symmetrically means:
 *
 *   - For un-categorized routes (no category match), `route_desc` keeps
 *     the descriptive text Tranzy published (D51's "P-ta Mihai Viteazu -
 *     Gilau" survives; CS's empty desc stays empty).
 *   - For categorized routes, `route_desc` is overwritten with the
 *     comma-separated category labels (the canonical structured
 *     representation), so the desc-fallback case for un-categorized
 *     routes doesn't get mixed in.
 *
 * @param {{ route_short_name?: string, route_desc?: string }} row
 * @returns {string} cleaned desc (may be empty)
 */
export function cleanDesc(row) {
  return cleanText(row, row?.route_desc ?? '');
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
 * Apply classification + cleanup + fallback to all route rows in
 * place. Single orchestrator-facing entry point.
 *
 * **Order matters** (and is intentional, not arbitrary):
 *
 *   1. **Classify** against the ORIGINAL Tranzy values, BEFORE cleanup.
 *      Why: `M76A`'s long_name `"TE2 Floresti str. Somesului - Liceul D.
 *      Tautan"` carries the school-bus signal (the `^TE\d+\s+Floresti`
 *      substring). After cleanup strips that prefix, the signal is gone.
 *      So classify first.
 *
 *   2. **Cleanup long_name** via `cleanLongName()` (strips
 *      parentheticals, prefixes, etc.).
 *
 *   3. **Cleanup desc** via `cleanDesc()` (same regexes, applied
 *      symmetrically so desc and long_name stay in sync).
 *
 *   4. **route_long_name fallback chain**: cleaned long_name → cleaned
 *      desc (when long_name ended up empty after cleanup but desc has
 *      data) → `<first stop> - <last stop>` from stop_times.
 *
 *   5. **route_desc strategy**:
 *      - If classified (≥1 category): `route_desc` is the comma-joined
 *        category labels (`"Transport Elevi, Metropolitana"` for 1:many).
 *      - Else if cleaned desc has data: `route_desc` is the cleaned
 *        desc. Preserves Tranzy's descriptive text for un-categorized
 *        routes (e.g. D51's `" P-ta Mihai Viteazu - Gilau"` is no
 *        longer clobbered to empty).
 *      - Else: empty string.
 *
 * **1:many semantics** live in `route_networks.txt` — one row per
 * (network_id, route_id) so consumers see the n:m mapping natively.
 * Comma-separated labels in `route_desc` are the consumer-side
 * fallback for tools that don't read networks.txt.
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
 *   descCleanedCount: number,
 *   descFromCleanedCount: number,
 *   descFromUnchangedCount: number,
 * }}
 */
export function applyRouteCategory({ routes, allStopTimeRows = [], tripToRoute, stopsByStopId, warnings }) {
  let classifiedCount = 0;
  let multiNetworkCount = 0;
  let longNameCleanedCount = 0;
  let longNameDerivedCount = 0;
  let longNameUnresolvedCount = 0;
  let descCleanedCount = 0;
  let descFromCleanedCount = 0;
  let descFromUnchangedCount = 0;

  for (const row of routes) {
    // 1. Classify against the ORIGINAL row (pre-cleanup). See block
    //    comment for why order matters.
    const categories = classifyRoute(row);
    if (categories.length > 0) classifiedCount++;
    if (categories.length > 1) multiNetworkCount++;

    // 2. Cleanup pass on long_name.
    const originalLongName = row.route_long_name ?? '';
    const cleanedLong = cleanLongName(row);
    if (cleanedLong !== originalLongName) longNameCleanedCount++;

    // 3. Cleanup pass on desc (symmetric with long_name). Counts any
    //    change as a "cleaned desc" for the build-log INFO summary.
    const originalDesc = row.route_desc ?? '';
    const cleanedDesc = cleanDesc(row);
    if (cleanedDesc !== originalDesc) descCleanedCount++;

    // 4. route_long_name fallback chain: long_name → cleaned desc → stops.
    let resolvedLong = cleanedLong;
    if (!resolvedLong && cleanedDesc) {
      resolvedLong = cleanedDesc;
      longNameDerivedCount++; // counter reused: "derived from somewhere other than long_name"
    }
    if (!resolvedLong) {
      const derived = deriveLongNameFromStops({
        routeId: row.route_id,
        allStopTimeRows,
        tripToRoute,
        stopsByStopId,
      });
      if (derived) {
        resolvedLong = derived;
        longNameDerivedCount++;
      } else {
        longNameUnresolvedCount++;
      }
    }
    row.route_long_name = resolvedLong;

    // 5. route_desc strategy: categorized labels > cleaned desc > ''.
    if (categories.length > 0) {
      row.route_desc = categories.map((c) => c.label).join(', ');
    } else if (cleanedDesc) {
      row.route_desc = cleanedDesc;
      descFromCleanedCount++;
    } else {
      row.route_desc = '';
    }
    if (row.route_desc === cleanedDesc && cleanedDesc === originalDesc) {
      descFromUnchangedCount++;
    }
  }

  // Build-log INFO summary. Per-row detail is in routes.txt + networks.txt;
  // this is the one-liner for the human reading the build log.
  if (classifiedCount > 0 || longNameCleanedCount > 0 || longNameDerivedCount > 0 || longNameUnresolvedCount > 0 || descCleanedCount > 0 || descFromCleanedCount > 0) {
    warnings.push({
      severity: 'info',
      message:
        `routes: classified ${classifiedCount} route(s), ${multiNetworkCount} with multiple networks, ` +
        `cleaned ${longNameCleanedCount} long_name + ${descCleanedCount} desc, ` +
        `derived ${longNameDerivedCount} long_name(s) (desc or stops fallback)` +
        (longNameUnresolvedCount > 0 ? `, ${longNameUnresolvedCount} unresolved` : '') +
        `, preserved ${descFromCleanedCount} desc(s) on un-categorized routes` +
        ' — see networks.txt + route_networks.txt',
    });
  }

  return {
    classifiedCount,
    multiNetworkCount,
    longNameCleanedCount,
    longNameDerivedCount,
    longNameUnresolvedCount,
    descCleanedCount,
    descFromCleanedCount,
    descFromUnchangedCount,
  };
}

/**
 * Get the canonical category list — for `networks.txt` emission in the
 * `emit/networks.js` module.
 */
export function getAllCategories() {
  return CATEGORIES.map(({ id, label }) => ({ id, label }));
}