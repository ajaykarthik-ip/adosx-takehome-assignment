import { addMoney, formatMoney } from "./money";

/**
 * The comparison logic.
 *
 * This module decides what counts as a disagreement between System A and
 * System B. It is deliberately pure: it takes plain arrays in and returns
 * plain objects out, touches no database and reads no files. That is what
 * makes it testable without fixtures, and it is the part of the submission
 * worth reading first.
 *
 * Scoping to a single org happens *before* this runs - see lib/queries.ts.
 * By the time records reach this function they already belong to one tenant.
 */

// --------------------------------------------------------------------------
// Inputs
// --------------------------------------------------------------------------

/** One event as System A recorded it. Money is in integer minor units. */
export type SystemARecord = {
  recordId: string;
  locationId: string | null;
  orgId: string | null;
  eventDate: string | null;
  /** null when the CSV value could not be parsed. */
  totalValueMinor: number | null;
  baseValueMinor: number | null;
  adjustmentMinor: number | null;
  state: string | null;
};

/** One entry as System B recorded it. */
export type SystemBEntry = {
  entryId: string;
  /** The reference exactly as written in the CSV, e.g. " REC - 1070 ". */
  recordRefRaw: string | null;
  /** The reference reduced to canonical form, e.g. "REC-1070". Null if unrecognisable. */
  recordRefKey: string | null;
  locationId: string | null;
  orgId: string | null;
  recordedOn: string | null;
  valueMinor: number | null;
  label: string | null;
  /** Set when the label marked this entry as one piece of a split record. */
  splitPartNumber: number | null;
  splitPartTotal: number | null;
};

export type ComparisonInput = {
  records: SystemARecord[];
  entries: SystemBEntry[];
};

// --------------------------------------------------------------------------
// Output
// --------------------------------------------------------------------------

export const DISCREPANCY_REASONS = [
  "MISSING_IN_B",
  "ORPHAN_IN_B",
  "DUPLICATE_IN_B",
  "VALUE_MISMATCH",
  "VALUE_NOT_COMPARABLE",
  "LOCATION_MISMATCH",
  "DATE_MISMATCH",
  "VOIDED_PRESENT_IN_B",
] as const;

export type DiscrepancyReason = (typeof DISCREPANCY_REASONS)[number];

/** Human-readable labels, used by the UI and by the reason filter. */
export const REASON_LABELS: Record<DiscrepancyReason, string> = {
  MISSING_IN_B: "Missing in System B",
  ORPHAN_IN_B: "Orphan entry in System B",
  DUPLICATE_IN_B: "Entered twice in System B",
  VALUE_MISMATCH: "Values disagree",
  VALUE_NOT_COMPARABLE: "Value missing or unreadable",
  LOCATION_MISMATCH: "Locations disagree",
  DATE_MISMATCH: "Dates disagree",
  VOIDED_PRESENT_IN_B: "Voided in System A but present in System B",
};

export type Discrepancy = {
  reason: DiscrepancyReason;
  /** The System A record, or null for an orphan entry that matches none. */
  recordId: string | null;
  /** Every System B entry involved. Empty when nothing was recorded in B. */
  entryIds: string[];
  /** The tenant this disagreement belongs to. See ownerOrgOf below. */
  orgId: string | null;
  /** Location shown in the table: System A's if we have it, otherwise System B's. */
  locationId: string | null;
  systemALocationId: string | null;
  systemBLocationId: string | null;
  systemAValueMinor: number | null;
  systemBValueMinor: number | null;
  /** systemB - systemA, in minor units. Null when either side is unusable. */
  differenceMinor: number | null;
  /** One sentence a reviewer can read without opening the data. */
  detail: string;
};

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

/**
 * Compare System A against System B and return every disagreement found.
 *
 * A single record can produce more than one discrepancy - a record can be
 * both entered twice and filed against the wrong location, and hiding the
 * second behind the first would misreport the data. Each is its own row.
 */
export function compareSystems(input: ComparisonInput): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  const recordsById = new Map(input.records.map((record) => [record.recordId, record]));
  const entriesByRecordKey = groupEntriesByRecordKey(input.entries);

  // 1. System B entries that point at nothing.
  discrepancies.push(...findOrphanEntries(input.entries, recordsById));

  // 2. Everything judged from the System A side.
  for (const record of input.records) {
    const entries = entriesByRecordKey.get(record.recordId) ?? [];

    if (entries.length === 0) {
      discrepancies.push(buildMissingInB(record));
      continue;
    }

    discrepancies.push(...compareMatchedRecord(record, entries));
  }

  return discrepancies;
}

/**
 * Group System B entries by the record they claim to belong to.
 * Entries whose reference could not be recognised at all are left out here
 * and picked up by findOrphanEntries.
 */
function groupEntriesByRecordKey(entries: SystemBEntry[]): Map<string, SystemBEntry[]> {
  const grouped = new Map<string, SystemBEntry[]>();

  for (const entry of entries) {
    if (entry.recordRefKey === null) continue;

    const existing = grouped.get(entry.recordRefKey);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(entry.recordRefKey, [entry]);
    }
  }

  return grouped;
}

// --------------------------------------------------------------------------
// One rule per function, so each can be pointed at and explained
// --------------------------------------------------------------------------

/**
 * ORPHAN_IN_B - a System B entry whose record_ref matches no System A record,
 * either because the reference is unreadable or because the record does not
 * exist. Reported one row per entry.
 */
function findOrphanEntries(
  entries: SystemBEntry[],
  recordsById: Map<string, SystemARecord>,
): Discrepancy[] {
  const orphans: Discrepancy[] = [];

  for (const entry of entries) {
    const isUnreadableReference = entry.recordRefKey === null;
    const pointsAtMissingRecord =
      entry.recordRefKey !== null && !recordsById.has(entry.recordRefKey);

    if (!isUnreadableReference && !pointsAtMissingRecord) continue;

    const detail = isUnreadableReference
      ? `System B entry ${entry.entryId} has an unreadable record reference ${JSON.stringify(entry.recordRefRaw)}.`
      : `System B entry ${entry.entryId} points at ${entry.recordRefKey}, which does not exist in System A.`;

    orphans.push({
      reason: "ORPHAN_IN_B",
      recordId: entry.recordRefKey,
      entryIds: [entry.entryId],
      orgId: entry.orgId,
      locationId: entry.locationId,
      systemALocationId: null,
      systemBLocationId: entry.locationId,
      systemAValueMinor: null,
      systemBValueMinor: entry.valueMinor,
      differenceMinor: null,
      detail,
    });
  }

  return orphans;
}

/** MISSING_IN_B - System A has the record, System B never recorded it. */
function buildMissingInB(record: SystemARecord): Discrepancy {
  return {
    reason: "MISSING_IN_B",
    recordId: record.recordId,
    entryIds: [],
    orgId: record.orgId,
    locationId: record.locationId,
    systemALocationId: record.locationId,
    systemBLocationId: null,
    systemAValueMinor: record.totalValueMinor,
    systemBValueMinor: null,
    differenceMinor: null,
    detail: `System A record ${record.recordId} has no matching entry in System B.`,
  };
}

/**
 * Everything we can say about a record that does exist on both sides.
 *
 * The order matters only for readability; each check is independent.
 */
function compareMatchedRecord(
  record: SystemARecord,
  entries: SystemBEntry[],
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const combined = combineEntries(record, entries);

  if (combined.isDuplicate) {
    discrepancies.push(buildDuplicate(record, entries, combined));
  }

  discrepancies.push(...compareValues(record, entries, combined));
  discrepancies.push(...compareLocations(record, entries, combined));
  discrepancies.push(...compareDates(record, entries, combined));
  discrepancies.push(...checkVoided(record, entries, combined));

  return discrepancies;
}

/**
 * Reduce the System B entries for one record to a single comparable value,
 * and decide whether having more than one of them is a problem.
 *
 * This is the function that keeps the split record from being called a
 * duplicate. A record split across several rows carries a label like
 * "Entry part 2 of 2" on at least one of them; those rows are one record
 * recorded in pieces, so their values are summed and no duplicate is raised.
 * Several rows with no such marker are a genuine double entry, and there the
 * repeated value - not the sum - is what System B believes.
 */
type CombinedEntries = {
  /** What System B says this record is worth, in minor units. Null if unusable. */
  valueMinor: number | null;
  isSplit: boolean;
  isDuplicate: boolean;
  /** Extra context appended to the detail line, e.g. an incomplete split. */
  note: string;
};

function combineEntries(record: SystemARecord, entries: SystemBEntry[]): CombinedEntries {
  const isSplit = entries.some((entry) => entry.splitPartTotal !== null);
  const hasUnreadableValue = entries.some((entry) => entry.valueMinor === null);

  if (isSplit) {
    const declaredPartTotal = Math.max(
      ...entries.map((entry) => entry.splitPartTotal ?? 0),
    );

    // A split we only have part of is worth saying out loud, but it is still
    // compared on the sum of what we do have rather than being dropped.
    const note =
      entries.length === declaredPartTotal
        ? `System B recorded this as ${entries.length} parts that sum to the compared value.`
        : `System B labelled this as ${declaredPartTotal} parts but only ${entries.length} were found.`;

    return {
      valueMinor: hasUnreadableValue ? null : sumEntryValues(entries),
      isSplit: true,
      isDuplicate: false,
      note,
    };
  }

  if (entries.length > 1) {
    // A true duplicate. The value System B holds is the repeated one, so we
    // compare against a single entry, not the sum - summing would invent a
    // value mismatch on top of the duplicate.
    const distinctValues = new Set(entries.map((entry) => entry.valueMinor));
    const note =
      distinctValues.size === 1
        ? "The duplicated entries carry the same value."
        : "The duplicated entries do not even agree with each other.";

    return {
      valueMinor: entries[0].valueMinor,
      isSplit: false,
      isDuplicate: true,
      note,
    };
  }

  return {
    valueMinor: entries[0].valueMinor,
    isSplit: false,
    isDuplicate: false,
    note: "",
  };
}

function sumEntryValues(entries: SystemBEntry[]): number {
  return addMoney(...entries.map((entry) => entry.valueMinor ?? 0));
}

/** DUPLICATE_IN_B - the same record entered into System B more than once. */
function buildDuplicate(
  record: SystemARecord,
  entries: SystemBEntry[],
  combined: CombinedEntries,
): Discrepancy {
  return {
    reason: "DUPLICATE_IN_B",
    recordId: record.recordId,
    entryIds: entries.map((entry) => entry.entryId),
    orgId: ownerOrgOf(record, entries),
    locationId: record.locationId,
    systemALocationId: record.locationId,
    systemBLocationId: entries[0].locationId,
    systemAValueMinor: record.totalValueMinor,
    systemBValueMinor: combined.valueMinor,
    differenceMinor: null,
    detail:
      `System A record ${record.recordId} appears ${entries.length} times in System B ` +
      `(${entries.map((entry) => entry.entryId).join(", ")}). ${combined.note}`,
  };
}

/**
 * VALUE_MISMATCH - the two systems report different amounts.
 * VALUE_NOT_COMPARABLE - one side has no usable number, so we say so rather
 * than reporting a mismatch against a value we do not have.
 */
function compareValues(
  record: SystemARecord,
  entries: SystemBEntry[],
  combined: CombinedEntries,
): Discrepancy[] {
  const systemAValue = record.totalValueMinor;
  const systemBValue = combined.valueMinor;

  const base = {
    recordId: record.recordId,
    entryIds: entries.map((entry) => entry.entryId),
    orgId: ownerOrgOf(record, entries),
    locationId: record.locationId,
    systemALocationId: record.locationId,
    systemBLocationId: entries[0].locationId,
    systemAValueMinor: systemAValue,
    systemBValueMinor: systemBValue,
  };

  if (systemAValue === null || systemBValue === null) {
    const missingSide = systemAValue === null ? "System A" : "System B";
    return [
      {
        ...base,
        reason: "VALUE_NOT_COMPARABLE",
        differenceMinor: null,
        detail:
          `${missingSide} has no readable value for ${record.recordId}, ` +
          `so the two cannot be compared.`,
      },
    ];
  }

  if (systemAValue === systemBValue) return [];

  return [
    {
      ...base,
      reason: "VALUE_MISMATCH",
      differenceMinor: systemBValue - systemAValue,
      detail:
        `System A has ${formatMoney(systemAValue)}, System B has ${formatMoney(systemBValue)} ` +
        `(difference ${formatMoney(systemBValue - systemAValue)}).` +
        describeLikelyCause(record, systemBValue) +
        (combined.note ? ` ${combined.note}` : ""),
    },
  ];
}

/**
 * A cheap, honest hint rather than a correction. Several System B values in
 * this dataset are exactly System A's base_value, i.e. the adjustment was
 * dropped on the way across. Saying so saves the reader the arithmetic; we
 * still report it as a mismatch and change nothing.
 */
function describeLikelyCause(record: SystemARecord, systemBValue: number): string {
  if (record.baseValueMinor !== null && systemBValue === record.baseValueMinor) {
    return " System B's value equals System A's base_value, so the adjustment looks to have been dropped.";
  }
  return "";
}

/**
 * LOCATION_MISMATCH - the two systems filed the same record against different
 * locations. Called out separately when the two locations belong to different
 * orgs, because that is a tenancy problem and not just a typo.
 */
function compareLocations(
  record: SystemARecord,
  entries: SystemBEntry[],
  combined: CombinedEntries,
): Discrepancy[] {
  const mismatched = entries.filter(
    (entry) => entry.locationId !== null && entry.locationId !== record.locationId,
  );
  if (mismatched.length === 0) return [];

  const entry = mismatched[0];
  const crossesOrgBoundary =
    record.orgId !== null && entry.orgId !== null && record.orgId !== entry.orgId;

  const orgNote = crossesOrgBoundary
    ? ` These locations belong to different orgs (${record.orgId} and ${entry.orgId}), so this crosses a tenant boundary.`
    : "";

  return [
    {
      reason: "LOCATION_MISMATCH",
      recordId: record.recordId,
      entryIds: mismatched.map((each) => each.entryId),
      // Deliberately the System A record's org - see ownerOrgOf.
      orgId: record.orgId,
      locationId: record.locationId,
      systemALocationId: record.locationId,
      systemBLocationId: entry.locationId,
      systemAValueMinor: record.totalValueMinor,
      systemBValueMinor: combined.valueMinor,
      differenceMinor: null,
      detail:
        `System A filed ${record.recordId} against ${record.locationId}, ` +
        `System B against ${entry.locationId}.${orgNote}`,
    },
  ];
}

/** DATE_MISMATCH - same record, different date. */
function compareDates(
  record: SystemARecord,
  entries: SystemBEntry[],
  combined: CombinedEntries,
): Discrepancy[] {
  const mismatched = entries.filter(
    (entry) => entry.recordedOn !== null && entry.recordedOn !== record.eventDate,
  );
  if (mismatched.length === 0) return [];

  const entry = mismatched[0];

  return [
    {
      reason: "DATE_MISMATCH",
      recordId: record.recordId,
      entryIds: mismatched.map((each) => each.entryId),
      orgId: ownerOrgOf(record, entries),
      locationId: record.locationId,
      systemALocationId: record.locationId,
      systemBLocationId: entry.locationId,
      systemAValueMinor: record.totalValueMinor,
      systemBValueMinor: combined.valueMinor,
      differenceMinor: null,
      detail:
        `System A dates ${record.recordId} ${record.eventDate}, ` +
        `System B dates it ${entry.recordedOn}.`,
    },
  ];
}

/**
 * VOIDED_PRESENT_IN_B - System A voided the record but System B still carries
 * an entry for it, so any total taken from System B is overstated.
 */
function checkVoided(
  record: SystemARecord,
  entries: SystemBEntry[],
  combined: CombinedEntries,
): Discrepancy[] {
  if (record.state === null || record.state.toUpperCase() !== "VOIDED") return [];

  return [
    {
      reason: "VOIDED_PRESENT_IN_B",
      recordId: record.recordId,
      entryIds: entries.map((entry) => entry.entryId),
      orgId: ownerOrgOf(record, entries),
      locationId: record.locationId,
      systemALocationId: record.locationId,
      systemBLocationId: entries[0].locationId,
      systemAValueMinor: record.totalValueMinor,
      systemBValueMinor: combined.valueMinor,
      differenceMinor: null,
      detail:
        `System A marked ${record.recordId} ${record.state}, but System B still has ` +
        `${entries.length === 1 ? "an entry" : `${entries.length} entries`} for it.`,
    },
  ];
}

/**
 * Which tenant owns a disagreement.
 *
 * The System A record's org wins whenever there is one. This matters for the
 * record whose two systems disagree about location *across* orgs: if we took
 * the org from System B's location, that disagreement would move to the other
 * tenant and vanish from the one that actually owns the record. An orphan
 * entry has no System A record, so it falls back to System B's location.
 */
function ownerOrgOf(record: SystemARecord | null, entries: SystemBEntry[]): string | null {
  if (record?.orgId) return record.orgId;
  return entries[0]?.orgId ?? null;
}
