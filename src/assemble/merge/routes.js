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
 * See `docs/assemble-rules.md` for the priority table.
 */

import { parseCsv } from '../../lib/csv.js';
import { info } from '../../lib/log-severity.js';
import { canonicalShortName } from '../../sources/ctp-csv/shortname-aliases.js';

/**
 * Normalize a color value to the GTFS-spec `Color` type: six-digit hex,
 * uppercased, no leading `#`. Accepts:
 *   - `'#abc'`  / `'abc'`     → `'AABBCC'` (CSS 3-char shorthand expanded)
 *   - `'#abcdef'` / `'abcdef'` → `'ABCDEF'`
 *   - empty / nullish / malformed → `''` (caller decides the fallback)
 *
 * Per https://gtfs.org/documentation/schedule/reference/#field-types
 * a `Color` MUST be six hex digits with no `#`. Tranzy occasionally
 * returns CSS 3-char shorthand (e.g. `'000'` for black on ~80 routes),
 * which is spec-violating; we expand rather than pass it through.
 */
function normalizeColor(raw) {
  let c = (raw ?? '').toString().replace(/^#?/, '').toUpperCase();
  if (c.length === 3 && /^[0-9A-F]{3}$/.test(c)) {
    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  return /^[0-9A-F]{6}$/.test(c) ? c : '';
}

/**
 * Pick a contrasting text color (`'FFFFFF'` or `'000000'`) for a 6-char
 * hex background. Used as a producer-side fallback when no source
 * supplies `route_text_color` — the GTFS spec requires producers to
 * ensure "sufficient contrast between route_color and route_text_color"
 * (see https://gtfs.org/documentation/schedule/reference/#routestxt).
 *
 * Note: the spec's *consumer-side* default for empty `route_text_color`
 * is `'000000'` (black). Defaulting unconditionally to black would
 * produce black-on-black for the many Tranzy routes with dark
 * `route_color` (e.g. `'000000'`, `'002FFF'`). Computing contrast at
 * publish time honors the producer-side contrast requirement.
 */
function contrastingTextColor(bg) {
  if (!/^[0-9A-F]{6}$/.test(bg)) return 'FFFFFF';
  const r = parseInt(bg.slice(0, 2), 16);
  const g = parseInt(bg.slice(2, 4), 16);
  const b = parseInt(bg.slice(4, 6), 16);
  // sRGB-weighted luminance (approximation); same threshold neary uses.
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.6 ? '000000' : 'FFFFFF';
}

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
  // Keyed by canonical CTP-side name (post-alias, post-normalize) so
  // Tranzy's `39C` and Transitous's `39 CREIC` map to the same row.
  // The raw catalog-side names are still preserved on each row's
  // `route_short_name` field for downstream `routes.txt` output.
  const tranzyByCanonical = new Map();
  /** @type {Map<string, any>} */
  const seedByCanonical = new Map();
  const routes = [];

  // ── Step 1: Tranzy is the base catalog. Every Tranzy route becomes
  // a row keyed by its Tranzy route_id. We track them by canonical
  // short_name so the Transitous pass can look up the matching row
  // for ID-stability upgrades (using canonical names means the lookup
  // works even when Tranzy and Transitous spell the same route
  // differently — e.g. `39C` vs `39 CREIC`).
  let tranzyAdded = 0;
  if (tranzy && Array.isArray(tranzy.routes)) {
    for (const r of tranzy.routes) {
      const id = r.route_id ? String(r.route_id) : null;
      if (!id) continue;
      if (byRouteId.has(id)) continue;
      const shortName = (r.route_short_name ?? '').toString().trim();
      const canonical = canonicalShortName(shortName);
      const row = {
        route_id: id,
        agency_id: '2', // CTP Cluj-Napoca
        route_short_name: shortName,
        route_long_name: r.route_long_name ?? '',
        // `?? '3'` not `?` — the GTFS enum 0 (tram) is a valid value that
        // `?` would treat as missing and demote to bus. Same applies to
        // the Transitous-only branch below.
        route_type: String(r.route_type ?? '3'),
        route_color: normalizeColor(r.route_color),
        route_text_color: normalizeColor(r.route_text_color),
        route_desc: r.route_desc ?? '',
      };
      byRouteId.set(id, row);
      routes.push(row);
      if (canonical) tranzyByCanonical.set(canonical, row);
      tranzyAdded++;
    }
  }

  // ── Step 2: Transitous is the ID-stability overlay. For each
  // Transitous route, if we already added the matching Tranzy row by
  // canonical short_name, swap the published route_id to Transitous's
  // value so downstream apps (neary catalog, etc.) keep their
  // references. Tranzy stays authoritative for content (route_type,
  // colors, names); Transitous only fills fields Tranzy left empty.
  let tranzyUpgradedToTransitousId = 0;
  let transitousOnlyAdded = 0;
  for (const r of seed.routes) {
    if (!r.routeId) continue;
    const shortName = (r.shortName ?? '').toString().trim();
    const canonical = canonicalShortName(shortName);
    if (shortName && tranzyByCanonical.has(canonical)) {
      // Shared route — upgrade the existing Tranzy row's route_id to
      // Transitous's, and patch any missing fields from the seed.
      const tranzyRow = tranzyByCanonical.get(canonical);
      const oldId = tranzyRow.route_id;
      const newId = String(r.routeId);
      if (oldId !== newId) {
        byRouteId.delete(oldId);
        tranzyRow.route_id = newId;
        byRouteId.set(newId, tranzyRow);
        tranzyUpgradedToTransitousId++;
      }
      if (tranzyRow.route_type == null && r.type != null) tranzyRow.route_type = String(r.type);
      if (!tranzyRow.route_color) {
        const seedColor = normalizeColor(r.color);
        if (seedColor) tranzyRow.route_color = seedColor;
      }
      if (!tranzyRow.route_text_color) {
        const seedText = normalizeColor(r.textColor);
        if (seedText) tranzyRow.route_text_color = seedText;
      }
      if (!tranzyRow.route_long_name && r.longName) tranzyRow.route_long_name = r.longName;
      // Remember the match so a Transitous-only fallback (no Tranzy)
      // wouldn't double-add this canonical name.
      seedByCanonical.set(canonical, tranzyRow);
      continue;
    }
    // Transitous-only route (Tranzy doesn't have it).
    if (byRouteId.has(r.routeId)) continue;
    const row = {
      route_id: String(r.routeId),
      agency_id: '2',
      route_short_name: shortName,
      route_long_name: r.longName ?? '',
      // `?? '3'` not `?` — see Step 1 comment; type=0 is valid.
      route_type: String(r.type ?? '3'),
      route_color: normalizeColor(r.color),
      route_text_color: normalizeColor(r.textColor),
      route_desc: '',
    };
    byRouteId.set(row.route_id, row);
    routes.push(row);
    if (canonical) seedByCanonical.set(canonical, row);
    transitousOnlyAdded++;
  }

  // ── Step 3: Producer-side defaults for the color pair, applied to
  // every row before serialization. Per the GTFS spec
  // (https://gtfs.org/documentation/schedule/reference/#routestxt):
  //   - route_color defaults to FFFFFF (white) when omitted.
  //   - route_text_color defaults to 000000 (black) when omitted.
  //   - The producer SHOULD ensure sufficient contrast between them.
  //
  // Tranzy never returns route_text_color, so most Tranzy-only rows
  // would ship with the field empty and consumers would resolve to
  // black per spec — producing black-on-black plates for the many
  // Tranzy routes with dark route_color. We pick a contrasting text
  // color (white on dark, black on light) when text_color is empty
  // and route_color is set, satisfying the contrast requirement
  // without overriding any explicit producer-supplied value.
  for (const row of routes) {
    if (!row.route_color) row.route_color = 'FFFFFF';
    if (!row.route_text_color) row.route_text_color = contrastingTextColor(row.route_color);
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