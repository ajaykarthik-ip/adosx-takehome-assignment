import type { Db } from "./db";
import { getDb } from "./db";
import {
  compareSystems,
  type Discrepancy,
  type DiscrepancyReason,
  type SystemARecord,
  type SystemBEntry,
} from "./compare";
import {
  sortDiscrepancies,
  type SortDirection,
  type SortField,
} from "./sort-discrepancies";

/**
 * Data access, and the only place tenant isolation is enforced.
 *
 * Every query below takes an orgId and constrains on it in SQL. Nothing
 * upstream can ask for "all discrepancies" - `loadOrgScopedData` is the only
 * way rows leave the database, and it cannot be called without an org. The UI
 * filters nothing; by the time a response is built, the other tenant's rows
 * were never read.
 */

export type DiscrepancyQuery = {
  orgId: string;
  reason?: DiscrepancyReason | null;
  sortBy?: SortField;
  sortDirection?: SortDirection;
};

export type Org = { orgId: string; locationCount: number };

/** Every org in the system. Used to populate the org selector. */
export function listOrgs(db: Db = getDb()): Org[] {
  const rows = db
    .prepare(
      `SELECT org_id AS orgId, COUNT(*) AS locationCount
         FROM locations
        GROUP BY org_id
        ORDER BY org_id`,
    )
    .all() as unknown as Org[];

  return rows;
}

export function orgExists(orgId: string, db: Db = getDb()): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM locations WHERE org_id = ? LIMIT 1`)
    .get(orgId) as unknown as { present: number } | undefined;

  return row !== undefined;
}

/**
 * Load exactly the rows one org is allowed to see.
 *
 * There are three pieces, and the second is the subtle one:
 *
 *  1. System A records whose location belongs to this org.
 *  2. System B entries belonging to those records - matched on the record
 *     reference, deliberately *not* filtered by System B's own location.
 *     One record in this dataset is filed by System B against a location in
 *     the other org. Filtering System B by location would hide that entry from
 *     the org that owns the record, and the record would be misreported as
 *     missing downstream instead of as a location mismatch.
 *  3. System B entries that match no System A record at all (orphans). These
 *     have no owning record, so they are scoped by their own location's org.
 *
 * A row whose location is not in locations.csv resolves to no org and is
 * therefore visible to nobody. That is the safe direction to fail: such rows
 * are reported by the importer instead.
 */
export function loadOrgScopedData(
  orgId: string,
  db: Db = getDb(),
): { records: SystemARecord[]; entries: SystemBEntry[] } {
  const recordRows = db
    .prepare(
      `SELECT a.record_id, a.location_id, l.org_id, a.event_date,
              a.total_value_minor, a.base_value_minor, a.adjustment_minor, a.state
         FROM system_a_records a
         JOIN locations l ON l.location_id = a.location_id
        WHERE l.org_id = ?
        ORDER BY a.record_id`,
    )
    .all(orgId) as unknown as SystemARecordRow[];

  const entryRows = db
    .prepare(
      `SELECT b.entry_id, b.record_ref_raw, b.record_ref_key,
              b.location_id, bl.org_id, b.recorded_on, b.value_minor, b.label,
              b.split_part_number, b.split_part_total
         FROM system_b_entries b
         LEFT JOIN locations bl ON bl.location_id = b.location_id
        WHERE
          -- (2) entries belonging to a record this org owns
          b.record_ref_key IN (
            SELECT a.record_id
              FROM system_a_records a
              JOIN locations l ON l.location_id = a.location_id
             WHERE l.org_id = ?
          )
          OR
          -- (3) orphan entries sitting at one of this org's locations
          (
            bl.org_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM system_a_records a WHERE a.record_id = b.record_ref_key
            )
          )
        ORDER BY b.entry_id`,
    )
    .all(orgId, orgId) as unknown as SystemBEntryRow[];

  return {
    records: recordRows.map(toSystemARecord),
    entries: entryRows.map(toSystemBEntry),
  };
}

/**
 * The screen's data: every disagreement for one org, filtered and sorted.
 *
 * Filtering and sorting happen after the comparison because a discrepancy is
 * computed, not stored - there is no table to sort. At 120 rows per side that
 * costs nothing, and it keeps the comparison logic free of query concerns.
 */
export function getDiscrepancies(query: DiscrepancyQuery, db: Db = getDb()): Discrepancy[] {
  const { records, entries } = loadOrgScopedData(query.orgId, db);
  const discrepancies = compareSystems({ records, entries });

  const filtered = query.reason
    ? discrepancies.filter((discrepancy) => discrepancy.reason === query.reason)
    : discrepancies;

  return sortDiscrepancies(filtered, query.sortBy, query.sortDirection);
}

/** Counts per reason for the whole org, so the filter can show totals. */
export function countByReason(
  orgId: string,
  db: Db = getDb(),
): Record<string, number> {
  const { records, entries } = loadOrgScopedData(orgId, db);
  const counts: Record<string, number> = {};

  for (const discrepancy of compareSystems({ records, entries })) {
    counts[discrepancy.reason] = (counts[discrepancy.reason] ?? 0) + 1;
  }

  return counts;
}

// --------------------------------------------------------------------------
// row mapping (snake_case columns -> camelCase domain objects)
// --------------------------------------------------------------------------

type SystemARecordRow = {
  record_id: string;
  location_id: string | null;
  org_id: string | null;
  event_date: string | null;
  total_value_minor: number | null;
  base_value_minor: number | null;
  adjustment_minor: number | null;
  state: string | null;
};

type SystemBEntryRow = {
  entry_id: string;
  record_ref_raw: string | null;
  record_ref_key: string | null;
  location_id: string | null;
  org_id: string | null;
  recorded_on: string | null;
  value_minor: number | null;
  label: string | null;
  split_part_number: number | null;
  split_part_total: number | null;
};

function toSystemARecord(row: SystemARecordRow): SystemARecord {
  return {
    recordId: row.record_id,
    locationId: row.location_id,
    orgId: row.org_id,
    eventDate: row.event_date,
    totalValueMinor: row.total_value_minor,
    baseValueMinor: row.base_value_minor,
    adjustmentMinor: row.adjustment_minor,
    state: row.state,
  };
}

function toSystemBEntry(row: SystemBEntryRow): SystemBEntry {
  return {
    entryId: row.entry_id,
    recordRefRaw: row.record_ref_raw,
    recordRefKey: row.record_ref_key,
    locationId: row.location_id,
    orgId: row.org_id,
    recordedOn: row.recorded_on,
    valueMinor: row.value_minor,
    label: row.label,
    splitPartNumber: row.split_part_number,
    splitPartTotal: row.split_part_total,
  };
}
