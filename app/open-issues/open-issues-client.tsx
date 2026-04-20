"use client";

import { useMemo, useState } from "react";

type Status = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
type Urgency = "high" | "medium" | "low";
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
    return rows
      .filter((r) =>
        tab === "resolved" ? r.status === "DONE" : r.status !== "DONE",
      )
      .filter((r) => {
        if (tab !== "open") return true;
        if (statusFilter === "ALL") return true;
        return r.status === statusFilter;
      })
      .filter((r) => urgencyFilter === "ALL" || r.urgency === urgencyFilter);
  }, [rows, tab, statusFilter, urgencyFilter]);
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
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-white/60 px-3 py-2">
          <span className="text-xs uppercase tracking-wide text-slate-500">
            Filter
          </span>
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
          <span className="ml-auto text-xs text-slate-500">
            Showing {filteredRows.length} of {counts.open} open issue
            {counts.open === 1 ? "" : "s"}
          </span>
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
              <SlipCell
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
              <Field label="Progress">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-blue-500"
                      style={{ width: `${Math.min(100, Math.max(0, r.progress))}%` }}
                    />
                  </div>
                  <span className="font-medium text-slate-700">
                    {r.progress}%
                  </span>
                </div>
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

function SlipCell({ original, current }: { original: string; current: string }) {
  const msPerDay = 86_400_000;
  const o = new Date(original);
  const c = new Date(current);
  const delta = Math.round((c.getTime() - o.getTime()) / msPerDay);
  if (delta === 0) {
    return (
      <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
        On track
      </span>
    );
  }
  if (delta > 0) {
    return (
      <span
        className={`rounded px-2 py-0.5 text-[11px] font-medium ${
          delta > 7
            ? "bg-red-100 text-red-700"
            : "bg-amber-100 text-amber-700"
        }`}
        title={`Slipped ${delta} day${delta === 1 ? "" : "s"} from original target.`}
      >
        +{delta}d
      </span>
    );
  }
  return (
    <span
      className="rounded bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-700"
      title={`Pulled in ${Math.abs(delta)} day${delta === -1 ? "" : "s"}.`}
    >
      {delta}d
    </span>
  );
}

