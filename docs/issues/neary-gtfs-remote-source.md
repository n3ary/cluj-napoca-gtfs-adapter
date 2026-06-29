# Allow specific feeds to source from other repos (remote GTFS source)

Issue metadata to use when filing this in `ciotlosm/neary-gtfs`:

- **Title:** Allow specific feeds to source from other repos (remote GTFS source)
- **Labels:** enhancement
- **Assignee:** (none — open for grabs)

## Goal

Extend `neary-gtfs` so individual feeds can declare their GTFS source as
**a URL produced by another repo** instead of always going through Transitous.

This enables a chain like:

```
cluj-napoca-gtfs-adapter  ──►  neary-gtfs  ──►  binaries  ──►  neary app
        (static feed)              (SQLite +       (jsDelivr)
                                   SQLite regen)
```

…alongside the existing Transitous chain:

```
transitous  ──►  neary-gtfs  ──►  binaries  ──►  neary app
```

`neary-gtfs` continues to own the SQLite-regeneration step. It only
gains the ability to swap the *upstream* for a specific feed.

## Why

### Today

Every feed in `countries.json` flows through Transitous:

```json
{
  "countries": ["ro"],
  "include": ["Cluj-Napoca", "Bucuresti-Ilfov"]
}
```

`src/pipeline/fetch-gtfs.js` only knows `source.type === "transitous"` (or
`"build"` for the Cluj enhancement). When Transitous is stale (which
happens — `neary-gtfs#1` investigated and closed: "63 routes without CSV
schedule data" / "irregular cadence"), there's no way to point at an
alternative source short of forking the whole pipeline.

### Tomorrow

`ciotlosm/cluj-napoca-gtfs-adapter` (companion repo) reconciles **three sources** for the same operator:

- Transitous seed (mdb-2121) — curated structure
- Tranzy.ai — live static, fills missing directions (`neary-gtfs#13`, `#15`)
- CTP CSV timetables — authoritative departure times

…and emits `cluj-napoca.gtfs.zip` to a stable URL. The Cluj feed should
be able to consume *that* zip instead of going through Transitous
directly.

## Proposed approach

Add a new `source.type === "remote"` that takes a URL. The pipeline
downloads the URL instead of hitting Transitous for that feed.

### Configuration

```json
// countries.json — unchanged shape
{
  "countries": ["ro"],
  "include": ["Cluj-Napoca", "Bucuresti-Ilfov"]
}
```

```json
// feeds/cluj-napoca/config.json — NEW field
{
  "enhances": "Cluj-Napoca",
  "source": {
    "type": "remote",
    "url": "https://cdn.jsdelivr.net/gh/ciotlosm/cluj-napoca-gtfs-adapter@binaries/output/cluj-napoca.gtfs.zip",
    "etag": "optional, for cache validation"
  },
  "license": { ... }
}
```

When `source.type` is `"remote"`:
1. `fetch-gtfs.js` downloads the URL.
2. `feeds/cluj-napoca/build.js` is **no longer invoked** — the remote
   zip is already a fully reconciled GTFS feed.
3. The vestigial `tranzy` field in `feeds/cluj-napoca/config.json` is
   removed (it's never read by anything).
4. The rest of the pipeline (validate, derive-bbox, make-sqlite) runs
   unchanged.

### Code changes

- `src/pipeline/fetch-gtfs.js`: add a third branch
  `else if (feed.source.type === 'remote') { await fetchToFile(feed.source.url, dest); }`.
- `src/pipeline/resolve-feeds.js`: pass through the `source` field as-is
  (already does for `type === 'build'` / `'transitous'`).
- `schemas/feeds.schema.json`: extend the `source` enum to include
  `"remote"` and add the `url` field to the schema.
- Optional: a `etag` field so the pipeline can skip a refetch if the
  upstream zip hasn't changed (similar to the existing Transitous
  skip-on-unchanged in `src/pipeline/lib/zip-hash.js`).

### Migration path (long-term)

Once `ciotlosm/cluj-napoca-gtfs-adapter` is registered with Transitous as
a known good source for the Cluj feed (the adapter author would upstream
it), the override in `feeds/cluj-napoca/config.json` can be **removed**
entirely. The feed then flows through Transitous again — same path as
every other feed. No permanent fork in the pipeline.

```
today:    cluj-napoca-gtfs-adapter → neary-gtfs → binaries → app
future:   transitous ← [cluj-napoca-gtfs-adapter registered upstream]
          transitous → neary-gtfs → binaries → app
```

## Out of scope

- **GTFS-Realtime** (covered separately by `neary#108`). The realtime
  bridge is its own repo with its own URL; `neary-gtfs` doesn't proxy it.
- **Multiple remote sources for one feed.** The remote source is a
  single URL. If we ever want to merge multiple zips into one feed, that's
  a bigger refactor (maybe `source.type === "merged"`).
- **Authentication on the remote URL.** jsDelivr-served URLs are
  unauthenticated. If we ever host on a private CDN, add a `headers`
  field to the source config later.

## Acceptance criteria

- [ ] `feeds/cluj-napoca/config.json` declares `source.type = "remote"` with a URL pointing at `cluj-napoca-gtfs-adapter@binaries/output/cluj-napoca.gtfs.zip`.
- [ ] `feeds/cluj-napoca/build.js` is **not** invoked for this feed in CI.
- [ ] `feeds/cluj-napoca/config.json` `tranzy` field is removed.
- [ ] `output/cluj-napoca.gtfs.zip` (the SQLite, not the source zip) is regenerated daily and published to `binaries`.
- [ ] The `neary` app's Cluj-Napoca feed continues to render correctly — same routes, same stops, same trips as today.
- [ ] `source.type = "remote"` is documented in `schemas/feeds.schema.json` with the required `url` field.
- [ ] A daily smoke test verifies the remote URL returns a valid GTFS zip (size > 0, contains the 5 required GTFS files).

## Related

- `neary#108` — Standalone Tranzy → GTFS-RT bridge repo (the realtime counterpart of this; same architectural pattern).
- `neary-gtfs#16` — Use Tranzy static API as build-time fallback (which `cluj-napoca-gtfs-adapter` now provides in full).
- `neary-gtfs#13` — 25N direction=1 trips silently dropped (the adapter fixes this via Tranzy).
- `neary-gtfs#15` — M26 zero trips due to missing direction + CSV frequency annotations (the adapter fixes both).
- `neary-gtfs#1` — 63 routes without CSV schedule data (the adapter's combined-source approach handles many of these).