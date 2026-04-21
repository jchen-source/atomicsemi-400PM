/**
 * Narrow, serializable input for the matrix builder.
 *
 * Prisma `Task` rows upcast into this automatically; client code that
 * only has serialized task data (dates as ISO strings) can also call
 * directly. We accept `Date | string` on both date fields so JSON
 * payloads don't need a hydration pass before getting to us.
 */
export type MatrixTask = {
  id: string;
  title: string;
  parentId: string | null;
  startDate: Date | string;
  endDate: Date | string;
  effortHours: number | null;
  assignee: string | null;
  resourceAllocated: string | null;
  allocations?: string | null;
  type?: string | null;
};

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
 * Distribution rule (business-day weighted):
 *   businessDays = count of Mon–Fri dates in [startDate, endDate]
 *   perDay = effortHours / businessDays
 *   perPersonPerDay = perDay * share(person)
 *     share comes from Task.allocations (percent/100) when present, else
 *     an even 1/N across the names found in assignee/resourceAllocated.
 *   ...distributed across every business day the task spans. Weekends
 *   inside the span carry 0 hours so a task that starts on Wed of week N
 *   only deposits Wed/Thu/Fri load into that week — Sat/Sun contribute
 *   nothing and the remaining effort rolls naturally into Mon-Fri of
 *   week N+1 and beyond.
 *
 *   Falls back to calendar-day distribution when the task has zero
 *   business days (e.g. a one-day task scheduled on a Saturday) so the
 *   hours still surface somewhere instead of silently vanishing.
 *
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
 *   chain and attribute its hours to the nearest ancestor that does
 *   (honoring that ancestor's allocations split too). If no ancestor
 *   has one either, the hours fall into the "Unassigned" bucket.
 */
export function buildResourceMatrix({
  tasks,
  roster,
  windowStart,
  weeks,
}: {
  tasks: MatrixTask[];
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
  const tasksById = new Map<string, MatrixTask>();
  const hasChildren = new Set<string>();
  for (const t of tasks) {
    tasksById.set(t.id, t);
    if (t.parentId) hasChildren.add(t.parentId);
  }
  /**
   * One contribution target: a canonical person name plus the fraction of
   * this task's hours they should receive. Shares across the returned
   * list always sum to ~1 (we defensively re-normalize below to absorb
   * floating point slop from stored percents).
   */
  type Target = { name: string; share: number };

  const canonOf = (raw: string): string =>
    canonicalRoster.get(raw.toLowerCase()) ?? raw;

  const targetsFromTask = (cursor: MatrixTask): Target[] | null => {
    // Explicit percent split wins. We accept the JSON column as-is but
    // defensively guard against malformed rows so one bad record doesn't
    // tank the whole matrix.
    const raw = cursor.allocations ?? null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Array<{
          name?: unknown;
          percent?: unknown;
        }>;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const rows = parsed
            .map((r) => ({
              name: typeof r.name === "string" ? r.name.trim() : "",
              percent: typeof r.percent === "number" ? r.percent : 0,
            }))
            .filter((r) => r.name && r.percent > 0);
          const total = rows.reduce((s, r) => s + r.percent, 0);
          if (rows.length > 0 && total > 0) {
            return rows.map((r) => ({
              name: canonOf(r.name),
              share: r.percent / total,
            }));
          }
        }
      } catch {
        // fall through to the legacy string-based split
      }
    }
    const names = splitAssignees(cursor.assignee, cursor.resourceAllocated);
    if (names.length === 0) return null;
    const share = 1 / names.length;
    return names.map((n) => ({ name: canonOf(n), share }));
  };

  const resolveTargets = (t: MatrixTask): Target[] => {
    // Walk parentId chain, bounded to the depth of the fetched set,
    // returning the first ancestor (including `t` itself) that has any
    // form of assignment. `seen` guards against cycles from stale data.
    const seen = new Set<string>();
    let cursor: MatrixTask | undefined = t;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const targets = targetsFromTask(cursor);
      if (targets) return targets;
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

    const startMs =
      t.startDate instanceof Date
        ? t.startDate.getTime()
        : new Date(t.startDate).getTime();
    const endMs =
      t.endDate instanceof Date
        ? t.endDate.getTime()
        : new Date(t.endDate).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    // Task days span [start, end] inclusive; use +1 day so a same-day
    // task still contributes one day of effort.
    const spanDays = Math.max(1, Math.round((endMs - startMs) / DAY_MS) + 1);

    // Count business days (Mon-Fri) in the task span so effort is spread
    // across realistic working time instead of evenly across weekends.
    // If the task somehow has zero business days (e.g. a single-day task
    // that lands on a Sunday), fall back to calendar-day spreading so the
    // hours still show up somewhere rather than disappearing.
    const firstDay = startOfDayUTC(new Date(startMs));
    let businessDays = 0;
    for (let i = 0; i < spanDays; i++) {
      const dow = new Date(firstDay.getTime() + i * DAY_MS).getUTCDay();
      if (dow !== 0 && dow !== 6) businessDays++;
    }
    const divisor = businessDays > 0 ? businessDays : spanDays;
    const perDay = effort / divisor;
    const spreadAcrossBusinessOnly = businessDays > 0;

    const resolved = resolveTargets(t);
    const targets =
      resolved.length === 0
        ? [{ name: "__unassigned__", share: 1 }]
        : resolved;

    // Walk each day in the task span that also falls inside our window
    // and, when spreading business-only, only the Mon–Fri ones. This is
    // what makes a task starting Wed of week N deposit only Wed/Thu/Fri
    // into that week instead of smearing hours across Sat/Sun too.
    for (let i = 0; i < spanDays; i++) {
      const dayMs = firstDay.getTime() + i * DAY_MS;
      if (dayMs < windowStartMs || dayMs >= windowEndMs) continue;
      if (spreadAcrossBusinessOnly) {
        const dow = new Date(dayMs).getUTCDay();
        if (dow === 0 || dow === 6) continue;
      }
      const weekKey = isoDate(startOfWeekUTC(new Date(dayMs)));
      const weekIdx = weekIndexByKey.get(weekKey);
      if (weekIdx == null) continue;
      for (const target of targets) {
        const slice = perDay * target.share;
        let bucket: Bucket;
        if (target.name === "__unassigned__") {
          bucket = unassigned;
        } else {
          bucket = byName.get(target.name) ?? freshBucket(target.name);
          byName.set(target.name, bucket);
        }
        bucket.totalHours += slice;
        bucket.hoursByWeek[weekIdx] += slice;
        const prev = bucket.byTask.get(t.id);
        if (prev) {
          prev.hours += slice;
        } else {
          bucket.byTask.set(t.id, {
            taskId: t.id,
            taskTitle: t.title,
            hours: slice,
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

/**
 * Render a Monday-based week-start ISO date as an unambiguous range,
 * e.g. "Apr 20 – 26" or "Apr 27 – May 3" when the week spans a month
 * boundary. The column header in /people was showing only the Monday,
 * which looked like a single-day label — users read "Apr 20" and
 * assumed hours charged to it meant work scheduled on the 20th itself,
 * not anywhere in the Mon-Sun window.
 */
export function formatWeekRangeLabel(iso: string): string {
  const start = new Date(iso + "T00:00:00Z");
  const end = new Date(start.getTime() + 6 * DAY_MS);
  const startMonth = start.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const endMonth = end.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  if (startMonth === endMonth) {
    return `${startMonth} ${startDay} – ${endDay}`;
  }
  return `${startMonth} ${startDay} – ${endMonth} ${endDay}`;
}

/**
 * Long form of {@link formatWeekRangeLabel} with explicit Mon / Sun
 * anchors for the hover tooltip. Keeps the visible column header
 * compact while still letting a curious user confirm the full window.
 */
export function formatWeekRangeTooltip(iso: string): string {
  const start = new Date(iso + "T00:00:00Z");
  const end = new Date(start.getTime() + 6 * DAY_MS);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${fmt(start)} – ${fmt(end)}`;
}
