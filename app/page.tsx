import Link from "next/link";
import { prisma } from "@/lib/db";
import GanttClient from "./gantt-client";
import CleanupDefaultsButton from "./cleanup-defaults-button";
import ImportBacklogButton from "./import-backlog-button";
import { parseTags } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function GanttPage() {
  const [rawTasks, deps, notionCount, latestSync] = await Promise.all([
    prisma.task.findMany({
      orderBy: [
        { sortOrder: "asc" },
        { startDate: "asc" },
      ],
    }),
    prisma.dependency.findMany(),
    prisma.task.count({ where: { notionId: { not: null } } }),
    prisma.syncLog.findFirst({ orderBy: { runAt: "desc" } }),
  ]);

  const hasNotion = notionCount > 0;
  const tasks = orderTasksHierarchy(rawTasks);
  const childCountByParent = new Map<string, number>();
  for (const t of tasks) {
    if (t.type === "ISSUE") continue;
    if (!t.parentId) continue;
    childCountByParent.set(
      t.parentId,
      (childCountByParent.get(t.parentId) ?? 0) + 1,
    );
  }
  const taskTitleById = new Map(tasks.map((t) => [t.id, t.title]));
  const incomingDepsByTask = new Map<string, string[]>();
  for (const d of deps) {
    const arr = incomingDepsByTask.get(d.dependentId) ?? [];
    arr.push(taskTitleById.get(d.predecessorId) ?? "Unknown");
    incomingDepsByTask.set(d.dependentId, arr);
  }
  const linkedOpenIssuesByTask = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.type !== "ISSUE" || !t.parentId) continue;
    const arr = linkedOpenIssuesByTask.get(t.parentId) ?? [];
    arr.push(t.title);
    linkedOpenIssuesByTask.set(t.parentId, arr);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Roadmap</h1>
          <p className="text-sm text-muted-foreground">
            Drag bars to reschedule, drag the right edge to resize, drag from
            one bar to another to link. Dependencies auto-push successors.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {tasks.length} tasks · {deps.length} links
          </span>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            <span aria-hidden>{"\u2699"}</span>
            Settings
          </Link>
          <Link
            href="/settings#notion"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <span aria-hidden>{"\u2B22"}</span>
            {hasNotion ? "Sync with Notion" : "Connect Notion"}
          </Link>
          <CleanupDefaultsButton />
        </div>
      </div>

      {!hasNotion && (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Import your Notion roadmap</p>
              <p className="text-sm text-muted-foreground">
                The sample data below is a placeholder. Paste your Notion
                integration token and database IDs on the Settings page to pull
                your real roadmap and issues. Re-sync is additive — your local
                edits are never overwritten.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ImportBacklogButton />
              <Link
                href="/settings#notion"
                className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Connect Notion
              </Link>
            </div>
          </div>
        </div>
      )}

      {hasNotion && latestSync && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Last Notion sync{" "}
          {new Date(latestSync.runAt).toLocaleString()} · imported{" "}
          {latestSync.imported}, skipped {latestSync.skipped}, failed{" "}
          {latestSync.failed}
        </div>
      )}

      <GanttClient
        tasks={tasks.map((t) => ({
          id: t.id,
          text:
            t.type === "ISSUE"
              ? `Open Issue: ${t.title}`
              : linkedOpenIssuesByTask.get(t.id)?.length
                ? `${t.title} [${linkedOpenIssuesByTask.get(t.id)!.length} open]`
                : t.title,
          start: t.startDate.toISOString(),
          end: t.endDate.toISOString(),
          depsLabel:
            t.type === "ISSUE"
              ? `Linked to: ${
                  t.parentId ? (taskTitleById.get(t.parentId) ?? "Unknown") : "Unlinked"
                }`
              : linkedOpenIssuesByTask.get(t.id)?.length
                ? `Open issues: ${linkedOpenIssuesByTask.get(t.id)!.join(", ")}`
                : (incomingDepsByTask.get(t.id) ?? []).join(", ") || "—",
          depsCount: (incomingDepsByTask.get(t.id) ?? []).length,
          progress: t.progress,
          urgency: urgencyFromTags(parseTags(t.tags)),
          parent: t.type === "ISSUE" ? null : t.parentId,
          open: t.type === "ISSUE" ? undefined : (childCountByParent.get(t.id) ?? 0) > 0,
          type:
            t.type === "EPIC"
              ? "summary"
              : t.type === "ISSUE"
                ? "task"
                : "task",
          rowType: (t.type === "EPIC" || t.type === "ISSUE" ? t.type : "TASK") as
            | "EPIC"
            | "TASK"
            | "ISSUE",
        }))}
        links={deps.map((d) => ({
          id: d.id,
          source: d.predecessorId,
          target: d.dependentId,
          type: depTypeToLinkType(d.type),
        }))}
      />
    </div>
  );
}

function urgencyFromTags(tags: string[]): "high" | "medium" | "low" {
  const normalized = tags.map((t) => t.trim().toLowerCase());
  if (normalized.includes("urgency:high") || normalized.includes("high")) return "high";
  if (normalized.includes("urgency:low") || normalized.includes("low")) return "low";
  return "medium";
}

function orderTasksHierarchy<
  T extends { id: string; parentId: string | null; sortOrder: number; startDate: Date },
>(rows: T[]): T[] {
  const byParent = new Map<string | null, T[]>();
  for (const r of rows) {
    const arr = byParent.get(r.parentId) ?? [];
    arr.push(r);
    byParent.set(r.parentId, arr);
  }
  for (const [, arr] of byParent) {
    arr.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.startDate.getTime() - b.startDate.getTime(),
    );
  }
  const out: T[] = [];
  const visit = (parentId: string | null) => {
    const kids = byParent.get(parentId) ?? [];
    for (const k of kids) {
      out.push(k);
      visit(k.id);
    }
  };
  visit(null);
  return out;
}

function depTypeToLinkType(t: string): "e2s" | "s2s" | "e2e" | "s2e" {
  switch (t) {
    case "SS":
      return "s2s";
    case "FF":
      return "e2e";
    case "SF":
      return "s2e";
    default:
      return "e2s";
  }
}

