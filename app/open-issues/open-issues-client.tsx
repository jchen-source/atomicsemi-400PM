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
      <div>
        <h1 className="text-2xl font-semibold">Open Issues</h1>
        <p className="text-sm text-muted-foreground">
          Track blockers and risks linked to a task or subtask. Open issues are
          saved as `ISSUE` items and appear on the Gantt board.
        </p>
      </div>

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

      <div className="overflow-auto rounded-md border border-border">
        <table className="min-w-[1050px] text-sm">
          <thead className="bg-muted/40">
            <tr>
              <Th>Issue</Th>
              <Th>Status</Th>
              <Th>Owner</Th>
              <Th>Original Resolution</Th>
              <Th>New Resolution</Th>
              <Th>Slip</Th>
              <Th>Linked Task/Subtask</Th>
              <Th>Urgency</Th>
              <Th>Progress</Th>
              <Th>Comments</Th>
              <Th>Quick Action</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-t border-border ${urgencyRowClass(r.urgency)}`}
              >
                <Td className="font-medium">{r.title}</Td>
                <Td>
                  <select
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
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
                </Td>
                <Td>
                  <input
                    className="w-36 rounded border border-border bg-background px-2 py-1 text-xs"
                    value={r.assignee ?? ""}
                    placeholder="Owner"
                    onBlur={(e) =>
                      patchIssue(r.id, { assignee: e.target.value.trim() || null })
                    }
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((x) =>
                          x.id === r.id ? { ...x, assignee: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Td>
                <Td>
                  <input
                    type="date"
                    className="rounded border border-border bg-background px-2 py-1 text-xs"
                    value={r.originalResolutionDate.slice(0, 10)}
                    onChange={(e) => {
                      const nextOriginal = new Date(e.target.value);
                      const currentNew = new Date(r.expectedResolutionDate);
                      // Server enforces start<=end; if the user pulls the
                      // original past the current new date, bump the new
                      // date too so the PATCH doesn't 400.
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
                </Td>
                <Td>
                  <input
                    type="date"
                    className="rounded border border-border bg-background px-2 py-1 text-xs"
                    value={r.expectedResolutionDate.slice(0, 10)}
                    onChange={(e) =>
                      patchIssue(r.id, {
                        endDate: new Date(e.target.value).toISOString(),
                      })
                    }
                    title="Current (updated) target date. Slippage is measured against the original."
                  />
                </Td>
                <Td>
                  <SlipCell
                    original={r.originalResolutionDate}
                    current={r.expectedResolutionDate}
                  />
                </Td>
                <Td>
                  <select
                    className="max-w-72 rounded border border-border bg-background px-2 py-1 text-xs"
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
                </Td>
                <Td>
                  <select
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
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
                </Td>
                <Td>{r.progress}%</Td>
                <Td className="min-w-[420px]">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${urgencyPillClass(r.urgency)}`}>
                        {r.urgency.toUpperCase()}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <textarea
                        className="h-20 w-[320px] resize-y rounded border border-border bg-background px-2 py-1 text-xs"
                        placeholder="Add open issue comment (standup detail, blocker, next step)..."
                        value={commentDraftByIssueId[r.id] ?? ""}
                        onChange={(e) =>
                          setCommentDraftByIssueId((prev) => ({
                            ...prev,
                            [r.id]: e.target.value,
                          }))
                        }
                      />
                      <button
                        className="h-8 self-start rounded border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
                        onClick={() => addIssueComment(r.id)}
                      >
                        Add
                      </button>
                    </div>
                    <div className="max-h-36 space-y-1 overflow-auto rounded border border-border bg-muted/20 px-2 py-1">
                      {(commentsByIssueId.get(r.id) ?? []).slice(0, 5).map((c) => (
                        <div key={c.id} className="text-[11px]">
                          <span className="text-muted-foreground">
                            {new Date(c.createdAt).toLocaleString()}:
                          </span>{" "}
                          <span>{c.comment}</span>
                        </div>
                      ))}
                      {(commentsByIssueId.get(r.id) ?? []).length === 0 ? (
                        <div className="text-[11px] text-muted-foreground">No comments yet.</div>
                      ) : null}
                    </div>
                  </div>
                </Td>
                <Td>
                  <button
                    className="rounded border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
                    onClick={() => patchIssue(r.id, { status: "DONE", progress: 100 })}
                  >
                    Mark Resolved
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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

function urgencyPillClass(urgency: Urgency): string {
  if (urgency === "high") return "bg-red-100 text-red-700";
  if (urgency === "low") return "bg-green-100 text-green-700";
  return "bg-amber-100 text-amber-700";
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

