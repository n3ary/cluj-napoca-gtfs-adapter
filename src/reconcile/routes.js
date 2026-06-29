/**
 * Routes reconciliation.
 *
 * Transitous and Tranzy use **different route_id namespaces** for the
 * same physical routes — Transitous's `mdb-2121` mirror assigns its
 * own numeric IDs (`route_id=47` for `route_short_name='48'`); Tranzy
 * uses its own numeric IDs that don't line up. Cluj-Napoca alone has
 * ~107 routes that appear in BOTH sources with different `route_id`
 * values but the same `route_short_name`. If we matched by `route_id`
 * we'd emit ~107 duplicate routes and 107 misleading "added from
 * Tranzy" warnings.
 *
 * Reconciliation strategy:
 *   1. Seed populates the canonical row for every route.
 *   2. Tranzy routes are matched against seed by `route_short_name`
 *      (the user-visible identifier — both sources agree on it). When
 *      matched, Tranzy fills in fresher fields (live color updates,
 *      headsigns) but the row's identity (`route_id`, primary fields)
 *      stays with the seed.
 *   3. Tranzy routes without a `route_short_name` match are added as
 *      new rows (their IDs are unique to Tranzy). Summarized, not per-row.
 *
 * See `docs/reconciliation-rules.md` for the rationale.
 */

import { parseCsv } from '../lib/csv.js';

/**
 * @param {{
 *   seed: { routes: Array<{routeId, shortName, longName, type, color}>, agencyTxt: string },
 *   tranzy: { routes: any[] } | null,
 *   warnings: string[],
 * }} input
 * @returns {{
 *   routes: Array<{route_id, agency_id, route_short_name, route_long_name, route_type, route_color, route_text_color, route_desc}>,
 *   byRouteId: Map<string, any>,
 * }}
 */
export function reconcileRoutes({ seed, tranzy, warnings }) {
  /** @type {Map<string, any>} */
  const byRouteId = new Map();
  /** @type {Map<string, any>} */
  const seedByShortName = new Map();
  const routes = [];

  // Seed wins — already curated by mdb-2121.
  for (const r of seed.routes) {
    if (!r.routeId) continue;
    const row = {
      route_id: r.routeId,
      agency_id: '2', // CTP Cluj-Napoca
      route_short_name: r.shortName ?? '',
      route_long_name: r.longName ?? '',
      route_type: r.type ? String(r.type) : '3',
      route_color: (r.color ?? '').replace(/^#?/, '').toUpperCase(),
      route_text_color: '',
      route_desc: '',
    };
    if (!byRouteId.has(row.route_id)) {
      byRouteId.set(row.route_id, row);
      routes.push(row);
      if (row.route_short_name) seedByShortName.set(row.route_short_name, row);
    }
  }

  // Tranzy fills gaps. Match by route_short_name (NOT route_id —
  // Transitous and Tranzy use different numeric ID namespaces for the
  // same physical routes). When matched, Tranzy's fresher fields
  // (live color updates, etc.) overwrite the seed's.
  const tranzyAdditions = [];
  let tranzyMergedIntoSeed = 0;
  if (tranzy && Array.isArray(tranzy.routes)) {
    for (const r of tranzy.routes) {
      const shortName = (r.route_short_name ?? '').toString().trim();
      if (shortName && seedByShortName.has(shortName)) {
        // Same route, different ID namespaces — merge Tranzy's live data.
        const seedRow = seedByShortName.get(shortName);
        const tranzyColor = (r.route_color ?? '').toString().replace(/^#?/, '').toUpperCase();
        if (tranzyColor) seedRow.route_color = tranzyColor;
        const tranzyTextColor = (r.route_text_color ?? '').toString().replace(/^#?/, '').toUpperCase();
        if (tranzyTextColor) seedRow.route_text_color = tranzyTextColor;
        const tranzyLongName = (r.route_long_name ?? '').toString().trim();
        if (tranzyLongName) seedRow.route_long_name = tranzyLongName;
        tranzyMergedIntoSeed++;
        continue;
      }
      const id = r.route_id ? String(r.route_id) : null;
      if (!id) continue;
      if (byRouteId.has(id)) continue; // already added
      // Genuinely new route (no short_name match in seed).
      const color = (r.route_color ?? '').toString().replace(/^#?/, '').toUpperCase();
      const row = {
        route_id: id,
        agency_id: '2',
        route_short_name: shortName,
        route_long_name: r.route_long_name ?? '',
        route_type: r.route_type ? String(r.route_type) : '3',
        route_color: color,
        route_text_color: (r.route_text_color ?? '').toString().replace(/^#?/, '').toUpperCase(),
        route_desc: r.route_desc ?? '',
      };
      tranzyAdditions.push(row);
      byRouteId.set(id, row);
      routes.push(row);
    }
  }
  // Single-line summary for build logs. Detail goes to grep if anyone
  // wants to audit "why is route X in the output?".
  if (tranzyMergedIntoSeed > 0) {
    warnings.push(`routes: merged ${tranzyMergedIntoSeed} Tranzy rows into seed by route_short_name (different route_id namespaces)`);
  }
  if (tranzyAdditions.length > 0) {
    warnings.push(`routes: added ${tranzyAdditions.length} Tranzy-only routes (not in seed by short_name)`);
  }

  return { routes, byRouteId };
}

/**
 * Serialize routes rows to GTFS routes.txt body.
 *
 * @param {Array<object>} routes  output of `reconcileRoutes`
 * @returns {string}
 */
export function routesToTxt(routes) {
  const headers = [
    'route_id', 'agency_id', 'route_short_name', 'route_long_name',
    'route_desc', 'route_type', 'route_url', 'route_color', 'route_text_color',
  ];
  const lines = [headers.join(',')];
  for (const r of routes) {
    lines.push([
      csvField(r.route_id),
      csvField(r.agency_id ?? '2'),
      csvField(r.route_short_name),
      csvField(r.route_long_name),
      csvField(r.route_desc ?? ''),
      csvField(r.route_type),
      '', // route_url
      csvField(r.route_color),
      csvField(r.route_text_color ?? ''),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

/** Quote a field if it contains comma, quote, or newline. */
function csvField(v) {
  const s = (v ?? '').toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export { parseCsv };