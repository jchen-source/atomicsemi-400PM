import { prisma } from "@/lib/db";
import { DEFAULT_PEOPLE } from "@/lib/default-people";
import { ensurePersonTable } from "@/lib/person-bootstrap";
import OpenIssuesClient from "./open-issues-client";
import { parseTags } from "@/lib/utils";
import {
  type ActiveIssueView,
  type IssueStatus,
  buildReminderBuckets,
  parseIssueMeta,
  parseNotes,
  summariseIssues,
} from "@/lib/open-issues";

export const dynamic = "force-dynamic";

type AllowedStatus = IssueStatus;
const STATUSES: AllowedStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];
function toStatus(s: string): AllowedStatus {
  return (STATUSES as string[]).includes(s) ? (s as AllowedStatus) : "TODO";
}

export default async function OpenIssuesPage({
  searchParams,
}: {
  searchParams?: Promise<{
    focus?: string;
    taskId?: string;
    workstreamId?: string;
  }>;
}) {
  const params = (await searchParams) ?? {};
  // Seed the people roster on first hit so the owner dropdown never
  // starts empty on a fresh deploy.
  await ensurePersonTable();
  const personCount = await prisma.person.count();
  if (personCount === 0) {
    for (const name of DEFAULT_PEOPLE) {
      try {
        await prisma.person.create({ data: { name } });
      } catch {
        /* race or unique collision */
      }
    }
  }

  const [rawIssues, planningTasks, people] = await Promise.all([
    prisma.task.findMany({
      where: { type: "ISSUE" },
      orderBy: { updatedAt: "desc" },
    }),
    // Anything that can be planned: workstreams, tasks, milestones.
    // Used both for the linked-task dropdown and for the reminder panel.
    prisma.task.findMany({
      where: { type: { in: ["EPIC", "TASK", "MILESTONE"] } },
      orderBy: [{ type: "asc" }, { title: "asc" }],
    }),
    prisma.person.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // Comment thread per issue, stored as TaskUpdate rows with type
  // OPEN_ISSUE. We keep these separate from PROGRESS updates so the
  // Updates tab and the Open Issues thread can evolve independently.
  const issueIds = rawIssues.map((i) => i.id);
  const rawComments =
    issueIds.length === 0
      ? []
      : await prisma.$queryRaw<
          Array<{
            id: string;
            taskId: string;
            comment: string;
            createdAt: Date;
          }>
        >`
          SELECT
            tu."id" as id,
            tu."taskId" as "taskId",
            tu."comment" as comment,
            tu."createdAt" as "createdAt"
          FROM "TaskUpdate" tu
          WHERE tu."commentType" = 'OPEN_ISSUE'
          ORDER BY tu."createdAt" DESC
          LIMIT 1000
        `;
  const commentsByIssueId = new Map<
    string,
    Array<{ id: string; comment: string; createdAt: string }>
  >();
  const issueIdSet = new Set(issueIds);
  for (const c of rawComments) {
    if (!issueIdSet.has(c.taskId)) continue;
    const arr = commentsByIssueId.get(c.taskId) ?? [];
    arr.push({
      id: c.id,
      comment: c.comment,
      createdAt: c.createdAt.toISOString(),
    });
    commentsByIssueId.set(c.taskId, arr);
  }

  const taskById = new Map(planningTasks.map((t) => [t.id, t]));

  // Assemble the normalised ActiveIssueView list the client consumes.
  const issues: ActiveIssueView[] = rawIssues.map((i) => {
    const meta = parseIssueMeta(parseTags(i.tags));
    const notes = parseNotes(i.description);
    // Back-compat: old issues stored the link as `parentId`. Prefer
    // the explicit `linkedTaskId` column if set, otherwise fall back.
    const effectiveLink = i.linkedTaskId ?? i.parentId ?? null;
    const linked = effectiveLink ? taskById.get(effectiveLink) : undefined;
    const linkedParentId = linked?.parentId ?? null;
    const linkedParent = linkedParentId
      ? taskById.get(linkedParentId)
      : undefined;
    return {
      id: i.id,
      title: i.title,
      status: toStatus(i.status),
      urgency: meta.urgency,
      issueType: meta.issueType,
      scheduleImpact: meta.scheduleImpact,
      owner: i.assignee,
      nextStep: notes.nextStep,
      resolutionNote: notes.resolutionNote,
      // For open issues we treat endDate as the current due date and
      // startDate as the committed original due date so slippage is
      // always visible.
      dueDate: i.endDate.toISOString(),
      originalDueDate: i.startDate.toISOString(),
      linkedTaskId: effectiveLink,
      linkedTaskTitle: linked?.title ?? null,
      linkedParentId,
      linkedParentTitle: linkedParent?.title ?? null,
      progress: i.progress,
      lastUpdated: i.updatedAt.toISOString(),
    };
  });

  const parentTitleById = new Map(planningTasks.map((t) => [t.id, t.title]));
  const reminder = buildReminderBuckets({
    tasks: planningTasks.map((t) => ({
      id: t.id,
      title: t.title,
      type: t.type,
      status: t.status,
      startDate: t.startDate,
      endDate: t.endDate,
      progress: t.progress,
      assignee: t.assignee,
      parentId: t.parentId,
    })),
    issues,
    parentTitleById,
  });

  const summary = summariseIssues(issues);

  // The client treats EPIC/TASK/MILESTONE equivalently for linking,
  // but we surface the kind so the picker can label them.
  const linkTargets = planningTasks.map((t) => ({
    id: t.id,
    title: t.title,
    type: (t.type === "EPIC" || t.type === "TASK" || t.type === "MILESTONE"
      ? t.type
      : "TASK") as "EPIC" | "TASK" | "MILESTONE",
    parentId: t.parentId,
    parentTitle: t.parentId
      ? parentTitleById.get(t.parentId) ?? null
      : null,
  }));

  const commentsByIssueIdObj: Record<
    string,
    Array<{ id: string; comment: string; createdAt: string }>
  > = {};
  for (const [k, v] of commentsByIssueId) commentsByIssueIdObj[k] = v;

  // Resolve ?workstreamId=<id> into the full set of descendant task
  // ids. That scope is then used to filter issues to anything linked
  // to the workstream itself OR anything nested beneath it — which is
  // what the Gantt badge count represents.
  let initialScopeIds: string[] | null = null;
  let initialScopeTitle: string | null = null;
  if (params.workstreamId) {
    const root = planningTasks.find((t) => t.id === params.workstreamId);
    if (root) {
      initialScopeTitle = root.title;
      const childrenByParent = new Map<string, string[]>();
      for (const t of planningTasks) {
        if (!t.parentId) continue;
        const arr = childrenByParent.get(t.parentId) ?? [];
        arr.push(t.id);
        childrenByParent.set(t.parentId, arr);
      }
      const scope = new Set<string>([root.id]);
      const queue = [root.id];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const kid of childrenByParent.get(cur) ?? []) {
          if (!scope.has(kid)) {
            scope.add(kid);
            queue.push(kid);
          }
        }
      }
      initialScopeIds = [...scope];
    }
  }

  return (
    <OpenIssuesClient
      issues={issues}
      linkTargets={linkTargets}
      people={people.map((p) => ({ id: p.id, name: p.name, role: p.role }))}
      reminder={reminder}
      summary={summary}
      commentsByIssueId={commentsByIssueIdObj}
      initialFocusTaskId={params.taskId ?? null}
      initialFilter={params.focus ?? null}
      initialScopeIds={initialScopeIds}
      initialScopeTitle={initialScopeTitle}
    />
  );
}
