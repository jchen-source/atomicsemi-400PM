"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Shared multi-owner / percent-split picker. Used by the /tasks drawer and
 * the Gantt resource picker so both surfaces edit the same data model.
 *
 * Behavior (matches the product spec):
 *   - Single selected person → no split required; parent writes the
 *     legacy `assignee` string only and clears `allocations`.
 *   - Two or more selected → user MUST enter percent values that sum to
 *     100 (±0.1 slack). Save is disabled until the constraint holds.
 *   - "Split evenly" quickly distributes 100 / N across the rows.
 *   - "Unassigned" clears both fields.
 *
 * The caller decides what to do with the returned payload (PATCH the
 * task, update optimistic state, etc.) — this component is pure input.
 */

export type AllocationRow = { name: string; percent: number };

export type AllocationPickerPerson = {
  id: string;
  name: string;
  role: string | null;
  active: boolean;
  /** "roster" rows come from the Person table; "freeform" are names
   *  harvested from task assignee strings so legacy data keeps working.
   *  Optional because the Gantt-side picker only sees the roster and
   *  doesn't need the distinction. */
  source?: "roster" | "freeform";
};

export type AllocationPickerProps = {
  people: AllocationPickerPerson[];
  /** Current explicit split for this task; pass null if none stored. */
  currentAllocations: AllocationRow[] | null;
  /** Current single-assignee string. Used when no explicit split exists,
   *  to preselect the sole owner so the picker opens with context. */
  currentAssignee: string | null;
  /** Optional: estimated hours for the task. Shown next to each row so
   *  the user sees "Alice — 60% ≈ 12h" instead of having to do math. */
  taskEffortHours?: number | null;
  /** Called when the user commits a change. `assignee` is the comma-joined
   *  name list kept in sync for filters/chips that read the legacy field. */
  onSave: (payload: {
    allocations: AllocationRow[] | null;
    assignee: string | null;
  }) => void | Promise<void>;
  onClose: () => void;
  /** Hide the standalone "Unassigned" button — useful when embedding in
   *  a surface that already has its own clear affordance. */
  hideUnassignButton?: boolean;
  /** Optional style overrides for the root. Used by the Gantt to float
   *  the picker at an absolute viewport position (position: fixed) next
   *  to the resource cell instead of anchoring to a relative parent. */
  style?: React.CSSProperties;
  /** Optional class passed through to the root in addition to .alloc-picker. */
  className?: string;
};

/**
 * Parse what's stored on the task (either explicit allocations JSON or a
 * legacy assignee string) into the picker's editable rows. A single-owner
 * task returns a single row with `percent: 100` so the user can see their
 * starting state; if they keep it single we still save as a legacy
 * assignee-only update (no allocations JSON).
 */
export function initialRowsFrom(
  allocations: AllocationRow[] | null,
  assignee: string | null,
): AllocationRow[] {
  if (allocations && allocations.length > 0) {
    return allocations.map((r) => ({
      name: r.name,
      percent: r.percent,
    }));
  }
  const names = splitAssigneeString(assignee);
  if (names.length === 0) return [];
  const share = Math.round((100 / names.length) * 100) / 100;
  return names.map((n) => ({ name: n, percent: share }));
}

function splitAssigneeString(assignee: string | null): string[] {
  if (!assignee) return [];
  const out = new Set<string>();
  for (const part of assignee.split(/[,;/&]/)) {
    const name = part.trim();
    if (name) out.add(name);
  }
  return [...out];
}

function sumPercents(rows: AllocationRow[]): number {
  return rows.reduce((acc, r) => acc + (Number.isFinite(r.percent) ? r.percent : 0), 0);
}

function isValid(rows: AllocationRow[]): boolean {
  if (rows.length === 0) return true; // unassigned is valid
  if (rows.length === 1) return true; // single owner — legacy path, percent ignored
  const s = sumPercents(rows);
  return Math.abs(s - 100) <= 0.1;
}

export function AllocationPicker({
  people,
  currentAllocations,
  currentAssignee,
  taskEffortHours,
  onSave,
  onClose,
  hideUnassignButton,
  style,
  className,
}: AllocationPickerProps) {
  const [rows, setRows] = useState<AllocationRow[]>(() =>
    initialRowsFrom(currentAllocations, currentAssignee),
  );
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Outside-click + Escape to dismiss. Scroll events from inside the
  // picker are explicitly allowed so the roster list can scroll without
  // the popover closing on the user (same pattern as the Gantt resource
  // picker fix).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && rootRef.current && rootRef.current.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const selectedNames = useMemo(
    () => new Set(rows.map((r) => r.name.toLowerCase())),
    [rows],
  );

  const q = query.trim().toLowerCase();
  const filtered = q
    ? people.filter((p) => p.name.toLowerCase().includes(q))
    : people;

  const canCreate = q.length > 0 && !people.some((p) => p.name.toLowerCase() === q);

  const addPerson = useCallback((name: string) => {
    const clean = name.trim();
    if (!clean) return;
    setErr(null);
    setRows((prev) => {
      if (prev.some((r) => r.name.toLowerCase() === clean.toLowerCase())) {
        return prev;
      }
      // New row starts at 0; the user picks a percent (or hits Split evenly).
      // Seeding with even-shares-so-far would overwrite percents the user
      // has already typed, which is more annoying than a fresh row.
      return [...prev, { name: clean, percent: 0 }];
    });
    setQuery("");
  }, []);

  const removePerson = useCallback((name: string) => {
    setErr(null);
    setRows((prev) => prev.filter((r) => r.name !== name));
  }, []);

  const setPercent = useCallback((name: string, value: number) => {
    setErr(null);
    setRows((prev) =>
      prev.map((r) =>
        r.name === name
          ? { ...r, percent: Math.max(0, Math.min(100, value)) }
          : r,
      ),
    );
  }, []);

  const splitEvenly = useCallback(() => {
    setErr(null);
    setRows((prev) => {
      if (prev.length === 0) return prev;
      const each = Math.floor((100 / prev.length) * 100) / 100;
      const next = prev.map((r) => ({ ...r, percent: each }));
      // Fold rounding drift onto the last row so the visible sum is
      // exactly 100. E.g. 3 people → 33.33 / 33.33 / 33.34.
      const drift = 100 - sumPercents(next);
      if (next.length > 0) {
        next[next.length - 1] = {
          ...next[next.length - 1],
          percent: Math.round((next[next.length - 1].percent + drift) * 100) / 100,
        };
      }
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setErr(null);
    setRows([]);
  }, []);

  const total = sumPercents(rows);
  const valid = isValid(rows);
  const needsSplit = rows.length >= 2;

  async function commit() {
    if (!valid || saving) return;
    setSaving(true);
    setErr(null);
    try {
      // Single owner → legacy single-assignee write; don't persist a 100%
      // allocation JSON for the simple case.
      if (rows.length === 0) {
        await onSave({ allocations: null, assignee: null });
      } else if (rows.length === 1) {
        await onSave({ allocations: null, assignee: rows[0].name });
      } else {
        // Snap to 2 decimals so we persist exactly what the user saw.
        const normalized = rows.map((r) => ({
          name: r.name,
          percent: Math.round(r.percent * 100) / 100,
        }));
        const assignee = normalized.map((r) => r.name).join(", ");
        await onSave({ allocations: normalized, assignee });
      }
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className={"alloc-picker" + (className ? " " + className : "")}
      role="dialog"
      aria-label="Edit owners and split"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header className="alloc-picker__head">
        <h3 className="alloc-picker__title">Owners & split</h3>
        <p className="alloc-picker__sub">
          Percentages must sum to 100 when two or more people share a task.
          Hours derive from the task&rsquo;s estimate.
        </p>
      </header>

      {rows.length > 0 && (
        <section className="alloc-picker__selected">
          <div className="alloc-picker__selected-head">
            <span>Selected</span>
            <div className="alloc-picker__selected-actions">
              <button
                type="button"
                className="alloc-picker__mini-btn"
                onClick={splitEvenly}
                disabled={rows.length < 2}
                title={
                  rows.length < 2
                    ? "Add another person to split"
                    : "Split 100% evenly across everyone"
                }
              >
                Split evenly
              </button>
              {!hideUnassignButton && (
                <button
                  type="button"
                  className="alloc-picker__mini-btn alloc-picker__mini-btn--danger"
                  onClick={clearAll}
                >
                  Unassign
                </button>
              )}
            </div>
          </div>
          <ul className="alloc-picker__rows">
            {rows.map((r) => {
              const hours =
                taskEffortHours && taskEffortHours > 0 && rows.length > 1
                  ? Math.round(((r.percent / 100) * taskEffortHours) * 10) /
                    10
                  : null;
              return (
                <li key={r.name} className="alloc-picker__row">
                  <span className="alloc-picker__row-name" title={r.name}>
                    {r.name}
                  </span>
                  {rows.length > 1 ? (
                    <>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={Number.isFinite(r.percent) ? r.percent : 0}
                        onChange={(e) =>
                          setPercent(r.name, Number(e.target.value) || 0)
                        }
                        className="alloc-picker__row-pct"
                        aria-label={`Percent for ${r.name}`}
                      />
                      <span className="alloc-picker__row-unit">%</span>
                      {hours != null && (
                        <span className="alloc-picker__row-hours">
                          ≈ {hours}h
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="alloc-picker__row-solo">sole owner</span>
                  )}
                  <button
                    type="button"
                    className="alloc-picker__row-remove"
                    aria-label={`Remove ${r.name}`}
                    onClick={() => removePerson(r.name)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          {needsSplit && (
            <div
              className={
                "alloc-picker__total" +
                (valid ? "" : " alloc-picker__total--bad")
              }
              aria-live="polite"
            >
              <span>Total</span>
              <strong>{total.toFixed(2)}%</strong>
              <span className="alloc-picker__total-hint">
                {valid ? "Looks good" : "Must equal 100"}
              </span>
            </div>
          )}
        </section>
      )}

      <section className="alloc-picker__roster">
        <input
          ref={inputRef}
          type="text"
          className="alloc-picker__search"
          placeholder="Search or add a new person…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCreate) {
              e.preventDefault();
              addPerson(query);
            }
          }}
        />
        <ul className="alloc-picker__list">
          {filtered.map((p) => {
            const isSelected = selectedNames.has(p.name.toLowerCase());
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={
                    "alloc-picker__person" +
                    (isSelected ? " alloc-picker__person--selected" : "") +
                    (!p.active ? " alloc-picker__person--inactive" : "")
                  }
                  onClick={() =>
                    isSelected ? removePerson(p.name) : addPerson(p.name)
                  }
                >
                  <span className="alloc-picker__person-check" aria-hidden>
                    {isSelected ? "✓" : "+"}
                  </span>
                  <span className="alloc-picker__person-meta">
                    <span className="alloc-picker__person-name">{p.name}</span>
                    {p.role && (
                      <span className="alloc-picker__person-role">
                        {p.role}
                      </span>
                    )}
                  </span>
                  {p.source === "freeform" && (
                    <span
                      className="alloc-picker__tag"
                      title="Used on a task but not in the roster"
                    >
                      legacy
                    </span>
                  )}
                  {!p.active && (
                    <span className="alloc-picker__tag">inactive</span>
                  )}
                </button>
              </li>
            );
          })}
          {canCreate && (
            <li>
              <button
                type="button"
                className="alloc-picker__person alloc-picker__person--new"
                onClick={() => addPerson(query)}
              >
                <span className="alloc-picker__person-check" aria-hidden>
                  +
                </span>
                <span className="alloc-picker__person-name">
                  Add &ldquo;{query.trim()}&rdquo;
                </span>
              </button>
            </li>
          )}
          {!canCreate && filtered.length === 0 && (
            <li className="alloc-picker__empty">No matches.</li>
          )}
        </ul>
      </section>

      {err && <div className="alloc-picker__error">{err}</div>}

      <footer className="alloc-picker__foot">
        <button
          type="button"
          className="alloc-picker__btn alloc-picker__btn--ghost"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="alloc-picker__btn alloc-picker__btn--primary"
          onClick={commit}
          disabled={saving || !valid}
          title={valid ? "Save owners and split" : "Percents must sum to 100"}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </div>
  );
}
