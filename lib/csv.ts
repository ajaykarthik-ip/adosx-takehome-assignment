/**
 * A small RFC 4180 CSV reader.
 *
 * Written by hand rather than pulled in as a dependency because the only
 * awkward thing these three files do is quote a field that contains commas
 * ("1,25,400.00"), and a naive split(",") gets that wrong by shifting every
 * later column on the row. That single case is worth about forty lines.
 *
 * Handles: quoted fields, commas and newlines inside quotes, doubled quotes
 * as an escaped quote, CRLF and LF line endings, and a UTF-8 BOM.
 *
 * Does not handle: alternative delimiters, or headerless files. Neither
 * appears here.
 */

export type CsvRow = Record<string, string>;

export type ParsedCsv = {
  headers: string[];
  /** One entry per data row. Keys are the header names. */
  rows: CsvRow[];
  /** 1-based line number in the source file for each row, for error messages. */
  lineNumbers: number[];
};

export function parseCsv(text: string): ParsedCsv {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = splitIntoRecords(withoutBom);

  if (records.length === 0) {
    return { headers: [], rows: [], lineNumbers: [] };
  }

  const headers = records[0].fields.map((header) => header.trim());
  const rows: CsvRow[] = [];
  const lineNumbers: number[] = [];

  for (const record of records.slice(1)) {
    // A trailing newline produces one empty record; that is not a data row.
    const isBlankLine = record.fields.length === 1 && record.fields[0].trim() === "";
    if (isBlankLine) continue;

    const row: CsvRow = {};
    headers.forEach((header, columnIndex) => {
      // A short row yields "" rather than undefined, so callers only ever
      // deal with strings. A blank field and a missing field mean the same
      // thing here: no value was supplied.
      row[header] = record.fields[columnIndex] ?? "";
    });

    rows.push(row);
    lineNumbers.push(record.lineNumber);
  }

  return { headers, rows, lineNumbers };
}

type RawRecord = { fields: string[]; lineNumber: number };

/**
 * Walk the text one character at a time, tracking whether we are inside a
 * quoted field. Character-at-a-time is slower than splitting, but it is the
 * only way to know that a comma or newline is data rather than a separator.
 */
function splitIntoRecords(text: string): RawRecord[] {
  const records: RawRecord[] = [];

  let fields: string[] = [];
  let field = "";
  let insideQuotes = false;
  let lineNumber = 1;
  let recordStartLine = 1;

  const finishField = () => {
    fields.push(field);
    field = "";
  };

  const finishRecord = () => {
    finishField();
    records.push({ fields, lineNumber: recordStartLine });
    fields = [];
    recordStartLine = lineNumber;
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (insideQuotes) {
      if (character === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          insideQuotes = false;
        }
      } else {
        if (character === "\n") lineNumber++;
        field += character;
      }
      continue;
    }

    if (character === '"' && field === "") {
      insideQuotes = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\r") {
      // Swallow the CR of a CRLF pair; the LF below ends the record.
      if (text[index + 1] !== "\n") {
        lineNumber++;
        finishRecord();
      }
    } else if (character === "\n") {
      lineNumber++;
      finishRecord();
    } else {
      field += character;
    }
  }

  // A final record with no trailing newline still counts.
  if (field !== "" || fields.length > 0) {
    finishRecord();
  }

  return records;
}
