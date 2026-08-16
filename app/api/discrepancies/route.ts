import { DISCREPANCY_REASONS, REASON_LABELS, type DiscrepancyReason } from "@/lib/compare";
import { formatMoney } from "@/lib/money";
import { countByReason, getDiscrepancies, orgExists } from "@/lib/queries";
import {
  SORT_DIRECTIONS,
  SORT_FIELDS,
  type SortDirection,
  type SortField,
} from "@/lib/sort-discrepancies";

/**
 * GET /api/discrepancies?org=ORG-A&reason=VALUE_MISMATCH&sortBy=systemAValue&sortDirection=desc
 *
 * `org` is required. There is no "all orgs" mode: without a tenant scope the
 * request is rejected, so there is no code path that can return two tenants'
 * rows in one response.
 *
 * Money crosses the wire twice - as exact integer minor units for sorting and
 * comparison, and as a preformatted string for display - so the browser never
 * has to turn these amounts back into floats.
 */

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const orgId = params.get("org");
  if (!orgId) {
    return Response.json(
      { error: "An org is required. Pass ?org=ORG-A." },
      { status: 400 },
    );
  }

  try {
    if (!orgExists(orgId)) {
      return Response.json({ error: `Unknown org ${orgId}.` }, { status: 404 });
    }

    const reason = parseReason(params.get("reason"));
    if (reason === "invalid") {
      return Response.json(
        { error: `Unknown reason. Expected one of: ${DISCREPANCY_REASONS.join(", ")}.` },
        { status: 400 },
      );
    }

    const discrepancies = getDiscrepancies({
      orgId,
      reason,
      sortBy: parseSortField(params.get("sortBy")),
      sortDirection: parseSortDirection(params.get("sortDirection")),
    });

    return Response.json({
      orgId,
      count: discrepancies.length,
      countsByReason: countByReason(orgId),
      reasonLabels: REASON_LABELS,
      discrepancies: discrepancies.map(toResponseShape),
    });
  } catch (error) {
    return Response.json({ error: describeError(error) }, { status: 500 });
  }
}

type DiscrepancyForResponse = ReturnType<typeof toResponseShape>;
export type { DiscrepancyForResponse };

function toResponseShape(discrepancy: ReturnType<typeof getDiscrepancies>[number]) {
  return {
    reason: discrepancy.reason,
    reasonLabel: REASON_LABELS[discrepancy.reason],
    recordId: discrepancy.recordId,
    entryIds: discrepancy.entryIds,
    locationId: discrepancy.locationId,
    systemALocationId: discrepancy.systemALocationId,
    systemBLocationId: discrepancy.systemBLocationId,
    systemAValueMinor: discrepancy.systemAValueMinor,
    systemBValueMinor: discrepancy.systemBValueMinor,
    systemAValue: formatOrNull(discrepancy.systemAValueMinor),
    systemBValue: formatOrNull(discrepancy.systemBValueMinor),
    difference: formatOrNull(discrepancy.differenceMinor),
    detail: discrepancy.detail,
  };
}

function formatOrNull(minor: number | null): string | null {
  return minor === null ? null : formatMoney(minor);
}

/** Returns the reason, null for "no filter", or "invalid" for a bad value. */
function parseReason(raw: string | null): DiscrepancyReason | null | "invalid" {
  if (raw === null || raw === "" || raw === "ALL") return null;
  return DISCREPANCY_REASONS.includes(raw as DiscrepancyReason)
    ? (raw as DiscrepancyReason)
    : "invalid";
}

function parseSortField(raw: string | null): SortField {
  return SORT_FIELDS.includes(raw as SortField) ? (raw as SortField) : "systemAValue";
}

function parseSortDirection(raw: string | null): SortDirection {
  return SORT_DIRECTIONS.includes(raw as SortDirection) ? (raw as SortDirection) : "desc";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
