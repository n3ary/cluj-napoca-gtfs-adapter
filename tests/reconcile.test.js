import { describe, it, expect } from 'vitest';

import { reconcile } from '../src/reconcile/index.js';
import { parseCtpCsv } from '../src/sources/ctp-csv.js';
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

  it('route 22 from Tranzy (orange, neary-gtfs#14) is included', () => {
    const { files } = reconcile({ seed, tranzy: fixtures.tranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    const routesLines = files['routes.txt'].split('\n');
    const r22 = routesLines.find((l) => l.startsWith('22,'));
    expect(r22).toBeTruthy();
    expect(r22).toMatch(/EF8732/);
  });

  it('emits a data-quality warning for route 22 orange color (#14)', () => {
    const { warnings } = reconcile({ seed, tranzy: fixtures.tranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    expect(warnings.some((w) => w.includes('route 22') && w.includes('EF8732'))).toBe(true);
  });

  it('M26 direction=1 is resolvable via Tranzy fallback (fixes #15)', () => {
    const { warnings } = reconcile({ seed, tranzy: fixtures.tranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    // We should NOT have a warning about M26 dir=1 having no pattern.
    const has = warnings.some((w) => w.includes('M26') && w.includes('dir=1') && w.includes('No pattern'));
    expect(has).toBe(false);
  });

  it('generates canonical CTP-format trip_ids matching cluj-rt-feed.gtfs.ro', () => {
    const { files } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    const tripLines = files['trips.txt'].split('\n').slice(1).filter(Boolean);
    expect(tripLines.length).toBeGreaterThan(0);
    for (const line of tripLines) {
      const cols = line.split(',');
      const tripId = cols[2];
      // Pattern is one of:
      //   <route_id>_<dir>_<serviceId>_<seq>_<HHMM>          (regular trips)
      //   <route_id>_<dir>_<serviceId>_FREQ_<HHMM>            (frequency anchors)
      // route_id may contain letters (M26, 25N).
      expect(tripId).toMatch(
        /^[A-Za-z0-9]+_[01]_(LV|S|D|LD)(?:_\d+_\d{4}|_FREQ_\d{4})$/,
      );
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

  it('calendar.txt has LV, S, D entries (services we actually scraped)', () => {
    const { files } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    expect(files['calendar.txt']).toMatch(/^LV,/m);
    expect(files['calendar.txt']).toMatch(/^S,/m);
    expect(files['calendar.txt']).toMatch(/^D,/m);
  });
});

function hhmmssToSeconds(hms) {
  const parts = hms.split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}