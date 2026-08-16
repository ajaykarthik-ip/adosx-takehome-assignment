/**
 * System B's `record_ref` points back at System A's `record_id`, but it is not
 * written consistently. In this dataset alone it appears as:
 *
 *   "REC-1001"      the clean form
 *   "rec1034"       lowercase, no separator
 *   " REC - 1070 "  padded, with spaces around the separator
 *   "1112"          the bare number, no prefix at all
 *
 * All four mean the same record. Matching on the raw string finds three false
 * "missing" records and three false orphans, so every reference is reduced to
 * one canonical form before matching.
 *
 * The raw string is always kept alongside the canonical key - normalising is
 * a guess about intent, and a reviewer needs to see what was actually in the
 * file.
 */

/** The canonical shape we reduce every reference to. */
const CANONICAL_PATTERN = /^REC-\d+$/;

/**
 * Anything that is not a digit or a letter is noise: whitespace, dashes,
 * underscores, slashes. Strip it, then look for an optional REC prefix
 * followed by the record number.
 */
const STRIPPED_PATTERN = /^(?:REC)?(\d+)$/;

/**
 * Reduce a raw record reference to its canonical form, e.g. "rec1034" -> "REC-1034".
 *
 * Returns null when the reference cannot be recognised as a record number at
 * all. The caller is expected to keep such a row and flag it, not discard it.
 */
export function canonicalRecordKey(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const stripped = raw.replace(/[^0-9a-z]/gi, "").toUpperCase();
  if (stripped === "") return null;

  const match = STRIPPED_PATTERN.exec(stripped);
  if (!match) return null;

  // Leading zeros would make "REC-0042" and "REC-42" different keys, so the
  // number is normalised through Number(). No record id in this data has
  // leading zeros, but exports elsewhere do.
  const recordNumber = Number(match[1]);
  if (!Number.isSafeInteger(recordNumber)) return null;

  return `REC-${recordNumber}`;
}

/** True when the raw reference was already in canonical form. */
export function isAlreadyCanonical(raw: string | null | undefined): boolean {
  return typeof raw === "string" && CANONICAL_PATTERN.test(raw);
}

/**
 * A System B label can mark an entry as one piece of a deliberately split
 * record, e.g. "Entry part 2 of 2". Those entries are NOT duplicates - they
 * are one record recorded across several rows, and their values are meant to
 * be summed.
 */
export type SplitPart = { partNumber: number; partTotal: number };

const SPLIT_LABEL_PATTERN = /\bpart\s+(\d+)\s+of\s+(\d+)\b/i;

/** Parse "Entry part 2 of 2" into { partNumber: 2, partTotal: 2 }, or null. */
export function parseSplitPart(label: string | null | undefined): SplitPart | null {
  if (!label) return null;

  const match = SPLIT_LABEL_PATTERN.exec(label);
  if (!match) return null;

  const partNumber = Number(match[1]);
  const partTotal = Number(match[2]);
  if (partNumber < 1 || partTotal < 1 || partNumber > partTotal) return null;

  return { partNumber, partTotal };
}
