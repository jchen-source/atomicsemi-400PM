import type { Task } from "@prisma/client";

export type AssignmentSource = {
  taskId: string;
  taskTitle: string;
  startMs: number;
  endMs: number;
  effortHours: number;
  hoursPerDay: number;
  assigneeNames: string[]; // what the row contributes to; empty name == "Unassigned"
};

export type PersonWeekHours = {
  /** ISO-like key: YYYY-MM-DD of the Monday that starts the week. */
  weekStart: string;
  hours: number;
};

export type ResourceMatrixRow = {
  name: string;
  /** Total hours across the window. */
  totalHours: number;
  /** Hours per week (ordered to match the header). */
  hoursByWeek: number[];
  /** Contributing tasks, for inspection. */
  tasks: Array<{
    taskId: string;
    taskTitle: string;
    hours: number;
  }>;
};

export type ResourceMatrix = {
  weekStarts: string[]; // Monday-of-week date keys, in order
  rows: ResourceMatrixRow[];
  unassigned: ResourceMatrixRow | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfWeekUTC(d: Date): Date {
  const base = startOfDayUTC(d);
  // UTC Monday = 1, Sunday = 0. Shift so Monday is the first day of the week.
  const dow = (base.getUTCDay() + 6) % 7;
  return new Date(base.getTime() - dow * DAY_MS);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function splitAssignees(
  assignee: string | null,
  resourceAllocated: string | null,
): string[] {
  const names = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    for (const part of raw.split(/[,;/&]/)) {
      const name = part.trim();
      if (name) names.add(name);
    }
  };
  add(assignee);
  add(resourceAllocated);
  return [...names];
}

/**
 * Build the per-person per-week hours matrix.
 *
 * Distribution rule (matches the user's spec):
 *   perDay = effortHours / durationInDays
 *   perPersonPerDay = perDay / numAssignees
 *   ...distributed evenly across every day the task spans.
 * Tasks with no assignees go into the "Unassigned" bucket so capacity
 * planning surfaces work that still needs an owner.
 *
 * Double-counting guard (leaves-only + inherit):
 *   Only LEAF tasks (rows with no children in the fetched set)
 *   contribute hours. Parent rows carry a rollup of their children's
 *   effortHours (see lib/schedule.ts#rollupProgress) — counting both
 *   would allocate the same 40 h to, say, Alice twice if she's
 *   assigned to both the workstream and one of its tasks.
 *
 *   If a leaf has no assignee(s) of its own, we walk up the parent
 *   chain and attribute its hours to the nearest ancestor that does.
 *   That lets teams that assign at the workstream level keep working
 *   without explicitly tagging every leaf. If no ancestor has one
 *   either, the hours fall into the "Unassigned" bucket as before.
 */
export function buildResourceMatrix({
  tasks,
  roster,
  windowStart,
  weeks,
}: {
  tasks: Task[];
  roster: string[];
  windowStart: Date;
  weeks: number;
}): ResourceMatrix {
  const weekStartDate = startOfWeekUTC(windowStart);
  const weekStarts: string[] = [];
  const weekIndexByKey = new Map<string, number>();
  for (let i = 0; i < weeks; i++) {
    const ws = new Date(weekStartDate.getTime() + i * 7 * DAY_MS);
    const key = isoDate(ws);
    weekStarts.push(key);
    weekIndexByKey.set(key, i);
  }

  const canonicalRoster = new Map<string, string>();
  for (const name of roster) {
    canonicalRoster.set(name.toLowerCase(), name);
  }

  type Bucket = {
    name: string;
    totalHours: number;
    hoursByWeek: number[];
    byTask: Map<string, { taskId: string; taskTitle: string; hours: number }>;
  };
  const freshBucket = (name: string): Bucket => ({
    name,
    totalHours: 0,
    hoursByWeek: new Array(weeks).fill(0),
    byTask: new Map(),
  });

  const byName = new Map<string, Bucket>();
  // Pre-seed so every roster person shows up even with zero hours.
  for (const r of roster) byName.set(r, freshBucket(r));
  const unassigned = freshBucket("Unassigned");

  const windowStartMs = weekStartDate.getTime();
  const windowEndMs = windowStartMs + weeks * 7 * DAY_MS;

  // Precompute hierarchy lookups so the main loop can detect leaves
  // and walk up to the nearest assigned ancestor without nested scans.
  const tasksById = new Map<string, Task>();
  const hasChildren = new Set<string>();
  for (const t of tasks) {
    tasksById.set(t.id, t);
    if (t.parentId) hasChildren.add(t.parentId);
  }
  const resolveTargets = (t: Task): string[] => {
    // Walk parentId chain, bounded to the depth of the fetched set,
    // collecting the first ancestor (including `t` itself) with any
    // assignee. `seen` guards against cycles from stale data.
    const seen = new Set<string>();
    let cursor: Task | undefined = t;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const names = splitAssignees(cursor.assignee, cursor.resourceAllocated);
      if (names.length > 0) {
        return names.map((raw) => {
          const canon = canonicalRoster.get(raw.toLowerCase());
          return canon ?? raw;
        });
      }
      if (!cursor.parentId) break;
      cursor = tasksById.get(cursor.parentId);
    }
    return [];
  };

  for (const t of tasks) {
    // Skip ISSUE layer and 0-effort tasks; they don't consume capacity.
    if ((t.type ?? "TASK") === "ISSUE") continue;
    // Skip non-leaf rows. Their effortHours is a rollup of their
    // children's hours; counting both double-allocates capacity.
    if (hasChildren.has(t.id)) continue;
    const effort = Number(t.effortHours ?? 0);
    if (!effort || effort <= 0) continue;

    const startMs = new Date(t.startDate).getTime();
    const endMs = new Date(t.endDate).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    // Task days span [start, end] inclusive; use +1 day so a same-day
    // task still contributes one day of effort.
    const spanDays = Math.max(1, Math.round((endMs - startMs) / DAY_MS) + 1);
    const perDay = effort / spanDays;

    const resolved = resolveTargets(t);
    const targets: string[] = resolved.length === 0 ? ["__unassigned__"] : resolved;
    const perPersonPerDay = perDay / targets.length;

    // Walk each day in the task span that also falls inside our window and
    // drop `perPersonPerDay` into each assignee's week bucket.
    const firstDay = startOfDayUTC(new Date(startMs));
    for (let i = 0; i < spanDays; i++) {
      const dayMs = firstDay.getTime() + i * DAY_MS;
      if (dayMs < windowStartMs || dayMs >= windowEndMs) continue;
      const weekKey = isoDate(startOfWeekUTC(new Date(dayMs)));
      const weekIdx = weekIndexByKey.get(weekKey);
      if (weekIdx == null) continue;
      for (const name of targets) {
        let bucket: Bucket;
        if (name === "__unassigned__") {
          bucket = unassigned;
        } else {
          bucket = byName.get(name) ?? freshBucket(name);
          byName.set(name, bucket);
        }
        bucket.totalHours += perPersonPerDay;
        bucket.hoursByWeek[weekIdx] += perPersonPerDay;
        const prev = bucket.byTask.get(t.id);
        if (prev) {
          prev.hours += perPersonPerDay;
        } else {
          bucket.byTask.set(t.id, {
            taskId: t.id,
            taskTitle: t.title,
            hours: perPersonPerDay,
          });
        }
      }
    }
  }

  const toRow = (b: Bucket): ResourceMatrixRow => ({
    name: b.name,
    totalHours: round(b.totalHours),
    hoursByWeek: b.hoursByWeek.map(round),
    tasks: [...b.byTask.values()]
      .map((t) => ({ ...t, hours: round(t.hours) }))
      .sort((a, b) => b.hours - a.hours),
  });

  const rows = [...byName.values()]
    .map(toRow)
    .sort((a, b) => {
      // Roster names first (alpha), then anyone picked up from task strings.
      const aKnown = roster.includes(a.name);
      const bKnown = roster.includes(b.name);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return {
    weekStarts,
    rows,
    unassigned: unassigned.totalHours > 0 ? toRow(unassigned) : null,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function formatWeekLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
