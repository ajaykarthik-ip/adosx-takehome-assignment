import type { Discrepancy } from "./compare";

/**
 * Sorting for the discrepancies table.
 *
 * Its own module so that both data sources sort identically - swapping the
 * CSV store for SQL must not change the order rows appear in.
 */

export type SortField = "systemAValue" | "systemBValue" | "difference" | "recordId";
export type SortDirection = "asc" | "desc";

export const SORT_FIELDS: SortField[] = [
  "systemAValue",
  "systemBValue",
  "difference",
  "recordId",
];
export const SORT_DIRECTIONS: SortDirection[] = ["asc", "desc"];

export function sortDiscrepancies(
  discrepancies: Discrepancy[],
  sortBy: SortField = "systemAValue",
  direction: SortDirection = "desc",
): Discrepancy[] {
  const multiplier = direction === "asc" ? 1 : -1;

  // Copy first: callers should not have their array reordered underneath them.
  return [...discrepancies].sort((left, right) => {
    if (sortBy === "recordId") {
      return multiplier * (left.recordId ?? "").localeCompare(right.recordId ?? "");
    }

    const leftValue = sortValueOf(left, sortBy);
    const rightValue = sortValueOf(right, sortBy);

    // Rows with no value on the sorted side always sink to the bottom, in
    // either direction. A missing value is not a small value.
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;

    return multiplier * (leftValue - rightValue);
  });
}

function sortValueOf(discrepancy: Discrepancy, sortBy: SortField): number | null {
  if (sortBy === "systemBValue") return discrepancy.systemBValueMinor;
  if (sortBy === "difference") {
    return discrepancy.differenceMinor === null
      ? null
      : Math.abs(discrepancy.differenceMinor);
  }
  return discrepancy.systemAValueMinor;
}
