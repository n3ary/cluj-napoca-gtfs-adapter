/**
 * Classify a reconcile warning into severity: 'info' (we guessed /
 * resolved gracefully) vs 'warn' (we lost data or couldn't verify).
 *
 * Used by the build CLI to render the build log with proper visual
 * hierarchy — info gets a green prefix, warn gets a yellow prefix,
 * and the GH Actions web console renders each as a collapsible group.
 *
 * The classification is heuristic (we look at substring patterns in
 * the warning text). If the text doesn't match any pattern, we
 * default to 'warn' (assume data-loss unless proven otherwise — the
 * safe side of "we don't know what we don't know").
 */

const INFO_PATTERNS = [
  // Fallback paths that succeeded
  /Tranzy \/trips fallback/i,
  /Tranzy primary catalog/i,
  /routes: merged \d+ Tranzy/i,
  /routes: added \d+ Tranzy-only/i,
  // Transitous-only fills — successfully added what Tranzy is missing
  /Transitous-only (shapes|stops)/i,
  // Origin validation tiers that resolved cleanly
  /exact-both/i,
  /fuzzy-matched/i,
  /fuzzy-one/i,
  /exact-one/i,
  /partial match/i,
  // Frequency annotation anchor: success path — anchor trip +
  // frequencies.txt entry emitted. NOT data loss.
  /^frequency anchor: /i,
  // Frequency annotation default fallbacks: graceful degradation
  /frequency anchor .*: no (range|headway), using default/i,
  // Reconciliation merges
  /merged \d+ rows/i,
  /merged into/i,
];

const WARN_PATTERNS = [
  // Real data-loss signals
  /no usable pattern/i,
  /No pattern for/i,
  /no CSV/i,
  /CSV missing/i,
  /0 trips/i,
  // Strong mismatches
  /DO NOT MATCH/i,
  /DO NOT match/i,
  /cannot be trusted/i,
  /no-match/i,
  // Catalog gaps
  /catalog gap/i,
  /CSV fetch.* returned 404/i,
  /not found/i,
  // Frequency anchor SKIPPED (not emitted) — data loss
  /frequency anchor skipped/i,
  // Build signals
  /skipped/i,
  /dropping \d+ departures/i,
];

/**
 * @param {string} warning
 * @returns {'info' | 'warn'}
 */
export function classifyWarning(warning) {
  for (const p of INFO_PATTERNS) {
    if (p.test(warning)) return 'info';
  }
  return 'warn'; // safe default
}

/**
 * ANSI color codes. GitHub Actions renders these in the web console
 * (and `script` blocks in workflow steps honor them). In a non-TTY
 * (e.g. when piped to a file) the colors still show as escape codes
 * — that's the trade-off for cross-platform support.
 */
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/**
 * GitHub Actions workflow command for collapsible groups. These are
 * stripped by GH Actions into a click-to-expand section in the web
 * console. The opener/closer must be on their own lines.
 *
 * Outside GH Actions (e.g. local runs) these are harmless noise — the
 * workflow runner filters them out before rendering.
 */
const GHA = {
  groupOpen: (name) => `::group::${name}`,
  groupClose: () => '::endgroup::',
  notice: (msg) => `::notice::${msg}`,
  warning: (msg) => `::warning::${msg}`,
  error: (msg) => `::error::${msg}`,
};

/**
 * Render a single warning line with a colored severity prefix.
 * Use this when printing warnings one-per-line in the build log.
 *
 * @param {string} severity  'info' | 'warn' | 'error'
 * @param {string} message
 * @returns {string}
 */
export function formatWarningLine(severity, message) {
  const tag = severity.toUpperCase().padEnd(5);
  const color =
    severity === 'info' ? COLORS.green :
    severity === 'error' ? COLORS.red :
    COLORS.yellow;
  return `${color}[${tag}]${COLORS.reset} ${message}`;
}

/**
 * Group warnings by severity and emit them under collapsible GHA
 * sections. Returns the counts for the summary line.
 *
 * @param {string[]} warnings
 * @returns {{info: number, warn: number, error: number}}
 */
export function emitGroupedWarnings(warnings) {
  const groups = { info: [], warn: [], error: [] };
  for (const w of warnings) {
    groups[classifyWarning(w)].push(w);
  }
  if (groups.info.length > 0) {
    console.log(GHA.groupOpen(`\x1b[32mINFO\x1b[0m: ${groups.info.length} reconcile note(s) — data resolved successfully`));
    for (const w of groups.info) console.log(`  ${formatWarningLine('info', w)}`);
    console.log(GHA.groupClose());
  }
  if (groups.warn.length > 0) {
    console.log(GHA.groupOpen(`\x1b[33mWARN\x1b[0m: ${groups.warn.length} data-loss signal(s) — review before merging`));
    for (const w of groups.warn) console.log(`  ${formatWarningLine('warn', w)}`);
    console.log(GHA.groupClose());
  }
  return {
    info: groups.info.length,
    warn: groups.warn.length,
    error: groups.error.length,
  };
}

export { COLORS, GHA };