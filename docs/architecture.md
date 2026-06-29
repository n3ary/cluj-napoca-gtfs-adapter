# Architecture

## Goal

Produce a **single** reconciled GTFS Schedule zip for CTP Cluj-Napoca
(`agency_id=2`) that combines:

- **Transitous seed** — curated structure, mdb-validated
- **Tranzy.ai** — live-updated static API, per-direction shapes
- **CTP CSV timetables** — authoritative departure times

…and is **always available** at a stable URL (GitHub Pages `binaries`
branch, via GitHub raw) so the [neary](https://github.com/ciotlosm/neary)
PWA can consume it like any other GTFS source.

## Why three sources?

CTP doesn't expose its schedule data through one canonical GTFS feed:

- **Tranzy.ai** is the live network state — 168 routes, 880+ stops,
  per-direction shapes (`<route>_<dir>` convention), up-to-date
  colors/headsigns. CTP city hall officially promotes Tranzy as their
  open-data partner (see `https://ctpcj.ro/index.php/ro/despre-noi/
  open-data-tranzy`). Tranzy carries stop ordering but **not** arrival
  times (`/stop_times` has no `arrival_time`).
- **Transitous** mirror (`mdb-2121`) is the curated secondary catalog —
  108 routes, 750 stops, mdb-validated coordinates and IDs. Updates
  irregularly (sometimes weeks stale — see
  [`neary-gtfs#1`](https://github.com/ciotlosm/neary-gtfs/issues/1)).
  Used by this adapter mainly for **ID stability**: downstream apps
  (notably `neary`) already key routes by Transitous `route_id`, and
  re-keying shared routes to Tranzy's internal IDs would break every
  catalog reference.
- **CTP CSV timetables** carry the real departure times per route per
  service day. CTP doesn't publish them for every route (~63 of ~298
  missing — same `neary-gtfs#1`).

The three sources are complementary. Reconciliation is the only way to
get a feed that's *complete*, *fresh*, and *correct* — and *stable in
the IDs downstream apps already key on*.

## Data flow

```
                  ┌─────────────────────────────────────────┐
                  │  GitHub Actions (cron 30 0 * * * UTC)   │
                  └────────────────────┬────────────────────┘
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            │                                                     │
            ▼                                                     ▼
   ┌─────────────────────┐                            ┌──────────────────┐
   │  Stage 1 — fetch    │                            │  Stage 2 — build │
   │  scripts/smoke-     │   .build-input/csv/        │  src/cli.js      │
   │  csv-parser.js      │   .build-input/csv-        │  build           │
   │                     │   status.json             │                  │
   │  Authoritative      │   (200-ok CSV bodies +    │  Reads CSVs from │
   │  route list:        │    manifest of every      │  disk. NEVER     │
   │   Tranzy union      │    attempt's outcome)     │  fetches.        │
   │   Transitous seed   │                            │                  │
   │                     │                            │  Reconciles      │
   │  Fetches every      │                            │  routes/stops/   │
   │  (route × service)  │                            │  shapes/trips/   │
   │  CSV from CTP.      │                            │  calendar →      │
   │  Writes body on     │                            │  GTFS zip.       │
   │  200-ok. Fails loud │                            │                  │
   │  on infra miss.     │                            │                  │
   └─────────────────────┘                            └──────────────────┘
```

**Why two phases?** Smoke acts as a gate — if upstream has a
WAF/HTTP/network failure, CI fails before build runs, so we never
produce a degraded zip. Single fetch per CSV per CI run (no double-fetch).

**Authoritative route source for smoke**: Tranzy (`/routes` endpoint)
+ Transitous seed (id stability). Tranzy is the source of truth for
*what CTP operates* (~168 routes vs Transitous's ~108); Transitous adds
id stability for shared routes so downstream apps (neary) keep their
keying on Transitous `route_id`. Transitous-only routes still get CSV
fetches in case CTP publishes them.

```
   ┌──────────────┐  ┌────────────┐         ┌──────────────────┐
   │  Transitous  │  │   Tranzy   │         │  CTP CSV scrape  │
   │  seed zip    │  │  /routes   │         │  ctpcj.ro/orare/ │
   │  (no auth)   │  │  /stops    │         │  csv/orar_*.csv  │
   │              │  │  /trips    │         │  (WAF headers)   │
   │              │  │  /shapes   │         │                  │
   │              │  │  /stop_tim │         │                  │
   │              │  │  (X-API-KEY│         │                  │
   │              │  │  + AGENCY) │         │                  │
   └──────┬───────┘  └─────┬──────┘         └────────┬─────────┘
          │                │                         │
          ▼                ▼                         ▼
       ┌──────────────────────────────────────────────────┐
       │              src/sources/                        │
       │   transitous.js   tranzy.js   ctp-csv.js         │
       │   (loadSeed)      (TranzyClient) (parseCtpCsv)   │
       └─────────────────────┬────────────────────────────┘
                             │
                             ▼
       ┌──────────────────────────────────────────────────┐
       │              src/reconcile/                      │
       │                                                  │
       │  1. seedPatterns    ← (route, dir) → stop list  │
       │  2. tranzyPatterns  ← (route, dir) → stop list  │
       │  3. csvDepartures   ← (route, dir, svc) → HH:MM  │
       │  4. routes.js       ← merge routes.txt          │
       │  5. stops.js        ← merge stops.txt           │
       │  6. shapes.js       ← merge shapes.txt          │
       │  7. trips.js        ← CSV × patterns → trips    │
       │  8. stop-times.js   ← computeStopTimes per trip │
       │  9. calendar.js     ← derive from CSV service   │
       │ 10. data-quality.js ← emit warnings (#14, #15)  │
       │                                                  │
       │  See docs/reconciliation-rules.md for priority   │
       │  table and edge-case handling.                   │
       └─────────────────────┬────────────────────────────┘
                             │
                             ▼
       ┌──────────────────────────────────────────────────┐
       │              src/gtfs.js                         │
       │   write .txt files → output/cluj-napoca.gtfs.zip │
       │   (agency, routes, stops, shapes, calendar,      │
       │    trips, stop_times, feed_info)                 │
       └─────────────────────┬────────────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  GitHub `binaries`   │
                  │  branch / GitHub raw  │
                  │  CDN                 │
                  └──────────────────────┘
```

## Components

### `src/sources/`

Thin adapters around each upstream. Each module:

- Returns normalized in-memory shapes (not upstream-specific row types).
- Treats partial failures (404, empty arrays) as warnings, not errors.
- Has zero dependencies on other modules — they can be composed freely.

#### `src/sources/transitous.js`

Wraps `loadSeed` from `src/lib/seed.js`. Single public function:
`loadTransitousSeed({ url, userAgent })`. Returns the parsed seed
(`{ routes, stops, trips, stopTimes, shapesById, agencyTxt }`).

#### `src/sources/tranzy.js`

The Node port of the `ctp-gtfs-adapter`'s `client.py`. Class
`TranzyClient` with one method per endpoint plus `fetchAll()`.

#### `src/sources/ctp-csv.js`

Two functions:
- `fetchAllCsvDepartures({ routes, serviceKeys, baseUrl })` — fans out
  to ~180 URLs (routes × service keys) with 4-way concurrency.
- `parseCtpCsv(text)` — single-CSV parser (rows 0..4 metadata, row 5+
  data table with the WAF-aware headers from `docs/csv-timetable-format.md`).

### `src/reconcile/`

The pipeline that produces the final output GTFS structure. **Tranzy
is the primary catalog** (see priority table in
[`docs/reconciliation-rules.md`](./reconciliation-rules.md)); Transitous
seed is the ID-stability overlay. Order:

1. `tranzyPatterns(routeId, dir)` — first trip's stop sequence from
   Tranzy, or null. Primary pattern source.
2. `seedPatterns(routeId, dir)` — same lookup against Transitous seed.
   Fallback when Tranzy doesn't have this direction (the case behind
   `neary-gtfs#13` 25N dir=1 was solved when Tranzy got the direction;
   the case behind `#15` M26 dir=1 was solved by Tranzy having it).
3. `csvDepartures(routeId)` — map of `(dir, serviceId) → HH:MM[]`.
4. `routes.js` — Tranzy first (all Tranzy rows included with Tranzy
   `route_id`); Transitous overlay re-keys shared routes (matched by
   `route_short_name`) to Transitous's `route_id` for downstream
   stability, and adds Transitous-only routes.
5. `stops.js` — Tranzy first (~880 stops); Transitous fills the legacy
   few hundred Transitous has but Tranzy doesn't.
6. `shapes.js` — Tranzy first (per-direction shapes); Transitous fills
   legacy shapes.
7. `trips.js` — for each CSV departure, pick the pattern (Tranzy
   primary), generate `trip_id` (format
   `${route}_${dir}_${serviceId}_${HHMM}`), write trip row. Validates
   the CSV's `in_stop_name` / `out_stop_name` header against the
   pattern's terminal stops and skips the CSV terminal as a headsign
   fallback on mismatch (see `src/reconcile/trips.js`
   `terminalNamesMatch`). Emits `timepoint='0'` on every stop_time row
   since our arrival/departure times are interpolated, not authoritative.
8. `stop-times.js` — for each trip, compute per-stop arrival/departure
   times via `computeStopTimes()` from `lib/timing.js`.
9. `calendar.js` — service-id → weekday-bool map from CSV keys scraped.
10. `data-quality.js` — emit warnings (#14, #15, M26, M26N, Route 22, etc.).

### `src/lib/` (vendored from `neary-gtfs`)

Pure helpers, no I/O:

- `seed.js` — load GTFS zip from path/URL.
- `timing.js` — `pickSpeedBucket()` + `computeStopTimes()` (peak/offpeak/
  night speed model + shape projection + dwell).
- `csv.js` — RFC4180-ish GTFS CSV parser (for reading the seed).
- `polyline.js` — project stops onto polyline, haversine fallback.

### `src/gtfs.js`

The output writer. Given the merged in-memory structures from
`src/reconcile/`, writes the eight required GTFS `.txt` files plus
`feed_info.txt` into a zip using `archiver`.

### `src/cli.js`

Single entry point:

```bash
node src/cli.js build           # full pipeline → output/cluj-napoca.gtfs.zip
node src/cli.js validate [path]  # check a produced zip
node src/cli.js reconcile --dry  # print what would change, don't write
```

## Deployment

GitHub Actions cron at `30 0 * * *` UTC (after Transitous's daily ~00:00
UTC import). Steps:

1. Checkout this repo.
2. Setup Node 24, `npm ci`.
3. `node src/cli.js build` with `TRANZY_API_KEY` from repo secret.
4. Push `output/cluj-napoca.gtfs.zip` to the `binaries` branch (orphan,
   same pattern as `neary-gtfs/.github/workflows/daily.yml`).
5. GitHub raw serves it at
   `https://raw.githubusercontent.com/ciotlosm/cluj-napoca-gtfs-adapter/binaries/output/cluj-napoca.gtfs.zip`.

The `neary-gtfs` pipeline then mirrors this URL into its `binaries`
branch's `feeds.json` (or directly via a `realtime.zip` style entry)
instead of running its own `feeds/cluj-napoca/build.js`. The vestigial
`tranzy` field in `feeds/cluj-napoca/config.json` gets removed at that
point.

## What lives in `neary-gtfs` after this lands

| Today | After |
|---|---|
| `feeds/cluj-napoca/build.js` — 339-line enhancement script | Removed; replaced by fetching this adapter's zip. |
| `feeds/cluj-napoca/config.json` — declarative metadata | Kept as a thin config that points at this adapter's URL. |
| `feeds/cluj-napoca/lib/{seed,timing}.js` — vendored | Kept in their original locations (already shared via copy). |
| `tranzy` field in config (vestigial) | Removed. |
| Daily pipeline: `node src/pipeline/build-all.js` | Daily pipeline: same + a new "fetch adapter URL, store locally" step for the Cluj feed. |

The bigger refactor — collapsing the `neary-gtfs` pipeline into a
"download + SQLite" pipeline that consumes upstream feeds directly — is a
separate task. The minimum viable step is the deletion of
`feeds/cluj-napoca/build.js` and the config's `tranzy` field.