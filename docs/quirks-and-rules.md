# Quirks and rules

This document captures the **non-obvious** behaviors of the
`cluj-napoca-gtfs-adapter` reconciler — the things you'd only know if
you read every warning text and cross-referenced against CTP's
upstream catalog. Read this before changing warning text, classify
logic, or the failure thresholds in `scripts/fetch-stage.js`.

For the per-field priority order (which source wins for which GTFS
field) see [`assemble-rules.md`](./assemble-rules.md).
For the data-quality data-loss categories see
[`known-limitations.md`](./known-limitations.md).

## Table of contents

- [404s: expected weekend gap vs whole-line gap](#404s-expected-weekend-gap-vs-whole-line-gap)
- [`*`/`**` CSV annotations](#csv-annotations-and-suspension-markers)
- [Origin label matching: exact / fuzzy / no-match](#origin-label-matching-exact--fuzzy--no-match)
- [Frequency annotations and anchor trips](#frequency-annotations-and-anchor-trips)
- [Tranzy /trips fallback for routes without CSV](#tranzy-trips-fallback-for-routes-without-csv)
- [Suspension markers (`Nu circula` etc.)](#suspension-markers-nu-circula-etc)
- [GTFS specification quirks](#gtfs-specification-quirks)
- [Build log severity tiers](#build-log-severity-tiers)

---

## 404s: expected weekend gap vs whole-line gap

CTP returns 404 from `https://ctpcj.ro/orare/csv/orar_<route>_<service>.csv`
in two distinct situations:

1. **Expected weekend gap** — the route exists and runs on weekdays,
   but does not run on weekends (or only runs LV). CTP's CSV
   endpoint correctly returns 404 because there's no schedule to
   publish. Cross-referenced against CTP's HTML pages (route 22:
   *"Sâmbăta: Nu circulă. Duminica: Nu circulă."*). This is
   **NOT a build failure** — the adapter correctly skips the
   route×service combo and emits trips for the days that do work.

2. **Whole-line gap** — the route is listed on CTP's website but
   has zero CSVs published for any service day (no recent example —
   the historical `39 CREIC` case is fixed via the
   [`canonicalShortName`](../src/sources/ctp-csv/shortname-aliases.js)
   helper, which collapses Tranzy's `39C` and Transitous's `39 CREIC`
   to the same canonical `39CREIC` for the CSV URL).
   This **IS a build failure** — the operator hasn't published any
   authoritative schedule data, and the Tranzy fallback (see below)
   is the only data we have.

The smoke script distinguishes the two by cross-referencing each
route's 404s against its own successful CSV fetches:

- Route has ≥1 successful CSV → 404s are weekend/service-day gaps
  (reported as `Expected (route has weekday CSV — 404 is weekend/no-service)`)
- Route has 0 successful CSVs → 404s are whole-line gaps
  (reported as `⚠ WHOLE-LINE gaps (no CSV at all for this route)`,
   fails build with exit code 3 unless
   `SMOKE_ALLOW_WHOLE_LINE_404S=1`)

Current state (2026-06-29): 18 expected 404s (weekday-only routes
missing weekend CSV), 0 whole-line gaps (the historical `39 CREIC`
case is fixed via [`canonicalShortName`](../src/sources/ctp-csv/shortname-aliases.js):
`39C` → `39CREIC`).

---

## CSV annotations and suspension markers

CTP's CSV timetable cells carry single-character annotations whose
meaning is **per-line** — documented on each line's HTML legend page
(verified examples for M23 and M39):

| Marker | M23 meaning | M39 meaning |
|---|---|---|
| `*` (leading or trailing) | Shared run with M81/M22 (bus doesn't stop at terminal) | Extends past terminus to Sânmartin |
| `**` (double trailing) | (not used in M23) | Skips the Cluj Due neighborhood |

**Adapter behavior**: the marker is stripped, the time is kept,
the trip is emitted. The annotation is surfaced in the build log via
`CtpCsvSchedule.annotations[]` so the operator can see what
happened. The trip_id format is unchanged.

**GTFS implication**: since the operator's published timetable
includes the trip, we include it in our GTFS even though the
operating vehicle is registered under a different `route_id`. Live
GPS won't match (the bus is an M81, not an M23) — consumers see
"scheduled time, no live GPS" which is the correct UX.

**Suspension markers** (`Nu circula`, `In lucru`, `Suspendat`,
`Suspended`, `Nu functioneaza`, `Nu merge`) are classified as
`{type: 'suspended', reason}` and produce **zero trips** for that
service day. Routes where every cell is suspended get the
`suspendedAllCells` flag.

---

## Origin label matching: exact / fuzzy / no-match (with pattern traversal)

CTP's CSV carries two terminal-name labels in its metadata header
(rows 3 and 4):

- `in_stop_name` = origin of col 0 buses = first stop of dir 0
  pattern
- `out_stop_name` = origin of col 1 buses = first stop of dir 1
  pattern
- (The other terminal is the destination of that direction and is
  used as the headsign.)

The adapter validates these against the catalog pattern's stops
using `findLabelInPattern()` + `terminalNamesMatch()` in
`src/assemble/emit/trips.js`:

1. **Pattern traversal** — search every stop in the pattern (not just
   position 0). CTP sometimes publishes an origin that's mid-pattern
   (M24: catalog dir 0 starts at "Disp. Bucium" but the CSV says col
   0 origin is "Calea Floresti" further along the route).
2. **Exact match** — diacritic-insensitive case-insensitive equality
   after normalization (`ă/â→a, î→i, ș→s, ț→t`).
3. **Word-token overlap** — split both names on word boundaries
   (spaces, hyphens, parens, punctuation). Accept when EITHER:
   - ≥2 shared tokens of length ≥4, OR
   - ≥1 shared token of length ≥6.

   The stricter "≥2 OR ≥6" rule (vs the older "≥1 of length ≥4")
   prevents false positives on common transit prefixes like "Disp."
   (4 chars, abbreviation for "Dispecerat" = depot). Without it,
   "Disp. Grigorescu" would falsely match "Disp. IRA" because both
   share "disp" — but those are different physical depots.

Reported as a 5-tier build-log classification:

| Tier | When | Action |
|---|---|---|
| `exact-both` | both CSV terminals match somewhere in their respective patterns (any position, exact) | silent |
| `exact-one` | one exact, one fuzzy/no-match | info, trust column convention |
| `fuzzy-both` | both fuzzy matches found | info, trust column convention |
| `fuzzy-one` | one fuzzy, one no-match | info, trust column convention |
| `swap-exact-both` | cross-direction (col 0 ↔ dir 1, col 1 ↔ dir 0) both exact | info, direction_id unchanged (RT feed alignment) |
| `swap-fuzzy-both` | cross-direction both fuzzy | info, direction_id unchanged |
| `swap-partial` | one cross-pair exact/fuzzy, other doesn't match anywhere | warn, asymmetric — operator likely renamed one terminal |
| `no-match` | neither same-direction nor cross-direction matches anywhere in any pattern | warn with categorized sub-type |

### No-match sub-types (operator-actionable categorization)

When the no-match tier fires, the warning carries one of three
sub-types so the operator/Tranzy knows where to act:

| Sub-type | When | Operator action |
|---|---|---|
| `csv-placeholder` | A CSV label looks like a generic term — either it appears as a substring of the CSV's own `route_long_name` (likely a placeholder) or it has no real stop-name tokens (e.g. "Cluj-Napoca", "M") | Fix the CSV |
| `catalog-out-of-date` | CSV terminals look like real stops (no placeholder) but neither catalog pattern contains them | Ask Tranzy to update the stops for this route |
| `no-match-asymmetric` | Catalog patterns for the two directions have different first stops AND neither is a placeholder | Ask Tranzy to realign the catalog |

Live data examples (2026-06-30):

| Route | Sub-type | Diagnosis |
|---|---|---|
| 30 | (swap-exact-both → asymmetric) | Catalog patterns have 4 distinct terminal names; CSV describes a Disp. Grigorescu ↔ Disp. IRA corridor the catalog doesn't connect. Operator: ask Tranzy to realign the route's two patterns. |
| M26 | `csv-placeholder` | `in_stop_name = "Cluj-Napoca"` is a city name, not a stop (matches CSV's own `route_long_name` substring). Operator: fix the CSV. |
| 29S | `catalog-out-of-date` | `in_stop_name = "Sf.Ioan"` and `out_stop_name = "Pod Traian"` are real stops but neither is in the seed's patterns for this route. Operator: ask Tranzy to add these stops. |
| 46 | `swap-partial` | col 1 ("Giratie Drum Faget") fuzzy-matches dir 0 first stop; col 0 ("Opera") doesn't match anything. Asymmetric catalog. |

### Why the warn-but-proceed strategy

Trip direction is determined by **CSV column index** (col 0 = dir 0,
col 1 = dir 1), not by the CSV header labels. So an origin-mismatch
does NOT mean trips are going to the wrong direction — it means we
can't trust the CSV's terminal name as a headsign fallback. We
keep using catalog `direction_id` so the schedule stays aligned
with the Tranzy RT feed (which uses Tranzy's catalog mapping).
**We never flip `direction_id`** even when swap is detected — see
the [route_long_name rewrite](#route-long_name-rewrite-from-csv)
section below for the alternative use of swap detection.

### `route_long_name` rewrite from CSV in/out

When the CSV ↔ catalog resolution is clean (`exact-both`,
`swap-exact-both`, or `swap-fuzzy-both`), the CSV's `in/out_stop_name`
labels are a more accurate "Start - End" descriptor than whatever
Tranzy/Transitous left in `route_long_name` (especially when the
catalog is stale and uses a TE code or outdated terminal pair).
The validation tier's resolution drives a side-effect: rewrite
`route_long_name` to `"${in_stop_name} - ${out_stop_name}"` so
downstream consumers see the operator-published terminals.

Guards:

- Only fires on clean resolutions (`exact-both`, `swap-exact-both`,
  `swap-fuzzy-both`). Group B (no-match with `catalog-out-of-date` /
  `csv-placeholder` / asymmetric) is left alone because the CSV
  terminals don't correspond to any trajectory that exists in the
  catalog.
- **Cross-direction cases** (swap-*) get an extra symmetry guard via
  `patternsShareEndpoint()`: only rewrite when the two catalog
  patterns SHARE an endpoint stop name. When the patterns have 4
  distinct terminal names (route 30 case), the operator's CSV
  describes a corridor the catalog's two patterns don't connect —
  rewriting would produce a `route_long_name` that consumers can't
  navigate.

Build log emits one INFO line per rewrite pass:

```
routes: 46 route_long_name(s) rewritten from CSV in/out (catalog was stale — pattern traversal found a clean resolution, CSV terminals are more accurate).
```

A high rewrite count is normal when the catalog's `route_long_name`
is stale; operators should consider asking Tranzy/Transitous to
realign their catalog.

**Fuzzy-match summary**: the build emits a single INFO line counting
how many `(route, dir)` pairs used fuzzy (not exact) matching:

```
origin validation: 47 (route, dir) pair(s) used fuzzy word-token matching to align catalog ↔ CSV origin labels
```

A high count means the upstream sources use different naming
conventions for the same stops — operators should consider asking
CTP / Transitous / Tranzy to align.

---

## Frequency annotations and anchor trips

CTP's CSV cells aren't always `HH:MM` — some are frequency
annotations:

- `HH:MM-HH:MM` — service runs in this window
- `N-Mmin` — headway range (e.g. `10-20min` = bus every 10-20 min)
- `Nmin` — fixed headway (e.g. `5min`)
- `*` markers (see above)

The adapter handles these in `src/assemble/derive/frequencies.js`:

1. Pick the **first** window as the operating range (e.g.
   `05:05-22:40`)
2. Pick the headway as the **average** of the range (e.g. `15min`
   for `10-20min`)
3. Emit a **frequency anchor** trip in `trips.txt` with
   `trip_id=<route>_<dir>_<serviceId>_FREQ_<HHMM>` and one
   `stop_times.txt` row (anchor stop)
4. Emit a `frequencies.txt` row with `start_time`, `end_time`,
   `headway_secs`, `exact_times=0` (frequency-based, not exact)

**GTFS exact_times=0** is the canonical "service operates with
the given frequency, not exact timetabled times" — see
[GTFS spec](https://gtfs.org/schedule/reference/#frequenciestxt).

The build log emits one INFO line per frequency anchor (the success
path):

```
[INFO ] frequency anchor: M26 dir=0 LV 05:05-22:40 every 15min (avg)
```

This is **NOT a data-loss signal** — the anchor trip and
`frequencies.txt` row ARE the data. Don't be alarmed by these
warnings; they're confirmation that M26's complex schedule parsed
correctly.

If the CSV has frequency annotations but no explicit window/headway,
the adapter falls back to defaults (`05:00-23:00`, `600s = 10min`),
also surfaced as INFO.

The WARN-tier signal `frequency anchor skipped: ... — no pattern`
means we couldn't emit the anchor (no pattern available) — that's
a real data loss.

---

## Tranzy /trips fallback for routes without CSV

For routes with **no CTP CSV coverage** (new metropolitan lines CTP
hasn't published yet — TE1-TE14, 40S, 87B, M26U, 101A, 30U, etc.),
the adapter pulls trips directly from Tranzy's `/trips` and
`/stop_times` endpoints via `src/assemble/emit/tranzy-fallback.js`.

Historical note: `39 CREIC` used to be a whole-line gap until we
discovered Tranzy publishes its `route_short_name` as the truncated
`39C` while CTP publishes the CSV at `orar_39CREIC_lv.csv`. The
[`canonicalShortName`](../src/sources/ctp-csv/shortname-aliases.js)
helper handles this — `39C` → `39CREIC` (and the Transitous-side
`39 CREIC` collapses to the same canonical name). Every CSV-IO path
funnels through this one function so the URL, on-disk filename,
manifest entry, and route lookup all use `39CREIC`.

Constraints:

- **Tranzy doesn't publish `arrival_time` or `departure_time`** —
  we emit empty arrival/departure + `timepoint='0'` per GTFS spec
  (when `timepoint=0`, times MUST be empty).
- **Tranzy doesn't publish `service_id`** — we default to all three
  (`LV`, `S`, `D`). Over-scheduling is better than under-scheduling:
  the "does this route run at all" question is independent of
  which days it runs.
- **Trip_id format** for fallback trips: `${routeId}_${dir}_${serviceId}_NT${idx}`
  — the `NT` (no-time) sentinel signals to downstream parsers like
  `neary`'s `parseLiveStartMin` that there's no real start time to
  extract. Don't try to parse HHMM from these.
- **Stops filtered** to those in the reconciled `stops.txt` (drop
  orphans if Tranzy references a stop that didn't make it through).

Build-log line:

```
[INFO ] routes: 61 routes using Tranzy /trips fallback (no CSV coverage — times empty, timepoint=0, 312 trips emitted, service_ids=LV+S+D)
```

---

## Suspension markers (`Nu circula` etc.)

See [CSV annotations and suspension markers](#csv-annotations-and-suspension-markers)
above. The pattern is treated as a known skip — no trips generated,
no warning emitted for that service day (the marker IS the signal
that zero trips is correct).

Routes where **every** non-empty cell is suspended get the
`suspendedAllCells` flag, used by `reconcileTripsAndStopTimes` to
skip the route×service combo entirely without emitting
"No pattern" or "0 trips" warnings.

---

## GTFS specification quirks

The adapter makes several choices that deviate from "naive" GTFS
output. These are documented in `assemble-rules.md` but called
out here for quick reference:

- **`timepoint='0'` on every `stop_times.txt` row** — our
  arrival/departure times come from `computeStopTimes()` projecting
  the CSV origin time across the pattern. They're interpolated, not
  authoritative per-stop times. GTFS spec says `timepoint=0` is the
  canonical signal for "times are approximate".
- **`stop_sequence` preserved from upstream** — we never re-number.
  Re-numbering would discard any non-contiguous numbering the
  operator uses (gaps for dwell-only stops, odd-numbered extras).
- **`trip_id` format** is `${routeId}_${dir}_${serviceId}_${HHMM}`
  for CSV-derived trips, with `FREQ_<HHMM>` suffix for frequency
  anchors and `NT<idx>` suffix for Tranzy-fallback trips. The HHMM
  tail is the only structural requirement (downstream consumers like
  `neary`'s `parseLiveStartMin` rely on it).
- **`feed_info.txt`** identifies us as `cluj-napoca-gtfs-adapter`,
  not as CTP or Transitous. We do not impersonate upstream sources.

---

## Build log severity tiers

The build CLI classifies every reconcile warning into one of three
severity tiers (`src/lib/log-severity.js`):

| Tier | Visual | Meaning |
|---|---|---|
| **INFO** | `[INFO ]` (green) | We guessed data successfully (fuzzy match, Tranzy fallback, frequency anchor, route merge). NOT a failure. |
| **WARN** | `[WARN ]` (yellow) | We lost data or couldn't verify (no pattern, missing CSV, origin mismatch, frequency anchor skipped, color mismatch). Build proceeds; operator should review. |
| **ERROR** | `[ERROR]` (red) | Real failures. Currently unused in the reconciler output (errors exit the build before this layer). |

**Heuristic classification** (substring pattern match on warning text).
Defaults to `WARN` (safe side — "we don't know what we don't know").

INFO patterns:
- Tranzy /trips fallback success
- Tranzy primary catalog stats
- Transitous-only shapes/stops (gap fills)
- Origin exact-both / fuzzy-matched / fuzzy-one / exact-one / partial match
- Frequency anchor success (`frequency anchor: ...`)
- Frequency default fallback (`no (range|headway), using default`)

WARN patterns:
- Real data-loss: no usable pattern / No pattern for / no CSV / CSV missing / 0 trips
- Strong mismatches: DO NOT MATCH / DO NOT match / no-match / cannot be trusted
- Catalog gaps: CSV fetch returned 404 / not found
- Frequency anchor SKIPPED
- Dropping N departures

Build CLI renders each tier in its own collapsible GH Actions
section (`::group::INFO:` / `::group::WARN:`), and the final summary
line counts per tier:

```
::group::INFO: 9 reconcile note(s) — data resolved successfully
  [INFO ] routes: Tranzy primary catalog — ...
::endgroup::
::group::WARN: 2 data-loss signal(s) — review before merging
  [WARN ] routes: 13 distinct non-default color bucket(s) — ...
::endgroup::

  11 total — 9 info, 2 warn, 0 error
```

## Smoke test exit codes

| Code | Meaning |
|---|---|
| 0 | OK — no unrecognized cells, no infra misses, no whole-line 404s |
| 1 | Unrecognized cells in CSV (extend `classifyCell()`) |
| 2 | Infra miss (WAF / HTTP / network). Opt-out: `SMOKE_ALLOW_INFRA_FAILURES=1` |
| 3 | Whole-line 404 gap (route has zero CSV coverage). Opt-out: `SMOKE_ALLOW_WHOLE_LINE_404S=1` |