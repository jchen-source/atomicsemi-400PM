import Link from "next/link";
import { prisma } from "@/lib/db";
import { parseTags } from "@/lib/utils";
import { computeHealth, expectedProgressAt } from "@/lib/health";
import { effectivePriority, type TaskLike } from "@/lib/filters";
import { ensurePersonTable } from "@/lib/person-bootstrap";
import type {
  BurndownSnapshotInput,
  BurndownTaskInput,
} from "./burndown-chart";
import TasksClient, {
  type TaskRow,
  type TaskSnapshot,
  type PersonOption,
} from "./tasks-client";

export const dynamic = "force-dynamic";

/**
 * Master task list at /tasks. One indented flat table that reflects the full
 * execution hierarchy (Program → Workstream → Task → Subtask). Saved views
 * let the team pivot into "This Week" / "Blocked" / "Needs Update" etc., and
 * clicking any row opens a drawer that writes a `TaskUpdate` snapshot via
 * /api/tasks/[id]/progress. Burndown reads those snapshots back.
 */
export default async function TasksPage() {
  // Bootstrap the Person table before the concurrent query — otherwise on a
  // fresh SQLite install the `person.findMany` below fires before the table
  // exists and the whole page errors out.
  await ensurePersonTable();
  const [rawTasks, deps, allSnapshots, rawPeople] = await Promise.all([
    prisma.task.findMany({
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    }),
    prisma.dependency.findMany(),
    prisma.taskUpdate.findMany({
      where: { commentType: "PROGRESS" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        taskId: true,
        createdAt: true,
        progress: true,
        remainingEffort: true,
        status: true,
        blocked: true,
        health: true,
        comment: true,
      },
    }),
    prisma.person.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: { id: true, name: true, role: true, active: true },
    }),
  ]);

  // Exclude issues (/open-issues owns them) and the legacy MILESTONE rows.
  const workTasks = rawTasks.filter(
    (t) => t.type !== "ISSUE" && t.type !== "MILESTONE",
  );

  // Compute predecessor end-dates per dependent — used by "Next Week" to
  // surface dep-ready tasks whose predecessors finish in the next 7 days.
  const taskById = new Map(rawTasks.map((t) => [t.id, t]));
  const predEndDatesByDependent = new Map<string, Date[]>();
  for (const d of deps) {
    const pred = taskById.get(d.predecessorId);
    if (!pred) continue;
    const arr = predEndDatesByDependent.get(d.dependentId) ?? [];
    arr.push(pred.endDate);
    predEndDatesByDependent.set(d.dependentId, arr);
  }

  // Latest TaskUpdate per task powers the "Latest comment" column without
  // pulling the full history for every row. We fetch the whole feed grouped
  // on the fly — it's small enough (<10k) for a single query.
  const latestUpdates = await prisma.taskUpdate.findMany({
    where: {
      taskId: { in: workTasks.map((t) => t.id) },
      commentType: "PROGRESS",
    },
    orderBy: { createdAt: "desc" },
  });
  const latestByTaskId = new Map<string, (typeof latestUpdates)[number]>();
  for (const u of latestUpdates) {
    if (!latestByTaskId.has(u.taskId)) latestByTaskId.set(u.taskId, u);
  }

  // Depth lookup for the indented table. Walk parents up, memoize.
  const depthById = new Map<string, number>();
  function depthOf(id: string): number {
    const cached = depthById.get(id);
    if (cached !== undefined) return cached;
    const node = taskById.get(id);
    if (!node || !node.parentId) {
      depthById.set(id, 0);
      return 0;
    }
    const d = depthOf(node.parentId) + 1;
    depthById.set(id, d);
    return d;
  }
  for (const t of workTasks) depthOf(t.id);

  // Child count so the client can render chevrons on parent rows.
  const childCountById = new Map<string, number>();
  for (const t of workTasks) {
    if (!t.parentId) continue;
    childCountById.set(
      t.parentId,
      (childCountById.get(t.parentId) ?? 0) + 1,
    );
  }

  // Stable DFS order matching the Gantt table so users have one mental model.
  const byParent = new Map<string | null, typeof workTasks>();
  for (const t of workTasks) {
    const arr = byParent.get(t.parentId) ?? [];
    arr.push(t);
    byParent.set(t.parentId, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
  const ordered: typeof workTasks = [];
  const visit = (parentId: string | null) => {
    for (const k of byParent.get(parentId) ?? []) {
      ordered.push(k);
      visit(k.id);
    }
  };
  visit(null);

  const now = new Date();

  const rows: TaskRow[] = ordered.map((t) => {
    const priority = effectivePriority(t);
    // Prefer cached Task.health; if a row hasn't been updated post-migration
    // we compute a best-effort health on the fly so the column lights up
    // immediately.
    const health =
      (t.health as "green" | "yellow" | "red" | null) ??
      computeHealth({
        startDate: t.startDate,
        endDate: t.endDate,
        progress: t.progress,
        blocked: t.blocked,
        status: t.status,
        now,
      });
    const expected = Math.round(
      expectedProgressAt(t.startDate, t.endDate, now),
    );
    const latest = latestByTaskId.get(t.id);
    const rowType: TaskRow["rowType"] = deriveRowType(
      t.type,
      depthById.get(t.id) ?? 0,
      (childCountById.get(t.id) ?? 0) > 0,
    );
    return {
      id: t.id,
      title: t.title,
      parentId: t.parentId,
      depth: depthById.get(t.id) ?? 0,
      hasChildren: (childCountById.get(t.id) ?? 0) > 0,
      rowType,
      status: t.status,
      assignee: t.assignee,
      priority,
      startDate: t.startDate.toISOString(),
      endDate: t.endDate.toISOString(),
      progress: t.progress,
      effortHours: t.effortHours,
      remainingEffort: t.remainingEffort,
      blocked: t.blocked,
      nextStep: t.nextStep,
      health,
      expectedProgress: expected,
      lastProgressAt: t.lastProgressAt?.toISOString() ?? null,
      latestComment: latest ? latest.comment : null,
      latestCommentAt: latest ? latest.createdAt.toISOString() : null,
      tags: t.tags,
      updatedAt: t.updatedAt.toISOString(),
    };
  });

  // TaskLike rows for the server-rendered filter chip counts. We keep Date
  // objects here because the shared predicate accepts both.
  const filterRows: TaskLike[] = ordered.map((t) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    startDate: t.startDate,
    endDate: t.endDate,
    progress: t.progress,
    blocked: t.blocked,
    assignee: t.assignee,
    parentId: t.parentId,
    priority: t.priority,
    tags: t.tags,
    lastProgressAt: t.lastProgressAt,
  }));

  // Serialize predEndDates into ISO strings so the client can compute counts
  // with the same predicate set.
  const predEndDatesSerialized: Record<string, string[]> = {};
  for (const [depId, dates] of predEndDatesByDependent) {
    predEndDatesSerialized[depId] = dates.map((d) => d.toISOString());
  }

  // Pre-fetch the last 20 snapshots per task on demand is cheap on SQLite,
  // but for the initial paint we ship only the freshest row's history lazily
  // (via a GET to /api/tasks/[id]) — the client hydrates on drawer open.
  const initialSnapshots: TaskSnapshot[] = [];

  // Burndown payload for the embedded chart on /tasks. Ships the full task
  // hierarchy + every PROGRESS snapshot. Filtering by type keeps `ISSUE` and
  // `MILESTONE` rows out of the rollup.
  const burnTasks: BurndownTaskInput[] = rawTasks
    .filter((t) => t.type !== "ISSUE" && t.type !== "MILESTONE")
    .map((t) => ({
      id: t.id,
      title: t.title,
      parentId: t.parentId,
      startDate: t.startDate.toISOString(),
      endDate: t.endDate.toISOString(),
      progress: t.progress,
      status: t.status,
      health: (t.health as "green" | "yellow" | "red" | null) ?? null,
      effortHours: t.effortHours,
      assignee: t.assignee,
      blocked: t.blocked,
    }));

  const burnSnapshots: BurndownSnapshotInput[] = allSnapshots
    .filter((u) => u.progress !== null)
    .map((u) => ({
      id: u.id,
      taskId: u.taskId,
      createdAt: u.createdAt.toISOString(),
      progress: u.progress ?? 0,
      remainingEffort: u.remainingEffort ?? null,
      status: u.status ?? null,
      health: (u.health as "green" | "yellow" | "red" | null) ?? null,
      comment: u.comment ?? "",
    }));

  return (
    <div className="roadmap-page space-y-3">
      <header className="roadmap-header">
        <div className="roadmap-title-block">
          <h1 className="roadmap-title">Master task list</h1>
          <div className="roadmap-stats">
            <span className="roadmap-stat-pill">
              <span className="roadmap-stat-value">{rows.length}</span>
              <span className="roadmap-stat-label">tasks</span>
            </span>
            <span className="roadmap-stat-pill">
              <span className="roadmap-stat-value">
                {rows.filter((r) => r.status === "IN_PROGRESS").length}
              </span>
              <span className="roadmap-stat-label">in progress</span>
            </span>
            <span className="roadmap-stat-pill roadmap-stat-pill--muted">
              Updated {now.toLocaleDateString()}
            </span>
          </div>
        </div>
        <div className="roadmap-actions">
          <Link href="/" className="roadmap-btn roadmap-btn--ghost">
            Roadmap
          </Link>
        </div>
      </header>

      <TasksClient
        rows={rows}
        filterRows={filterRowsForClient(filterRows)}
        predEndDatesByDependent={predEndDatesSerialized}
        initialSnapshots={initialSnapshots}
        burnTasks={burnTasks}
        burnSnapshots={burnSnapshots}
        nowISO={now.toISOString()}
        // Roster for the drawer's owner picker. Merges the Person table (for
        // real contributors managed via /people) with any free-form assignee
        // string found on existing tasks, so legacy Notion imports still
        // surface their original owner as a suggestion.
        people={buildPeopleOptions(rawPeople, rawTasks)}
      />
    </div>
  );
}

function buildPeopleOptions(
  people: Array<{ id: string; name: string; role: string | null; active: boolean }>,
  tasks: Array<{ assignee: string | null }>,
): PersonOption[] {
  const byName = new Map<string, PersonOption>();
  for (const p of people) {
    byName.set(p.name, {
      id: p.id,
      name: p.name,
      role: p.role,
      active: p.active,
      source: "roster",
    });
  }
  // Fold in freeform assignees from existing tasks so the picker can
  // autocomplete even when the Person table hasn't caught up yet.
  for (const t of tasks) {
    const raw = (t.assignee ?? "").trim();
    if (!raw) continue;
    if (byName.has(raw)) continue;
    byName.set(raw, {
      id: `freeform:${raw}`,
      name: raw,
      role: null,
      active: true,
      source: "freeform",
    });
  }
  return [...byName.values()].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function deriveRowType(
  type: string,
  depth: number,
  hasChildren: boolean,
): TaskRow["rowType"] {
  if (type === "EPIC" && depth === 0) return "program";
  if (depth === 0) return hasChildren ? "program" : "task";
  if (depth === 1) return hasChildren ? "workstream" : "task";
  if (depth === 2) return hasChildren ? "task" : "task";
  return "subtask";
}

function filterRowsForClient(rows: TaskLike[]) {
  // Serialize dates so the client stays trivially serializable — the shared
  // predicate accepts ISO strings as well as Date objects.
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    startDate: (r.startDate as Date).toISOString?.() ?? String(r.startDate),
    endDate: (r.endDate as Date).toISOString?.() ?? String(r.endDate),
    progress: r.progress,
    blocked: r.blocked,
    assignee: r.assignee,
    parentId: r.parentId,
    priority: r.priority,
    tags: r.tags,
    lastProgressAt:
      r.lastProgressAt instanceof Date
        ? r.lastProgressAt.toISOString()
        : (r.lastProgressAt as string | null),
  }));
}
