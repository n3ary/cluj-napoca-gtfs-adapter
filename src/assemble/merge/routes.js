/**
 * Routes reconciliation.
 *
 * **Tranzy is the primary catalog.** Cluj-Napoca city hall promotes
 * Tranzy as the authoritative live source for the network (per
 * `docs/known-limitations.md` §3 and `https://ctpcj.ro/index.php/ro/
 * despre-noi/open-data-tranzy`), so Tranzy is more up-to-date than
 * the Transitous `mdb-2121` mirror: 168 vs 108 routes, with the gap
 * mostly in newer metropolitan lines (M22–M81, etc.).
 *
 * Transitous is consulted only for **ID stability** — downstream apps
 * (notably `neary`) key routes by `route_id`, and we don't want to
 * break those references every time Tranzy's internal numeric IDs
 * rotate. So when a route exists in BOTH sources:
 *   - The published row uses **Transitous's `route_id`** (downstream
 *     apps keep working without re-mapping).
 *   - The row's content (color, long_name, etc.) is **Tranzy's** (the
 *     live source — Tranzy's color/long_name override Transitous's).
 *
 * Routes only in Tranzy: included with Tranzy's `route_id`.
 * Routes only in Transitous: included with Transitous's `route_id`.
 *
 * See `docs/reconciliation-rules.md` for the priority table.
 */

import { parseCsv } from '../../lib/csv.js';
import { info } from '../../lib/log-severity.js';

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
  const tranzyByShortName = new Map();
  /** @type {Map<string, any>} */
  const seedByShortName = new Map();
  const routes = [];

  // ── Step 1: Tranzy is the base catalog. Every Tranzy route becomes
  // a row keyed by its Tranzy route_id. We track them by short_name so
  // the Transitous pass can look up the matching row for ID-stability
  // upgrades.
  let tranzyAdded = 0;
  if (tranzy && Array.isArray(tranzy.routes)) {
    for (const r of tranzy.routes) {
      const id = r.route_id ? String(r.route_id) : null;
      if (!id) continue;
      if (byRouteId.has(id)) continue;
      const shortName = (r.route_short_name ?? '').toString().trim();
      const color = (r.route_color ?? '').toString().replace(/^#?/, '').toUpperCase();
      const row = {
        route_id: id,
        agency_id: '2', // CTP Cluj-Napoca
        route_short_name: shortName,
        route_long_name: r.route_long_name ?? '',
        route_type: r.route_type ? String(r.route_type) : '3',
        route_color: color,
        route_text_color: (r.route_text_color ?? '').toString().replace(/^#?/, '').toUpperCase(),
        route_desc: r.route_desc ?? '',
      };
      byRouteId.set(id, row);
      routes.push(row);
      if (shortName) tranzyByShortName.set(shortName, row);
      tranzyAdded++;
    }
  }

  // ── Step 2: Transitous is the ID-stability overlay. For each
  // Transitous route, if we already added the matching Tranzy row by
  // short_name, swap the published route_id to Transitous's value so
  // downstream apps (neary catalog, etc.) keep their references. Also
  // fill in any fields Tranzy left empty (route_type, etc.).
  let tranzyUpgradedToTransitousId = 0;
  let transitousOnlyAdded = 0;
  for (const r of seed.routes) {
    if (!r.routeId) continue;
    const shortName = (r.shortName ?? '').toString().trim();
    if (shortName && tranzyByShortName.has(shortName)) {
      // Shared route — upgrade the existing Tranzy row's route_id to
      // Transitous's, and patch any missing fields from the seed.
      const tranzyRow = tranzyByShortName.get(shortName);
      const oldId = tranzyRow.route_id;
      const newId = String(r.routeId);
      if (oldId !== newId) {
        byRouteId.delete(oldId);
        tranzyRow.route_id = newId;
        byRouteId.set(newId, tranzyRow);
        tranzyUpgradedToTransitousId++;
      }
      if (!tranzyRow.route_type && r.type) tranzyRow.route_type = String(r.type);
      if (!tranzyRow.route_color && r.color) {
        tranzyRow.route_color = r.color.replace(/^#?/, '').toUpperCase();
      }
      if (!tranzyRow.route_long_name && r.longName) tranzyRow.route_long_name = r.longName;
      // Remember the match so a Transitous-only fallback (no Tranzy)
      // wouldn't double-add this short_name.
      seedByShortName.set(shortName, tranzyRow);
      continue;
    }
    // Transitous-only route (Tranzy doesn't have it).
    if (byRouteId.has(r.routeId)) continue;
    const row = {
      route_id: String(r.routeId),
      agency_id: '2',
      route_short_name: shortName,
      route_long_name: r.longName ?? '',
      route_type: r.type ? String(r.type) : '3',
      route_color: (r.color ?? '').replace(/^#?/, '').toUpperCase(),
      route_text_color: '',
      route_desc: '',
    };
    byRouteId.set(row.route_id, row);
    routes.push(row);
    if (shortName) seedByShortName.set(shortName, row);
    transitousOnlyAdded++;
  }

  // Build-log summary. One line per category — the per-row detail is
  // already in routes.txt, so grepping is enough for auditing.
  if (tranzyAdded > 0) {
    const onlyInTranzy = tranzyAdded - tranzyUpgradedToTransitousId;
    warnings.push(info(
      `routes: Tranzy primary catalog — ${tranzyAdded} routes total` +
      (onlyInTranzy > 0 ? `, ${onlyInTranzy} Tranzy-only` : '') +
      (tranzyUpgradedToTransitousId > 0 ? `, ${tranzyUpgradedToTransitousId} shared with Transitous (re-keyed to Transitous route_id for downstream stability)` : ''),
    ));
  }
  if (transitousOnlyAdded > 0) {
    warnings.push(info(`routes: ${transitousOnlyAdded} Transitous-only (Tranzy missing)`));
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