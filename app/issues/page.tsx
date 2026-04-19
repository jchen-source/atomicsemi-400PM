import { prisma } from "@/lib/db";
import IssuesClient from "./issues-client";
import { parseTags } from "@/lib/utils";

export const dynamic = "force-dynamic";

type AllowedStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
const STATUSES: AllowedStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];
function toStatus(s: string): AllowedStatus {
  return (STATUSES as string[]).includes(s) ? (s as AllowedStatus) : "TODO";
}
function toParentType(t: string | null): "EPIC" | "TASK" | null {
  if (t === "EPIC" || t === "TASK") return t;
  return null;
}

export default async function IssuesPage() {
  const [issues, parents, workItems, updates] = await Promise.all([
    prisma.task.findMany({
      where: { type: "TASK" },
      orderBy: [{ status: "asc" }, { endDate: "asc" }],
    }),
    prisma.task.findMany({
      where: { type: { in: ["EPIC", "TASK"] } },
      select: { id: true, title: true, type: true },
      orderBy: { title: "asc" },
    }),
    prisma.task.findMany({
      where: { type: { in: ["EPIC", "TASK", "ISSUE"] } },
      orderBy: [{ type: "asc" }, { title: "asc" }],
    }),
    prisma.$queryRaw<
      Array<{
        id: string;
        taskId: string;
        taskTitle: string;
        parentId: string | null;
        commentType: "PROGRESS" | "OPEN_ISSUE";
        comment: string;
        progress: number | null;
        endDate: Date | null;
        effortHours: number | null;
        assignee: string | null;
        resourceAllocated: string | null;
        createdAt: Date;
      }>
    >`
      SELECT
        tu."id" as id,
        tu."taskId" as taskId,
        t."title" as taskTitle,
        t."parentId" as parentId,
        tu."commentType" as commentType,
        tu."comment" as comment,
        tu."progress" as progress,
        tu."endDate" as endDate,
        tu."effortHours" as effortHours,
        tu."assignee" as assignee,
        tu."resourceAllocated" as resourceAllocated,
        tu."createdAt" as createdAt
      FROM "TaskUpdate" tu
      JOIN "Task" t ON t."id" = tu."taskId"
      ORDER BY tu."createdAt" DESC
      LIMIT 200
    `,
  ]);

  const parentMap = Object.fromEntries(workItems.map((p) => [p.id, p])) as Record<
    string,
    (typeof workItems)[number]
  >;

  return (
    <IssuesClient
      initial={issues.map((i) => ({
        id: i.id,
        title: i.title,
        status: toStatus(i.status),
        progress: i.progress,
        startDate: i.startDate.toISOString(),
        endDate: i.endDate.toISOString(),
        parentId: i.parentId,
        parentTitle: i.parentId ? parentMap[i.parentId]?.title ?? null : null,
        parentType: i.parentId
          ? toParentType(parentMap[i.parentId]?.type ?? null)
          : null,
        assignee: i.assignee,
        resourceAllocated: i.resourceAllocated,
        effortHours: i.effortHours,
        tags: parseTags(i.tags),
        urgency: urgencyFromTags(parseTags(i.tags)),
      }))}
      parents={parents.map((p) => ({
        id: p.id,
        title: p.title,
        type: (p.type === "EPIC" || p.type === "TASK" || p.type === "ISSUE"
          ? p.type
          : "TASK") as "EPIC" | "TASK" | "ISSUE",
      }))}
      workItems={workItems.map((t) => ({
        id: t.id,
        title: t.title,
        type: (t.type === "EPIC" || t.type === "TASK" || t.type === "ISSUE"
          ? t.type
          : "TASK") as "EPIC" | "TASK" | "ISSUE",
        status: toStatus(t.status),
        progress: t.progress,
        startDate: t.startDate.toISOString(),
        endDate: t.endDate.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        parentId: t.parentId,
        parentTitle: t.parentId ? parentMap[t.parentId]?.title ?? null : null,
        assignee: t.assignee,
        resourceAllocated: t.resourceAllocated,
        effortHours: t.effortHours,
        tags: parseTags(t.tags),
        urgency: urgencyFromTags(parseTags(t.tags)),
      }))}
      updates={updates.map((u) => ({
        id: u.id,
        taskId: u.taskId,
        taskTitle: u.taskTitle,
        parentId: u.parentId,
        commentType: u.commentType,
        comment: u.comment,
        progress: u.progress,
        endDate: u.endDate ? u.endDate.toISOString() : null,
        effortHours: u.effortHours,
        assignee: u.assignee,
        resourceAllocated: u.resourceAllocated,
        createdAt: u.createdAt.toISOString(),
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
