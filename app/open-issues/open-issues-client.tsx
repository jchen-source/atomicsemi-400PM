"use client";

import { useMemo, useState } from "react";

type Status = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
type Urgency = "high" | "medium" | "low";
type BlockingTarget = {
  id: string;
  title: string;
  type: string;
  status: string;
  kind: "dependency" | "linked";
};
type OpenIssue = {
  id: string;
  title: string;
  status: Status;
  assignee: string | null;
  /** First-committed target date, captured when the issue was created. */
  originalResolutionDate: string;
  /** Current target date. May slip out (or in) relative to original. */
  expectedResolutionDate: string;
  linkedTaskId: string | null;
  linkedTaskTitle: string | null;
  progress: number;
  urgency: Urgency;
  tags: string[];
  blocking: BlockingTarget[];
};
type LinkTarget = {
  id: string;
  title: string;
  type: "EPIC" | "TASK" | "ISSUE";
  parentId: string | null;
};
type OpenIssueComment = {
  id: string;
  taskId: string;
  comment: string;
  createdAt: string;
};

const STATUS_LABEL: Record<Status, string> = {
  TODO: "Open",
  IN_PROGRESS: "In Progress",
  BLOCKED: "Blocked",
  DONE: "Resolved",
};

export default function OpenIssuesClient({
  issues,
  comments,
  linkTargets,
}: {
  issues: OpenIssue[];
  comments: OpenIssueComment[];
  linkTargets: LinkTarget[];
}) {
  const [rows, setRows] = useState(issues);
  const [commentRows, setCommentRows] = useState(comments);
  // Top-level catalog split: "open" = anything not yet resolved, "resolved"
  // = the DONE archive. Resolved items stay accessible for reference but
  // don't clutter the active catalog.
  const [tab, setTab] = useState<"open" | "resolved">("open");
  // Secondary filter that narrows the Open tab to a specific in-flight
  // status (Open, In Progress, Blocked) or shows all active items.
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "TODO" | "IN_PROGRESS" | "BLOCKED"
  >("ALL");
  const [urgencyFilter, setUrgencyFilter] = useState<"ALL" | Urgency>("ALL");
  const [ownerFilter, setOwnerFilter] = useState<string>("ALL");
  const [linkedFilter, setLinkedFilter] = useState<string>("ALL");
  type SlipBucket = "ALL" | "ON_TRACK" | "PULLED_IN" | "SLIPPING" | "CRITICAL";
  const [slipFilter, setSlipFilter] = useState<SlipBucket>("ALL");
  const [search, setSearch] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createOwner, setCreateOwner] = useState("");
  const [createExpectedDate, setCreateExpectedDate] = useState(
    new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
  );
  const [createLinkId, setCreateLinkId] = useState<string>("");
  const [createUrgency, setCreateUrgency] = useState<Urgency>("medium");
  const [status, setStatus] = useState("");
  const [commentDraftByIssueId, setCommentDraftByIssueId] = useState<
    Record<string, string>
  >({});
  const byId = useMemo(() => new Map(linkTargets.map((t) => [t.id, t])), [linkTargets]);

  // Counts drive the tab badges and the per-status dropdown labels.
  const counts = useMemo(() => {
    const c = { open: 0, resolved: 0, todo: 0, inProgress: 0, blocked: 0 };
    for (const r of rows) {
      if (r.status === "DONE") c.resolved += 1;
      else c.open += 1;
      if (r.status === "TODO") c.todo += 1;
      if (r.status === "IN_PROGRESS") c.inProgress += 1;
      if (r.status === "BLOCKED") c.blocked += 1;
    }
    return c;
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) =>
        tab === "resolved" ? r.status === "DONE" : r.status !== "DONE",
      )
      .filter((r) => {
        if (tab !== "open") return true;
        if (statusFilter === "ALL") return true;
        return r.status === statusFilter;
      })
      .filter((r) => urgencyFilter === "ALL" || r.urgency === urgencyFilter)
      .filter((r) => ownerFilter === "ALL" || (r.assignee ?? "") === ownerFilter)
      .filter(
        (r) =>
          linkedFilter === "ALL" ||
          (linkedFilter === "__unlinked__"
            ? !r.linkedTaskId
            : r.linkedTaskId === linkedFilter),
      )
      .filter((r) => {
        if (slipFilter === "ALL") return true;
        const b = slipBucket(r.originalResolutionDate, r.expectedResolutionDate);
        return b === slipFilter;
      })
      .filter((r) => {
        if (!q) return true;
        return (
          r.title.toLowerCase().includes(q) ||
          (r.assignee ?? "").toLowerCase().includes(q) ||
          (r.linkedTaskTitle ?? "").toLowerCase().includes(q)
        );
      });
  }, [
    rows,
    tab,
    statusFilter,
    urgencyFilter,
    ownerFilter,
    linkedFilter,
    slipFilter,
    search,
  ]);

  const ownerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.assignee) set.add(r.assignee);
    }
    return [...set].sort();
  }, [rows]);

  const activeFilterCount =
    (statusFilter !== "ALL" ? 1 : 0) +
    (urgencyFilter !== "ALL" ? 1 : 0) +
    (ownerFilter !== "ALL" ? 1 : 0) +
    (linkedFilter !== "ALL" ? 1 : 0) +
    (slipFilter !== "ALL" ? 1 : 0) +
    (search.trim() ? 1 : 0);

  function clearFilters() {
    setStatusFilter("ALL");
    setUrgencyFilter("ALL");
    setOwnerFilter("ALL");
    setLinkedFilter("ALL");
    setSlipFilter("ALL");
    setSearch("");
  }
  const commentsByIssueId = useMemo(() => {
    const map = new Map<string, OpenIssueComment[]>();
    for (const c of commentRows) {
      const arr = map.get(c.taskId) ?? [];
      arr.push(c);
      map.set(c.taskId, arr);
    }
    return map;
  }, [commentRows]);

  async function createIssue() {
    const title = createTitle.trim();
    if (!title) {
      setStatus("Issue title is required.");
      return;
    }
    if (!createExpectedDate) {
      setStatus("Expected resolution date is required.");
      return;
    }

    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description: "",
          type: "ISSUE",
          status: "TODO",
          // For open issues, startDate doubles as the Original Resolution
          // Date — frozen at creation so later slippage is visible.
          startDate: new Date(createExpectedDate),
          endDate: new Date(createExpectedDate),
          progress: 0,
          parentId: createLinkId || null,
          assignee: createOwner.trim() || null,
          tags: [`urgency:${createUrgency}`],
          sortOrder: 9999,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const created = (await res.json()) as {
        id: string;
        title: string;
        status: Status;
        assignee: string | null;
        startDate: string;
        endDate: string;
        parentId: string | null;
        progress: number;
        tags?: string[];
      };
      setRows((prev) => [
        {
          id: created.id,
          title: created.title,
          status: created.status,
          assignee: created.assignee,
          originalResolutionDate: created.startDate,
          expectedResolutionDate: created.endDate,
          linkedTaskId: created.parentId,
          linkedTaskTitle: created.parentId ? byId.get(created.parentId)?.title ?? null : null,
          progress: created.progress,
          urgency: createUrgency,
          tags: created.tags ?? [`urgency:${createUrgency}`],
          blocking: [],
        },
        ...prev,
      ]);
      setCreateTitle("");
      setCreateOwner("");
      setCreateLinkId("");
      setCreateUrgency("medium");
      setStatus("Open issue created. It now appears on Gantt.");
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Create failed");
    }
  }

  async function patchIssue(
    id: string,
    patch: Partial<{
      status: Status;
      assignee: string | null;
      startDate: string;
      endDate: string;
      parentId: string | null;
      progress: number;
      tags: string[];
      urgency: Urgency;
    }>,
  ) {
    const prev = rows;
    setRows((curr) =>
      curr.map((r) =>
        r.id === id
          ? {
              ...r,
              status: patch.status ?? r.status,
              assignee: patch.assignee !== undefined ? patch.assignee : r.assignee,
              originalResolutionDate:
                patch.startDate ?? r.originalResolutionDate,
              expectedResolutionDate: patch.endDate ?? r.expectedResolutionDate,
              linkedTaskId: patch.parentId !== undefined ? patch.parentId : r.linkedTaskId,
              linkedTaskTitle:
                patch.parentId !== undefined
                  ? patch.parentId
                    ? byId.get(patch.parentId)?.title ?? null
                    : null
                  : r.linkedTaskTitle,
              progress: patch.progress ?? r.progress,
              tags: patch.tags ?? r.tags,
              urgency: patch.urgency ?? r.urgency,
            }
          : r,
      ),
    );
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: patch.status,
          assignee: patch.assignee,
          startDate: patch.startDate ? new Date(patch.startDate) : undefined,
          endDate: patch.endDate ? new Date(patch.endDate) : undefined,
          parentId: patch.parentId,
          progress: patch.progress,
          tags: patch.tags,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch {
      setRows(prev);
      setStatus("Update failed.");
    }
  }

  async function addIssueComment(issueId: string) {
    const text = (commentDraftByIssueId[issueId] ?? "").trim();
    if (!text) {
      setStatus("Comment is empty.");
      return;
    }
    try {
      const res = await fetch(`/api/tasks/${issueId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ openIssueComment: text }),
      });
      if (!res.ok) throw new Error(await res.text());
      setCommentRows((prev) => [
        {
          id: `tmp-${Date.now()}`,
          taskId: issueId,
          comment: text,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);
      setCommentDraftByIssueId((prev) => ({ ...prev, [issueId]: "" }));
      setStatus("Open issue comment added.");
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Failed to add comment");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Open Issues</h1>
          <p className="text-sm text-muted-foreground">
            Track blockers and risks linked to a task or subtask. Open issues are
            saved as `ISSUE` items and appear on the Gantt board.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-slate-100 p-1 text-sm font-medium flex gap-1">
            <button
              type="button"
              className={`rounded-md px-3 py-1.5 transition ${
                tab === "open"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
              onClick={() => setTab("open")}
            >
              Open
              <span
                className={`ml-2 inline-flex min-w-[22px] justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold ${
                  tab === "open"
                    ? "bg-blue-600 text-white"
                    : "bg-slate-200 text-slate-700"
                }`}
              >
                {counts.open}
              </span>
            </button>
            <button
              type="button"
              className={`rounded-md px-3 py-1.5 transition ${
                tab === "resolved"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
              onClick={() => setTab("resolved")}
            >
              Resolved
              <span
                className={`ml-2 inline-flex min-w-[22px] justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold ${
                  tab === "resolved"
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-200 text-slate-700"
                }`}
              >
                {counts.resolved}
              </span>
            </button>
          </div>
        </div>
      </div>

      {tab === "open" && (
        <div className="rounded-md border border-border bg-white/60 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">
              Filter
            </span>
            <input
              type="search"
              placeholder="Search title, owner, linked task…"
              className="flex-1 min-w-[180px] rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(
                  e.target.value as "ALL" | "TODO" | "IN_PROGRESS" | "BLOCKED",
                )
              }
            >
              <option value="ALL">All active ({counts.open})</option>
              <option value="TODO">Open ({counts.todo})</option>
              <option value="IN_PROGRESS">In Progress ({counts.inProgress})</option>
              <option value="BLOCKED">Blocked ({counts.blocked})</option>
            </select>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={urgencyFilter}
              onChange={(e) => setUrgencyFilter(e.target.value as "ALL" | Urgency)}
            >
              <option value="ALL">All urgencies</option>
              <option value="high">High urgency</option>
              <option value="medium">Medium urgency</option>
              <option value="low">Low urgency</option>
            </select>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={slipFilter}
              onChange={(e) => setSlipFilter(e.target.value as SlipBucket)}
              title="Slippage vs. Original Resolution"
            >
              <option value="ALL">Any slip</option>
              <option value="ON_TRACK">On track</option>
              <option value="PULLED_IN">Pulled in</option>
              <option value="SLIPPING">Slipping ≤ 7d</option>
              <option value="CRITICAL">Critical &gt; 7d</option>
            </select>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
            >
              <option value="ALL">All owners</option>
              {ownerOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              {ownerOptions.length === 0 && (
                <option value="" disabled>
                  No owners yet
                </option>
              )}
            </select>
            <select
              className="max-w-[220px] rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={linkedFilter}
              onChange={(e) => setLinkedFilter(e.target.value)}
            >
              <option value="ALL">Any linked task</option>
              <option value="__unlinked__">Unlinked only</option>
              {linkTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.type} · {t.title}
                </option>
              ))}
            </select>
            {activeFilterCount > 0 && (
              <button
                type="button"
                className="rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                onClick={clearFilters}
              >
                Clear ({activeFilterCount})
              </button>
            )}
          </div>
          <div className="mt-1.5 text-xs text-slate-500">
            Showing {filteredRows.length} of {counts.open} open issue
            {counts.open === 1 ? "" : "s"}
          </div>
        </div>
      )}

      {tab === "open" && (
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="mb-2 text-sm font-medium">Create Open Issue</div>
        <div className="grid gap-2 md:grid-cols-6">
          <input
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            placeholder="Issue title"
            value={createTitle}
            onChange={(e) => setCreateTitle(e.target.value)}
          />
          <input
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            placeholder="Owner"
            value={createOwner}
            onChange={(e) => setCreateOwner(e.target.value)}
          />
          <input
            type="date"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={createExpectedDate}
            onChange={(e) => setCreateExpectedDate(e.target.value)}
          />
          <select
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={createLinkId}
            onChange={(e) => setCreateLinkId(e.target.value)}
          >
            <option value="">Link to task/subtask...</option>
            {linkTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.type} · {t.title}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={createUrgency}
            onChange={(e) => setCreateUrgency(e.target.value as Urgency)}
          >
            <option value="high">Urgency: High</option>
            <option value="medium">Urgency: Medium</option>
            <option value="low">Urgency: Low</option>
          </select>
          <button
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
            onClick={createIssue}
          >
            Add Open Issue
          </button>
        </div>
        {status ? <p className="mt-2 text-xs text-muted-foreground">{status}</p> : null}
      </div>
      )}

      {tab === "resolved" && status && (
        <p className="text-xs text-muted-foreground">{status}</p>
      )}

      <div className="space-y-3">
        {filteredRows.length === 0 && (
          <div className="rounded-md border border-border bg-white/60 px-4 py-8 text-center text-sm text-slate-500">
            {tab === "resolved"
              ? "No resolved issues yet."
              : counts.open === 0
                ? "No open issues. Create one above or mark a task as an issue from the Gantt."
                : "No issues match the current filters."}
          </div>
        )}
        {filteredRows.map((r) => (
          <article
            key={r.id}
            className={`rounded-lg border shadow-sm overflow-hidden ${urgencyCardClass(r.urgency)}`}
          >
            {/* Header strip: urgency, title, linked parent, status, quick action */}
            <header className="flex flex-wrap items-center gap-3 border-b border-black/5 bg-white/70 px-4 py-2.5">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${urgencyPillClass(r.urgency)}`}
              >
                {r.urgency}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-slate-900">
                  {r.title}
                </div>
                {r.linkedTaskTitle && (
                  <div className="mt-0.5 truncate text-[11px] text-slate-500">
                    Linked to {r.linkedTaskTitle}
                  </div>
                )}
              </div>
              <SlipBadge
                original={r.originalResolutionDate}
                current={r.expectedResolutionDate}
              />
              <select
                className={`rounded-md border border-border bg-white px-2 py-1 text-xs font-medium ${statusBadgeClass(r.status)}`}
                value={r.status}
                onChange={(e) =>
                  patchIssue(r.id, { status: e.target.value as Status })
                }
              >
                {Object.entries(STATUS_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              {r.status === "DONE" ? (
                <button
                  className="rounded-md border border-border bg-white px-3 py-1 text-xs font-medium hover:bg-slate-50"
                  onClick={() =>
                    patchIssue(r.id, {
                      status: "IN_PROGRESS",
                      progress: r.progress === 100 ? 0 : r.progress,
                    })
                  }
                >
                  Reopen
                </button>
              ) : (
                <button
                  className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                  onClick={() =>
                    patchIssue(r.id, { status: "DONE", progress: 100 })
                  }
                >
                  Mark Resolved
                </button>
              )}
            </header>

            {/* Metadata grid: Owner / Original / New / Urgency / Progress / Linked */}
            <div className="grid gap-x-6 gap-y-3 bg-white/50 px-4 py-3 text-xs sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
              <Field label="Owner">
                <input
                  className="w-full rounded-md border border-border bg-white px-2 py-1 text-xs"
                  value={r.assignee ?? ""}
                  placeholder="Unassigned"
                  onBlur={(e) =>
                    patchIssue(r.id, {
                      assignee: e.target.value.trim() || null,
                    })
                  }
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((x) =>
                        x.id === r.id ? { ...x, assignee: e.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Original resolution">
                <input
                  type="date"
                  className="w-full rounded-md border border-border bg-white px-2 py-1 text-xs"
                  value={r.originalResolutionDate.slice(0, 10)}
                  onChange={(e) => {
                    const nextOriginal = new Date(e.target.value);
                    const currentNew = new Date(r.expectedResolutionDate);
                    const patch: Parameters<typeof patchIssue>[1] = {
                      startDate: nextOriginal.toISOString(),
                    };
                    if (nextOriginal > currentNew) {
                      patch.endDate = nextOriginal.toISOString();
                    }
                    patchIssue(r.id, patch);
                  }}
                  title="First-committed target date. Edit only to correct the original estimate."
                />
              </Field>
              <Field label="New resolution">
                <input
                  type="date"
                  className="w-full rounded-md border border-border bg-white px-2 py-1 text-xs"
                  value={r.expectedResolutionDate.slice(0, 10)}
                  onChange={(e) =>
                    patchIssue(r.id, {
                      endDate: new Date(e.target.value).toISOString(),
                    })
                  }
                  title="Current (updated) target date. Slippage is measured against the original."
                />
              </Field>
              <Field label="Urgency">
                <select
                  className="w-full rounded-md border border-border bg-white px-2 py-1 text-xs"
                  value={r.urgency}
                  onChange={(e) => {
                    const urgency = e.target.value as Urgency;
                    patchIssue(r.id, {
                      urgency,
                      tags: withUrgencyTags(r.tags, urgency),
                    });
                  }}
                >
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </Field>
              <Field label="Progress" wide>
                <ProgressEditor
                  value={r.progress}
                  onCommit={(next) => {
                    // Auto-resolve / auto-reopen so progress and status stay
                    // consistent without an extra click during standup.
                    const patch: Parameters<typeof patchIssue>[1] = {
                      progress: next,
                    };
                    if (next === 100 && r.status !== "DONE") {
                      patch.status = "DONE";
                    } else if (next < 100 && r.status === "DONE") {
                      patch.status = "IN_PROGRESS";
                    }
                    patchIssue(r.id, patch);
                  }}
                  onLocalChange={(next) =>
                    setRows((prev) =>
                      prev.map((x) =>
                        x.id === r.id ? { ...x, progress: next } : x,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Linked task / subtask" wide>
                <select
                  className="w-full rounded-md border border-border bg-white px-2 py-1 text-xs"
                  value={r.linkedTaskId ?? ""}
                  onChange={(e) =>
                    patchIssue(r.id, { parentId: e.target.value || null })
                  }
                >
                  <option value="">Unlinked</option>
                  {linkTargets
                    .filter((t) => t.id !== r.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.type} · {t.title}
                      </option>
                    ))}
                </select>
              </Field>
              {r.blocking.length > 0 && (
                <Field label={`Blocking (${r.blocking.length})`} wide>
                  <div className="flex flex-wrap gap-1.5">
                    {r.blocking.map((b) => (
                      <span
                        key={`${b.kind}-${b.id}`}
                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${
                          b.kind === "linked"
                            ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                            : "border-rose-200 bg-rose-50 text-rose-700"
                        }`}
                        title={
                          b.kind === "linked"
                            ? "This issue is linked to (and holding up) this task."
                            : "This issue is a predecessor of (blocking) this task."
                        }
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                        >
                          <rect x="3" y="11" width="18" height="10" rx="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        <span className="truncate max-w-[220px]">
                          {b.title}
                        </span>
                        <span className="rounded bg-white/70 px-1 text-[9px] font-semibold uppercase tracking-wide">
                          {b.kind === "linked" ? "linked" : "dep"}
                        </span>
                      </span>
                    ))}
                  </div>
                </Field>
              )}
            </div>

            {/* Comments section */}
            <div className="border-t border-black/5 bg-white/80 px-4 py-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Comments
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <textarea
                  className="h-16 w-full resize-y rounded-md border border-border bg-white px-2 py-1.5 text-xs"
                  placeholder="Add open issue comment (standup detail, blocker, next step)…"
                  value={commentDraftByIssueId[r.id] ?? ""}
                  onChange={(e) =>
                    setCommentDraftByIssueId((prev) => ({
                      ...prev,
                      [r.id]: e.target.value,
                    }))
                  }
                />
                <button
                  className="h-8 shrink-0 self-start rounded-md border border-border bg-white px-3 text-xs font-medium hover:bg-slate-50"
                  onClick={() => addIssueComment(r.id)}
                >
                  Add
                </button>
              </div>
              {(commentsByIssueId.get(r.id) ?? []).length > 0 ? (
                <ul className="mt-2 space-y-1 text-[11px]">
                  {(commentsByIssueId.get(r.id) ?? []).slice(0, 5).map((c) => (
                    <li key={c.id} className="flex gap-2 text-slate-700">
                      <span className="shrink-0 text-slate-400">
                        {new Date(c.createdAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span>{c.comment}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[11px] italic text-slate-400">
                  No comments yet.
                </p>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ProgressEditor({
  value,
  onCommit,
  onLocalChange,
}: {
  value: number;
  onCommit: (next: number) => void;
  onLocalChange: (next: number) => void;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const v = clamp(value);
  const barColor =
    v >= 100
      ? "bg-emerald-500"
      : v >= 66
        ? "bg-blue-500"
        : v >= 33
          ? "bg-sky-400"
          : "bg-slate-400";

  const quick = [0, 25, 50, 75, 100];

  return (
    <div className="space-y-1.5">
      {/* Slider with live track fill + numeric input */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full rounded-full transition-[width] duration-150 ${barColor}`}
              style={{ width: `${v}%` }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={v}
            onChange={(e) => onLocalChange(clamp(Number(e.target.value)))}
            onMouseUp={(e) =>
              onCommit(clamp(Number((e.target as HTMLInputElement).value)))
            }
            onTouchEnd={(e) =>
              onCommit(clamp(Number((e.target as HTMLInputElement).value)))
            }
            onKeyUp={(e) => {
              const key = e.key;
              if (
                key === "ArrowLeft" ||
                key === "ArrowRight" ||
                key === "ArrowUp" ||
                key === "ArrowDown" ||
                key === "Home" ||
                key === "End" ||
                key === "PageUp" ||
                key === "PageDown"
              ) {
                onCommit(clamp(Number((e.target as HTMLInputElement).value)));
              }
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="Progress percent"
          />
        </div>
        <div className="flex items-center gap-0.5">
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            value={v}
            onChange={(e) => onLocalChange(clamp(Number(e.target.value)))}
            onBlur={(e) => onCommit(clamp(Number(e.target.value)))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="w-12 rounded-md border border-border bg-white px-1 py-0.5 text-right text-xs tabular-nums"
          />
          <span className="text-[11px] text-slate-500">%</span>
        </div>
      </div>
      {/* Quick-set preset buttons */}
      <div className="flex gap-1">
        {quick.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onCommit(q)}
            className={`flex-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
              v === q
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-border bg-white text-slate-600 hover:bg-slate-50"
            }`}
            title={q === 100 ? "Mark resolved" : `${q}%`}
          >
            {q}%
          </button>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? "lg:col-span-2" : ""}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      {children}
    </div>
  );
}

function withUrgencyTags(tags: string[], urgency: Urgency): string[] {
  const kept = tags.filter((t) => !t.toLowerCase().startsWith("urgency:"));
  return [...kept, `urgency:${urgency}`];
}

function urgencyCardClass(urgency: Urgency): string {
  if (urgency === "high") return "border-red-200 bg-red-50/40";
  if (urgency === "low") return "border-emerald-200 bg-emerald-50/30";
  return "border-amber-200 bg-amber-50/30";
}

function urgencyPillClass(urgency: Urgency): string {
  if (urgency === "high") return "bg-red-100 text-red-700";
  if (urgency === "low") return "bg-green-100 text-green-700";
  return "bg-amber-100 text-amber-700";
}

function statusBadgeClass(status: Status): string {
  if (status === "DONE") return "text-emerald-700";
  if (status === "BLOCKED") return "text-red-700";
  if (status === "IN_PROGRESS") return "text-blue-700";
  return "text-slate-700";
}

function slipDeltaDays(original: string, current: string): number {
  const msPerDay = 86_400_000;
  return Math.round(
    (new Date(current).getTime() - new Date(original).getTime()) / msPerDay,
  );
}

function slipBucket(
  original: string,
  current: string,
): "ON_TRACK" | "PULLED_IN" | "SLIPPING" | "CRITICAL" {
  const d = slipDeltaDays(original, current);
  if (d === 0) return "ON_TRACK";
  if (d < 0) return "PULLED_IN";
  if (d <= 7) return "SLIPPING";
  return "CRITICAL";
}

function SlipBadge({
  original,
  current,
}: {
  original: string;
  current: string;
}) {
  const delta = slipDeltaDays(original, current);
  const abs = Math.abs(delta);

  if (delta === 0) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5"
        title="On original target"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="text-emerald-600"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <div className="flex flex-col leading-none">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
            On track
          </span>
          <span className="text-[10px] text-emerald-600">0 days</span>
        </div>
      </div>
    );
  }

  if (delta < 0) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5"
        title={`Pulled in ${abs} day${abs === 1 ? "" : "s"}`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="text-sky-600"
        >
          <polyline points="7 17 12 12 17 17" />
          <polyline points="7 11 12 6 17 11" />
        </svg>
        <div className="flex flex-col leading-none">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-sky-700">
            Pulled in
          </span>
          <span className="text-sm font-bold text-sky-700">{delta}d</span>
        </div>
      </div>
    );
  }

  const critical = delta > 7;
  const cls = critical
    ? "border-red-300 bg-red-50"
    : "border-amber-300 bg-amber-50";
  const tone = critical ? "text-red-700" : "text-amber-700";
  const softer = critical ? "text-red-600" : "text-amber-600";

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 ${cls} ${critical ? "shadow-sm ring-2 ring-red-200" : ""}`}
      title={
        critical
          ? `Critical slip — ${delta} days past the original target.`
          : `Slipped ${delta} day${delta === 1 ? "" : "s"} from original target.`
      }
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className={tone}
      >
        <path d="M12 8v5M12 17h.01" />
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      </svg>
      <div className="flex flex-col leading-none">
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${tone}`}>
          {critical ? "Critical" : "Slipping"}
        </span>
        <span className={`text-sm font-bold ${tone}`}>
          +{delta}d
        </span>
        <span className={`text-[10px] ${softer}`}>
          vs original
        </span>
      </div>
    </div>
  );
}

