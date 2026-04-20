import { prisma } from "@/lib/db";
import OpenIssuesClient from "./open-issues-client";
import { parseTags } from "@/lib/utils";

export const dynamic = "force-dynamic";

type AllowedStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
const STATUSES: AllowedStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];
function toStatus(s: string): AllowedStatus {
  return (STATUSES as string[]).includes(s) ? (s as AllowedStatus) : "TODO";
}

export default async function OpenIssuesPage() {
  const [openIssues, linkTargets] = await Promise.all([
    prisma.task.findMany({
      where: { type: "ISSUE" },
      orderBy: [{ status: "asc" }, { endDate: "asc" }],
    }),
    prisma.task.findMany({
      where: { type: { in: ["EPIC", "TASK"] } },
      select: { id: true, title: true, type: true, parentId: true },
      orderBy: [{ type: "asc" }, { title: "asc" }],
    }),
  ]);

  const byId = new Map(linkTargets.map((t) => [t.id, t]));
  const issueIds = openIssues.map((i) => i.id);
  const issueComments =
    issueIds.length === 0
      ? []
      : (
          await prisma.$queryRaw<
            Array<{
              id: string;
              taskId: string;
              commentType: string;
              comment: string;
              createdAt: Date;
            }>
          >`
            SELECT
              tu."id" as id,
              tu."taskId" as taskId,
              tu."commentType" as commentType,
              tu."comment" as comment,
              tu."createdAt" as createdAt
            FROM "TaskUpdate" tu
            WHERE tu."commentType" = 'OPEN_ISSUE'
            ORDER BY tu."createdAt" DESC
            LIMIT 500
          `
        ).filter((c) => issueIds.includes(c.taskId));

  return (
    <OpenIssuesClient
      issues={openIssues.map((i) => ({
        id: i.id,
        title: i.title,
        status: toStatus(i.status),
        assignee: i.assignee,
        originalResolutionDate: i.startDate.toISOString(),
        expectedResolutionDate: i.endDate.toISOString(),
        linkedTaskId: i.parentId,
        linkedTaskTitle: i.parentId ? byId.get(i.parentId)?.title ?? null : null,
        progress: i.progress,
        urgency: urgencyFromTags(parseTags(i.tags)),
        tags: parseTags(i.tags),
      }))}
      comments={issueComments.map((c) => ({
        id: c.id,
        taskId: c.taskId,
        comment: c.comment,
        createdAt: c.createdAt.toISOString(),
      }))}
      linkTargets={linkTargets.map((t) => ({
        id: t.id,
        title: t.title,
        type: (t.type === "EPIC" || t.type === "TASK" || t.type === "ISSUE"
          ? t.type
          : "TASK") as "EPIC" | "TASK" | "ISSUE",
        parentId: t.parentId,
      }))}
    />
  );
}

function urgencyFromTags(tags: string[]): "high" | "medium" | "low" {
  const normalized = tags.map((t) => t.trim().toLowerCase());
  if (normalized.includes("urgency:high") || normalized.includes("high")) return "high";
  if (normalized.includes("urgency:low") || normalized.includes("low")) return "low";
  return "medium";
}

