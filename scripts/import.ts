/**
 * Rebuild the SQLite database from the CSVs in data/csv.
 *
 *   npm run import
 *
 * Safe to run repeatedly: it drops and recreates the database each time.
 * Prints a summary of everything the importer had to work around, so a dirty
 * row is visible in the terminal rather than buried in a column.
 */

import { createEmptyDb, DATABASE_PATH } from "../lib/db";
import { importAll } from "../lib/importer";

function main(): void {
  const db = createEmptyDb();

  try {
    const report = importAll(db);

    console.log(`\nImported into ${DATABASE_PATH}`);
    console.log(`  locations        ${report.locations}`);
    console.log(`  system_a records ${report.systemARecords}`);
    console.log(`  system_b entries ${report.systemBEntries}`);

    if (report.issues.length > 0) {
      console.log(`\n${report.issues.length} row(s) imported with issues:`);
      for (const issue of report.issues) {
        console.log(`  ${issue.file}:${issue.line} [${issue.id}] ${issue.issue}`);
      }
    }

    if (report.rejects.length > 0) {
      console.log(
        `\n${report.rejects.length} row(s) could not be placed and were written to import_rejects:`,
      );
      for (const reject of report.rejects) {
        console.log(`  ${reject.file}:${reject.line} ${reject.reason}`);
      }
    } else {
      console.log("\nNo rows were rejected.");
    }

    console.log("");
  } finally {
    db.close();
  }
}

main();
