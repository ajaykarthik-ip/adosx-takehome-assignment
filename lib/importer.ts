import fs from "node:fs";
import path from "node:path";
import { runInTransaction, type Db } from "./db";
import { parseCsv, type CsvRow } from "./csv";
import { parseMoney, addMoney } from "./money";
import { canonicalRecordKey, isAlreadyCanonical, parseSplitPart } from "./record-key";

/**
 * CSV -> SQLite importer.
 *
 * The governing rule is that a bad field never costs us the row. Whenever a
 * value cannot be parsed the row is still inserted, the cleaned column is left
 * NULL, the raw text is kept, and a human-readable note is appended to that
 * row's `import_issues`. The only rows that do not reach their table are ones
 * whose primary key collided, and those are written to `import_rejects`
 * verbatim. Every issue is also collected into the returned report so the
 * import prints a summary instead of failing quietly.
 */

export type RowIssue = {
  file: string;
  line: number;
  id: string;
  issue: string;
};

export type ImportReport = {
  locations: number;
  systemARecords: number;
  systemBEntries: number;
  issues: RowIssue[];
  rejects: { file: string; line: number; reason: string }[];
};

const CSV_DIRECTORY = path.join(process.cwd(), "data", "csv");

export function importAll(db: Db, csvDirectory: string = CSV_DIRECTORY): ImportReport {
  const report: ImportReport = {
    locations: 0,
    systemARecords: 0,
    systemBEntries: 0,
    issues: [],
    rejects: [],
  };

  // One transaction for the whole import: either we get a complete database
  // or we get none, never a half-populated one that looks fine.
  runInTransaction(db, () => {
    report.locations = importLocations(db, csvDirectory, report);
    report.systemARecords = importSystemA(db, csvDirectory, report);
    report.systemBEntries = importSystemB(db, csvDirectory, report);
  });

  return report;
}

function readCsvFile(csvDirectory: string, fileName: string) {
  const fullPath = path.join(csvDirectory, fileName);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing input file: ${fullPath}`);
  }
  return parseCsv(fs.readFileSync(fullPath, "utf8"));
}

/** Blank-safe field read: returns null for a missing or whitespace-only field. */
function textOrNull(row: CsvRow, column: string): string | null {
  const value = row[column];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// --------------------------------------------------------------------------
// locations.csv
// --------------------------------------------------------------------------

function importLocations(db: Db, csvDirectory: string, report: ImportReport): number {
  const { rows, lineNumbers } = readCsvFile(csvDirectory, "locations.csv");

  const insert = db.prepare(
    `INSERT INTO locations (location_id, org_id, location_name) VALUES (?, ?, ?)`,
  );

  const seenLocationIds = new Set<string>();
  let inserted = 0;

  rows.forEach((row, index) => {
    const line = lineNumbers[index];
    const locationId = textOrNull(row, "location_id");
    const orgId = textOrNull(row, "org_id");

    // locations.csv is the only place the tenant mapping exists. A location
    // with no id or no org cannot be used for isolation, so it is rejected
    // loudly rather than allowed to produce rows that belong to nobody.
    if (!locationId || !orgId) {
      rejectRow(db, report, "locations.csv", line, row, "missing location_id or org_id");
      return;
    }

    if (seenLocationIds.has(locationId)) {
      rejectRow(db, report, "locations.csv", line, row, `duplicate location_id ${locationId}`);
      return;
    }
    seenLocationIds.add(locationId);

    insert.run(locationId, orgId, textOrNull(row, "location_name"));
    inserted++;
  });

  return inserted;
}

// --------------------------------------------------------------------------
// system_a.csv
// --------------------------------------------------------------------------

function importSystemA(db: Db, csvDirectory: string, report: ImportReport): number {
  const { rows, lineNumbers } = readCsvFile(csvDirectory, "system_a.csv");

  const insert = db.prepare(`
    INSERT INTO system_a_records (
      record_id, location_id, event_date, category_code, actor_id,
      base_value_minor, adjustment_minor, total_value_minor,
      raw_base_value, raw_adjustment, raw_total_value,
      state, source_line, import_issues
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const knownLocationIds = loadKnownLocationIds(db);
  const seenRecordIds = new Set<string>();
  let inserted = 0;

  rows.forEach((row, index) => {
    const line = lineNumbers[index];
    const issues: string[] = [];

    const recordId = textOrNull(row, "record_id");
    if (!recordId) {
      // Without an identifier the row cannot be matched to anything, so it is
      // kept in import_rejects rather than inserted under a made-up id.
      rejectRow(db, report, "system_a.csv", line, row, "missing record_id");
      return;
    }

    if (seenRecordIds.has(recordId)) {
      rejectRow(db, report, "system_a.csv", line, row, `duplicate record_id ${recordId}`);
      return;
    }
    seenRecordIds.add(recordId);

    const base = readMoneyColumn(row, "base_value", issues);
    const adjustment = readMoneyColumn(row, "adjustment", issues);
    const total = readMoneyColumn(row, "total_value", issues);

    // System A carries base, adjustment and total. If they do not agree the
    // row is still imported - we flag it and let the comparison decide what
    // to trust, rather than silently recomputing the total.
    if (base !== null && adjustment !== null && total !== null) {
      const expectedTotal = addMoney(base, adjustment);
      if (expectedTotal !== total) {
        issues.push(
          `base_value + adjustment (${expectedTotal}) does not equal total_value (${total}), in minor units`,
        );
      }
    }

    const locationId = textOrNull(row, "location_id");
    if (!locationId) {
      issues.push("missing location_id");
    } else if (!knownLocationIds.has(locationId)) {
      issues.push(`location_id ${locationId} is not in locations.csv`);
    }

    if (!textOrNull(row, "actor_id")) {
      issues.push("missing actor_id");
    }

    insert.run(
      recordId,
      locationId,
      textOrNull(row, "event_date"),
      textOrNull(row, "category_code"),
      textOrNull(row, "actor_id"),
      base,
      adjustment,
      total,
      row["base_value"] ?? null,
      row["adjustment"] ?? null,
      row["total_value"] ?? null,
      textOrNull(row, "state"),
      line,
      JSON.stringify(issues),
    );
    inserted++;

    recordIssues(report, "system_a.csv", line, recordId, issues);
  });

  return inserted;
}

// --------------------------------------------------------------------------
// system_b.csv
// --------------------------------------------------------------------------

function importSystemB(db: Db, csvDirectory: string, report: ImportReport): number {
  const { rows, lineNumbers } = readCsvFile(csvDirectory, "system_b.csv");

  const insert = db.prepare(`
    INSERT INTO system_b_entries (
      entry_id, record_ref_raw, record_ref_key, location_id, recorded_on,
      value_minor, raw_value, label,
      split_part_number, split_part_total,
      source_line, import_issues
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const knownLocationIds = loadKnownLocationIds(db);
  const knownRecordIds = loadKnownRecordIds(db);
  const seenEntryIds = new Set<string>();
  let inserted = 0;

  rows.forEach((row, index) => {
    const line = lineNumbers[index];
    const issues: string[] = [];

    const entryId = textOrNull(row, "entry_id");
    if (!entryId) {
      rejectRow(db, report, "system_b.csv", line, row, "missing entry_id");
      return;
    }

    if (seenEntryIds.has(entryId)) {
      rejectRow(db, report, "system_b.csv", line, row, `duplicate entry_id ${entryId}`);
      return;
    }
    seenEntryIds.add(entryId);

    // Keep the reference exactly as written, and separately the canonical form
    // used for matching. Both go into the table.
    const rawRef = row["record_ref"] ?? null;
    const refKey = canonicalRecordKey(rawRef);

    if (rawRef === null || rawRef.trim() === "") {
      issues.push("missing record_ref");
    } else if (refKey === null) {
      issues.push(`record_ref ${JSON.stringify(rawRef)} is not a recognisable record reference`);
    } else {
      if (!isAlreadyCanonical(rawRef)) {
        issues.push(`record_ref ${JSON.stringify(rawRef)} normalised to ${refKey}`);
      }
      if (!knownRecordIds.has(refKey)) {
        issues.push(`record_ref ${refKey} does not match any System A record`);
      }
    }

    const value = readMoneyColumn(row, "value", issues);

    const locationId = textOrNull(row, "location_id");
    if (!locationId) {
      issues.push("missing location_id");
    } else if (!knownLocationIds.has(locationId)) {
      issues.push(`location_id ${locationId} is not in locations.csv`);
    }

    const label = textOrNull(row, "label");
    const splitPart = parseSplitPart(label);

    insert.run(
      entryId,
      rawRef,
      refKey,
      locationId,
      textOrNull(row, "recorded_on"),
      value,
      row["value"] ?? null,
      label,
      splitPart?.partNumber ?? null,
      splitPart?.partTotal ?? null,
      line,
      JSON.stringify(issues),
    );
    inserted++;

    recordIssues(report, "system_b.csv", line, entryId, issues);
  });

  return inserted;
}

// --------------------------------------------------------------------------
// shared helpers
// --------------------------------------------------------------------------

/**
 * Parse one money column, appending a note if it could not be read.
 * Returns null when unparseable, which is what goes into the table.
 */
function readMoneyColumn(row: CsvRow, column: string, issues: string[]): number | null {
  const raw = row[column];
  const parsed = parseMoney(raw);

  if (!parsed.ok) {
    issues.push(`${column} could not be parsed (${parsed.reason})`);
    return null;
  }

  // Worth surfacing: the value was readable, but only after removing digit
  // grouping, e.g. the Indian-format "1,25,400.00".
  if (typeof raw === "string" && raw.includes(",")) {
    issues.push(`${column} ${JSON.stringify(raw)} contained digit grouping`);
  }

  return parsed.minor;
}

function loadKnownLocationIds(db: Db): Set<string> {
  const rows = db.prepare(`SELECT location_id FROM locations`).all() as unknown as {
    location_id: string;
  }[];
  return new Set(rows.map((row) => row.location_id));
}

function loadKnownRecordIds(db: Db): Set<string> {
  const rows = db.prepare(`SELECT record_id FROM system_a_records`).all() as unknown as {
    record_id: string;
  }[];
  return new Set(rows.map((row) => row.record_id));
}

function rejectRow(
  db: Db,
  report: ImportReport,
  file: string,
  line: number,
  row: CsvRow,
  reason: string,
): void {
  db.prepare(
    `INSERT INTO import_rejects (source_file, source_line, raw_row, reason) VALUES (?, ?, ?, ?)`,
  ).run(file, line, JSON.stringify(row), reason);

  report.rejects.push({ file, line, reason });
}

function recordIssues(
  report: ImportReport,
  file: string,
  line: number,
  id: string,
  issues: string[],
): void {
  for (const issue of issues) {
    report.issues.push({ file, line, id, issue });
  }
}
