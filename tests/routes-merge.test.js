import { describe, it, expect } from 'vitest';

import { reconcileRoutes, routesToTxt } from '../src/assemble/merge/routes.js';

/** Minimal seed object shape consumed by reconcileRoutes. */
function seedOf(routes) {
  return { routes, agencyTxt: '' };
}

describe('reconcileRoutes — color spec compliance', () => {
  it("normalizes Tranzy's 3-char hex route_color to 6-char per GTFS spec", () => {
    // GTFS Color type requires six hex digits. Tranzy returns CSS
    // shorthand (e.g. '000') for ~80 CTP routes, which is non-compliant.
    // The adapter expands it rather than passing through.
    const tranzy = {
      routes: [
        { route_id: '50', route_short_name: '50', route_long_name: 'Test', route_type: 3, route_color: '000' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '50');
    expect(r.route_color).toBe('000000');
  });

  it('strips the leading # and uppercases route_color', () => {
    const tranzy = {
      routes: [
        { route_id: '51', route_short_name: '51', route_long_name: 'Test', route_type: 3, route_color: '#abcdef' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '51');
    expect(r.route_color).toBe('ABCDEF');
  });

  it("falls back to FFFFFF for route_color when Tranzy and seed both empty (matches GTFS consumer default)", () => {
    const tranzy = {
      routes: [
        { route_id: '52', route_short_name: '52', route_long_name: 'No Color', route_type: 3 },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '52');
    expect(r.route_color).toBe('FFFFFF');
  });
});

describe('reconcileRoutes — contrast-aware route_text_color', () => {
  it("picks white text on a dark route_color when Tranzy supplied no text color", () => {
    // route_color='000' (black) → contrast picker returns white.
    // GTFS consumer default for empty text_color is black, which would
    // produce black-on-black; the adapter's producer-side fallback
    // satisfies the spec's contrast requirement.
    const tranzy = {
      routes: [
        { route_id: '60', route_short_name: '60', route_long_name: 'Dark', route_type: 3, route_color: '000' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '60');
    expect(r.route_color).toBe('000000');
    expect(r.route_text_color).toBe('FFFFFF');
  });

  it('picks black text on a light route_color when text_color empty', () => {
    const tranzy = {
      routes: [
        { route_id: '61', route_short_name: '61', route_long_name: 'Light', route_type: 3, route_color: 'FFEE88' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '61');
    expect(r.route_text_color).toBe('000000');
  });

  it('honors an explicit route_text_color from Tranzy (no override)', () => {
    const tranzy = {
      routes: [
        { route_id: '62', route_short_name: '62', route_long_name: 'Custom', route_type: 3, route_color: '000', route_text_color: 'ABCDEF' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '62');
    expect(r.route_text_color).toBe('ABCDEF');
  });

  it("inherits Transitous's route_text_color when Tranzy left it empty", () => {
    const seed = seedOf([
      { routeId: '99', shortName: '99', longName: 'Shared', type: '3', color: 'D24CAE', textColor: 'EEEEEE' },
    ]);
    const tranzy = {
      routes: [
        { route_id: '888', route_short_name: '99', route_long_name: 'Shared', route_type: 3, route_color: 'D24CAE' },
      ],
    };
    const { routes } = reconcileRoutes({ seed, tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '99');
    expect(r.route_text_color).toBe('EEEEEE');
  });
});

describe('reconcileRoutes — route_type policy (Tranzy primary)', () => {
  it('preserves Tranzy route_type=0 (tram) — the GTFS enum value 0 is valid and falsy', () => {
    // Regression test for the truthiness bug: `r.route_type ? String(r.route_type) : '3'`
    // demoted every tram to bus because the number 0 is falsy in JS.
    // Tranzy correctly classifies CTP's four tram routes (100/101/102/102L)
    // as route_type=0; the adapter must ship them as type=0.
    const tranzy = {
      routes: [
        { route_id: '2', route_short_name: '100', route_long_name: 'Tram 100', route_type: 0, route_color: 'F3513C' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '100');
    expect(r.route_type).toBe('0');
  });

  it('honors Tranzy route_type even when Transitous disagrees on a shared route', () => {
    // Tranzy-primary by design: whatever Tranzy says ships, even when
    // Transitous's mdb-2121 mirror has a different value. Divergent
    // classifications are a Tranzy data-quality concern to raise
    // upstream, not something the adapter should second-guess.
    const seed = seedOf([
      { routeId: '40', shortName: '40', longName: 'Disputed', type: '0', color: '3BAC2C', textColor: 'FFFFFF' },
    ]);
    const tranzy = {
      routes: [
        { route_id: '888', route_short_name: '40', route_long_name: 'Disputed', route_type: 3, route_color: 'D24CAE' },
      ],
    };
    const { routes } = reconcileRoutes({ seed, tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '40');
    expect(r.route_type).toBe('3');
    // route_id is still re-keyed to Transitous for ID stability.
    expect(r.route_id).toBe('40');
  });

  it("inherits Transitous's route_type only when Tranzy is missing it entirely", () => {
    // If Tranzy returns a route with no route_type at all (truly null /
    // undefined), the row builder defaults to '3' (bus), then Step 2's
    // overlay would only swap to seed.type if Tranzy left it nullish.
    // With the current row-builder default of '3', this is hard to
    // observe directly — but the fill-only-if-Tranzy-missing semantics
    // are what the seed-overlay branch implements (using `== null`).
    const seed = seedOf([
      { routeId: '70', shortName: '70', longName: 'Test', type: '11', color: '3C4E9A', textColor: 'FFFFFF' },
    ]);
    const tranzy = {
      routes: [
        // route_type omitted intentionally.
        { route_id: '777', route_short_name: '70', route_long_name: 'Test', route_color: '3C4E9A' },
      ],
    };
    const { routes } = reconcileRoutes({ seed, tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '70');
    // Row builder defaults missing Tranzy type to '3'. The seed
    // overlay's `== null` check sees a populated value and leaves it
    // alone. Tranzy-primary: missing-from-Tranzy still wins over seed,
    // because the row builder already supplied the default.
    expect(r.route_type).toBe('3');
  });
});

describe('routesToTxt', () => {
  it('serializes route_color and route_text_color in the expected columns', () => {
    const tranzy = {
      routes: [
        { route_id: '7', route_short_name: '7', route_long_name: 'Plain', route_type: 3, route_color: 'D24CAE' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const txt = routesToTxt(routes);
    const [header, row] = txt.trim().split('\n');
    const cols = row.split(',');
    const headers = header.split(',');
    expect(cols[headers.indexOf('route_color')]).toBe('D24CAE');
    expect(cols[headers.indexOf('route_text_color')]).toBe('FFFFFF');
  });
});
