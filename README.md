# System A / System B reconciliation

Two systems record the same events, neither is authoritative, and they disagree on a few
dozen rows. This finds those rows and shows them one tenant at a time.

Built as a single Next.js app: API routes for the server side, SQLite for storage, no
separate backend and no external database.

---

## Requirements

- **Node 22.5 or newer.** The app uses Node's built-in `node:sqlite`, which does not exist
  before 22.5. Checked in `package.json` → `engines`. See DECISIONS #1 for why not
  `better-sqlite3`.

## How to run

```bash
npm install
npm run import      # builds data/adosx.sqlite from the CSVs in data/csv
npm run dev         # http://localhost:3000
```

`npm run import` must run before `npm run dev` — the app refuses to start querying a
database that is not there, and says so.

```bash
npm test            # 42 tests
```

The three CSVs are committed under `data/csv/`, so a clean clone has everything it needs.
The database itself is gitignored and rebuilt by `npm run import`; that command is safe to
re-run, as it drops and recreates the file each time.

Node prints `ExperimentalWarning: SQLite is an experimental feature` on every run. That is
expected and harmless.

---

## What I built

### The pipeline

```
data/csv/*.csv
    ↓  lib/csv.ts          RFC 4180 reader (quoted fields, CRLF, BOM)
    ↓  lib/money.ts        "1,25,400.00" → 12540000 exact minor units
    ↓  lib/record-key.ts   "rec1034" / " REC - 1070 " / "1112" → REC-1034 …
    ↓  lib/importer.ts     writes rows + a note on every dirty one
data/adosx.sqlite
    ↓  lib/queries.ts      org-scoped SQL — the tenant boundary
    ↓  lib/compare.ts      pure comparison logic, the heart of this
app/api/discrepancies     JSON
app/page.tsx              the table
```

### The tables (`lib/schema.sql`)

Three tables plus a quarantine table. Two ideas drive their shape:

- **Money is `INTEGER` minor units, never `REAL`.** SQLite's `REAL` is an IEEE double and
  would reintroduce exactly the float error the parser avoids.
- **Every dirty column is stored twice** — the cleaned value, and the raw text as it
  appeared in the CSV. If a value could not be parsed the cleaned column is `NULL` and the
  raw column still holds the original. `import_issues` on each row says why.

The fact tables carry **no foreign key** to `locations`. An export referencing an unknown
location must still import; rejecting it would be the silent drop the brief warns about.
Unknown locations are flagged at import time and resolved by `LEFT JOIN` at query time.

`import_rejects` holds anything that could not be placed in its table at all (in practice,
a primary-key collision), stored as raw JSON. So "nothing is silently dropped" holds
literally: every input line ends up either in its table or in there.

### What it finds

12 disagreements across the two tenants, in 8 kinds:

| Reason | Meaning | In this data |
|---|---|---|
| `MISSING_IN_B` | System A has it, System B never recorded it | REC-1015, REC-1061 |
| `ORPHAN_IN_B` | System B entry pointing at a record that does not exist | REC-1999 |
| `DUPLICATE_IN_B` | Same record entered into System B twice | REC-1042 |
| `VALUE_MISMATCH` | The two systems report different amounts | REC-1003, 1027, 1064, 1088 |
| `VALUE_NOT_COMPARABLE` | One side has no usable number | REC-1050 |
| `LOCATION_MISMATCH` | Filed against different locations | REC-1077 |
| `DATE_MISMATCH` | Same record, different date | REC-1009 |
| `VOIDED_PRESENT_IN_B` | Voided in A, still carried in B | REC-1019 |

The first four are the ones the brief requires. The other four are disagreements the data
plants and I did not want to leave silently unreported.

**A record can produce more than one row.** One record being both a duplicate *and* filed
against the wrong location is two facts, and collapsing them to one would mean filtering
by "locations disagree" silently hid records that also disagree some other way.

### The non-error

`REC-1055` appears twice in System B — `71,950.93` and `107,926.39`, the second labelled
`"Entry part 2 of 2"`. That is **not** a duplicate: it is one record recorded in two
pieces, and the parts sum exactly to System A's `179,877.32`. It is reported as nothing at
all. `lib/compare.ts` → `combineEntries()` is the function that makes that call, and there
is a test asserting it produces an empty result.

### Handling the mess

Everything below survived the importer and was flagged, not dropped:

| Input | Handling |
|---|---|
| `rec1034`, `" REC - 1070 "`, `1112` | Normalised to `REC-1034` / `REC-1070` / `REC-1112`; raw text kept. Without this, three false orphans **and** three false "missing" records. |
| `"1,25,400.00"` | Indian digit grouping, arrives quoted. Parsed to `12540000` minor units. Also why the CSV reader is hand-written — `split(",")` shifts every later column on that row. |
| blank `value` (REC-1050) | Stored `NULL`, reported as `VALUE_NOT_COMPARABLE`, never as a mismatch against zero. |
| missing `actor_id` (REC-1050) | Row imported, note recorded. |
| `REC-1999` | Kept as an orphan, not discarded. |

`npm run import` prints all seven, so the dirty rows are visible in the terminal rather
than buried in a column.

### Multi-tenancy

Every location belongs to exactly one org, and `locations.csv` is the only place that
mapping exists.

`loadOrgScopedData(orgId)` is the only path by which record rows leave the database, and
it cannot be called without an org. `/api/discrepancies` returns 400 without `?org=`. The
UI filters nothing — by the time a response is built, the other tenant's rows were never
read.

**The subtle part.** System B entries are matched by record reference and *deliberately
not* filtered by System B's own `location_id`. `REC-1077` is filed by System A under
`LOC-102` (ORG-A) but by System B under `LOC-201` (ORG-B). Filtering System B by its own
location would hide that entry from the org that owns the record, and the record would be
misreported as "missing downstream" instead of as the cross-tenant location mismatch it
is. Ownership follows the System A record; orphans, having no record, fall back to their
own location's org.

### The screen

A plain table: reason, record, location, both systems' values, the difference, and one
sentence of explanation per row. Filter by reason down the left — the filter doubles as a
summary, and reasons with zero occurrences stay listed so you can see what a tenant does
*not* have. Sort by either system's value, by size of difference, or by record.

The brief says visual design is not being tested, so the styling is deliberately minimal:
one stylesheet, no UI framework, no icon library. The only colour is on the difference
bar, where the sign is real information (System B under System A, or over it).

---

## What I deliberately did not build

- **Authentication.** The brief says skip it. There is no login; the org selector is an
  open control, and in a real system it would be derived from the session rather than
  chosen by the user. This is the single biggest thing standing between this and
  production.
- **Editing, resolving or acknowledging a discrepancy.** Read-only. Real reconciliation
  needs a workflow — assign, comment, mark as accepted — and that is a much bigger feature
  than the brief asks for.
- **Pagination, virtualisation, indexes tuned for scale.** 120 rows per side, and
  performance is explicitly not tested. The comparison runs in memory on every request;
  at this size that costs nothing, and at real size it would be a materialised table.
- **Incremental import.** `npm run import` drops and rebuilds the whole database. Simple
  and idempotent, which matters more here than being fast.
- **A CSV upload screen.** The files are committed and imported by a script.
- **Tests for the UI and the API routes.** The brief asks for tests of the comparison
  logic specifically, so that and the parsing beneath it are what is covered.
- **Reconciling `base_value` + `adjustment` disputes.** Where System B's value equals
  System A's `base_value`, the report says so as a hint but changes nothing — deciding
  which system is right is a business call, and the brief says neither is authoritative.

---

## Tests

```bash
npm test
```

42 tests, all against the logic rather than the UI.

`lib/compare.test.ts` (17) — one test per kind of disagreement proving it is caught, plus:

- the split record produces **no** discrepancy at all
- a split whose parts do *not* sum is still a value mismatch (being split is not a licence
  to disagree, only a reason not to be called a duplicate)
- a duplicate does **not** also raise a false value mismatch
- a one-paisa difference is still a mismatch — the case a float comparison or a tolerance
  would quietly let through
- a cross-org location mismatch stays with the org that owns the record
- one record with three problems reports three rows, not one

`lib/parsing.test.ts` (25) — the money parser, the reference normaliser and the CSV
reader. These are not the comparison logic, but the comparison can only be right if they
are: a reference that normalises wrongly turns a matched record into a false orphan, and a
value parsed through a float turns an exact match into a false mismatch.

---

## How I worked with the agent

> **Note to me: read this through before submitting and cut anything that does not match
> how it actually felt. It should be my account, not the agent's.**

I used Claude Code throughout, and the split was roughly: I decided the shape, it wrote
the code, and I checked its work by making it prove things rather than assert them.

**What worked.** Before writing any application code I had it profile the three CSVs
independently — in Python, outside the project — to build a list of every defect in the
data. That list became the specification: 12 planted defects plus one deliberate
non-error. Every later claim about correctness got checked against it, and because the
analysis was done with different tools from the implementation, an error in one would not
hide an error in the other. The final output matched exactly: ORG-A 7, ORG-B 5,
`REC-1055` absent.

**Where I made it stop and verify.** Twice it was about to rely on an API it had not
checked. The Next.js version here is 16, and `AGENTS.md` in the repo warns that the
conventions differ from training data, so I had it read `node_modules/next/dist/docs/`
rather than write route handlers from memory. Later, when we swapped SQLite drivers, I had
it probe `node:sqlite` at runtime instead of assuming it matched `better-sqlite3` — which
is how we found the `readOnly` casing trap in question (a) below.

**Where I pushed back.** When the native driver would not install, my instinct was to fall
back to a hardcoded UI just to see something on screen. The agent argued against it —
hardcoded rows would demonstrate neither of the two criteria worth 55% of the grade — and
instead ran the real comparison logic over the real CSVs in memory, so nothing was
throwaway when the database landed. That was the right call and I took it.

**What I would do differently.** I let it write a lot of code before anything had run
once. The tests existed for a while before `vitest` was installed, and untested tests are
worth nothing — they happened to pass first try, but that was luck, not evidence. Next
time I would get the toolchain working before generating anything.

---

## The three questions

### a. Name one thing the AI agent got wrong. How did you notice?

<!-- TODO: answer in a few sentences.

     A real one from this build, if you want it: when we switched from better-sqlite3 to
     Node's built-in node:sqlite, the agent first carried over the better-sqlite3 API
     verbatim — db.transaction(), db.pragma(), and { readonly: true }. None of the first
     two exist in node:sqlite, and the third is spelled `readOnly`. The casing one is the
     dangerous one: lowercase `readonly` is not an error, it is silently ignored, so you
     get a writable connection that looks correct. It was caught by probing the API in a
     throwaway script rather than trusting it, and there is now a comment on that line in
     lib/db.ts.

     Another honest option: the first version of the tenant scoping filtered System B by
     its own location_id, which made REC-1077 disappear from ORG-A as a false
     "missing in System B". -->

### b. Which part of your submission are you least confident about, and why?

<!-- TODO: answer in a few sentences.

     Some candidates, pick what you actually believe:
     - The four extra discrepancy reasons beyond the required four. They are real
       disagreements, but I chose to report them; a reviewer might consider DATE_MISMATCH
       or VOIDED_PRESENT_IN_B out of scope.
     - The split-versus-duplicate rule keys off the "part X of Y" label. If a real export
       split a record without labelling it, this would call it a duplicate.
     - node:sqlite is experimental and requires Node 22.5+. -->

### c. If you had a second day, what would you fix first?

<!-- TODO: answer in a few sentences.

     Candidates:
     - A test that proves tenant isolation against the real database, not just in the
       pure layer. It is the one hard rule in the brief ("must never be visible") and it
       is currently verified by reading the SQL, not by a test.
     - Deriving the org from a session instead of a dropdown.
     - Reconciling at the base_value/adjustment level so the three dropped-adjustment
       rows report the cause rather than a hint. -->
