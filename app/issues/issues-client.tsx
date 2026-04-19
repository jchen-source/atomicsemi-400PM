"use client";

import { useEffect, useMemo, useState } from "react";

type Status = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
type UpdateType = "PROGRESS" | "OPEN_ISSUE";
type Urgency = "high" | "medium" | "low";

type SubtaskRow = {
  id: string;
  title: string;
  status: Status;
  progress: number;
  startDate: string;
  endDate: string;
  parentId: string | null;
  parentTitle: string | null;
  parentType: "EPIC" | "TASK" | null;
  assignee: string | null;
  resourceAllocated: string | null;
  effortHours: number | null;
  urgency: Urgency;
  tags: string[];
};

type Parent = { id: string; title: string; type: "EPIC" | "TASK" | "ISSUE" };
type WorkItem = {
  id: string;
  title: string;
  type: "EPIC" | "TASK" | "ISSUE";
  status: Status;
  progress: number;
  startDate: string;
  endDate: string;
  updatedAt: string;
  parentId: string | null;
  parentTitle: string | null;
  assignee: string | null;
  resourceAllocated: string | null;
  effortHours: number | null;
  urgency: Urgency;
  tags: string[];
};
type TaskUpdate = {
  id: string;
  taskId: string;
  taskTitle: string;
  parentId: string | null;
  commentType: UpdateType;
  comment: string;
  progress: number | null;
  endDate: string | null;
  effortHours: number | null;
  assignee: string | null;
  resourceAllocated: string | null;
  createdAt: string;
};

const STATUS_LABEL: Record<Status, string> = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  DONE: "Done",
};

const STATUS_COLOR: Record<Status, string> = {
  TODO: "bg-muted text-foreground",
  IN_PROGRESS: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  BLOCKED: "bg-red-500/15 text-red-600 dark:text-red-300",
  DONE: "bg-green-500/15 text-green-600 dark:text-green-300",
};

export default function IssuesClient({
  initial,
  parents,
  workItems,
  updates,
}: {
  initial: SubtaskRow[];
  parents: Parent[];
  workItems: WorkItem[];
  updates: TaskUpdate[];
}) {
  const [rows, setRows] = useState<SubtaskRow[]>(initial);
  const [items, setItems] = useState<WorkItem[]>(workItems);
  const [feed, setFeed] = useState<TaskUpdate[]>(updates);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | Status>("ALL");
  const [parentFilter, setParentFilter] = useState<string>("ALL");
  const [sortKey, setSortKey] = useState<"endDate" | "progress" | "status">(
    "endDate",
  );
  const [tab, setTab] = useState<"updates" | "effort">("updates");
  const [progressCommentById, setProgressCommentById] = useState<Record<string, string>>({});
  const [openIssueCommentById, setOpenIssueCommentById] = useState<Record<string, string>>({});
  const [showProcurement, setShowProcurement] = useState(false);
  const [banner, setBanner] = useState("");
  const [standupOrder, setStandupOrder] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const parentById = useMemo(
    () => new Map(parents.map((p) => [p.id, p] as const)),
    [parents],
  );
  const assigneeSuggestions = useMemo(
    () =>
      Array.from(
        new Set(
          items
            .map((r) => r.assignee?.trim())
            .filter((v): v is string => Boolean(v)),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [items],
  );

  const filtered = useMemo(() => {
    let out = rows;
    if (query) {
      const q = query.toLowerCase();
      out = out.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.assignee?.toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (statusFilter !== "ALL") {
      out = out.filter((r) => r.status === statusFilter);
    }
    if (parentFilter !== "ALL") {
      out = out.filter((r) => r.parentId === parentFilter);
    }
    out = [...out].sort((a, b) => {
      if (sortKey === "endDate")
        return a.endDate.localeCompare(b.endDate);
      if (sortKey === "progress") return a.progress - b.progress;
      return a.status.localeCompare(b.status);
    });
    return out;
  }, [rows, query, statusFilter, parentFilter, sortKey]);

  const grouped = useMemo(() => {
    const map = new Map<string, { parent: string; items: SubtaskRow[] }>();
    for (const r of filtered) {
      const key = r.parentId ?? "__none__";
      const label =
        r.parentTitle ??
        (r.parentId ? "(unknown parent)" : "(unassigned)");
      if (!map.has(key)) map.set(key, { parent: label, items: [] });
      map.get(key)!.items.push(r);
    }
    return [...map.values()].sort((a, b) => a.parent.localeCompare(b.parent));
  }, [filtered]);

  async function updateRow(
    id: string,
    patch: Partial<
      Pick<
        SubtaskRow,
        | "status"
        | "progress"
        | "parentId"
        | "parentTitle"
        | "parentType"
        | "assignee"
        | "endDate"
        | "effortHours"
        | "resourceAllocated"
        | "urgency"
        | "tags"
      >
    >,
    opts?: {
      progressComment?: string;
      openIssueComment?: string;
    },
  ) {
    const prevRows = rows;
    const prevItems = items;
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
    setItems((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
    try {
      const apiPatch: Record<string, unknown> = {};
      if (patch.status !== undefined) apiPatch.status = patch.status;
      if (patch.progress !== undefined) apiPatch.progress = patch.progress;
      if (patch.parentId !== undefined) apiPatch.parentId = patch.parentId;
      if (patch.assignee !== undefined) apiPatch.assignee = patch.assignee;
      if (patch.endDate !== undefined) apiPatch.endDate = patch.endDate;
      if (patch.effortHours !== undefined) apiPatch.effortHours = patch.effortHours;
      if (patch.resourceAllocated !== undefined) {
        apiPatch.resourceAllocated = patch.resourceAllocated;
      }
      if (patch.tags !== undefined) apiPatch.tags = patch.tags;
      if (opts?.progressComment && opts.progressComment.trim()) {
        apiPatch.progressComment = opts.progressComment.trim();
      }
      if (opts?.openIssueComment && opts.openIssueComment.trim()) {
        apiPatch.openIssueComment = opts.openIssueComment.trim();
      }

      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(apiPatch),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as {
        task?: {
          id: string;
          progress?: number;
          status?: Status;
          endDate?: string;
          assignee?: string | null;
          resourceAllocated?: string | null;
          effortHours?: number | null;
        };
      };
      const task = data.task;
      if (task?.id) {
        setRows((prev) =>
          prev.map((r) =>
            r.id === task.id
              ? {
                  ...r,
                  progress: task.progress ?? r.progress,
                  status: task.status ?? r.status,
                  endDate: task.endDate ?? r.endDate,
                  assignee:
                    task.assignee !== undefined ? task.assignee : r.assignee,
                  resourceAllocated:
                    task.resourceAllocated !== undefined
                      ? task.resourceAllocated
                      : r.resourceAllocated,
                  effortHours:
                    task.effortHours !== undefined ? task.effortHours : r.effortHours,
                  urgency: patch.urgency ?? r.urgency,
                }
              : r,
          ),
        );
        setItems((prev) =>
          prev.map((r) =>
            r.id === task.id
              ? {
                  ...r,
                  progress: task.progress ?? r.progress,
                  status: task.status ?? r.status,
                  endDate: task.endDate ?? r.endDate,
                  assignee:
                    task.assignee !== undefined ? task.assignee : r.assignee,
                  resourceAllocated:
                    task.resourceAllocated !== undefined
                      ? task.resourceAllocated
                      : r.resourceAllocated,
                  effortHours:
                    task.effortHours !== undefined ? task.effortHours : r.effortHours,
                  urgency: patch.urgency ?? r.urgency,
                }
              : r,
          ),
        );
      }
      const source = items.find((x) => x.id === id) ?? rows.find((x) => x.id === id);
      const newEntries: TaskUpdate[] = [];
      if (opts?.progressComment?.trim()) {
        newEntries.push({
          id: `tmp-p-${Date.now()}`,
          taskId: id,
          taskTitle: source?.title ?? "Subtask",
          parentId: source?.parentId ?? null,
          commentType: "PROGRESS",
          comment: opts.progressComment.trim(),
          progress: patch.progress ?? source?.progress ?? null,
          endDate: (patch.endDate as string | undefined) ?? source?.endDate ?? null,
          effortHours: patch.effortHours ?? source?.effortHours ?? null,
          assignee: patch.assignee ?? source?.assignee ?? null,
          resourceAllocated: patch.resourceAllocated ?? source?.resourceAllocated ?? null,
          createdAt: new Date().toISOString(),
        });
      }
      if (opts?.openIssueComment?.trim()) {
        newEntries.push({
          id: `tmp-o-${Date.now()}`,
          taskId: id,
          taskTitle: source?.title ?? "Subtask",
          parentId: source?.parentId ?? null,
          commentType: "OPEN_ISSUE",
          comment: opts.openIssueComment.trim(),
          progress: patch.progress ?? source?.progress ?? null,
          endDate: (patch.endDate as string | undefined) ?? source?.endDate ?? null,
          effortHours: patch.effortHours ?? source?.effortHours ?? null,
          assignee: patch.assignee ?? source?.assignee ?? null,
          resourceAllocated: patch.resourceAllocated ?? source?.resourceAllocated ?? null,
          createdAt: new Date().toISOString(),
        });
      }
      if (newEntries.length) setFeed((prev) => [...newEntries, ...prev]);
    } catch {
      // Revert only this optimistic change.
      setRows(prevRows);
      setItems(prevItems);
    }
  }

  const procurement = useMemo(
    () =>
      items.filter((i) => {
        const t = i.title.toLowerCase();
        if (t.includes("procurement")) return true;
        return i.tags.some((tag) => tag.toLowerCase().includes("procurement"));
      }),
    [items],
  );

  const workItemById = useMemo(
    () => new Map(items.map((i) => [i.id, i] as const)),
    [items],
  );

  const openIssueFeed = useMemo(
    () => feed.filter((u) => u.commentType === "OPEN_ISSUE").slice(0, 40),
    [feed],
  );

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("standup-open-issue-order");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setStandupOrder(parsed.filter((x): x is string => typeof x === "string"));
      }
    } catch {
      // ignore malformed localStorage
    }
  }, []);

  useEffect(() => {
    setStandupOrder((prev) => {
      const liveIds = new Set(openIssueFeed.map((x) => x.id));
      const kept = prev.filter((id) => liveIds.has(id));
      const missing = openIssueFeed
        .map((x) => x.id)
        .filter((id) => !kept.includes(id));
      const next = [...kept, ...missing];
      try {
        window.localStorage.setItem("standup-open-issue-order", JSON.stringify(next));
      } catch {
        // ignore localStorage errors
      }
      return next;
    });
  }, [openIssueFeed]);

  const standupRows = useMemo(() => {
    const orderIndex = new Map(standupOrder.map((id, idx) => [id, idx]));
    return [...openIssueFeed].sort((a, b) => {
      const ai = orderIndex.get(a.id);
      const bi = orderIndex.get(b.id);
      if (ai != null && bi != null) return ai - bi;
      if (ai != null) return -1;
      if (bi != null) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [openIssueFeed, standupOrder]);

  function reorderStandup(movedId: string, targetId: string) {
    if (!movedId || !targetId || movedId === targetId) return;
    setStandupOrder((prev) => {
      const base =
        prev.length > 0
          ? [...prev]
          : standupRows.map((r) => r.id);
      const from = base.indexOf(movedId);
      const to = base.indexOf(targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...base];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      try {
        window.localStorage.setItem("standup-open-issue-order", JSON.stringify(next));
      } catch {
        // ignore localStorage errors
      }
      return next;
    });
  }

  function nudgeStandup(id: string, direction: -1 | 1) {
    setStandupOrder((prev) => {
      const base =
        prev.length > 0
          ? [...prev]
          : standupRows.map((r) => r.id);
      const idx = base.indexOf(id);
      if (idx < 0) return prev;
      const to = idx + direction;
      if (to < 0 || to >= base.length) return prev;
      const next = [...base];
      const [item] = next.splice(idx, 1);
      next.splice(to, 0, item);
      try {
        window.localStorage.setItem("standup-open-issue-order", JSON.stringify(next));
      } catch {
        // ignore localStorage errors
      }
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Table View</h1>
          <p className="text-sm text-muted-foreground">
            Push update comments that feed timeline progress, manage
            effort/resources, and run daily standup updates.
          </p>
        </div>
        <button
          type="button"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
          onClick={() => setShowProcurement((v) => !v)}
        >
          Procurement Items
        </button>
      </div>

      {showProcurement && (
        <div className="rounded-md border border-border bg-muted/20 p-3">
          <h3 className="mb-2 text-sm font-semibold">Procurement Items</h3>
          {procurement.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No procurement-tagged tasks found.
            </p>
          ) : (
            <div className="grid gap-2">
              {procurement.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-border bg-background px-2 py-1.5 text-sm"
                >
                  <span className="font-medium">{p.title}</span>
                  <span className="rounded bg-muted px-1.5 text-xs">{p.status}</span>
                  <span className="text-xs text-muted-foreground">
                    Due {new Date(p.endDate).toLocaleDateString()}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Owner {p.assignee ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <TabButton
          label="Updates"
          active={tab === "updates"}
          onClick={() => setTab("updates")}
        />
        <TabButton
          label="Effort"
          active={tab === "effort"}
          onClick={() => setTab("effort")}
        />
        {banner ? (
          <span className="ml-auto text-xs text-muted-foreground">{banner}</span>
        ) : null}
      </div>

      {tab === "updates" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="w-56 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              placeholder="Search title, assignee, tag…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "ALL" | Status)}
            >
              <option value="ALL">All statuses</option>
              <option value="TODO">To do</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="BLOCKED">Blocked</option>
              <option value="DONE">Done</option>
            </select>
            <select
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={parentFilter}
              onChange={(e) => setParentFilter(e.target.value)}
            >
              <option value="ALL">All parents</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.type === "EPIC" ? "Epic · " : "Task · "}
                  {p.title}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={sortKey}
              onChange={(e) =>
                setSortKey(e.target.value as "endDate" | "progress" | "status")
              }
            >
              <option value="endDate">Sort: Due date</option>
              <option value="progress">Sort: Progress</option>
              <option value="status">Sort: Status</option>
            </select>
            <div className="ml-auto text-sm text-muted-foreground">
              {filtered.length} of {rows.length}
            </div>
          </div>

          {grouped.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No subtasks match your filters.
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map((g) => (
                <section key={g.parent} className="space-y-2">
                  <h2 className="text-sm font-medium text-muted-foreground">
                    {g.parent}{" "}
                    <span className="ml-1 rounded bg-muted px-1.5 text-xs">
                      {g.items.length}
                    </span>
                  </h2>
                  <div className="overflow-auto rounded-md border border-border">
                    <table className="min-w-[1200px] text-sm">
                      <thead className="bg-muted/50">
                        <tr>
                          <Th>Subtask</Th>
                          <Th>Status</Th>
                          <Th>Progress</Th>
                          <Th>Assigned Task</Th>
                          <Th>Owner</Th>
                          <Th>Urgency</Th>
                          <Th>Progress Update Comment</Th>
                          <Th>Open Issue Comment</Th>
                          <Th>Actions</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map((r) => (
                          <tr
                            key={r.id}
                            className={`border-t border-border ${urgencyRowClass(r.urgency)}`}
                          >
                            <Td className="font-medium">{r.title}</Td>
                            <Td>
                              <select
                                className={`rounded px-1.5 py-0.5 text-xs ${STATUS_COLOR[r.status]}`}
                                value={r.status}
                                onChange={(e) =>
                                  updateRow(r.id, {
                                    status: e.target.value as Status,
                                  })
                                }
                              >
                                {Object.entries(STATUS_LABEL).map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v}
                                  </option>
                                ))}
                              </select>
                            </Td>
                            <Td>
                              <ProgressEditor
                                value={r.progress}
                                onCommit={(v) => updateRow(r.id, { progress: v })}
                              />
                            </Td>
                            <Td>
                              <select
                                className="max-w-64 rounded border border-border bg-background px-2 py-1 text-xs"
                                value={r.parentId ?? ""}
                                onChange={(e) => {
                                  const parentId = e.target.value || null;
                                  const parent = parentId
                                    ? parentById.get(parentId)
                                    : undefined;
                                  updateRow(r.id, {
                                    parentId,
                                    parentTitle: parent?.title ?? null,
                                    parentType:
                                      parent?.type === "EPIC" || parent?.type === "TASK"
                                        ? parent.type
                                        : null,
                                  });
                                }}
                              >
                                <option value="">Unassigned</option>
                                {parents.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.type === "EPIC" ? "Epic · " : "Task · "}
                                    {p.title}
                                  </option>
                                ))}
                              </select>
                            </Td>
                            <Td>
                              <AssigneeEditor
                                value={r.assignee}
                                options={assigneeSuggestions}
                                onCommit={(next) =>
                                  updateRow(r.id, { assignee: next })
                                }
                              />
                            </Td>
                            <Td>
                              <select
                                className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                                value={r.urgency}
                                onChange={(e) => {
                                  const urgency = e.target.value as Urgency;
                                  updateRow(r.id, {
                                    urgency,
                                    tags: withUrgencyTags(r.tags, urgency),
                                  });
                                }}
                              >
                                <option value="high">High</option>
                                <option value="medium">Medium</option>
                                <option value="low">Low</option>
                              </select>
                            </Td>
                            <Td>
                              <input
                                className="w-64 rounded border border-border bg-background px-2 py-1 text-xs"
                                placeholder="Short progress update..."
                                value={progressCommentById[r.id] ?? ""}
                                onChange={(e) =>
                                  setProgressCommentById((prev) => ({
                                    ...prev,
                                    [r.id]: e.target.value,
                                  }))
                                }
                              />
                            </Td>
                            <Td>
                              <textarea
                                className="h-16 w-80 resize-y rounded border border-border bg-background px-2 py-1 text-xs"
                                placeholder="Longer open issue for daily standup..."
                                value={openIssueCommentById[r.id] ?? ""}
                                onChange={(e) =>
                                  setOpenIssueCommentById((prev) => ({
                                    ...prev,
                                    [r.id]: e.target.value,
                                  }))
                                }
                              />
                            </Td>
                            <Td>
                              <div className="flex flex-col gap-1">
                              <button
                                className="rounded border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
                                onClick={() => {
                                  const comment = (progressCommentById[r.id] ?? "").trim();
                                  if (!comment) {
                                    setBanner("Progress update comment required.");
                                    return;
                                  }
                                  updateRow(
                                    r.id,
                                    {
                                      progress: r.progress,
                                      status: r.status,
                                      parentId: r.parentId,
                                      assignee: r.assignee,
                                    },
                                    { progressComment: comment },
                                  ).then(() => {
                                    setProgressCommentById((prev) => ({
                                      ...prev,
                                      [r.id]: "",
                                    }));
                                    setBanner("Progress update pushed to schedule.");
                                    setTimeout(() => setBanner(""), 1500);
                                  });
                                }}
                              >
                                Push Progress
                              </button>
                              <button
                                className="rounded border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
                                onClick={() => {
                                  const comment = (openIssueCommentById[r.id] ?? "").trim();
                                  if (!comment) {
                                    setBanner("Open issue comment required.");
                                    return;
                                  }
                                  updateRow(r.id, {}, { openIssueComment: comment }).then(() => {
                                    setOpenIssueCommentById((prev) => ({
                                      ...prev,
                                      [r.id]: "",
                                    }));
                                    setBanner("Open issue logged for standup.");
                                    setTimeout(() => setBanner(""), 1500);
                                  });
                                }}
                              >
                                Log Open Issue
                              </button>
                              </div>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </div>
          )}

          <div className="rounded-md border border-border">
            <div className="border-b border-border px-3 py-2 text-sm font-medium">
              Recent Update Feed
            </div>
            <div className="max-h-56 overflow-auto">
              {feed.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  No update comments yet.
                </p>
              ) : (
                feed.slice(0, 30).map((u) => (
                  <div
                    key={u.id}
                    className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs"
                  >
                    <span className="font-medium">{u.taskTitle}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        u.commentType === "OPEN_ISSUE"
                          ? "bg-amber-500/20 text-amber-700 dark:text-amber-200"
                          : "bg-blue-500/20 text-blue-700 dark:text-blue-200"
                      }`}
                    >
                      {u.commentType === "OPEN_ISSUE" ? "Open Issue" : "Progress"}
                    </span>
                    <span className="text-muted-foreground">{u.comment}</span>
                    <span className="rounded bg-muted px-1.5">P {u.progress ?? "—"}%</span>
                    <span className="rounded bg-muted px-1.5">
                      E {u.effortHours ?? "—"}h
                    </span>
                    <span className="text-muted-foreground">
                      {new Date(u.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-md border border-border">
            <div className="border-b border-border px-3 py-2 text-sm font-medium">
              Daily Standup Open Issues
            </div>
            <div className="max-h-64 overflow-auto">
              {standupRows.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  No open issue comments logged.
                </p>
              ) : (
                <table className="min-w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr>
                      <Th>#</Th>
                      <Th>Move</Th>
                      <Th>Subtask</Th>
                      <Th>Open Issue</Th>
                      <Th>Original Resolution Date</Th>
                      <Th>Actual Resolution Date</Th>
                      <Th>Owner</Th>
                      <Th>Progress</Th>
                      <Th>Logged</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {standupRows.map((u, idx) => (
                      (() => {
                        const task = workItemById.get(u.taskId);
                        const originalResolution =
                          u.endDate ?? task?.endDate ?? null;
                        const actualResolution =
                          task && (task.status === "DONE" || task.progress >= 100)
                            ? task.updatedAt
                            : null;
                        return (
                      <tr
                        key={u.id}
                        className={`border-t border-border ${
                          draggingId === u.id ? "bg-muted/40" : ""
                        }`}
                        draggable
                        onDragStart={() => setDraggingId(u.id)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (draggingId) reorderStandup(draggingId, u.id);
                          setDraggingId(null);
                        }}
                        onDragEnd={() => setDraggingId(null)}
                      >
                        <Td>{idx + 1}</Td>
                        <Td>
                          <div className="flex items-center gap-1">
                            <button
                              className="rounded border border-border px-1 text-xs hover:bg-muted"
                              onClick={() => nudgeStandup(u.id, -1)}
                              title="Move up"
                            >
                              ↑
                            </button>
                            <button
                              className="rounded border border-border px-1 text-xs hover:bg-muted"
                              onClick={() => nudgeStandup(u.id, 1)}
                              title="Move down"
                            >
                              ↓
                            </button>
                            <span className="text-xs text-muted-foreground">drag</span>
                          </div>
                        </Td>
                        <Td className="font-medium">{u.taskTitle}</Td>
                        <Td>{u.comment}</Td>
                        <Td>
                          {originalResolution
                            ? new Date(originalResolution).toLocaleDateString()
                            : "—"}
                        </Td>
                        <Td>
                          {actualResolution
                            ? new Date(actualResolution).toLocaleDateString()
                            : "—"}
                        </Td>
                        <Td>{u.assignee ?? "—"}</Td>
                        <Td>{u.progress != null ? `${u.progress}%` : "—"}</Td>
                        <Td className="text-xs text-muted-foreground">
                          {new Date(u.createdAt).toLocaleString()}
                        </Td>
                      </tr>
                        );
                      })()
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {tab === "effort" && (
        <div className="overflow-auto rounded-md border border-border">
          <table className="min-w-[1100px] text-sm">
            <thead className="bg-muted/50">
              <tr>
                <Th>Task</Th>
                <Th>Type</Th>
                <Th>Effort Remaining (hrs)</Th>
                <Th>End Date</Th>
                <Th>Owner</Th>
                <Th>Urgency</Th>
                <Th>Resource Allocated</Th>
                <Th>Progress</Th>
              </tr>
            </thead>
            <tbody>
              {items
                .filter((i) => i.type !== "EPIC")
                .map((i) => (
                  <tr
                    key={i.id}
                    className={`border-t border-border ${urgencyRowClass(i.urgency)}`}
                  >
                    <Td className="font-medium">{i.title}</Td>
                    <Td>{i.type}</Td>
                    <Td>
                      <NumberEditor
                        value={i.effortHours}
                        min={0}
                        onCommit={(v) => updateRow(i.id, { effortHours: v })}
                      />
                    </Td>
                    <Td>
                      <input
                        type="date"
                        className="rounded border border-border bg-background px-2 py-1 text-xs"
                        value={i.endDate.slice(0, 10)}
                        onChange={(e) =>
                          updateRow(i.id, {
                            endDate: new Date(e.target.value).toISOString(),
                          })
                        }
                      />
                    </Td>
                    <Td>
                      <AssigneeEditor
                        value={i.assignee}
                        options={assigneeSuggestions}
                        onCommit={(v) => updateRow(i.id, { assignee: v })}
                      />
                    </Td>
                    <Td>
                      <select
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                        value={i.urgency}
                        onChange={(e) => {
                          const urgency = e.target.value as Urgency;
                          updateRow(i.id, {
                            urgency,
                            tags: withUrgencyTags(i.tags, urgency),
                          });
                        }}
                      >
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </select>
                    </Td>
                    <Td>
                      <TextEditor
                        value={i.resourceAllocated}
                        onCommit={(v) => updateRow(i.id, { resourceAllocated: v })}
                        placeholder="e.g. 2 ME + 1 EE"
                      />
                    </Td>
                    <Td>
                      <ProgressEditor
                        value={i.progress}
                        onCommit={(v) => updateRow(i.id, { progress: v })}
                      />
                    </Td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}

function ProgressEditor({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={100}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onMouseUp={() => onCommit(v)}
        onTouchEnd={() => onCommit(v)}
        className="w-28 accent-primary"
      />
      <span className="w-8 text-xs tabular-nums text-muted-foreground">
        {v}%
      </span>
    </div>
  );
}

function NumberEditor({
  value,
  min = 0,
  onCommit,
}: {
  value: number | null;
  min?: number;
  onCommit: (v: number | null) => void;
}) {
  const [v, setV] = useState(value != null ? String(value) : "");
  useEffect(() => setV(value != null ? String(value) : ""), [value]);
  const commit = () => {
    const trimmed = v.trim();
    if (!trimmed) {
      onCommit(null);
      return;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return;
    onCommit(Math.max(min, Math.round(num)));
  };
  return (
    <input
      className="w-24 rounded border border-border bg-background px-2 py-1 text-xs"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      placeholder="hrs"
    />
  );
}

function AssigneeEditor({
  value,
  options,
  onCommit,
}: {
  value: string | null;
  options: string[];
  onCommit: (v: string | null) => void;
}) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);

  const commit = () => {
    const trimmed = v.trim();
    onCommit(trimmed ? trimmed : null);
  };

  return (
    <>
      <input
        list="issue-assignee-options"
        className="w-40 rounded border border-border bg-background px-2 py-1 text-xs"
        value={v}
        placeholder="Assign..."
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
        }}
      />
      <datalist id="issue-assignee-options">
        {options.map((opt) => (
          <option key={opt} value={opt} />
        ))}
      </datalist>
    </>
  );
}

function TextEditor({
  value,
  placeholder,
  onCommit,
}: {
  value: string | null;
  placeholder?: string;
  onCommit: (v: string | null) => void;
}) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  const commit = () => {
    const next = v.trim();
    onCommit(next ? next : null);
  };
  return (
    <input
      className="w-44 rounded border border-border bg-background px-2 py-1 text-xs"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      placeholder={placeholder}
    />
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-sm ${
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted"
      }`}
    >
      {label}
    </button>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left text-xs font-medium">{children}</th>;
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

function withUrgencyTags(tags: string[], urgency: Urgency): string[] {
  const kept = tags.filter((t) => !t.toLowerCase().startsWith("urgency:"));
  return [...kept, `urgency:${urgency}`];
}

function urgencyRowClass(urgency: Urgency): string {
  if (urgency === "high") return "bg-red-50/55";
  if (urgency === "low") return "bg-green-50/55";
  return "bg-amber-50/55";
}
