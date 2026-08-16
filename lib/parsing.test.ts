import { describe, expect, it } from "vitest";
import { parseMoney, formatMoney, addMoney } from "./money";
import { canonicalRecordKey, parseSplitPart } from "./record-key";
import { parseCsv } from "./csv";

/**
 * Tests for the parsing that happens before the comparison runs.
 *
 * The comparison can only be right if these are: a reference that normalises
 * wrongly turns a matched record into a false orphan, and a value parsed
 * through a float turns an exact match into a false mismatch.
 */

describe("parseMoney", () => {
  it("reads a plain amount as exact minor units", () => {
    expect(parseMoney("88969.92")).toEqual({ ok: true, minor: 8896992 });
  });

  it("reads Indian digit grouping, which arrives quoted in the CSV", () => {
    // The real value in system_b.csv, entry ENT/2026/4064.
    expect(parseMoney("1,25,400.00")).toEqual({ ok: true, minor: 12540000 });
  });

  it("reads Western digit grouping the same way", () => {
    expect(parseMoney("125,400.00")).toEqual({ ok: true, minor: 12540000 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseMoney("  1608.95  ")).toEqual({ ok: true, minor: 160895 });
  });

  it("pads a single decimal place", () => {
    expect(parseMoney("10.5")).toEqual({ ok: true, minor: 1050 });
  });

  it("treats a whole number as having no paise", () => {
    expect(parseMoney("1000")).toEqual({ ok: true, minor: 100000 });
  });

  it("reports blank rather than defaulting to zero", () => {
    // Defaulting a blank to 0 would silently turn a missing value into a
    // real disagreement of the full amount.
    expect(parseMoney("")).toEqual({ ok: false, reason: "blank" });
    expect(parseMoney("   ")).toEqual({ ok: false, reason: "blank" });
    expect(parseMoney(null)).toEqual({ ok: false, reason: "blank" });
    expect(parseMoney(undefined)).toEqual({ ok: false, reason: "blank" });
  });

  it("refuses text instead of guessing", () => {
    expect(parseMoney("n/a").ok).toBe(false);
    expect(parseMoney("12.34.56").ok).toBe(false);
    expect(parseMoney("1e5").ok).toBe(false);
  });

  it("handles a negative amount", () => {
    expect(parseMoney("-40.10")).toEqual({ ok: true, minor: -4010 });
  });

  it("does not lose precision the way a float would", () => {
    // 0.1 + 0.2 !== 0.3 in floating point. In minor units it is just 10 + 20.
    const tenth = parseMoney("0.10");
    const fifth = parseMoney("0.20");
    expect(tenth.ok && fifth.ok).toBe(true);
    if (tenth.ok && fifth.ok) {
      expect(addMoney(tenth.minor, fifth.minor)).toBe(30);
      expect(formatMoney(addMoney(tenth.minor, fifth.minor))).toBe("0.30");
    }
  });

  it("round-trips through formatMoney", () => {
    for (const amount of ["0.00", "0.05", "1608.95", "183244.16", "-40.10"]) {
      const parsed = parseMoney(amount);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(formatMoney(parsed.minor)).toBe(amount);
    }
  });
});

describe("canonicalRecordKey", () => {
  it("leaves an already-clean reference alone", () => {
    expect(canonicalRecordKey("REC-1001")).toBe("REC-1001");
  });

  it("normalises the three dirty forms in system_b.csv", () => {
    expect(canonicalRecordKey("rec1034")).toBe("REC-1034");
    expect(canonicalRecordKey(" REC - 1070 ")).toBe("REC-1070");
    expect(canonicalRecordKey("1112")).toBe("REC-1112");
  });

  it("collapses leading zeros so one record cannot become two keys", () => {
    expect(canonicalRecordKey("REC-0042")).toBe("REC-42");
    expect(canonicalRecordKey("REC-42")).toBe("REC-42");
  });

  it("returns null when the reference is not a record reference at all", () => {
    // Null means "flag this row", not "drop it" - the importer keeps the raw
    // text and the comparison reports it as an orphan.
    expect(canonicalRecordKey("")).toBeNull();
    expect(canonicalRecordKey("   ")).toBeNull();
    expect(canonicalRecordKey(null)).toBeNull();
    expect(canonicalRecordKey("no reference")).toBeNull();
  });

  it("does not invent a match out of an unrelated prefix", () => {
    expect(canonicalRecordKey("ENT-1001")).toBeNull();
  });
});

describe("parseSplitPart", () => {
  it("recognises the split label used in system_b.csv", () => {
    expect(parseSplitPart("Entry part 2 of 2")).toEqual({ partNumber: 2, partTotal: 2 });
  });

  it("ignores an ordinary label", () => {
    expect(parseSplitPart("Entry for CAT-08")).toBeNull();
    expect(parseSplitPart(null)).toBeNull();
  });

  it("rejects a nonsensical part number", () => {
    expect(parseSplitPart("part 3 of 2")).toBeNull();
  });
});

describe("parseCsv", () => {
  it("keeps a quoted field containing commas in one column", () => {
    // Splitting on commas here would shift `label` into `value` and lose a
    // column off the end of the row.
    const parsed = parseCsv(
      'entry_id,value,label\r\nENT/2026/4064,"1,25,400.00",Entry for CAT-04\r\n',
    );

    expect(parsed.rows).toEqual([
      { entry_id: "ENT/2026/4064", value: "1,25,400.00", label: "Entry for CAT-04" },
    ]);
  });

  it("handles CRLF and LF alike, and ignores a trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([{ a: "1", b: "2" }]);
    expect(parseCsv("a,b\n1,2\n").rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("gives a short row empty strings rather than undefined", () => {
    expect(parseCsv("a,b,c\n1,2\n").rows).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  it("preserves whitespace inside a field so the raw value is not lost", () => {
    // " REC - 1070 " must survive the CSV layer intact; normalising is the
    // record-key module's job, not the parser's.
    const parsed = parseCsv("entry_id,record_ref\nENT/2026/4070, REC - 1070 \n");
    expect(parsed.rows[0].record_ref).toBe(" REC - 1070 ");
  });

  it("reports the source line number for each row", () => {
    const parsed = parseCsv("a\n1\n2\n3\n");
    expect(parsed.lineNumbers).toEqual([2, 3, 4]);
  });

  it("strips a UTF-8 BOM from the first header", () => {
    expect(parseCsv("﻿a,b\n1,2\n").headers).toEqual(["a", "b"]);
  });
});
