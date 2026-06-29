/**
 * Shared "build input" directory layout.
 *
 * The pipeline is split into two phases:
 *   Phase 1 — smoke (scripts/smoke-csv-parser.js):
 *     Fetches every (route, service) CSV from CTP, writes each
 *     200-ok body to disk, and emits a status manifest at the end.
 *     This is the ONLY phase that touches upstream.
 *
 *   Phase 2 — build (src/cli.js build → src/sources/ctp-csv.js):
 *     Reads the CSV bodies from disk and the status manifest, then
 *     assembles the GTFS zip. NEVER fetches upstream.
 *
 * Why two phases:
 *   - One fetch per CSV per CI run (no double-fetch).
 *   - Smoke acts as a gate: infra errors fail the CI before the
 *     build runs, so we never produce a degraded zip.
 *   - The .build-input/ directory is a DATA-EXCHANGE LAYOUT, not a
 *     cache. No TTL, no staleness checks. Refresh = delete the
 *     directory and re-run smoke.
 *
 * Directory layout (under .build-input/):
 *   csv/<route_short_name>_<svcKey>.csv   — 200-ok body, untouched
 *   csv-status.json                       — manifest of all attempts
 *
 * CSV file presence rules:
 *   - Present (.csv)    → smoke got 200, parse this
 *   - Absent            → either smoke failed (404) or it wasn't run.
 *                          Read csv-status.json to disambiguate.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Root of the build-input layout. */
export const BUILD_INPUT_DIR = '.build-input';
/** Subdirectory holding 200-ok CSV bodies. */
export const CSV_DIR = join(BUILD_INPUT_DIR, 'csv');
/** Manifest filename. */
export const STATUS_FILE = join(BUILD_INPUT_DIR, 'csv-status.json');

/**
 * Ensure the .build-input/csv/ directory exists. Idempotent.
 * Called by smoke before writing.
 */
export function ensureBuildInputDirs() {
  mkdirSync(CSV_DIR, { recursive: true });
}

/**
 * Write a CSV body to the build-input directory. Overwrites any
 * existing file for the same (route, svc) pair. Caller is
 * responsible for only calling this on 200-ok responses.
 *
 * @param {string} routeShortName
 * @param {string} svcKey
 * @param {string} body
 */
export function writeCsvBody(routeShortName, svcKey, body) {
  const path = csvPath(routeShortName, svcKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

/**
 * @param {string} routeShortName
 * @param {string} svcKey
 * @returns {string}
 */
export function csvPath(routeShortName, svcKey) {
  return join(CSV_DIR, `${routeShortName}_${svcKey}.csv`);
}

/**
 * Read a CSV body from disk. Returns null if the file doesn't
 * exist (which can be legit for a 404, or a smoke-wasn't-run bug —
 * disambiguate via {@link readStatusManifest}).
 *
 * @param {string} routeShortName
 * @param {string} svcKey
 * @returns {string | null}
 */
export function readCsvBody(routeShortName, svcKey) {
  const path = csvPath(routeShortName, svcKey);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/**
 * @returns {boolean}
 */
export function statusManifestExists() {
  return existsSync(STATUS_FILE);
}

/**
 * Read the manifest of all (route, svc) fetch attempts emitted by
 * the most recent smoke run. Returns null if the manifest doesn't
 * exist (smoke never ran, or ran in an older layout).
 *
 * @returns {{
 *   version: 1,
 *   generatedAt: string,
 *   entries: Array<{
 *     route: string,
 *     svc: string,
 *     status: 'ok' | 'not-found' | 'waf-blocked' | 'http-error' | 'network-error',
 *     httpStatus?: number
 *   }>
 * } | null}
 */
export function readStatusManifest() {
  if (!statusManifestExists()) return null;
  return JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
}

/**
 * Write the manifest atomically (write to .tmp, then rename).
 *
 * @param {{
 *   entries: Array<{
 *     route: string,
 *     svc: string,
 *     status: 'ok' | 'not-found' | 'waf-blocked' | 'http-error' | 'network-error',
 *     httpStatus?: number
 *   }>
 * }} data
 */
export function writeStatusManifest(data) {
  mkdirSync(BUILD_INPUT_DIR, { recursive: true });
  const payload = { version: 1, generatedAt: new Date().toISOString(), ...data };
  const tmp = `${STATUS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  // Atomic rename — on most platforms this is a single inode swap.
  // Avoids a partial manifest being read by a build that started
  // racing the smoke writer.
  renameSync(tmp, STATUS_FILE);
}

/**
 * List all CSV files currently in the build-input directory.
 * Useful for sanity checks and CLI summaries.
 *
 * @returns {string[]}
 */
export function listCachedCsvs() {
  if (!existsSync(CSV_DIR)) return [];
  return readdirSync(CSV_DIR).filter((f) => f.endsWith('.csv'));
}