import { describe, it, expect } from 'vitest';

import {
  CATEGORIES,
  classifyRoute,
  cleanLongName,
  deriveLongNameFromStops,
  applyRouteCategory,
  getAllCategories,
} from '../src/assemble/merge/routeCategory.js';

describe('classifyRoute — pattern → category', () => {
  it('classifies TE-prefixed school buses as "Transport Elevi"', () => {
    expect(classifyRoute({ route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyRoute({ route_short_name: 'TE14' })).toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyRoute({ route_short_name: 'TE-OG' })).toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('classifies M7x school buses whose long_name starts with "TE\\d+ Floresti" as "Transport Elevi"', () => {
    // The M75A-M79C family is numbered with the metroline M prefix
    // because they go to Floresti, but their long_name carries the
    // school destination.
    expect(classifyRoute({
      route_short_name: 'M76A',
      route_long_name: 'TE2 Floresti str. Somesului',
    })).toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyRoute({
      route_short_name: 'M75B',
      route_long_name: 'TE1F',
    })).toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('catches "Elevi" substring case-insensitively across all 3 fields', () => {
    // Defensive: any route CTP names with "Elevi" anywhere counts as a
    // school bus — covers operator-named variants we haven't seen.
    expect(classifyRoute({ route_short_name: 'X1', route_long_name: 'Some elevi variant' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyRoute({ route_short_name: 'X2', route_long_name: '', route_desc: 'Elevi route' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyRoute({ route_short_name: 'ELEVI-99', route_long_name: '' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('classifies *U suffix + "(untold)" annotation as "Untold"', () => {
    expect(classifyRoute({ route_short_name: '30U', route_long_name: 'Grigorescu - IRA' }))
      .toEqual({ id: 'festival', label: 'Untold' });
    expect(classifyRoute({
      route_short_name: 'M26U',
      route_long_name: 'Uzinei Electrice - Floresti / Cetate (untold)',
    })).toEqual({ id: 'festival', label: 'Untold' });
    // After cleanup, "(untold)" is gone — pattern must still match via
    // the "untold" substring (no parens).
    expect(classifyRoute({ route_short_name: '30U', route_long_name: 'Grigorescu - IRA Untold' }))
      .toEqual({ id: 'festival', label: 'Untold' });
    // "Untold" in route_desc (Tranzy's pre-classification value).
    expect(classifyRoute({ route_short_name: '99', route_long_name: '', route_desc: 'Untold festival' }))
      .toEqual({ id: 'festival', label: 'Untold' });
  });

  it('classifies *N suffix + "Noapte" long_name as "Noapte"', () => {
    expect(classifyRoute({ route_short_name: '25N', route_long_name: 'Str. Bucium - Str. Unirii' }))
      .toEqual({ id: 'night', label: 'Noapte' });
    expect(classifyRoute({ route_short_name: '5N', route_long_name: 'Noapte Traian Vuia' }))
      .toEqual({ id: 'night', label: 'Noapte' });
    expect(classifyRoute({ route_short_name: '99', route_long_name: '', route_desc: 'Noapte special' }))
      .toEqual({ id: 'night', label: 'Noapte' });
  });

  it('classifies A1 / Aeroport long_name as "Aeroport Express"', () => {
    expect(classifyRoute({ route_short_name: 'A1', route_long_name: 'Piata Mihai Viteazu - Aeroport' }))
      .toEqual({ id: 'airport', label: 'Aeroport Express' });
    expect(classifyRoute({ route_short_name: '99', route_long_name: 'Some Route Aeroport Express' }))
      .toEqual({ id: 'airport', label: 'Aeroport Express' });
    expect(classifyRoute({ route_short_name: '99', route_long_name: '', route_desc: 'aeroport shuttle' }))
      .toEqual({ id: 'airport', label: 'Aeroport Express' });
  });

  it('does NOT classify D51 as commuter (D51 is employee-only / convention, not public commuter)', () => {
    // Per ctpcj.ro: D51 is "linie de transport dedicată exclusiv angajaților
    // (personalului navigant și tehnic) sau curselor de tip
    // „Divertisment/Convenție”". It's not a public commuter rail pattern.
    // The category was removed; D51 should fall through as regular urban.
    expect(classifyRoute({ route_short_name: 'D51', route_long_name: 'D51' })).toBeNull();
    expect(classifyRoute({ route_short_name: 'D99', route_long_name: 'Anywhere' })).toBeNull();
  });

  it('classifies M* (non-school) as "Metropolitana"', () => {
    expect(classifyRoute({ route_short_name: 'M11', route_long_name: 'P-ta Cipariu - Feleacu' }))
      .toEqual({ id: 'metroline', label: 'Metropolitana' });
    expect(classifyRoute({ route_short_name: 'M26', route_long_name: 'Floresti - Cluj Napoca' }))
      .toEqual({ id: 'metroline', label: 'Metropolitana' });
  });

  it('classifies CS as "Cursa Speciala"', () => {
    expect(classifyRoute({ route_short_name: 'CS', route_long_name: 'CURSA SPECIALA' }))
      .toEqual({ id: 'special', label: 'Cursa Speciala' });
    expect(classifyRoute({ route_short_name: 'CS', route_long_name: '', route_desc: 'CURSA SPECIALA' }))
      .toEqual({ id: 'special', label: 'Cursa Speciala' });
  });

  it('returns null for regular urban routes that match no category', () => {
    expect(classifyRoute({ route_short_name: '1', route_long_name: 'Str. Bucium - P-ta 1 Mai' }))
      .toBeNull();
    expect(classifyRoute({ route_short_name: '24', route_long_name: 'Str. Unirii - Str. Bucium' }))
      .toBeNull();
    expect(classifyRoute({ route_short_name: '101', route_long_name: 'Tram line 101' }))
      .toBeNull();
  });

  it('respects priority order (most-specific wins)', () => {
    // Pin the documented priority: special → school → festival → night →
    // airport → metropolitana. Bumping a category earlier changes
    // behavior for routes that match multiple patterns, so this is a
    // public contract.
    expect(CATEGORIES.map((c) => c.id)).toEqual([
      'special', 'school', 'festival', 'night', 'airport', 'metroline',
    ]);
  });

  it('treats missing/undefined short_name and long_name as empty strings', () => {
    expect(() => classifyRoute({})).not.toThrow();
    expect(classifyRoute({})).toBeNull();
  });
});

describe('cleanLongName — start-end format', () => {
  it('strips trailing parenthetical annotations', () => {
    expect(cleanLongName({ route_short_name: 'M26U', route_long_name: 'Uzinei Electrice - Floresti / Cetate (untold)' }))
      .toBe('Uzinei Electrice - Floresti / Cetate');
    expect(cleanLongName({ route_short_name: '88A', route_long_name: 'Floresti Cetate - Emerson (traseu M21)' }))
      .toBe('Floresti Cetate - Emerson');
    expect(cleanLongName({ route_short_name: 'M26N', route_long_name: 'Floresti - Cluj Napoca' }))
      .toBe('Floresti - Cluj Napoca');
  });

  it('strips "Transport Elevi -" / "Transport Elevi " prefix for school routes', () => {
    expect(cleanLongName({ route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur' }))
      .toBe('Manastur');
    expect(cleanLongName({ route_short_name: 'TE6', route_long_name: 'Transport Elevi-Manastur - Kogalniceanu' }))
      .toBe('Manastur - Kogalniceanu');
    expect(cleanLongName({ route_short_name: 'TE7', route_long_name: 'Transport Elevi-Bucium - Kogalniceanu' }))
      .toBe('Bucium - Kogalniceanu');
  });

  it('strips "TE\\d+ Floresti" prefix from M7x school routes', () => {
    expect(cleanLongName({ route_short_name: 'M76A', route_long_name: 'TE2 Floresti str. Somesului' }))
      .toBe('str. Somesului');
    expect(cleanLongName({ route_short_name: 'M79A', route_long_name: 'TE5 Floresti Tauti Floresti' }))
      .toBe('Tauti Floresti');
  });

  it('clears long_name for CS (no fixed endpoints to describe)', () => {
    expect(cleanLongName({ route_short_name: 'CS', route_long_name: 'CURSA SPECIALA' })).toBe('');
  });

  it('returns start-end unchanged when already clean', () => {
    expect(cleanLongName({ route_short_name: '1', route_long_name: 'Str. Bucium - P-ta 1 Mai' }))
      .toBe('Str. Bucium - P-ta 1 Mai');
    expect(cleanLongName({ route_short_name: '25', route_long_name: 'Str. Bucium - Str. Unirii' }))
      .toBe('Str. Bucium - Str. Unirii');
  });

  it('handles empty/undefined long_name gracefully', () => {
    expect(cleanLongName({ route_short_name: '1' })).toBe('');
    expect(cleanLongName({ route_short_name: '1', route_long_name: '' })).toBe('');
  });

  it('trims whitespace', () => {
    expect(cleanLongName({ route_short_name: '1', route_long_name: '  Str. Bucium - P-ta 1 Mai  ' }))
      .toBe('Str. Bucium - P-ta 1 Mai');
  });
});

describe('deriveLongNameFromStops — fallback when cleanup leaves long_name empty', () => {
  // Minimal shape — only fields actually used.
  const stopsByStopId = new Map([
    ['A', { stop_name: 'Piata Garii' }],
    ['B', { stop_name: 'Sala Sporturilor' }],
    ['C', { stop_name: 'Cart. Zorilor' }],
    ['D', { stop_name: 'Gara' }],
    ['E', { stop_name: 'Selimbar' }],
    ['Z', { stop_name: 'Circular Start' }],
  ]);

  it('returns "<first> - <last>" from the longest trip of the route', () => {
    const allStopTimeRows = [
      // Short trip (2 stops) for route 35
      { trip_id: 'short', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 'short', stop_id: 'B', stop_sequence: 1 },
      // Long trip (3 stops) — should win
      { trip_id: 'long', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 'long', stop_id: 'B', stop_sequence: 1 },
      { trip_id: 'long', stop_id: 'C', stop_sequence: 2 },
    ];
    const tripToRoute = new Map([['short', '35'], ['long', '35']]);
    expect(deriveLongNameFromStops({
      routeId: '35', allStopTimeRows, tripToRoute, stopsByStopId,
    })).toBe('Piata Garii - Cart. Zorilor');
  });

  it('returns "" when no stop_times exist for the route', () => {
    const allStopTimeRows = [{ trip_id: 't1', stop_id: 'A', stop_sequence: 0 }];
    const tripToRoute = new Map([['t1', 'OTHER']]);
    expect(deriveLongNameFromStops({
      routeId: '35', allStopTimeRows, tripToRoute, stopsByStopId,
    })).toBe('');
  });

  it('returns "" when first/last stop ids do not resolve to names', () => {
    const allStopTimeRows = [
      { trip_id: 't1', stop_id: 'UNKNOWN1', stop_sequence: 0 },
      { trip_id: 't1', stop_id: 'UNKNOWN2', stop_sequence: 1 },
    ];
    const tripToRoute = new Map([['t1', '35']]);
    expect(deriveLongNameFromStops({
      routeId: '35', allStopTimeRows, tripToRoute, stopsByStopId,
    })).toBe('');
  });

  it('returns "" for circular services (first stop == last stop)', () => {
    // Pin against emitting "X - X" which would mislead users.
    const allStopTimeRows = [
      { trip_id: 't1', stop_id: 'Z', stop_sequence: 0 },
      { trip_id: 't1', stop_id: 'Z', stop_sequence: 1 },
    ];
    const tripToRoute = new Map([['t1', 'CIRC']]);
    expect(deriveLongNameFromStops({
      routeId: 'CIRC', allStopTimeRows, tripToRoute, stopsByStopId,
    })).toBe('');
  });

  it('returns "" for single-stop trips (no start/end to extract)', () => {
    const allStopTimeRows = [
      { trip_id: 't1', stop_id: 'A', stop_sequence: 0 },
    ];
    const tripToRoute = new Map([['t1', '35']]);
    expect(deriveLongNameFromStops({
      routeId: '35', allStopTimeRows, tripToRoute, stopsByStopId,
    })).toBe('');
  });

  it('returns "" when inputs are missing (defensive)', () => {
    expect(deriveLongNameFromStops({})).toBe('');
  });
});

describe('applyRouteCategory — orchestrator entry point', () => {
  const stopsByStopId = new Map([
    ['A', { stop_name: 'Piata Garii' }],
    ['B', { stop_name: 'Sala Sporturilor' }],
    ['C', { stop_name: 'Cart. Zorilor' }],
  ]);

  function setup() {
    const allStopTimeRows = [
      { trip_id: 't-93', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-93', stop_id: 'B', stop_sequence: 1 },
      { trip_id: 't-93', stop_id: 'C', stop_sequence: 2 },
      { trip_id: 't-1',  stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-1',  stop_id: 'C', stop_sequence: 1 },
    ];
    const tripToRoute = new Map([['t-93', '93'], ['t-1', '1']]);
    const routes = [
      { route_id: '93', route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur', route_desc: '' },
      { route_id: '1',  route_short_name: '1',  route_long_name: 'Str. Bucium - P-ta 1 Mai',   route_desc: '' },
      // Route with empty long_name (e.g. Tranzy never published one).
      // Should fall back to stop_times.
      { route_id: '99', route_short_name: '99', route_long_name: '', route_desc: '' },
    ];
    return { routes, allStopTimeRows, tripToRoute };
  }

  it('cleans long_name, classifies, and mutates route_desc', () => {
    const { routes, allStopTimeRows, tripToRoute } = setup();
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.classifiedCount).toBe(1); // TE1 only
    expect(routes[0].route_long_name).toBe('Manastur');
    expect(routes[0].route_desc).toBe('Transport Elevi');
    expect(routes[1].route_long_name).toBe('Str. Bucium - P-ta 1 Mai');
    expect(routes[1].route_desc).toBe(''); // regular urban
  });

  it('falls back to stop_times when long_name is empty after cleanup', () => {
    // Build a fresh scenario where route 99 has empty long_name AND
    // matching stop_times available.
    const allStopTimeRows = [
      { trip_id: 't-99', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-99', stop_id: 'B', stop_sequence: 1 },
      { trip_id: 't-99', stop_id: 'C', stop_sequence: 2 },
    ];
    const tripToRoute = new Map([['t-99', '99']]);
    const routes = [
      { route_id: '99', route_short_name: '99', route_long_name: '', route_desc: '' },
    ];
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.longNameDerivedCount).toBe(1);
    expect(result.longNameUnresolvedCount).toBe(0);
    expect(routes[0].route_long_name).toBe('Piata Garii - Cart. Zorilor');
  });

  it('falls back when route has empty long_name AND stop_times available', () => {
    const allStopTimeRows = [
      { trip_id: 't-99', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-99', stop_id: 'B', stop_sequence: 1 },
      { trip_id: 't-99', stop_id: 'C', stop_sequence: 2 },
    ];
    const tripToRoute = new Map([['t-99', '99']]);
    const routes = [
      { route_id: '99', route_short_name: '99', route_long_name: '', route_desc: '' },
    ];
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.longNameDerivedCount).toBe(1);
    expect(routes[0].route_long_name).toBe('Piata Garii - Cart. Zorilor');
  });

  it('counts unresolved routes (empty long_name AND no stop_times fallback)', () => {
    const routes = [
      { route_id: '99', route_short_name: '99', route_long_name: '', route_desc: '' },
    ];
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows: [], tripToRoute: new Map(), stopsByStopId, warnings,
    });
    expect(result.longNameUnresolvedCount).toBe(1);
    expect(routes[0].route_long_name).toBe('');
  });

  it('emits an INFO warning summarizing classified / cleaned / derived counts', () => {
    const { routes, allStopTimeRows, tripToRoute } = setup();
    const warnings = [];
    applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    const info = warnings.find((w) => w.severity === 'info' && w.message.includes('classified'));
    expect(info).toBeDefined();
    expect(info.message).toMatch(/classified 1/);
    expect(info.message).toMatch(/cleaned 1/);
  });

  it('does not emit a warning when nothing changes', () => {
    const allStopTimeRows = [{ trip_id: 't-1', stop_id: 'A', stop_sequence: 0 }];
    const tripToRoute = new Map([['t-1', '1']]);
    const routes = [
      { route_id: '1', route_short_name: '1', route_long_name: 'A - B', route_desc: 'A - B' },
    ];
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.classifiedCount).toBe(0);
    expect(result.longNameCleanedCount).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe('getAllCategories — networks emission input', () => {
  it('returns the full category list with id + label', () => {
    const all = getAllCategories();
    expect(all.length).toBe(CATEGORIES.length);
    for (const c of all) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('label');
      expect(typeof c.id).toBe('string');
      expect(typeof c.label).toBe('string');
    }
  });

  it('exposes the categories neary will need to render', () => {
    const ids = getAllCategories().map((c) => c.id);
    expect(ids).toContain('school');
    expect(ids).toContain('festival');
    expect(ids).toContain('night');
    expect(ids).toContain('airport');
    expect(ids).toContain('metroline');
    expect(ids).toContain('special');
    // Commuter was removed — D51 isn't a public commuter rail route.
    expect(ids).not.toContain('commuter');
  });

  it('uses Romanian labels (matches ctpcj.ro terminology)', () => {
    const labels = Object.fromEntries(getAllCategories().map((c) => [c.id, c.label]));
    expect(labels.night).toBe('Noapte');
    expect(labels.metroline).toBe('Metropolitana');
    expect(labels.school).toBe('Transport Elevi');
    expect(labels.festival).toBe('Untold');
    expect(labels.airport).toBe('Aeroport Express');
    expect(labels.special).toBe('Cursa Speciala');
  });
});