/**
 * Money handling.
 *
 * These values are cent-exact, so they are never held in a JS float. A float
 * cannot represent 0.1 exactly, and summing a hundred of them drifts. Instead
 * every amount is converted, by string manipulation only, into an integer
 * number of *minor units* (paise). 88969.92 is stored as 8896992.
 *
 * Integers up to 2^53 are exact in JS. The largest amount in this dataset is
 * about 1.8e5 and the largest sum about 1.2e7, so 1.2e9 minor units - nowhere
 * near the limit. `assertSafe` below fails loudly if that ever stops holding.
 */

/** How many minor units make up one major unit. */
export const MINOR_UNITS_PER_MAJOR = 100;

/** Number of decimal places we keep. Anything beyond this is rounded. */
export const MONEY_DECIMAL_PLACES = 2;

export type MoneyParseResult =
  | { ok: true; minor: number }
  | { ok: false; reason: string };

/**
 * Parse a money string into integer minor units.
 *
 * Handles, deliberately:
 *   "88969.92"     -> 8896992
 *   "1,25,400.00"  -> 12540000   (Indian digit grouping, arrives quoted in the CSV)
 *   "125,400.00"   -> 12540000   (Western digit grouping)
 *   "  1608.95  "  -> 160895     (stray whitespace)
 *   ""  / null     -> not ok, reason "blank"
 *   "n/a"          -> not ok, reason "not a number"
 *
 * Returns a result object rather than throwing, because the importer has to
 * keep going and record the problem instead of dropping the row.
 */
export function parseMoney(raw: string | null | undefined): MoneyParseResult {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "blank" };
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "blank" };
  }

  // Commas are only ever digit grouping in this data. Stripping all of them
  // handles Indian (1,25,400.00) and Western (125,400.00) grouping alike.
  // We do not try to validate the grouping positions - the CSV is the source
  // of truth for the digits, not for how someone chose to punctuate them.
  const withoutGrouping = trimmed.replace(/,/g, "");

  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(withoutGrouping);
  if (!match) {
    return { ok: false, reason: `not a number: ${JSON.stringify(raw)}` };
  }

  const [, sign, wholeDigits, fractionDigits = ""] = match;

  const minor = toMinorUnits(wholeDigits, fractionDigits);
  if (minor === null) {
    return { ok: false, reason: `number too large to hold exactly: ${raw}` };
  }

  return { ok: true, minor: sign === "-" ? -minor : minor };
}

/**
 * Combine the whole and fractional digit strings into minor units, rounding
 * half-up if the source carried more precision than we keep.
 *
 * Returns null if the result would not be an exact JS integer.
 */
function toMinorUnits(wholeDigits: string, fractionDigits: string): number | null {
  const padded = fractionDigits.padEnd(MONEY_DECIMAL_PLACES, "0");
  const keptFraction = padded.slice(0, MONEY_DECIMAL_PLACES);

  const whole = Number(wholeDigits);
  const fraction = Number(keptFraction);
  if (!Number.isFinite(whole) || !Number.isFinite(fraction)) return null;

  let minor = whole * MINOR_UNITS_PER_MAJOR + fraction;

  // Round half-up on the first discarded digit. This dataset always has
  // exactly two decimals, so this branch is defensive rather than load-bearing.
  const firstDiscardedDigit = padded[MONEY_DECIMAL_PLACES];
  if (firstDiscardedDigit !== undefined && Number(firstDiscardedDigit) >= 5) {
    minor += 1;
  }

  return Number.isSafeInteger(minor) ? minor : null;
}

/** Add minor-unit amounts. Separate function so the safety check lives in one place. */
export function addMoney(...amounts: number[]): number {
  const total = amounts.reduce((runningTotal, amount) => runningTotal + amount, 0);
  assertSafe(total);
  return total;
}

/** Format minor units back into a plain decimal string, e.g. 8896992 -> "88969.92". */
export function formatMoney(minor: number): string {
  assertSafe(minor);
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / MINOR_UNITS_PER_MAJOR);
  const fraction = absolute % MINOR_UNITS_PER_MAJOR;
  return `${sign}${whole}.${String(fraction).padStart(MONEY_DECIMAL_PLACES, "0")}`;
}

function assertSafe(minor: number): void {
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`money value is not an exact integer of minor units: ${minor}`);
  }
}
