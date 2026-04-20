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
      // Order by sortOrder then id. We deliberately do NOT tie-break on
      // startDate — doing so caused rows to reshuffle in the left table
      // every time a user edited a date, which the user (rightly) flagged
      // as "things shifting around". `id` gives a stable, user-invisible
      // secondary so the list only moves when the user actually reorders.
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    }),
    prisma.dependency.findMany(),
    prisma.task.count({ where: { notionId: { not: null } } }),
    prisma.syncLog.findFirst({ orderBy: { runAt: "desc" } }),
  ]);

  const hasNotion = notionCount > 0;
  // Legacy rows from the now-removed milestone feature are filtered
  // out here so they disappear from the UI without requiring a DB
  // migration — any `type === "MILESTONE"` rows are simply ignored.
  const tasks = orderTasksHierarchy(rawTasks).filter(
    (t) => t.type !== "MILESTONE",
  );
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
  // Tri-state per-task indicator derived from linked issues:
  //   - "slipping"  = at least one active issue is flagged with a
  //     schedule-impact tag (stored as `impact:...` on the issue)
  //   - "active"    = has active issues but none flagged as slipping
  //   - "resolved"  = no active issues but at least one was resolved in the
  //     last 3 days; fades out client-side via CSS
  const issueIndicatorByTaskId: Record<
    string,
    "active" | "slipping" | "resolved"
  > = {};
  const issuesByTask = new Map<string, typeof tasks>();
  for (const t of tasks) {
    if (t.type !== "ISSUE" || !t.parentId) continue;
    const arr = issuesByTask.get(t.parentId) ?? [];
    arr.push(t);
    issuesByTask.set(t.parentId, arr);
    if (t.status !== "DONE") {
      const titles = linkedOpenIssuesByTask.get(t.parentId) ?? [];
      titles.push(t.title);
      linkedOpenIssuesByTask.set(t.parentId, titles);
    }
  }
  const RECENT_RESOLVE_MS = 72 * 3600 * 1000;
  const now = Date.now();
  for (const [taskId, its] of issuesByTask) {
    const active = its.filter((i) => i.status !== "DONE");
    if (active.length > 0) {
      const slipping = active.some((i) => {
        const tags = parseTags(i.tags);
        return tags.some((tag) => {
          const low = tag.toLowerCase();
          return (
            low === "impact:task slip" ||
            low.replace(/\s+/g, "") === "impact:taskslip" ||
            low === "impact:workstream slip" ||
            low.replace(/\s+/g, "") === "impact:workstreamslip"
          );
        });
      });
      issueIndicatorByTaskId[taskId] = slipping ? "slipping" : "active";
    } else {
      const recent = its.some(
        (i) => now - new Date(i.updatedAt).getTime() <= RECENT_RESOLVE_MS,
      );
      if (recent) issueIndicatorByTaskId[taskId] = "resolved";
    }
  }

  // Rollup open-issue counts so every ancestor (task, workstream,
  // program) shows the total number of active issues nested beneath
  // it. "Direct" counts the issues linked to a task itself; "rollup"
  // is self + all descendants, recomputed with memoized DFS so we
  // only visit each node once.
  const childrenByParent = new Map<string | null, string[]>();
  for (const t of tasks) {
    if (t.type === "ISSUE") continue;
    const arr = childrenByParent.get(t.parentId) ?? [];
    arr.push(t.id);
    childrenByParent.set(t.parentId, arr);
  }
  const directActiveByTask = new Map<string, number>();
  for (const t of tasks) {
    if (t.type !== "ISSUE" || !t.parentId) continue;
    if (t.status === "DONE") continue;
    directActiveByTask.set(
      t.parentId,
      (directActiveByTask.get(t.parentId) ?? 0) + 1,
    );
  }
  const rollupByTask = new Map<string, number>();
  const computeRollup = (id: string): number => {
    const cached = rollupByTask.get(id);
    if (cached !== undefined) return cached;
    let sum = directActiveByTask.get(id) ?? 0;
    for (const child of childrenByParent.get(id) ?? []) {
      sum += computeRollup(child);
    }
    rollupByTask.set(id, sum);
    return sum;
  };
  for (const t of tasks) {
    if (t.type === "ISSUE") continue;
    computeRollup(t.id);
  }
  const openIssueCountByTaskId: Record<
    string,
    { direct: number; rollup: number }
  > = {};
  for (const t of tasks) {
    if (t.type === "ISSUE") continue;
    const direct = directActiveByTask.get(t.id) ?? 0;
    const rollup = rollupByTask.get(t.id) ?? 0;
    if (rollup > 0) openIssueCountByTaskId[t.id] = { direct, rollup };
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
        // Open Issues are managed on their own page and intentionally do
        // NOT render on the roadmap / Gantt surface — the Gantt is for
        // planned work (programs, workstreams, tasks, subtasks). Issue
        // counts still surface on their anchor task via the badge
        // rendered inside the bar.
        tasks={tasks
          .filter((t) => t.type !== "ISSUE")
          .map((t) => ({
            id: t.id,
            text: t.title,
            start: t.startDate.toISOString(),
            end: t.endDate.toISOString(),
            depsLabel: linkedOpenIssuesByTask.get(t.id)?.length
              ? `Open issues: ${linkedOpenIssuesByTask.get(t.id)!.join(", ")}`
              : (incomingDepsByTask.get(t.id) ?? []).join(", ") || "—",
            depsCount: (incomingDepsByTask.get(t.id) ?? []).length,
            progress: t.progress,
            urgency: urgencyFromTags(parseTags(t.tags)),
            health:
              t.health === "green" ||
              t.health === "yellow" ||
              t.health === "red"
                ? t.health
                : null,
            effortHours: t.effortHours ?? null,
            assignee: t.assignee ?? null,
            resourceAllocated: t.resourceAllocated ?? null,
            parent: t.parentId,
            open: (childCountByParent.get(t.id) ?? 0) > 0,
            type:
              (childCountByParent.get(t.id) ?? 0) > 0 || t.type === "EPIC"
                ? "summary"
                : "task",
            rowType: (t.type === "EPIC" ? "EPIC" : "TASK") as
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
        issueIndicatorByTaskId={issueIndicatorByTaskId}
        openIssueCountByTaskId={openIssueCountByTaskId}
        emptyState={
          tasks.length === 0 ? (
            <div className="roadmap-empty">
              <p className="roadmap-empty-title">
                Your roadmap is empty
              </p>
              <p className="roadmap-empty-body">
                Click <strong>+ Create task</strong> to add one. Drag any task
                onto another to nest it — the hierarchy goes{" "}
                <strong>Program → Workstream → Task → Subtask</strong>, and
                each container rolls up dates and progress from everything
                nested below it.
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
  T extends { id: string; parentId: string | null; sortOrder: number },
>(rows: T[]): T[] {
  const byParent = new Map<string | null, T[]>();
  for (const r of rows) {
    const arr = byParent.get(r.parentId) ?? [];
    arr.push(r);
    byParent.set(r.parentId, arr);
  }
  for (const [, arr] of byParent) {
    // Stable-ish secondary sort by id (not startDate) so that changing a
    // task's dates never reorders its siblings. Reparenting / explicit
    // drag-reorder remains the only thing that moves rows.
    arr.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
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

