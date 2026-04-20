/**
 * Task health classification shared by the master task list, the burndown
 * charts, and the Gantt rail. Keeps one definition of "green / yellow / red"
 * so server-rendered chips match client-side runtime filtering.
 *
 * Algorithm:
 *  - blocked or explicit BLOCKED status → always red.
 *  - already 100% / DONE → always green.
 *  - before the planned window → green (no expectation yet).
 *  - past the planned end without being done → red.
 *  - inside the window: expected% = time elapsed as share of span;
 *    delta = expected − actual. 0–5 slop is green, 5–15 is yellow, >15 is red.
 */

export type Health = "green" | "yellow" | "red";

export type HealthInput = {
  startDate: Date;
  endDate: Date;
  progress: number;
  blocked?: boolean | null;
  status?: string | null;
  /** Override "now" — primarily for tests and historical recomputation. */
  now?: Date;
};

export function computeHealth(t: HealthInput): Health {
  if (t.blocked || t.status === "BLOCKED") return "red";
  if (t.progress >= 100 || t.status === "DONE") return "green";

  const now = (t.now ?? new Date()).getTime();
  const s = t.startDate.getTime();
  const e = t.endDate.getTime();

  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
    // Degenerate window: fall back to progress alone.
    if (t.progress >= 100) return "green";
    if (now > e) return "red";
    return t.progress > 0 ? "green" : "yellow";
  }

  if (now < s) return "green";
  if (now > e) return "red";

  const expected = ((now - s) / (e - s)) * 100;
  const delta = expected - t.progress;
  if (delta <= 5) return "green";
  if (delta <= 15) return "yellow";
  return "red";
}

/** Same expected% used by computeHealth — exposed so burndown can draw it. */
export function expectedProgressAt(
  startDate: Date,
  endDate: Date,
  at: Date = new Date(),
): number {
  const now = at.getTime();
  const s = startDate.getTime();
  const e = endDate.getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  if (now <= s) return 0;
  if (now >= e) return 100;
  return ((now - s) / (e - s)) * 100;
}
