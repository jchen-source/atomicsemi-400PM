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
    <div className="roadmap-page space-y-3">
      <header className="roadmap-header">
        <div className="roadmap-title-block">
          <h1 className="roadmap-title">Roadmap</h1>
          <div className="roadmap-stats">
            <span className="roadmap-stat-pill">
              <span className="roadmap-stat-value">{tasks.length}</span>
              <span className="roadmap-stat-label">tasks</span>
            </span>
            <span className="roadmap-stat-pill">
              <span className="roadmap-stat-value">{deps.length}</span>
              <span className="roadmap-stat-label">links</span>
            </span>
            {hasNotion && latestSync && (
              <span
                className="roadmap-stat-pill roadmap-stat-pill--muted"
                title={`Imported ${latestSync.imported}, skipped ${latestSync.skipped}, failed ${latestSync.failed}`}
              >
                Synced {new Date(latestSync.runAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
        <div className="roadmap-actions">
          <Link href="/settings" className="roadmap-btn roadmap-btn--ghost">
            Settings
          </Link>
          <Link
            href="/settings#notion"
            className={
              hasNotion
                ? "roadmap-btn roadmap-btn--ghost"
                : "roadmap-btn roadmap-btn--primary"
            }
          >
            {hasNotion ? "Sync Notion" : "Connect Notion"}
          </Link>
        </div>
      </header>

      {!hasNotion && tasks.length > 0 && (
        <div className="roadmap-notice">
          <div>
            <p className="roadmap-notice-title">
              You&apos;re working from local data
            </p>
            <p className="roadmap-notice-body">
              Connect Notion to pull your real roadmap and issues. Re-sync is
              additive — local edits are preserved.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ImportBacklogButton />
            <Link
              href="/settings#notion"
              className="roadmap-btn roadmap-btn--ghost"
            >
              Connect
            </Link>
          </div>
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
        emptyState={
          tasks.length === 0 ? (
            <div className="roadmap-empty">
              <p className="roadmap-empty-title">
                Your roadmap is empty
              </p>
              <p className="roadmap-empty-body">
                Add a task to start planning, or pull your existing programs in
                from the committed Notion backlog.
              </p>
              <div className="roadmap-empty-actions">
                <ImportBacklogButton />
                <Link
                  href="/settings#notion"
                  className="roadmap-btn roadmap-btn--ghost"
                >
                  Connect Notion
                </Link>
              </div>
            </div>
          ) : null
        }
      />

      <footer className="roadmap-footer">
        <CleanupDefaultsButton />
        <span className="roadmap-footer-hint">
          Drag bars to reschedule · drag edges to resize · drag from one bar to
          another to link
        </span>
      </footer>
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

