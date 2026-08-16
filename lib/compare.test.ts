import { describe, expect, it } from "vitest";
import {
  compareSystems,
  type Discrepancy,
  type DiscrepancyReason,
  type SystemARecord,
  type SystemBEntry,
} from "./compare";

/**
 * Tests for the comparison logic.
 *
 * Each test builds the smallest pair of rows that produces one kind of
 * disagreement, so a failure points at a rule rather than at a fixture. The
 * builders below fill in sensible defaults; every test overrides only the
 * fields that matter to it, which keeps what is under test visible.
 *
 * The values used are the real ones from the dataset where a real case exists,
 * so these double as a record of what the importer is expected to find.
 */

function aRecord(overrides: Partial<SystemARecord> = {}): SystemARecord {
  return {
    recordId: "REC-1001",
    locationId: "LOC-201",
    orgId: "ORG-B",
    eventDate: "2026-04-03",
    totalValueMinor: 8896992, // 88969.92
    baseValueMinor: 6950775, // 69507.75
    adjustmentMinor: 1946217, // 19462.17
    state: "CONFIRMED",
    ...overrides,
  };
}

function bEntry(overrides: Partial<SystemBEntry> = {}): SystemBEntry {
  return {
    entryId: "ENT/2026/4001",
    recordRefRaw: "REC-1001",
    recordRefKey: "REC-1001",
    locationId: "LOC-201",
    orgId: "ORG-B",
    recordedOn: "2026-04-03",
    valueMinor: 8896992,
    label: "Entry for CAT-02",
    splitPartNumber: null,
    splitPartTotal: null,
    ...overrides,
  };
}

/** All discrepancies of one reason. Keeps the assertions readable. */
function reasonsOf(discrepancies: Discrepancy[]): DiscrepancyReason[] {
  return discrepancies.map((discrepancy) => discrepancy.reason);
}

function only(discrepancies: Discrepancy[], reason: DiscrepancyReason): Discrepancy[] {
  return discrepancies.filter((discrepancy) => discrepancy.reason === reason);
}

describe("a record the two systems agree on", () => {
  it("produces no discrepancies at all", () => {
    const result = compareSystems({ records: [aRecord()], entries: [bEntry()] });

    expect(result).toEqual([]);
  });
});

describe("MISSING_IN_B - a record in System A with no entry in System B", () => {
  it("is flagged, and carries System A's value with nothing on the B side", () => {
    const result = compareSystems({
      records: [aRecord({ recordId: "REC-1015", totalValueMinor: 4109533 })],
      entries: [],
    });

    expect(reasonsOf(result)).toEqual(["MISSING_IN_B"]);
    expect(result[0].recordId).toBe("REC-1015");
    expect(result[0].systemAValueMinor).toBe(4109533);
    expect(result[0].systemBValueMinor).toBeNull();
    expect(result[0].entryIds).toEqual([]);
  });
});

describe("ORPHAN_IN_B - a System B entry pointing at a record that does not exist", () => {
  it("is flagged when the referenced record is absent", () => {
    const result = compareSystems({
      records: [aRecord({ recordId: "REC-1001" })],
      entries: [
        bEntry(),
        bEntry({
          entryId: "ENT/2026/4901",
          recordRefRaw: "REC-1999",
          recordRefKey: "REC-1999",
          valueMinor: 4125000,
        }),
      ],
    });

    const orphans = only(result, "ORPHAN_IN_B");
    expect(orphans).toHaveLength(1);
    expect(orphans[0].entryIds).toEqual(["ENT/2026/4901"]);
    expect(orphans[0].systemAValueMinor).toBeNull();
    expect(orphans[0].systemBValueMinor).toBe(4125000);
  });

  it("is also flagged when the reference is unreadable rather than merely absent", () => {
    // recordRefKey is null when the importer could not recognise the raw
    // reference as a record number at all.
    const result = compareSystems({
      records: [],
      entries: [bEntry({ recordRefRaw: "n/a", recordRefKey: null })],
    });

    expect(reasonsOf(result)).toEqual(["ORPHAN_IN_B"]);
    expect(result[0].detail).toContain("unreadable");
  });
});

describe("DUPLICATE_IN_B - the same record entered into System B twice", () => {
  it("is flagged once, naming both entries", () => {
    const result = compareSystems({
      records: [aRecord({ recordId: "REC-1042", totalValueMinor: 11283706 })],
      entries: [
        bEntry({
          entryId: "ENT/2026/4042",
          recordRefKey: "REC-1042",
          valueMinor: 11283706,
        }),
        bEntry({
          entryId: "ENT/2026/4902",
          recordRefKey: "REC-1042",
          valueMinor: 11283706,
        }),
      ],
    });

    const duplicates = only(result, "DUPLICATE_IN_B");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].entryIds).toEqual(["ENT/2026/4042", "ENT/2026/4902"]);
  });

  it("does not also report a value mismatch, because the value is repeated not doubled", () => {
    // Summing a duplicate would invent a second, false disagreement. The
    // value System B holds is the repeated one.
    const result = compareSystems({
      records: [aRecord({ recordId: "REC-1042", totalValueMinor: 11283706 })],
      entries: [
        bEntry({ entryId: "ENT-1", recordRefKey: "REC-1042", valueMinor: 11283706 }),
        bEntry({ entryId: "ENT-2", recordRefKey: "REC-1042", valueMinor: 11283706 }),
      ],
    });

    expect(reasonsOf(result)).toEqual(["DUPLICATE_IN_B"]);
    expect(only(result, "VALUE_MISMATCH")).toHaveLength(0);
  });
});

describe("VALUE_MISMATCH - the two systems report different values", () => {
  it("is flagged, with an exact difference in minor units", () => {
    // REC-1003: System B stored the base value and lost the adjustment.
    const result = compareSystems({
      records: [
        aRecord({
          recordId: "REC-1003",
          totalValueMinor: 12138801, // 121388.01
          baseValueMinor: 9483438, // 94834.38
          adjustmentMinor: 2655363,
        }),
      ],
      entries: [bEntry({ recordRefKey: "REC-1003", valueMinor: 9483438 })],
    });

    const mismatches = only(result, "VALUE_MISMATCH");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].differenceMinor).toBe(-2655363);
  });

  it("names the dropped adjustment when System B's value is exactly the base value", () => {
    const result = compareSystems({
      records: [
        aRecord({ totalValueMinor: 12138801, baseValueMinor: 9483438, adjustmentMinor: 2655363 }),
      ],
      entries: [bEntry({ valueMinor: 9483438 })],
    });

    expect(only(result, "VALUE_MISMATCH")[0].detail).toContain("adjustment");
  });

  it("compares exactly, so a one-paisa difference is still a mismatch", () => {
    // The reason money is held as integer minor units: this is the case a
    // float comparison, or a tolerance, would quietly let through.
    const result = compareSystems({
      records: [aRecord({ totalValueMinor: 8896992 })],
      entries: [bEntry({ valueMinor: 8896991 })],
    });

    expect(reasonsOf(result)).toEqual(["VALUE_MISMATCH"]);
    expect(only(result, "VALUE_MISMATCH")[0].differenceMinor).toBe(-1);
  });
});

describe("the split record - NOT a duplicate", () => {
  it("sums the parts and reports nothing when they add up to System A's total", () => {
    // REC-1055, the trap in this dataset. Two System B rows for one record,
    // the second labelled "Entry part 2 of 2". 71950.93 + 107926.39 = 179877.32.
    const result = compareSystems({
      records: [
        aRecord({
          recordId: "REC-1055",
          locationId: "LOC-103",
          orgId: "ORG-A",
          eventDate: "2026-03-14",
          totalValueMinor: 17987732,
          baseValueMinor: 14052916,
          adjustmentMinor: 3934816,
        }),
      ],
      entries: [
        bEntry({
          entryId: "ENT/2026/4055",
          recordRefKey: "REC-1055",
          locationId: "LOC-103",
          orgId: "ORG-A",
          recordedOn: "2026-03-14",
          valueMinor: 7195093,
          label: "Entry for CAT-08",
        }),
        bEntry({
          entryId: "ENT/2026/4903",
          recordRefKey: "REC-1055",
          locationId: "LOC-103",
          orgId: "ORG-A",
          recordedOn: "2026-03-14",
          valueMinor: 10792639,
          label: "Entry part 2 of 2",
          splitPartNumber: 2,
          splitPartTotal: 2,
        }),
      ],
    });

    expect(result).toEqual([]);
  });

  it("still reports a value mismatch if the parts do not sum to the total", () => {
    // Being a split is not a licence to disagree - only a reason not to be
    // called a duplicate.
    const result = compareSystems({
      records: [aRecord({ recordId: "REC-1055", totalValueMinor: 17987732 })],
      entries: [
        bEntry({ entryId: "ENT-1", recordRefKey: "REC-1055", valueMinor: 7195093 }),
        bEntry({
          entryId: "ENT-2",
          recordRefKey: "REC-1055",
          valueMinor: 10792600,
          label: "Entry part 2 of 2",
          splitPartNumber: 2,
          splitPartTotal: 2,
        }),
      ],
    });

    expect(reasonsOf(result)).toEqual(["VALUE_MISMATCH"]);
    expect(only(result, "DUPLICATE_IN_B")).toHaveLength(0);
  });
});

describe("LOCATION_MISMATCH - the systems filed the record against different locations", () => {
  it("is flagged when the locations differ within one org", () => {
    const result = compareSystems({
      records: [aRecord({ locationId: "LOC-101", orgId: "ORG-A" })],
      entries: [bEntry({ locationId: "LOC-102", orgId: "ORG-A" })],
    });

    const mismatches = only(result, "LOCATION_MISMATCH");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].systemALocationId).toBe("LOC-101");
    expect(mismatches[0].systemBLocationId).toBe("LOC-102");
  });

  it("says so explicitly when the mismatch crosses the org boundary", () => {
    // REC-1077: System A files it under LOC-102 (ORG-A), System B under
    // LOC-201 (ORG-B). This is a tenancy problem, not just a typo.
    const result = compareSystems({
      records: [aRecord({ recordId: "REC-1077", locationId: "LOC-102", orgId: "ORG-A" })],
      entries: [bEntry({ recordRefKey: "REC-1077", locationId: "LOC-201", orgId: "ORG-B" })],
    });

    const mismatch = only(result, "LOCATION_MISMATCH")[0];
    expect(mismatch.detail).toContain("different orgs");
    // The disagreement stays with the org that owns the System A record,
    // otherwise it would disappear from ORG-A's view entirely.
    expect(mismatch.orgId).toBe("ORG-A");
  });
});

describe("DATE_MISMATCH - the systems date the same record differently", () => {
  it("is flagged", () => {
    // REC-1009 crosses a month boundary, so it also moves between periods.
    const result = compareSystems({
      records: [aRecord({ recordId: "REC-1009", eventDate: "2026-03-31" })],
      entries: [bEntry({ recordRefKey: "REC-1009", recordedOn: "2026-04-02" })],
    });

    expect(only(result, "DATE_MISMATCH")).toHaveLength(1);
    expect(only(result, "DATE_MISMATCH")[0].detail).toContain("2026-04-02");
  });
});

describe("VALUE_NOT_COMPARABLE - one side has no usable number", () => {
  it("is reported instead of a mismatch when System B's value is missing", () => {
    // REC-1050 has a blank value in System B. Calling that a mismatch would
    // imply we know what System B thinks, and we do not.
    const result = compareSystems({
      records: [aRecord({ recordId: "REC-1050", totalValueMinor: 16040585 })],
      entries: [bEntry({ recordRefKey: "REC-1050", valueMinor: null })],
    });

    expect(reasonsOf(result)).toEqual(["VALUE_NOT_COMPARABLE"]);
    expect(only(result, "VALUE_MISMATCH")).toHaveLength(0);
  });
});

describe("VOIDED_PRESENT_IN_B - System A voided it, System B still carries it", () => {
  it("is flagged", () => {
    // REC-1019. Any total taken from System B is overstated by this amount.
    const result = compareSystems({
      records: [aRecord({ recordId: "REC-1019", state: "VOIDED", totalValueMinor: 5709235 })],
      entries: [bEntry({ recordRefKey: "REC-1019", valueMinor: 5709235 })],
    });

    expect(only(result, "VOIDED_PRESENT_IN_B")).toHaveLength(1);
  });
});

describe("more than one thing wrong with the same record", () => {
  it("reports each disagreement separately rather than hiding one behind another", () => {
    const result = compareSystems({
      records: [aRecord({ recordId: "REC-2000", locationId: "LOC-101", totalValueMinor: 1000 })],
      entries: [
        bEntry({ entryId: "ENT-1", recordRefKey: "REC-2000", locationId: "LOC-102", valueMinor: 2000 }),
        bEntry({ entryId: "ENT-2", recordRefKey: "REC-2000", locationId: "LOC-102", valueMinor: 2000 }),
      ],
    });

    expect(reasonsOf(result).sort()).toEqual(
      ["DUPLICATE_IN_B", "LOCATION_MISMATCH", "VALUE_MISMATCH"].sort(),
    );
  });
});
