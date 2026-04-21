import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { computeHealth } from "@/lib/health";
import { parseTags } from "@/lib/utils";
import { parseIssueMeta } from "@/lib/open-issues";
import { ensurePersonTable } from "@/lib/person-bootstrap";
import type { PersonOption } from "../tasks-client";
import type {
  BurndownSnapshotInput,
  BurndownTaskInput,
} from "../burndown-chart";
import WorkstreamClient, {
  type CardDependency,
  type ChildCard,
  type LinkedIssue,
  type WorkstreamHeader,
  type WorkstreamSnapshot,
} from "./workstream-client";

/**
 * Workstream drill-in page for standup.
 *
 * Route: /tasks/[id] — where [id] is the parent task the user wants to run
 * through (usually a workstream, but any parent with children renders fine).
 *
 * Responsibilities:
 *   1. Load the parent + all descendants so the big burndown can roll up
 *      every leaf effort-hour correctly.
 *   2. Load every PROGRESS snapshot for those tasks so the per-card history
 *      dropdowns can render without a follow-up fetch.
 *   3. Build a breadcrumb trail from root → parent for the header.
 *   4. Serialize to plain JSON shapes so the client component can own all
 *      state + optimistic updates (saves don't trigger a full page refresh).
 */

export default async function WorkstreamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await ensurePersonTable();

  const [all, rawPeople, allDeps] = await Promise.all([
    prisma.task.findMany({
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    }),
    prisma.person.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: { id: true, name: true, role: true, active: true },
    }),
    prisma.dependency.findMany(),
  ]);
  const parent = all.find((t) => t.id === id);
  if (!parent) notFound();

  // Merge Person roster with any free-form assignees found on tasks, so the
  // picker in the card owner chip autocompletes against the same union the
  // master /tasks page uses. Keeps behavior predictable across surfaces.
  const people: PersonOption[] = (() => {
    const byName = new Map<string, PersonOption>();
    for (const p of rawPeople) {
      byName.set(p.name, {
        id: p.id,
        name: p.name,
        role: p.role,
        active: p.active,
        source: "roster",
      });
    }
    for (const t of all) {
      const raw = (t.assignee ?? "").trim();
      if (!raw || byName.has(raw)) continue;
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
  })();

  // Walk down the tree from `parent` and collect every descendant. Direct
  // children become cards; leaves feed the big rollup chart.
  const byParent = new Map<string | null, typeof all>();
  for (const t of all) {
    const arr = byParent.get(t.parentId) ?? [];
    arr.push(t);
    byParent.set(t.parentId, arr);
  }
  const descendants: typeof all = [];
  const stack = [parent.id];
  const inScope = new Set<string>([parent.id]);
  while (stack.length) {
    const cur = stack.pop()!;
    const kids = byParent.get(cur) ?? [];
    for (const k of kids) {
      if (!inScope.has(k.id)) {
        inScope.add(k.id);
        descendants.push(k);
        stack.push(k.id);
      }
    }
  }
  const directChildren = (byParent.get(parent.id) ?? [])
    .filter((t) => t.type !== "ISSUE" && t.type !== "MILESTONE")
    .sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
        a.title.localeCompare(b.title),
    );

  // Breadcrumb: walk parent pointers until we hit null, then reverse.
  const crumbs: { id: string; title: string }[] = [];
  {
    let cur: (typeof all)[number] | undefined = parent;
    while (cur) {
      crumbs.unshift({ id: cur.id, title: cur.title });
      cur = cur.parentId ? all.find((t) => t.id === cur!.parentId) : undefined;
    }
  }

  // Snapshots for every task in scope. Pull both PROGRESS readings and
  // OPEN_ISSUE notes — progress rows drive the burn line, issue notes
  // become qualitative pings on the same chart so "every update has a
  // ping" at a glance.
  const ids = [parent.id, ...descendants.map((d) => d.id)];
  const rawSnapshots = await prisma.taskUpdate.findMany({
    where: {
      taskId: { in: ids },
      commentType: { in: ["PROGRESS", "OPEN_ISSUE"] },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      taskId: true,
      createdAt: true,
      commentType: true,
      comment: true,
      progress: true,
      remainingEffort: true,
      status: true,
      blocked: true,
      health: true,
    },
  });

  // Shape for the burndown math (no `comment`, minimal fields).
  const burnTasks: BurndownTaskInput[] = [parent, ...descendants]
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
  const burnSnapshots: BurndownSnapshotInput[] = rawSnapshots.map((s) => ({
    id: s.id,
    taskId: s.taskId,
    createdAt: s.createdAt.toISOString(),
    commentType:
      s.commentType === "OPEN_ISSUE" ? "OPEN_ISSUE" : "PROGRESS",
    progress: s.progress,
    remainingEffort: s.remainingEffort ?? null,
    status: s.status ?? null,
    health: (s.health as "green" | "yellow" | "red" | null) ?? null,
    comment: s.comment ?? "",
  }));

  // Display snapshots — carry the comment so the history dropdown can show
  // it. Keep this to PROGRESS-only: the history panel tracks progress
  // readings; OPEN_ISSUE notes live in their own Issues list.
  const displaySnapshots: WorkstreamSnapshot[] = rawSnapshots
    .filter((s) => s.commentType !== "OPEN_ISSUE")
    .map((s) => ({
      id: s.id,
      taskId: s.taskId,
      createdAt: s.createdAt.toISOString(),
      comment: s.comment ?? "",
      progress: s.progress ?? 0,
      remainingEffort: s.remainingEffort ?? null,
      status: s.status ?? null,
      blocked: s.blocked ?? null,
      health: (s.health as "green" | "yellow" | "red" | null) ?? null,
    }));

  const now = new Date();

  // Every Open Issue linked to a task in scope (parent or any descendant).
  // Issues are Task rows with type === "ISSUE" whose parentId is the
  // task they flag. We use them to (a) show a red banner on a card that
  // has an active issue slipping the schedule and (b) render an inline
  // list so the user can see / resolve them from the standup view.
  const issueRows = all.filter(
    (t) => t.type === "ISSUE" && t.parentId && inScope.has(t.parentId),
  );
  const issuesByTask = new Map<string, LinkedIssue[]>();
  for (const r of issueRows) {
    const meta = parseIssueMeta(parseTags(r.tags));
    const issue: LinkedIssue = {
      id: r.id,
      title: r.title,
      status: (r.status ?? "TODO") as LinkedIssue["status"],
      urgency: meta.urgency,
      issueType: meta.issueType,
      scheduleImpact: meta.scheduleImpact,
      owner: r.assignee ?? null,
      dueDate: r.endDate.toISOString(),
      createdAt: r.createdAt.toISOString(),
      linkedTaskId: r.parentId!,
    };
    const arr = issuesByTask.get(r.parentId!) ?? [];
    arr.push(issue);
    issuesByTask.set(r.parentId!, arr);
  }

  // Index dependencies both ways so a card can show what it's blocked
  // by (predecessors) and what it blocks (successors). We also need the
  // predecessor/dependent task metadata (title, dates, status) so the
  // card can render a meaningful chip without a client-side lookup.
  const taskById = new Map(all.map((t) => [t.id, t]));
  const preds = new Map<string, typeof allDeps>();
  const succs = new Map<string, typeof allDeps>();
  for (const d of allDeps) {
    const arrP = preds.get(d.dependentId) ?? [];
    arrP.push(d);
    preds.set(d.dependentId, arrP);
    const arrS = succs.get(d.predecessorId) ?? [];
    arrS.push(d);
    succs.set(d.predecessorId, arrS);
  }
  const linkFor = (taskId: string): CardDependency | null => {
    const t = taskById.get(taskId);
    if (!t) return null;
    return {
      id: t.id,
      title: t.title,
      endDate: t.endDate.toISOString(),
      startDate: t.startDate.toISOString(),
      status: t.status,
      progress: t.progress,
      blocked: t.blocked,
    };
  };

  // One card per direct child. We pre-compute health here so a child card
  // renders its badge correctly even before the client performs any update.
  //
  // Special case: when the parent has no real children (every task except
  // linked issues/milestones has been filtered away) we render ONE card
  // for the parent itself. That way clicking an empty workstream from
  // the master list lands on the same drill-in UI as a parent with
  // children — the user can push updates, edit owner/dates/estimates,
  // and see the burndown on a consistent surface instead of getting an
  // empty page and a dangling inline drawer.
  const cardTasks =
    directChildren.length > 0 ? directChildren : [parent];
  const cards: ChildCard[] = cardTasks.map((t) => {
    const childKidCount = (byParent.get(t.id) ?? []).filter(
      (c) => c.type !== "ISSUE" && c.type !== "MILESTONE",
    ).length;
    const h =
      (t.health as "green" | "yellow" | "red" | null) ??
      computeHealth({
        startDate: t.startDate,
        endDate: t.endDate,
        progress: t.progress,
        blocked: t.blocked,
        status: t.status,
        now,
      });
    const blockedBy: CardDependency[] = [];
    for (const d of preds.get(t.id) ?? []) {
      const link = linkFor(d.predecessorId);
      if (link) blockedBy.push({ ...link, depType: d.type, lagDays: d.lagDays });
    }
    const blocks: CardDependency[] = [];
    for (const d of succs.get(t.id) ?? []) {
      const link = linkFor(d.dependentId);
      if (link) blocks.push({ ...link, depType: d.type, lagDays: d.lagDays });
    }
    return {
      id: t.id,
      title: t.title,
      type: t.type,
      hasChildren: childKidCount > 0,
      childCount: childKidCount,
      assignee: t.assignee,
      status: t.status,
      blocked: t.blocked,
      progress: t.progress,
      effortHours: t.effortHours,
      remainingEffort: t.remainingEffort,
      startDate: t.startDate.toISOString(),
      endDate: t.endDate.toISOString(),
      nextStep: t.nextStep,
      health: h,
      lastProgressAt: t.lastProgressAt?.toISOString() ?? null,
      issues: issuesByTask.get(t.id) ?? [],
      blockedBy,
      blocks,
    };
  });

  const header: WorkstreamHeader = {
    id: parent.id,
    title: parent.title,
    type: parent.type,
    status: parent.status,
    blocked: parent.blocked,
    assignee: parent.assignee,
    startDate: parent.startDate.toISOString(),
    endDate: parent.endDate.toISOString(),
    progress: parent.progress,
    effortHours: parent.effortHours,
    remainingEffort: parent.remainingEffort,
    health:
      (parent.health as "green" | "yellow" | "red" | null) ??
      computeHealth({
        startDate: parent.startDate,
        endDate: parent.endDate,
        progress: parent.progress,
        blocked: parent.blocked,
        status: parent.status,
        now,
      }),
  };

  return (
    <div className="workstream-page">
      <header className="workstream-topbar">
        <div className="workstream-crumbs">
          <Link href="/tasks" className="workstream-back">
            ← Back to Tasks
          </Link>
          <nav aria-label="breadcrumb">
            {crumbs.map((c, i) => (
              <span key={c.id} className="workstream-crumb">
                {i > 0 && <span className="workstream-crumb-sep">/</span>}
                {i === crumbs.length - 1 ? (
                  <span>{c.title}</span>
                ) : (
                  <Link href={`/tasks/${c.id}`}>{c.title}</Link>
                )}
              </span>
            ))}
          </nav>
        </div>
      </header>

      <WorkstreamClient
        header={header}
        cards={cards}
        burnTasks={burnTasks}
        burnSnapshots={burnSnapshots}
        displaySnapshots={displaySnapshots}
        nowISO={now.toISOString()}
        people={people}
      />
    </div>
  );
}
