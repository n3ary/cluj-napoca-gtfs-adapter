import { describe, it, expect } from 'vitest';

import { reconcile } from '../src/assemble/index.js';
import { parseCtpCsv } from '../src/sources/ctp-csv/index.js';
import { fixtures } from './fixtures/index.js';
import { buildFixtureSeedMemory } from './fixtures/seed-builder.js';

function buildCsvByRouteService() {
  /** @type {Map<string, Map<string, any>>} */
  const out = new Map();
  for (const [shortName, bySvc] of Object.entries(fixtures.csv)) {
    const m = new Map();
    for (const [svcId, body] of Object.entries(bySvc)) {
      // Use the real parser so the structure matches what production produces
      // (incl. the frequencyAnnotations field).
      const parsed = parseCtpCsv(body);
      m.set(svcId, parsed);
    }
    out.set(shortName, m);
  }
  return out;
}

describe('reconcile', () => {
  const seed = buildFixtureSeedMemory();
  const csv = {
    byRouteService: buildCsvByRouteService(),
    warnings: [],
  };

  it('emits all required GTFS files', () => {
    const { files } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    expect(files['agency.txt']).toBeTruthy();
    expect(files['routes.txt']).toBeTruthy();
    expect(files['stops.txt']).toBeTruthy();
    expect(files['trips.txt']).toBeTruthy();
    expect(files['stop_times.txt']).toBeTruthy();
    expect(files['calendar.txt']).toBeTruthy();
    expect(files['feed_info.txt']).toBeTruthy();
  });

  it('route 22 from Tranzy (orange, neary-gtfs#14) is included with its Tranzy color', () => {
    // Non-black Tranzy colors are passed through unchanged; only black /
    // missing values get substituted with the per-type modal color.
    const { files } = reconcile({ seed, tranzy: fixtures.tranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    const routesLines = files['routes.txt'].split('\n');
    const r22 = routesLines.find((l) => l.startsWith('22,'));
    expect(r22).toBeTruthy();
    expect(r22).toMatch(/EF8732/);
  });

  it('M26 direction=1 is resolvable via Tranzy fallback (fixes #15)', () => {
    const { warnings } = reconcile({ seed, tranzy: fixtures.tranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    // We should NOT have a warning about M26 dir=1 having no pattern.
    const has = warnings.some((w) => w.message.includes('M26') && w.message.includes('dir=1') && w.message.includes('No pattern'));
    expect(has).toBe(false);
  });

  it('generates trip_ids in ${route}_${dir}_${serviceId}_${HHMM} format', () => {
    const { files } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    const tripLines = files['trips.txt'].split('\n').slice(1).filter(Boolean);
    expect(tripLines.length).toBeGreaterThan(0);
    const tripIdRe = /^[A-Za-z0-9]+_[01]_(LV|S|D|LD)(?:_FREQ)?_\d{4}$/;
    for (const line of tripLines) {
      const cols = line.split(',');
      const tripId = cols[2];
      // Format options:
      //   <route>_<dir>_<serviceId>_<HHMM>          (regular trip)
      //   <route>_<dir>_<serviceId>_FREQ_<HHMM>     (frequency anchor)
      // route may contain letters (M26, 25N). HHMM is the tail
      // (4 digits, no colon) — required for neary's parseLiveStartMin
      // fallback. We do NOT claim parity with the live RT feed's IDs;
      // the reconciler matches by (route, direction, time).
      expect(tripId).toMatch(tripIdRe);
      // Sanity: trip_id ends in 4 digits (HHMM tail).
      expect(tripId).toMatch(/_\d{4}$/);
    }
  });

  it('stop_times arrivals are monotonically non-decreasing within each trip', () => {
    const { files } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    const lines = files['stop_times.txt'].split('\n').slice(1).filter(Boolean);
    /** @type {Map<string, number[]>} */
    const byTrip = new Map();
    for (const line of lines) {
      const cols = line.split(',');
      const tripId = cols[0];
      const arrSec = hhmmssToSeconds(cols[1]);
      if (!byTrip.has(tripId)) byTrip.set(tripId, []);
      byTrip.get(tripId).push(arrSec);
    }
    for (const arr of byTrip.values()) {
      for (let i = 1; i < arr.length; i++) {
        expect(arr[i]).toBeGreaterThanOrEqual(arr[i - 1]);
      }
    }
  });

  it('stop_times preserves stop_sequence from the upstream pattern (seed or Tranzy)', () => {
    // Seed fixture has sequences 0, 1, 2 for route 35 dir=0 trips
    // (stops A, B, C). The reconciler must inherit those numbers,
    // not re-number with a fresh sequential index — re-numbering would
    // discard any non-contiguous numbering the operator uses.
    const { files } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    const lines = files['stop_times.txt'].split('\n').slice(1).filter(Boolean);
    /** @type {Map<string, Array<{stopId: string, sequence: number}>>} */
    const byTrip = new Map();
    for (const line of lines) {
      const cols = line.split(',');
      const tripId = cols[0];
      const seq = Number(cols[4]);
      const stopId = cols[3];
      if (!byTrip.has(tripId)) byTrip.set(tripId, []);
      byTrip.get(tripId).push({ stopId, sequence: seq });
    }
    // For trip 35_0_LV_0600 (35 dir=0 LV service at 06:00), the stops
    // are A, B, C with sequences 0, 1, 2 from the seed.
    const trip0600 = byTrip.get('35_0_LV_0600');
    expect(trip0600).toBeDefined();
    const seqByStop = Object.fromEntries(trip0600.map((s) => [s.stopId, s.sequence]));
    expect(seqByStop.A).toBe(0);
    expect(seqByStop.B).toBe(1);
    expect(seqByStop.C).toBe(2);
  });

  it('calendar.txt has LV, S, D entries (services we actually scraped)', () => {
    const { files } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    expect(files['calendar.txt']).toMatch(/^LV,/m);
    expect(files['calendar.txt']).toMatch(/^S,/m);
    expect(files['calendar.txt']).toMatch(/^D,/m);
  });

  it('drops phantom routes (Tranzy catalog entry but no trips anywhere) with a WARN', () => {
    // Synthetic Tranzy response that lists route 999 ("Phantom") in /routes
    // but provides no /trips or /stop_times for it — mirrors the live
    // behavior observed for route_id=117 (short_name="2") and
    // route_id=73 (short_name="M35") where Tranzy catalogs the route but
    // carries no trip data. The phantom-route filter in
    // `src/assemble/index.js` should drop these with a WARN.
    const phantomTranzy = {
      routes: [
        { route_id: '999', agency_id: 2, route_short_name: 'Phantom', route_long_name: 'Phantom Route', route_type: 3 },
      ],
      stops: [],
      trips: [],
      stop_times: [],
      shapes: [],
      calendar: [],
    };
    const { files, warnings } = reconcile({ seed, tranzy: phantomTranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    const routesLines = files['routes.txt'].split('\n').slice(1).filter(Boolean);
    expect(routesLines.find((l) => l.startsWith('999,'))).toBeUndefined();
    const phantomWarn = warnings.find((w) => w.message.includes('phantom route'));
    expect(phantomWarn).toBeDefined();
    expect(phantomWarn.severity).toBe('warn');
    expect(phantomWarn.message).toContain('Phantom');
    expect(phantomWarn.message).toContain('route_id=999');
  });

  it('keeps routes that have ONLY Tranzy fallback trips (no CSV)', () => {
    // Mirror real Tranzy-fallback behavior: a route with no CSV coverage
    // but with /trips + /stop_times in Tranzy data should still produce
    // _NTxxx synthetic trip rows and survive the phantom filter.
    const fallbackTranzy = {
      routes: [
        { route_id: '888', agency_id: 2, route_short_name: 'M99', route_long_name: 'M99 Metroline', route_type: 3 },
      ],
      stops: [],
      trips: [
        { trip_id: 'tranzy-M99-fwd', route_id: '888', direction_id: 0, trip_headsign: 'M99' },
      ],
      stop_times: [
        { trip_id: 'tranzy-M99-fwd', stop_id: 'A', stop_sequence: 0 },
        { trip_id: 'tranzy-M99-fwd', stop_id: 'B', stop_sequence: 1 },
      ],
      shapes: [],
      calendar: [],
    };
    const { files, warnings } = reconcile({ seed, tranzy: fallbackTranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    const routesLines = files['routes.txt'].split('\n').slice(1).filter(Boolean);
    expect(routesLines.find((l) => l.startsWith('888,'))).toBeDefined();
    const phantomWarn = warnings.find((w) => w.message.includes('phantom route'));
    expect(phantomWarn).toBeUndefined();
    // And the Tranzy fallback warning should be present.
    expect(warnings.some((w) => w.message.includes('Tranzy /trips fallback'))).toBe(true);
  });
});

function hhmmssToSeconds(hms) {
  const parts = hms.split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}