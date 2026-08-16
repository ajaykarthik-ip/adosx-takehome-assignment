"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import "./ledger.css";

/**
 * The disagreements screen.
 *
 * Every filter and sort is a query parameter handed to the API, so the server
 * does the scoping, filtering and sorting and this file only renders what comes
 * back. In particular the org selector does not filter a list the browser
 * already holds - changing org issues a new request, and the other tenant's
 * rows are never sent here in the first place.
 */

type Org = { orgId: string; locationCount: number };

type Discrepancy = {
  reason: string;
  reasonLabel: string;
  recordId: string | null;
  entryIds: string[];
  locationId: string | null;
  systemALocationId: string | null;
  systemBLocationId: string | null;
  systemAValueMinor: number | null;
  systemBValueMinor: number | null;
  systemAValue: string | null;
  systemBValue: string | null;
  difference: string | null;
  detail: string;
};

type DiscrepancyResponse = {
  orgId: string;
  count: number;
  countsByReason: Record<string, number>;
  reasonLabels: Record<string, string>;
  discrepancies: Discrepancy[];
};

const SORT_OPTIONS = [
  { value: "systemAValue", label: "System A value" },
  { value: "difference", label: "Size of difference" },
  { value: "systemBValue", label: "System B value" },
  { value: "recordId", label: "Record" },
];

const ALL_REASONS = "ALL";

export default function DiscrepanciesPage() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState<string>("");
  const [reason, setReason] = useState<string>(ALL_REASONS);
  const [sortBy, setSortBy] = useState<string>("difference");
  const [sortDirection, setSortDirection] = useState<string>("desc");

  const [data, setData] = useState<DiscrepancyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load the org list once and default to the first, so the page is never in
  // an unscoped state.
  useEffect(() => {
    fetch("/api/orgs")
      .then((response) => response.json())
      .then((payload) => {
        if (payload.error) throw new Error(payload.error);
        setOrgs(payload.orgs);
        if (payload.orgs.length > 0) setOrgId(payload.orgs[0].orgId);
      })
      .catch((loadError: Error) => {
        setError(loadError.message);
        setIsLoading(false);
      });
  }, []);

  const loadDiscrepancies = useCallback(async () => {
    if (!orgId) return;

    setIsLoading(true);
    setError(null);

    const query = new URLSearchParams({ org: orgId, reason, sortBy, sortDirection });

    try {
      const response = await fetch(`/api/discrepancies?${query}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? response.statusText);
      setData(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Request failed");
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, reason, sortBy, sortDirection]);

  useEffect(() => {
    loadDiscrepancies();
  }, [loadDiscrepancies]);

  // Difference bars are scaled against the largest absolute difference on
  // screen, so the column ranks at a glance rather than showing absolute width.
  const largestDifference = useMemo(() => {
    if (!data) return 0;
    return data.discrepancies.reduce((largest, discrepancy) => {
      const difference = differenceMinorOf(discrepancy);
      return difference === null ? largest : Math.max(largest, Math.abs(difference));
    }, 0);
  }, [data]);

  return (
    <div className="ledger">
      <header className="ledger__masthead">
        <div>
          <div className="ledger__eyebrow">System A / System B reconciliation</div>
          <h1 className="ledger__title">Disagreements</h1>
        </div>

        <div className="ledger__scope">
          <span className="ledger__eyebrow" style={{ marginBottom: 0 }}>
            Tenant
          </span>
          <select
            value={orgId}
            onChange={(event) => setOrgId(event.target.value)}
            aria-label="Org"
          >
            {orgs.map((org) => (
              <option key={org.orgId} value={org.orgId}>
                {org.orgId}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && <p className="message message--error">{error}</p>}

      <div className="ledger__body">
        <aside>
          <div className="panel__heading">Reason</div>
          <ReasonFilter
            data={data}
            selected={reason}
            onSelect={setReason}
          />
        </aside>

        <section>
          <div className="toolbar">
            <label>
              Sort by
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Order
              <select
                value={sortDirection}
                onChange={(event) => setSortDirection(event.target.value)}
              >
                <option value="desc">Largest first</option>
                <option value="asc">Smallest first</option>
              </select>
            </label>
          </div>

          {isLoading && <p className="message">Loading…</p>}

          {data && !isLoading && (
            <>
              <p className="count-line">
                {data.discrepancies.length}
                {reason === ALL_REASONS
                  ? ` disagreement${data.discrepancies.length === 1 ? "" : "s"} in ${data.orgId}`
                  : ` of ${data.count} in ${data.orgId}`}
              </p>

              <div className="rows">
                <div className="colhead" role="row">
                  <span>Record</span>
                  <span>Location</span>
                  <span style={{ textAlign: "right" }}>System A</span>
                  <span style={{ textAlign: "right" }}>System B</span>
                  <span>Difference</span>
                </div>

                {data.discrepancies.map((discrepancy, index) => (
                  <Row
                    key={rowKey(discrepancy, index)}
                    discrepancy={discrepancy}
                    largestDifference={largestDifference}
                  />
                ))}
              </div>

              {data.discrepancies.length === 0 && (
                <p className="message">No disagreements match this filter.</p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The reason filter and the reason summary are the same control: each row shows
 * that reason's share of the org's disagreements and selects it when clicked.
 * Reasons with no occurrences stay listed, greyed, so the reader can see which
 * disagreements this org does not have.
 */
function ReasonFilter({
  data,
  selected,
  onSelect,
}: {
  data: DiscrepancyResponse | null;
  selected: string;
  onSelect: (reason: string) => void;
}) {
  if (!data) return null;

  const reasonKeys = Object.keys(data.reasonLabels);
  const largestCount = Math.max(1, ...reasonKeys.map((key) => data.countsByReason[key] ?? 0));

  return (
    <div>
      <ReasonButton
        label="All reasons"
        count={data.count}
        share={1}
        isSelected={selected === ALL_REASONS}
        onSelect={() => onSelect(ALL_REASONS)}
      />
      {reasonKeys.map((key) => {
        const count = data.countsByReason[key] ?? 0;
        return (
          <ReasonButton
            key={key}
            label={data.reasonLabels[key]}
            count={count}
            share={count / largestCount}
            isSelected={selected === key}
            onSelect={() => onSelect(key)}
          />
        );
      })}
    </div>
  );
}

function ReasonButton({
  label,
  count,
  share,
  isSelected,
  onSelect,
}: {
  label: string;
  count: number;
  share: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`reason${count === 0 ? " reason--empty" : ""}`}
      aria-pressed={isSelected}
      onClick={onSelect}
    >
      <span className="reason__line">
        <span className="reason__label">{label}</span>
        <span className="reason__count">{count}</span>
      </span>
      <span className="reason__track">
        <span
          className="reason__fill"
          style={{ width: `${Math.max(0, share) * 100}%` }}
        />
      </span>
    </button>
  );
}

function Row({
  discrepancy,
  largestDifference,
}: {
  discrepancy: Discrepancy;
  largestDifference: number;
}) {
  return (
    <div className="entry">
      <div className="row">
        <span>
          <span className="reason-tag">{discrepancy.reasonLabel}</span>
          <span className="record">{discrepancy.recordId ?? "—"}</span>
        </span>

        <span className="location">{renderLocation(discrepancy)}</span>

        <span className="num">
          {groupDigits(discrepancy.systemAValue) ?? <span className="absent">not recorded</span>}
        </span>

        <span className="num">
          {groupDigits(discrepancy.systemBValue) ?? <span className="absent">not recorded</span>}
        </span>

        <DifferenceGauge discrepancy={discrepancy} largestDifference={largestDifference} />

        <p className="note">
          {discrepancy.detail}
          {discrepancy.entryIds.length > 0 && (
            <>
              {" "}
              <span className="note__ids">{discrepancy.entryIds.join(" · ")}</span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * A diverging bar with zero at the centre: the left arm means System B recorded
 * less than System A, the right arm means more. The sign is printed as a number
 * as well as drawn, so the colour is never the only thing carrying it.
 */
function DifferenceGauge({
  discrepancy,
  largestDifference,
}: {
  discrepancy: Discrepancy;
  largestDifference: number;
}) {
  const differenceMinor = differenceMinorOf(discrepancy);

  // Only one side has a usable number, so there is no difference to draw.
  if (differenceMinor === null) {
    return (
      <span className="delta">
        <span className="absent" style={{ fontSize: 12.5 }}>
          —
        </span>
      </span>
    );
  }

  // The two systems agree on the amount even though they disagree some other
  // way - a duplicate, or a date or location mismatch. Saying "in agreement"
  // is more useful than drawing a zero-width bar.
  if (differenceMinor === 0) {
    return (
      <span className="delta">
        <span className="delta__value delta__value--zero">values agree</span>
      </span>
    );
  }

  const isUnder = differenceMinor < 0;
  const magnitude = formatMinor(Math.abs(differenceMinor));
  const share =
    largestDifference === 0 ? 0 : Math.abs(differenceMinor) / largestDifference;
  // Half the track is one arm, so a full-width arm is 50% of the track.
  const armWidth = `${(share * 50).toFixed(2)}%`;

  return (
    <span className="delta">
      <span
        className="delta__track"
        title={`System B recorded ${groupDigits(magnitude)} ${isUnder ? "less" : "more"} than System A`}
      >
        <span
          className={`delta__fill delta__fill--${isUnder ? "under" : "over"}`}
          style={
            isUnder
              ? { right: "50%", width: armWidth }
              : { left: "50%", width: armWidth }
          }
        />
      </span>
      <span className={`delta__value delta__value--${isUnder ? "under" : "over"}`}>
        {isUnder ? "−" : "+"}
        {groupDigits(magnitude)}
      </span>
    </span>
  );
}

/**
 * Show one location normally, but both when the systems disagree - the whole
 * point of a location-mismatch row is seeing the two sides next to each other.
 */
function renderLocation(discrepancy: Discrepancy) {
  const { systemALocationId, systemBLocationId } = discrepancy;

  if (systemALocationId && systemBLocationId && systemALocationId !== systemBLocationId) {
    return (
      <>
        {systemALocationId}
        <span className="location__vs">vs</span>
        <span className="location__b">{systemBLocationId}</span>
      </>
    );
  }

  return systemALocationId ?? systemBLocationId ?? "—";
}

/**
 * System B minus System A, in exact minor units, or null when either side has
 * no usable number. Subtracting integers keeps this exact.
 */
function differenceMinorOf(discrepancy: Discrepancy): number | null {
  const { systemAValueMinor, systemBValueMinor } = discrepancy;
  if (systemAValueMinor === null || systemBValueMinor === null) return null;
  return systemBValueMinor - systemAValueMinor;
}

/** Integer minor units back to a plain decimal string, e.g. 5784416 -> "57844.16". */
function formatMinor(minor: number): string {
  const whole = Math.floor(minor / 100);
  const paise = minor % 100;
  return `${whole}.${String(paise).padStart(2, "0")}`;
}

/**
 * Add thousands separators for display only, by string manipulation.
 *
 * The server sends money as an exact decimal string; turning it into a Number
 * to format it would undo the whole point of parsing it as integer minor units
 * in the first place.
 */
function groupDigits(plain: string | null): string | null {
  if (plain === null) return null;

  const isNegative = plain.startsWith("-");
  const unsigned = isNegative ? plain.slice(1) : plain;
  const [wholePart, fractionPart] = unsigned.split(".");

  const grouped = wholePart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${isNegative ? "−" : ""}${grouped}${fractionPart ? `.${fractionPart}` : ""}`;
}

function rowKey(discrepancy: Discrepancy, index: number): string {
  return `${discrepancy.reason}-${discrepancy.recordId}-${discrepancy.entryIds.join("+")}-${index}`;
}
