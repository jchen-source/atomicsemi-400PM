"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatWeekLabel, type ResourceMatrix } from "@/lib/resource-matrix";

type Person = {
  id: string;
  name: string;
  role: string | null;
  active: boolean;
};

export default function PeopleClient({
  people,
  matrix,
}: {
  people: Person[];
  matrix: ResourceMatrix;
}) {
  const router = useRouter();
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const totals = useMemo(() => {
    const cols = matrix.weekStarts.map(() => 0);
    for (const row of matrix.rows) {
      row.hoursByWeek.forEach((h, i) => {
        cols[i] += h;
      });
    }
    if (matrix.unassigned) {
      matrix.unassigned.hoursByWeek.forEach((h, i) => {
        cols[i] += h;
      });
    }
    return cols.map((n) => Math.round(n * 10) / 10);
  }, [matrix]);

  async function addPerson() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, role: newRole.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error ?? "Failed to add contributor");
      }
      setNewName("");
      setNewRole("");
      router.refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to add contributor");
    } finally {
      setBusy(false);
    }
  }

  async function removePerson(id: string, name: string) {
    if (!window.confirm(`Remove ${name} from the roster?`)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/people/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove");
      router.refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setBusy(false);
    }
  }

  // Merge the roster's Person records with any strings the matrix picked
  // up from tasks that weren't in the DB, so the Roster section shows
  // everyone the app currently knows about.
  const rosterByName = new Map(people.map((p) => [p.name, p] as const));
  const extraFromMatrix = matrix.rows
    .filter((r) => !rosterByName.has(r.name))
    .map((r) => ({ name: r.name, totalHours: r.totalHours }));

  return (
    <div className="people-page">
      <header className="people-header">
        <div>
          <h1 className="people-title">People</h1>
          <p className="people-subtitle">
            Individual contributors and weekly resource loading. Effort on
            each task is split evenly across its days and its assigned
            contributors; anything without an assignee drops into
            Unassigned so capacity gaps are visible.
          </p>
        </div>
        <div className="people-add">
          <input
            className="people-input"
            placeholder="Add contributor…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addPerson();
            }}
          />
          <input
            className="people-input people-input--small"
            placeholder="Role (optional)"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addPerson();
            }}
          />
          <button
            className="people-add-btn"
            onClick={() => void addPerson()}
            disabled={busy || !newName.trim()}
            type="button"
          >
            + Add
          </button>
        </div>
      </header>

      {err && <div className="people-error">{err}</div>}

      <section className="people-roster">
        <h2 className="people-section-title">Roster</h2>
        {people.length === 0 && extraFromMatrix.length === 0 ? (
          <p className="people-empty">No contributors yet. Add one above.</p>
        ) : (
          <div className="people-chips">
            {people.map((p) => (
              <div key={p.id} className="person-chip">
                <span className="person-chip-avatar" aria-hidden>
                  {initials(p.name)}
                </span>
                <span className="person-chip-text">
                  <span className="person-chip-name">{p.name}</span>
                  {p.role && (
                    <span className="person-chip-role">{p.role}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="person-chip-remove"
                  onClick={() => void removePerson(p.id, p.name)}
                  aria-label={`Remove ${p.name}`}
                  title="Remove"
                  disabled={busy}
                >
                  ×
                </button>
              </div>
            ))}
            {extraFromMatrix.map((p) => (
              <div key={`extra-${p.name}`} className="person-chip person-chip--orphan">
                <span className="person-chip-avatar" aria-hidden>
                  {initials(p.name)}
                </span>
                <span className="person-chip-text">
                  <span className="person-chip-name">{p.name}</span>
                  <span className="person-chip-role">
                    from task assignments — add to roster
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="people-matrix">
        <div className="people-matrix-header">
          <h2 className="people-section-title">Weekly load</h2>
          <span className="people-matrix-note">
            Hours/week · next {matrix.weekStarts.length} weeks · starting{" "}
            {formatWeekLabel(matrix.weekStarts[0])}
          </span>
        </div>
        <div className="people-matrix-scroll">
          <table className="people-matrix-table">
            <thead>
              <tr>
                <th className="col-name">Contributor</th>
                {matrix.weekStarts.map((w) => (
                  <th key={w} className="col-week">
                    <span className="col-week-label">
                      {formatWeekLabel(w)}
                    </span>
                  </th>
                ))}
                <th className="col-total">Total</th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.length === 0 && !matrix.unassigned && (
                <tr>
                  <td
                    className="people-matrix-empty"
                    colSpan={matrix.weekStarts.length + 2}
                  >
                    No effort-bearing tasks yet. Set{" "}
                    <em>estimated hours</em> and assignees on the Roadmap to
                    see load here.
                  </td>
                </tr>
              )}
              {matrix.rows.map((row) => (
                <tr key={row.name}>
                  <td className="col-name">
                    <div className="cell-person">
                      <span className="cell-person-avatar" aria-hidden>
                        {initials(row.name)}
                      </span>
                      <span className="cell-person-name">{row.name}</span>
                    </div>
                  </td>
                  {row.hoursByWeek.map((h, i) => (
                    <td key={i} className="col-week">
                      <HoursCell hours={h} />
                    </td>
                  ))}
                  <td className="col-total">
                    {row.totalHours > 0 ? `${row.totalHours}h` : "—"}
                  </td>
                </tr>
              ))}
              {matrix.unassigned && (
                <tr className="row-unassigned">
                  <td className="col-name">
                    <div className="cell-person">
                      <span
                        className="cell-person-avatar cell-person-avatar--unassigned"
                        aria-hidden
                      >
                        ?
                      </span>
                      <span className="cell-person-name">Unassigned</span>
                    </div>
                  </td>
                  {matrix.unassigned.hoursByWeek.map((h, i) => (
                    <td key={i} className="col-week">
                      <HoursCell hours={h} unassigned />
                    </td>
                  ))}
                  <td className="col-total">
                    {matrix.unassigned.totalHours > 0
                      ? `${matrix.unassigned.totalHours}h`
                      : "—"}
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <th className="col-name">Total</th>
                {totals.map((t, i) => (
                  <th key={i} className="col-week">
                    {t > 0 ? `${t}h` : ""}
                  </th>
                ))}
                <th className="col-total">
                  {totals.reduce((a, b) => a + b, 0)
                    ? `${Math.round(totals.reduce((a, b) => a + b, 0) * 10) / 10}h`
                    : "—"}
                </th>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>
  );
}

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function HoursCell({
  hours,
  unassigned = false,
}: {
  hours: number;
  unassigned?: boolean;
}) {
  if (!hours) return <span className="hours-empty">·</span>;
  // 40h/week = full. Tint deepens up to that, flags red beyond.
  const pct = Math.min(1, hours / 40);
  const over = hours > 40;
  const base = unassigned ? "250, 204, 21" : "37, 99, 235";
  const bg = over
    ? "rgba(239, 68, 68, 0.22)"
    : `rgba(${base}, ${0.08 + pct * 0.28})`;
  return (
    <span
      className={
        "hours-pill" +
        (over ? " hours-pill--over" : "") +
        (unassigned ? " hours-pill--unassigned" : "")
      }
      style={{ background: bg }}
      title={`${hours}h`}
    >
      {hours}h
    </span>
  );
}
