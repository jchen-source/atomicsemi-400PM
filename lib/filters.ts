/**
 * Saved filter predicates for the master task list. Shared between the
 * server-rendered chip counts (app/tasks/page.tsx) and the client-side
 * runtime filter (app/tasks/tasks-client.tsx) so "This Week" always means
 * the same thing.
 *
 * Predicates operate over a trimmed TaskLike shape so they work for both
 * Prisma rows and serialized client payloads.
 */

import { parseTags } from "./utils";

export type SavedView =
  | "all"
  | "inProgress"
  | "blocked"
  | "overdue"
  | "lateStart"
  | "atRisk"
  | "needsUpdate"
  | "byOwner"
  | "byWorkstream";

/**
 * Time-window filter applied alongside SavedView. Orthogonal on purpose:
 * "Blocked · This month" and "At risk · Next week" are both first-class
 * combinations. A range of "any" disables the window filter entirely.
 *
 * Semantics: a task matches a range if its [startDate, endDate] overlaps
 * the range window. Overdue / retro windows intentionally sit in the past.
 */
export type DateRange =
  | "any"
  | "today"
  | "thisWeek"
  | "nextWeek"
  | "lastWeek"
  | "thisMonth"
  | "nextMonth"
  | "lastMonth";

export const DATE_RANGES: { id: DateRange; label: string }[] = [
  { id: "any", label: "All time" },
  { id: "today", label: "Today" },
  { id: "thisWeek", label: "This week" },
  { id: "nextWeek", label: "Next week" },
  { id: "lastWeek", label: "Last week" },
  { id: "thisMonth", label: "This month" },
  { id: "nextMonth", label: "Next month" },
  { id: "lastMonth", label: "Last month" },
];

export type Priority = "high" | "medium" | "low" | null;

export type TaskLike = {
  id: string;
  type: string;
  status: string;
  startDate: Date | string;
  endDate: Date | string;
  progress: number;
  blocked: boolean;
  assignee: string | null;
  parentId: string | null;
  priority: string | null;
  tags: string;
  lastProgressAt: Date | string | null;
};

export type FilterContext = {
  /** "Now" override — makes weekly buckets deterministic for SSR. */
  now: Date;
  /** Predecessor endDates keyed by dependent task id. Used by Next Week. */
  predEndDatesByDependent: Map<string, Date[]>;
};

export const SAVED_VIEWS: { id: SavedView; label: string }[] = [
  { id: "all", label: "All tasks" },
  { id: "inProgress", label: "In progress" },
  { id: "blocked", label: "Blocked" },
  { id: "overdue", label: "Overdue" },
  { id: "lateStart", label: "Late start" },
  { id: "atRisk", label: "At risk" },
  { id: "needsUpdate", label: "Needs update" },
  { id: "byOwner", label: "By owner" },
  { id: "byWorkstream", label: "By workstream" },
];

/**
 * Percentage-point tolerance for "At risk" — a task has to be meaningfully
 * behind its ideal pace before we nag. Matches the yellow band in the
 * burndown health classifier so the two surfaces agree.
 */
const AT_RISK_BEHIND_PP = 15;

export function startOfWeekMonday(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  // JS: 0 = Sunday … 6 = Saturday. Shift so Monday = 0.
  const dow = (c.getDay() + 6) % 7;
  c.setDate(c.getDate() - dow);
  return c;
}

export function endOfWeekSunday(d: Date): Date {
  const s = startOfWeekMonday(d);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  e.setHours(23, 59, 59, 999);
  return e;
}

function startOfMonth(d: Date): Date {
  const c = new Date(d.getFullYear(), d.getMonth(), 1);
  c.setHours(0, 0, 0, 0);
  return c;
}

function endOfMonth(d: Date): Date {
  const c = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  c.setHours(23, 59, 59, 999);
  return c;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function endOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(23, 59, 59, 999);
  return c;
}

/**
 * Resolve a named range to a concrete [start, end] window based on `now`.
 * Returns `null` for `"any"` — callers should treat null as "no filter".
 */
export function dateRangeWindow(
  range: DateRange,
  now: Date,
): { start: Date; end: Date } | null {
  switch (range) {
    case "any":
      return null;
    case "today":
      return { start: startOfDay(now), end: endOfDay(now) };
    case "thisWeek":
      return { start: startOfWeekMonday(now), end: endOfWeekSunday(now) };
    case "nextWeek": {
      const plus = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      return { start: startOfWeekMonday(plus), end: endOfWeekSunday(plus) };
    }
    case "lastWeek": {
      const minus = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { start: startOfWeekMonday(minus), end: endOfWeekSunday(minus) };
    }
    case "thisMonth":
      return { start: startOfMonth(now), end: endOfMonth(now) };
    case "nextMonth": {
      const plus = new Date(now.getFullYear(), now.getMonth() + 1, 15);
      return { start: startOfMonth(plus), end: endOfMonth(plus) };
    }
    case "lastMonth": {
      const minus = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      return { start: startOfMonth(minus), end: endOfMonth(minus) };
    }
  }
}

/**
 * True if the task's [startDate, endDate] overlaps `window` at all, or if
 * the task has already started and is still open (catches in-flight rows
 * from earlier weeks that should still surface for "this month"-style
 * cleanup work).
 */
export function dateRangeMatches(
  task: TaskLike,
  range: DateRange,
  now: Date,
): boolean {
  const win = dateRangeWindow(range, now);
  if (!win) return true;
  const start = toDate(task.startDate).getTime();
  const end = toDate(task.endDate).getTime();
  // Standard overlap check: task ends after window start AND task starts
  // before window end.
  return end >= win.start.getTime() && start <= win.end.getTime();
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/** Effective priority: explicit column first, tag fallback for legacy rows. */
export function effectivePriority(t: {
  priority: string | null;
  tags: string;
}): Priority {
  const p = (t.priority ?? "").toLowerCase();
  if (p === "high" || p === "medium" || p === "low") return p;
  for (const tag of parseTags(t.tags)) {
    const match = /^urgency:(high|medium|low|critical)$/i.exec(tag);
    if (match) {
      const v = match[1].toLowerCase();
      // "critical" was the original label; the UI now calls it "high".
      if (v === "critical") return "high";
      return v as Priority;
    }
  }
  return null;
}

export function filterPredicate(
  view: SavedView,
  task: TaskLike,
  ctx: FilterContext,
): boolean {
  // The master list only covers work items — open issues live elsewhere.
  if (task.type === "ISSUE") return false;

  const now = ctx.now;
  const start = toDate(task.startDate);
  const end = toDate(task.endDate);

  switch (view) {
    case "all":
    case "byOwner":
    case "byWorkstream":
      return true;

    case "inProgress":
      return task.status === "IN_PROGRESS";

    case "blocked":
      return task.blocked || task.status === "BLOCKED";

    case "overdue":
      return (
        task.progress < 100 &&
        task.status !== "DONE" &&
        end.getTime() < now.getTime()
      );

    case "lateStart": {
      // Task was scheduled to start by today but hasn't moved off zero.
      // Either the person didn't start, or they started and forgot to
      // push an update — both cases deserve a nudge. DONE / IN_PROGRESS
      // are filtered out (even at progress=0 you can flip status first
      // and we still want to catch TODO rows specifically).
      if (task.status === "DONE" || task.progress > 0) return false;
      if (task.status === "IN_PROGRESS") return false;
      return start.getTime() <= now.getTime();
    }

    case "atRisk": {
      // "Projected late at current pace." Compare the ideal progress we
      // should have at `now` (based purely on the scheduled window)
      // against actual progress. If we're more than AT_RISK_BEHIND_PP
      // behind and the due date is still in the future, surface the task.
      //
      // Tasks already past their due date go to `overdue` instead — at
      // risk is forward-looking. DONE or progress==100 never at-risk.
      if (task.status === "DONE" || task.progress >= 100) return false;
      if (end.getTime() <= now.getTime()) return false;
      if (start.getTime() >= now.getTime()) return false; // not started yet
      const span = Math.max(1, end.getTime() - start.getTime());
      const elapsed = Math.max(0, now.getTime() - start.getTime());
      const idealPct = Math.min(100, (elapsed / span) * 100);
      return idealPct - task.progress > AT_RISK_BEHIND_PP;
    }

    case "needsUpdate": {
      if (task.status === "DONE" || task.progress >= 100) return false;
      if (!task.lastProgressAt) return true;
      const last = toDate(task.lastProgressAt).getTime();
      const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
      return last < weekAgo;
    }
  }
}

/** Apply a saved view to a flat list of tasks. */
export function applyView(
  view: SavedView,
  tasks: TaskLike[],
  ctx: FilterContext,
): TaskLike[] {
  return tasks.filter((t) => filterPredicate(view, t, ctx));
}
