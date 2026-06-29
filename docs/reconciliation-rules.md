# Reconciliation rules

> **Single source of truth** for the question: *"source A and source B
> disagree about the same field — which wins?"*
>
> If you change anything here, update `docs/known-limitations.md` to
> reflect the new gaps and `tests/reconcile.test.js` to cover the case.

## Inputs

The adapter pulls from three independent sources for the same operator
(CTP Cluj-Napoca, `agency_id=2`):

| Source | Endpoint / file | Strong on | Weak on |
|---|---|---|---|
| **Transitous seed** | `https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip` | Curated, mdb-validated structure. `mdb-2121` mirror. Has authoritative `stop_times.txt` for routes whose CTP CSV is missing. | Update cadence is irregular — sometimes weeks stale (`neary-gtfs#1`). Missing entire directions for some routes (`neary-gtfs#13` for 25N, `#15` for M26). |
| **Tranzy.ai static** | `https://api.tranzy.ai/v1/opendata/{routes,stops,trips,stop_times,shapes}` | Live-updated routes/stops/headsigns/shapes. Per-direction shapes (`<route>_<dir>` shape_id convention). | No `arrival_time` / `departure_time`. No `calendar.txt` for most agencies (404). IDs are internal to Tranzy, may differ from Transitous. |
| **CTP CSV timetables** | `https://ctpcj.ro/orare/csv/orar_<route>_<serviceKey>.csv` | Authoritative departure times per route × service day. Fresh (hours, not weeks). Terminal stop names. | Per-route per-service-day, no full network shape. Some routes publish nothing (63 of ~300 per `neary-gtfs#1`). The CSV's dir0 column sometimes carries frequency annotations instead of times (`neary-gtfs#15` M26). |

## Priority table

The rule is **"more curated wins for structure, more recent wins for
labels, only CSV wins for actual times."** Read the **Rationale** column
before changing a priority — it captures the *why*, not just the *what*.

| Field | Primary | Fallback 1 | Fallback 2 | Last resort | Rationale |
|---|---|---|---|---|---|
| `agency` | Transitous seed | — | — | synthesized from config | Why seed: `agency.txt` only needs one row; Transitous's curated single-agency row is canonical for Cluj. Why synthesized last resort: if both seed and Tranzy are silent, fall back to a `.env`-driven row so the output stays valid GTFS. |
| `routes[].route_id` | Transitous seed | Tranzy | — | — | Why seed: Transitous IDs are stable, mdb-curated, and what downstream consumers already key on. Why Tranzy: routes CTP added since Transitous's last import. |
| `routes[].route_short_name` | Transitous seed | Tranzy | CSV URL filename | — | Why seed: curated, stable. Why Tranzy: fills routes missing from seed. Why CSV last: the URL filename (`orar_35_lv.csv`) embeds the short name CTP publishes, but it's the weakest source — CSV can have typos or different casing than the network data. |
| `routes[].route_long_name` | Transitous seed | Tranzy | CSV row 0 `route_long_name` | `route_short_name` | Why seed: curated long names. Why Tranzy: more recent renaming. Why CSV row 0: rows 0 of the CSV carries the literal long-name string (e.g. `"Zorilor - Marasti"`), which is what CTP uses on their own timetable pages. |
| `routes[].route_type` | Transitous seed | Tranzy | 3 (bus default) | — | Why seed: Transitous's type codes follow GTFS spec. Why Tranzy: same. Why bus default: Cluj is overwhelmingly buses (88 of ~107 routes per `neary-gtfs#14`); if all upstream is missing the type, defaulting to bus is the least-wrong answer. |
| `routes[].route_color` | Transitous seed | Tranzy | type-default palette | — | Why seed: Transitous inherits CTP's published color. Why Tranzy: same, when seed missing. Why type-default palette: when both upstream missing, fall back to CTP-type palette (bus=magenta, tram=green, trolleybus=blue — per `neary-gtfs#14`). |
| `routes[].route_text_color` | Transitous seed | Tranzy | FFFFFF | — | Why seed: same logic as `route_color`. Why FFFFFF last: white-on-color is the safe default for signage contrast. |
| `stops[].stop_id` | Transitous seed | Tranzy | — | — | Why seed: curated IDs are stable across imports. Why Tranzy: stops added after Transitous's last import. |
| `stops[].stop_name` | Transitous seed | Tranzy | — | — | Why seed: curated stop names follow the operator's published signage. Why Tranzy: more recent renames. Why no CSV fallback: the CSV doesn't carry per-stop names. |
| `stops[].stop_lat` / `stop_lon` | Transitous seed | Tranzy | — | — | Why seed: Transitous applies mdb-validated coordinate cleanup. Why Tranzy: GPS-surveyed coordinates; fills gaps. Why no third fallback: a stop without coordinates is unusable — drop rather than guess. |
| `stops[].stop_code` | Transitous seed (sometimes Roman — see warning) | Tranzy | empty | — | Why seed: Transitous passes through CTP's signage code. Why Tranzy: same source, when seed missing. Why empty last resort: don't synthesize a code — most consumers look up by `stop_id` anyway, and the Roman-numeral quirk makes guessing hazardous. |
| `shapes[].shape_id` | Transitous seed (mdb-2121) | Tranzy (`<route>_<dir>` convention) | synthesized from stop sequence | — | Why seed: Transitous's shape IDs are stable and what `neary-gtfs` already keys on. Why Tranzy: per-direction shapes (`35_0`, `35_1`) when seed missing — the convention FOL documents in `extract_direction_from_shape_id`. |
| `shapes[].shape_pt_*` | Transitous seed | Tranzy | haversine between consecutive stops | — | Why seed: mdb-validated polyline. Why Tranzy: live polyline. Why haversine: when both upstream missing, fall back to straight-line interpolation between stops — gives at least a renderable route on the map. |
| `trips[].trip_id` | **generated** — canonical CTP format `${route_id}_${dir}_${serviceId}_${seq}_${HHMM}` | — | — | — | Why generated (not from any source): the trip ID must match `cluj-rt-feed.gtfs.ro` GTFS-RT for JOINs to work. That format is a *contract* between this adapter and the upstream RT feed, not data from any single source. See `docs/known-limitations.md` §8 for the verification story. |
| `trips[].route_id` | CSV's URL filename (matches Transitous `route_short_name`) | Transitous seed | Tranzy | — | Why CSV URL first: the CSV is the authoritative source for *which routes have published schedules* — without it, we wouldn't be generating this trip. The URL embeds `route_short_name` which we resolve to `route_id` via the seed. Why seed: if CSV's short name collides with multiple seed entries, the seed wins on disambiguation. |
| `trips[].direction_id` | CSV column index (0 = first col, 1 = second col) | — | — | — | Why CSV column: each data row in the CSV has TWO columns of departures — column 0 is direction 0 (forward), column 1 is direction 1 (return). This is the only place direction info lives in the CSV. |
| `trips[].service_id` | CSV URL key mapped via `serviceIdMap` (`lv → LV`, `s → S`, `d → D`, `ld → LD`) | — | — | — | Why CSV URL key: each CSV is downloaded with a service-day suffix in the URL (`..._lv.csv`, `..._s.csv`). That suffix, mapped through `serviceIdMap`, becomes the GTFS `service_id`. Most precise source — it's literally how we decided to download this CSV. |
| `trips[].trip_headsign` | Tranzy (live) | Transitous seed | CSV `out_stop_name` (dir0) / `in_stop_name` (dir1) | `route_long_name` | Why Tranzy first (overriding the general "seed wins structure" rule): headsign is a *label*, not structural. Tranzy refreshes labels when CTP renames termini. Seed's headsign is stale if CTP changed it. Why CSV last resort: rows 3 and 4 of the CSV carry `in_stop_name` and `out_stop_name` — the terminal labels from CTP's published timetable (rows 0-4 are metadata; see `docs/csv-timetable-format.md`). |
| `trips[].shape_id` | Tranzy `<route>_<dir>` | Transitous seed | synthesized `${route_id}_${dir}` | empty | Why Tranzy first (again "label" logic): per-direction shape is the canonical routing geometry — Tranzy's `<route>_<dir>` is the convention. Why seed: when Tranzy missing, seed's shape (if any) carries over. Why synthesized last: synthesize from `route_id`+`dir` so consumers always have something to look up. |
| `stop_times[].stop_id` | pattern lookup (seed pattern OR Tranzy fallback per `patterns.js`) | — | — | — | Why pattern lookup: stop_times are generated by walking the resolved pattern's stop sequence, so `stop_id` comes from the pattern, not a separate source. |
| `stop_times[].arrival_time` / `departure_time` | **synthesized** via `computeStopTimes()` from CSV's first departure time + `timing.js` | — | — | — | Why synthesized: CSV gives us origin departure time only. The rest comes from `computeStopTimes()` which projects the origin time across the pattern using shape-aware distance + peak/offpeak/night speed buckets + dwell. This is the only way to produce per-stop times without authoritative schedule data. See `lib/timing.js`. |
| `stop_times[].stop_sequence` | pattern index (0-based) | — | — | — | Why pattern index: stop_times are emitted in pattern order; the sequence is the index in the resolved pattern. Not a separate source. |
| `stop_times[].shape_dist_traveled` | `cumulativeShapeDistances()` from the chosen shape | — | — | — | Why from shape: GTFS spec defines this as distance along the trip's shape. We use `cumulativeShapeDistances()` (vendored from `neary-gtfs`) which projects each stop onto the polyline, with haversine fallback for off-shape stops. |
| `calendar[].service_id` | `LV` / `S` / `D` / `LD` derived from CSV keys actually scraped | — | Tranzy (if 200) | synthesized | Why derived from CSV keys: each CSV we successfully parse confirms a service_id is active. We don't synthesize services we have no evidence for. Why Tranzy fallback: Tranzy's `/calendar` returns 404 for most agencies, but if it ever returns 200 we'd include those service_ids. |
| `calendar[].start_date` / `end_date` | build date + `GTFS_CALENDAR_DAYS` (default 180) | Tranzy | today only | — | Why build date + window: GTFS schedules are forward-looking. We publish "today + 6 months" which covers any consumer's planning window without locking in dates we can't validate against the seed. Why Tranzy fallback: Tranzy has real service windows if it ever exposes them. |
| `calendar[].{mon..sun}` | hardcoded service-day table (LV = M-F, S = Sat, D = Sun, LD = all) | Tranzy | — | — | Why hardcoded: the mapping is by definition — LV literally means "Luni-Vineri" (Monday-Friday) in Romanian. There's nothing to reconcile. |
| `feed_info` | static (publisher name, version = ISO date) | — | — | — | Why static: `feed_info` is meta about the producer of this feed, not data. We identify as `cluj-napoca-gtfs-adapter` and version by build date. Never overridden by upstream sources. |

## Pattern-resolution algorithm

For each `(route_id, direction_id)` pair that has CSV departures, we
need a stop sequence (the "pattern") to anchor the schedule:

```
function patternFor(routeId, directionId):
    seed = seedPatterns[routeId][directionId]    // Transitous seed
    if seed exists:
        return { stops: seed.stopSequence, shapeId: seed.shapeId, source: 'seed' }
    
    tranzy = tranzyPatterns[routeId][directionId]   // Tranzy shapes
    if tranzy exists:
        return { stops: tranzy.stopSequence, shapeId: tranzy.shapeId, source: 'tranzy' }
    
    // Last resort: synthesize by walking the stops along the shape from CSV's
    // in_stop_name/out_stop_name. This is what neary-gtfs#13 suggests as a
    // third option. For now we LOG a warning and skip.
    log.warn(`No pattern for ${routeId} dir=${directionId} — dropping departures`)
    return null
```

The Tranzy fallback is the **whole point** of this adapter — it directly
fixes `neary-gtfs#13` (25N direction=1) and `neary-gtfs#15` (M26 direction=1)
by providing the missing stop sequences.

### Trip-headsign resolution

When Tranzy publishes a more recent headsign than Transitous (e.g. a route
renamed a terminus), we prefer Tranzy. CSV's `in_stop_name` / `out_stop_name`
(rows 3 and 4 of the CSV — see [`docs/csv-timetable-format.md`](./csv-timetable-format.md))
is the third fallback: it's the literal terminal label from CTP's
timetable, useful as a tiebreaker when both seed and Tranzy headsign are empty.

### Schedule-generation algorithm

For each CSV departure `HH:MM` on pattern `P`:

```
startSec = hhmmToSeconds(HH:MM)
{ arrivals, departures, shapeDistTraveledM, bucket, speedKmh } =
    computeStopTimes({
        startSec,
        stops: P.stops.map(s => ({ stopId: s.stopId, lat: stopCoords[s.stopId].lat, lon: ... })),
        shape: shapesById[P.shapeId] ?? [],
        timing: TIMING,   // peak/offpeak/night + dwell config
    })

for (i = 0; i < P.stops.length; i++) {
    yield {
        trip_id: `${routeId}_${directionId}_${serviceId}_${seq}_${HHMMDigits}`,
        arrival_time: formatGtfsTime(arrivals[i]),
        departure_time: formatGtfsTime(departures[i]),
        stop_id: P.stops[i].stopId,
        stop_sequence: i,
        shape_dist_traveled: shapeDistTraveledM[i],
    }
}
```

The `bucket` / `speedKmh` returned by `computeStopTimes` are diagnostic —
logged per-route per-service-day so we can verify the time-of-day model
later.

## Data-quality checks (build warnings)

These don't block the build but emit `WARN` lines that should be reviewed
before merging the daily artifact:

1. **Routes with 0 emitted trips but CSV had non-suspended data** —
   surfaces the class of bug behind `neary-gtfs#15` (M26).
   *Suspended* = CSV row 0 starts with `"Nu circula"` or `"In lucru"` —
   explicit signals that zero trips is correct.

2. **CSV departures dropped due to non-`HH:MM` cells** — surfaces
   `neary-gtfs#15` M26's `05:05-22:40` / `10-20min` annotations. Currently
   we drop silently and warn; full frequency-annotation parsing
   (`frequencies.txt`) is a future feature.

3. **Route color doesn't match the type-default palette** — surfaces
   `neary-gtfs#14` (Route 22 orange). Expected palette:
   - `route_type=0` (tram) → `#3BAC2C`
   - `route_type=3` (bus) → `#D24CAE`
   - `route_type=11` (trolleybus) → `#3C4E9A`
   - Any other color → warn "verify intentional exception"

4. **Stop with empty `stop_lat` / `stop_lon`** — Tranzy occasionally
   returns stops with coordinates as empty strings. Drop the stop from
   the patterns it's referenced in, or skip the route. Don't emit a
   trip whose stop sequence has a missing coordinate.

5. **Multiple agencies in `agency.txt`** — surfaces `neary#87`'s
   validator concern. Single-agency feeds (like ours) should have exactly
   one row in `agency.txt`. Warn if not.

6. **CSV row count mismatch with seed trip count** — if the seed
   publishes `N` trips for `(route, dir)` and CSV publishes `M` very
   different departure times, log both for visibility. We don't reconcile
   to the seed's count — CSV wins for trip count.

## Out of scope (deliberately)

- **Reconciling agency_id** — Transitous and Tranzy both treat CTP as
  agency `2`; CSV has no agency concept. No reconciliation needed.
- **Cross-source `route_id` remapping** — we use Transitous's `route_id`
  everywhere; Tranzy's IDs that don't match are added as supplementary
  routes (different `route_short_name`) rather than merged. This avoids
  the mapping-table-trap that the user explicitly called out.
- **`feed_publisher_name`** — always `cluj-napoca-gtfs-adapter`. We do
  not impersonate Transitous or CTP.
- **License attribution** — preserved as-is from the seed (`CC-BY` to
  CTP). Our `feed_info.txt` adds our publisher but does not strip the
  upstream attribution.