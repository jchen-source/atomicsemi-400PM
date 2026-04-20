// Open Issues domain helpers. Open Issues are stored as Task rows with
// type="ISSUE" to keep a single source of truth, but we carry enough
// extra metadata (issueType, scheduleImpact, nextStep, resolutionNote)
// for real standup / slip tracking. To avoid a schema migration that
// would ripple through Notion sync and Prisma, the enum fields live in
// the existing `tags` JSON array as `key:value` entries and the free
// text fields live in `description` as a small structured blob.
//
// Reading / writing always goes through these helpers so the encoding
// is centralised and easy to evolve later.

export type IssueStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
export type IssueUrgency = "low" | "medium" | "high" | "critical";
export type IssueType =
  | "Blocker"
  | "Risk"
  | "Dependency"
  | "Decision"
  | "Procurement"
  | "External";
export type ScheduleImpact =
  | "None"
  | "At Risk"
  | "Task Slip"
  | "Milestone Slip";

export const ISSUE_TYPES: IssueType[] = [
  "Blocker",
  "Risk",
  "Dependency",
  "Decision",
  "Procurement",
  "External",
];

export const SCHEDULE_IMPACTS: ScheduleImpact[] = [
  "None",
  "At Risk",
  "Task Slip",
  "Milestone Slip",
];

export const URGENCIES: IssueUrgency[] = ["low", "medium", "high", "critical"];

/** Structured fields we cram into `Task.description` for open issues. */
export type IssueNotes = {
  nextStep: string;
  resolutionNote: string;
};

const NOTES_PREFIX = "__issue__:"; // must stay stable for old rows

export function parseNotes(description: string | null | undefined): IssueNotes {
  if (!description) return { nextStep: "", resolutionNote: "" };
  if (!description.startsWith(NOTES_PREFIX)) {
    // Legacy descriptions (pre-metadata): treat the whole blob as next
    // step so we don't silently lose the content.
    return { nextStep: description.trim(), resolutionNote: "" };
  }
  try {
    const obj = JSON.parse(description.slice(NOTES_PREFIX.length));
    return {
      nextStep: typeof obj?.nextStep === "string" ? obj.nextStep : "",
      resolutionNote:
        typeof obj?.resolutionNote === "string" ? obj.resolutionNote : "",
    };
  } catch {
    return { nextStep: "", resolutionNote: "" };
  }
}

export function serializeNotes(notes: Partial<IssueNotes>): string {
  const full: IssueNotes = {
    nextStep: (notes.nextStep ?? "").slice(0, 2_000),
    resolutionNote: (notes.resolutionNote ?? "").slice(0, 4_000),
  };
  return NOTES_PREFIX + JSON.stringify(full);
}

/**
 * Extract all issue-level enum metadata from the free-form `tags`
 * array. Anything not in a recognised `key:value` form is preserved
 * verbatim so Notion-imported tags survive round trips.
 */
export type IssueMeta = {
  urgency: IssueUrgency;
  issueType: IssueType;
  scheduleImpact: ScheduleImpact;
  /** Everything in `tags` that isn't one of the recognised metadata keys. */
  otherTags: string[];
};

const META_KEYS = new Set([
  "urgency",
  "issuetype", // stored lower-cased for legacy compatibility
  "impact",
]);

export function parseIssueMeta(tags: string[] | null | undefined): IssueMeta {
  const safe = Array.isArray(tags) ? tags : [];
  let urgency: IssueUrgency = "medium";
  let issueType: IssueType = "Blocker";
  let scheduleImpact: ScheduleImpact = "None";
  const otherTags: string[] = [];

  for (const raw of safe) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t) continue;
    const [kRaw, ...rest] = t.split(":");
    const k = (kRaw ?? "").trim().toLowerCase();
    const v = rest.join(":").trim();
    if (!META_KEYS.has(k) || !v) {
      // Allow bare "high"/"low"/"critical" shortcuts for urgency too.
      const bare = t.toLowerCase();
      if (
        bare === "high" ||
        bare === "medium" ||
        bare === "low" ||
        bare === "critical"
      ) {
        urgency = bare as IssueUrgency;
        continue;
      }
      otherTags.push(t);
      continue;
    }
    if (k === "urgency") {
      const lower = v.toLowerCase();
      if (
        lower === "low" ||
        lower === "medium" ||
        lower === "high" ||
        lower === "critical"
      ) {
        urgency = lower as IssueUrgency;
      }
    } else if (k === "issuetype") {
      const match = ISSUE_TYPES.find(
        (it) => it.toLowerCase() === v.toLowerCase(),
      );
      if (match) issueType = match;
    } else if (k === "impact") {
      const normalised = v.replace(/\s+/g, "").toLowerCase();
      const hit = SCHEDULE_IMPACTS.find(
        (s) => s.replace(/\s+/g, "").toLowerCase() === normalised,
      );
      if (hit) scheduleImpact = hit;
    }
  }

  return { urgency, issueType, scheduleImpact, otherTags };
}

/**
 * Re-build the `tags` array from explicit meta + any pass-through
 * tags. Use this when persisting edits so stale metadata entries
 * don't stack up over repeated saves.
 */
export function serializeIssueMeta(
  meta: Partial<IssueMeta> & {
    urgency?: IssueUrgency;
    issueType?: IssueType;
    scheduleImpact?: ScheduleImpact;
  },
  keepTags: string[] = [],
): string[] {
  const out: string[] = [];
  // Preserve non-metadata tags (Notion labels, etc.)
  for (const t of keepTags) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (!trimmed) continue;
    const [kRaw] = trimmed.split(":");
    const k = (kRaw ?? "").trim().toLowerCase();
    if (META_KEYS.has(k)) continue;
    const bare = trimmed.toLowerCase();
    if (
      bare === "high" ||
      bare === "medium" ||
      bare === "low" ||
      bare === "critical"
    ) {
      continue; // bare urgency shortcuts get replaced with the canonical key:value form
    }
    out.push(trimmed);
  }
  if (meta.urgency) out.push(`urgency:${meta.urgency}`);
  if (meta.issueType) out.push(`issueType:${meta.issueType}`);
  if (meta.scheduleImpact) out.push(`impact:${meta.scheduleImpact}`);
  return out;
}

// --- Dates -----------------------------------------------------------

const MS_PER_DAY = 86_400_000;

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Monday-start week containing `d`. */
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay(); // 0=Sunday..6=Saturday
  const diff = (day + 6) % 7; // distance back to Monday
  x.setDate(x.getDate() - diff);
  return x;
}

export function endOfWeek(d: Date): Date {
  const start = startOfWeek(d);
  return new Date(start.getTime() + 7 * MS_PER_DAY - 1);
}

export function isInCurrentWeek(d: Date, now: Date = new Date()): boolean {
  const t = d.getTime();
  return t >= startOfWeek(now).getTime() && t <= endOfWeek(now).getTime();
}

export function isOverdue(dueDate: Date, now: Date = new Date()): boolean {
  return startOfDay(dueDate).getTime() < startOfDay(now).getTime();
}

export function daysUntil(dueDate: Date, now: Date = new Date()): number {
  return Math.round(
    (startOfDay(dueDate).getTime() - startOfDay(now).getTime()) / MS_PER_DAY,
  );
}

// --- Normalised view model -----------------------------------------

/**
 * Shape every client consumer uses. Derived from the Task row plus the
 * parsed metadata above. `linkedTaskId` falls back to `parentId` for
 * legacy rows that were created before we split the two concepts.
 */
export type ActiveIssueView = {
  id: string;
  title: string;
  status: IssueStatus;
  urgency: IssueUrgency;
  issueType: IssueType;
  scheduleImpact: ScheduleImpact;
  owner: string | null;
  nextStep: string;
  resolutionNote: string;
  dueDate: string; // ISO
  originalDueDate: string; // ISO
  linkedTaskId: string | null;
  linkedTaskTitle: string | null;
  linkedParentId: string | null;
  linkedParentTitle: string | null;
  progress: number;
  lastUpdated: string; // ISO
};

export function isResolved(status: IssueStatus): boolean {
  return status === "DONE";
}

export function isActive(status: IssueStatus): boolean {
  return !isResolved(status);
}

export function isAffectingSchedule(v: ActiveIssueView): boolean {
  return (
    v.scheduleImpact === "Task Slip" || v.scheduleImpact === "Milestone Slip"
  );
}

// --- Sort order per spec ------------------------------------------

const URGENCY_RANK: Record<IssueUrgency, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const IMPACT_RANK: Record<ScheduleImpact, number> = {
  "Milestone Slip": 0,
  "Task Slip": 0,
  "At Risk": 1,
  None: 2,
};

export function compareStandupOrder(
  a: ActiveIssueView,
  b: ActiveIssueView,
  now: Date = new Date(),
): number {
  // 1) Critical first
  const u = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (u !== 0) return u;
  // 2) Slipping the schedule ahead of everything else
  const i = IMPACT_RANK[a.scheduleImpact] - IMPACT_RANK[b.scheduleImpact];
  if (i !== 0) return i;
  // 3) Overdue due dates
  const aOver = isOverdue(new Date(a.dueDate), now);
  const bOver = isOverdue(new Date(b.dueDate), now);
  if (aOver !== bOver) return aOver ? -1 : 1;
  // 4) Soonest due date
  const d = new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
  if (d !== 0) return d;
  // 5) Most recently updated
  return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
}

// --- Reminder / standup selectors --------------------------------

export type ReminderItem = {
  id: string;
  title: string;
  owner: string | null;
  plannedEnd: string; // ISO
  percentComplete: number;
  parentWorkstream: string | null;
  kind: "task" | "workstream" | "milestone";
  /** true if this item has active open issues affecting schedule */
  atRisk: boolean;
};

/**
 * Split every task into two standup buckets:
 *   - `shouldHaveStarted` — work whose planned start is today or
 *     earlier, hasn't kicked off (progress === 0 and status is not
 *     IN_PROGRESS/DONE), and doesn't already have an active linked
 *     Open Issue. These are the things a standup actually cares
 *     about: late-to-start work that nobody has flagged yet.
 *   - `comingUp` — work planned to start within the next 5 days.
 *     Useful for "what's landing on deck" conversation.
 *
 * Input rows should already be filtered to the planning set
 * (EPIC/TASK/MILESTONE, not ISSUE).
 */
export function buildReminderBuckets({
  tasks,
  issues,
  parentTitleById,
  now = new Date(),
  horizonDays = 5,
}: {
  tasks: Array<{
    id: string;
    title: string;
    type: string;
    status: string;
    startDate: Date;
    endDate: Date;
    progress: number;
    assignee: string | null;
    parentId: string | null;
  }>;
  issues: ActiveIssueView[];
  parentTitleById: Map<string, string>;
  now?: Date;
  horizonDays?: number;
}): {
  shouldHaveStarted: ReminderItem[];
  comingUp: ReminderItem[];
} {
  // Task ids that already have at least one ACTIVE linked Open Issue,
  // so the standup doesn't duplicate them in the reminder panel.
  const trackedTaskIds = new Set<string>();
  for (const i of issues) {
    if (!isActive(i.status)) continue;
    if (i.linkedTaskId) trackedTaskIds.add(i.linkedTaskId);
  }

  const affectedTaskIds = new Set(
    issues
      .filter((i) => isActive(i.status) && isAffectingSchedule(i))
      .flatMap((i) => [i.linkedTaskId, i.linkedParentId].filter(Boolean) as string[]),
  );

  const today = startOfDay(now);
  const horizonEnd = new Date(today.getTime() + horizonDays * MS_PER_DAY);

  const toItem = (t: (typeof tasks)[number]): ReminderItem => ({
    id: t.id,
    title: t.title,
    owner: t.assignee,
    plannedEnd: t.endDate.toISOString(),
    percentComplete: t.progress,
    parentWorkstream: t.parentId
      ? parentTitleById.get(t.parentId) ?? null
      : null,
    kind:
      t.type === "MILESTONE"
        ? "milestone"
        : t.type === "EPIC"
          ? "workstream"
          : "task",
    atRisk: affectedTaskIds.has(t.id),
  });

  const shouldHaveStarted: ReminderItem[] = [];
  const comingUp: ReminderItem[] = [];

  for (const t of tasks) {
    if (t.status === "DONE") continue;
    const starts = startOfDay(t.startDate);

    // "Should have started": start date is on or before today, the
    // task hasn't been kicked off, and there's no active Open Issue
    // tracking it. Parent rollup containers (EPIC workstreams) are
    // excluded because their dates are derived from children — the
    // children themselves are what the team should actually discuss.
    if (
      t.type !== "EPIC" &&
      starts.getTime() <= today.getTime() &&
      t.status !== "IN_PROGRESS" &&
      t.progress === 0 &&
      !trackedTaskIds.has(t.id)
    ) {
      shouldHaveStarted.push(toItem(t));
    }

    // "Coming up" window excludes already-started work.
    if (
      starts.getTime() > today.getTime() &&
      starts.getTime() <= horizonEnd.getTime()
    ) {
      comingUp.push(toItem(t));
    }
  }

  const byStartThenEnd = (a: ReminderItem, b: ReminderItem) => {
    const ea = new Date(a.plannedEnd).getTime();
    const eb = new Date(b.plannedEnd).getTime();
    return ea - eb;
  };
  shouldHaveStarted.sort(byStartThenEnd);
  comingUp.sort(byStartThenEnd);

  return { shouldHaveStarted, comingUp };
}

/**
 * Simple heuristic for "at risk by date". If we're more than 60% of
 * the way through a task's timeline but less than 40% complete, the
 * progress curve isn't on track and we flag it.
 */
export function dateRisk(
  start: Date,
  end: Date,
  progress: number,
  now: Date,
): boolean {
  const total = end.getTime() - start.getTime();
  if (total <= 0) return false;
  const elapsed = now.getTime() - start.getTime();
  if (elapsed < 0) return false;
  const timeFrac = Math.min(1, elapsed / total);
  const expected = Math.max(0, Math.min(100, Math.round(timeFrac * 100)));
  return expected - progress >= 25 && progress < 90;
}

// --- Summary counts ------------------------------------------------

export function summariseIssues(issues: ActiveIssueView[]): {
  open: number;
  /**
   * Count of issues flagged "high" urgency or above (critical still
   * counts here — the UI surfaces this as "High" so anything more
   * severe rolls up into the same card/filter).
   */
  high: number;
  affectingSchedule: number;
  tasksImpacted: number;
  workstreamsAtRisk: number;
  overdueNextActions: number;
} {
  const active = issues.filter((i) => isActive(i.status));
  const impactedTasks = new Set<string>();
  const atRiskWorkstreams = new Set<string>();
  let high = 0;
  let affecting = 0;
  let overdue = 0;
  const now = new Date();
  for (const i of active) {
    if (i.urgency === "high" || i.urgency === "critical") high += 1;
    if (isAffectingSchedule(i)) {
      affecting += 1;
      if (i.linkedParentId) atRiskWorkstreams.add(i.linkedParentId);
      else if (i.linkedTaskId) atRiskWorkstreams.add(i.linkedTaskId);
    }
    if (i.linkedTaskId) impactedTasks.add(i.linkedTaskId);
    if (isOverdue(new Date(i.dueDate), now)) overdue += 1;
  }
  return {
    open: active.length,
    high,
    affectingSchedule: affecting,
    tasksImpacted: impactedTasks.size,
    workstreamsAtRisk: atRiskWorkstreams.size,
    overdueNextActions: overdue,
  };
}
