"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import UploadIssuesButton from "./upload-issues-button";
import {
  ISSUE_TYPES,
  SCHEDULE_IMPACTS,
  URGENCIES,
  type ActiveIssueView,
  type IssueStatus,
  type IssueType,
  type IssueUrgency,
  type ReminderItem,
  type ScheduleImpact,
  compareStandupOrder,
  daysUntil,
  isActive,
  isAffectingSchedule,
  isOverdue,
  parseIssueMeta,
  serializeIssueMeta,
  serializeNotes,
  summariseIssues,
} from "@/lib/open-issues";

// ---------------- Types -----------------------------------------

type LinkTarget = {
  id: string;
  title: string;
  type: "EPIC" | "TASK";
  parentId: string | null;
  parentTitle: string | null;
};

type PersonRow = { id: string; name: string; role: string | null };

type ReminderBuckets = {
  shouldHaveStarted: ReminderItem[];
  comingUp: ReminderItem[];
};

type IssueComment = {
  id: string;
  comment: string;
  createdAt: string; // ISO
};

type SummaryCounts = ReturnType<typeof summariseIssues>;

type QuickFilter =
  | "all"
  | "high"
  | "affecting"
  | "dueThisWeek"
  | "overdue"
  | "mine";

const STATUS_LABEL: Record<IssueStatus, string> = {
  TODO: "Open",
  IN_PROGRESS: "In Progress",
  BLOCKED: "Waiting on External",
  DONE: "Resolved",
};

const STATUS_ORDER: IssueStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];

// ---------------- Component ------------------------------------

export default function OpenIssuesClient({
  issues,
  linkTargets,
  people,
  reminder,
  summary,
  commentsByIssueId,
  initialFocusTaskId,
  initialFilter,
  initialScopeIds,
  initialScopeTitle,
}: {
  issues: ActiveIssueView[];
  linkTargets: LinkTarget[];
  people: PersonRow[];
  reminder: ReminderBuckets;
  summary: SummaryCounts;
  commentsByIssueId: Record<string, IssueComment[]>;
  initialFocusTaskId: string | null;
  initialFilter: string | null;
  initialScopeIds: string[] | null;
  initialScopeTitle: string | null;
}) {
  const [rows, setRows] = useState<ActiveIssueView[]>(issues);
  // Comments keyed by issue id. Kept in client state so "push"
  // optimistically prepends without waiting for a round trip.
  const [comments, setComments] = useState<Record<string, IssueComment[]>>(
    commentsByIssueId,
  );
  const pushComment = async (issueId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const tempId = `tmp-${Date.now()}`;
    const optimistic: IssueComment = {
      id: tempId,
      comment: trimmed,
      createdAt: new Date().toISOString(),
    };
    setComments((prev) => ({
      ...prev,
      [issueId]: [optimistic, ...(prev[issueId] ?? [])],
    }));
    setRows((prev) =>
      prev.map((r) =>
        r.id === issueId
          ? { ...r, lastUpdated: new Date().toISOString() }
          : r,
      ),
    );
    try {
      const res = await fetch(`/api/tasks/${issueId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ openIssueComment: trimmed }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e) {
      // Roll back the optimistic comment on failure.
      setComments((prev) => ({
        ...prev,
        [issueId]: (prev[issueId] ?? []).filter((c) => c.id !== tempId),
      }));
      throw e;
    }
  };
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState<QuickFilter>(
    isQuickFilter(initialFilter) ? initialFilter : "all",
  );
  const [ownerFilter, setOwnerFilter] = useState<string>("ALL");
  const [linkedFilter, setLinkedFilter] = useState<string>(
    initialFocusTaskId ?? "ALL",
  );
  const [statusFilter, setStatusFilter] = useState<"ALL" | IssueStatus>("ALL");
  // Workstream scope: when set, only issues linked to a task inside
  // this workstream's subtree are shown. Populated by the
  // ?workstreamId= URL param coming from a Gantt badge click.
  const [scope, setScope] = useState<
    { ids: Set<string>; title: string } | null
  >(
    initialScopeIds && initialScopeTitle
      ? { ids: new Set(initialScopeIds), title: initialScopeTitle }
      : null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<string>("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2400);
  };

  // Re-derive summary from current rows so edits update the cards
  // immediately without a server round-trip.
  const liveSummary = useMemo(() => summariseIssues(rows), [rows]);

  const nameByPerson = useMemo(() => new Set(people.map((p) => p.name)), [
    people,
  ]);

  const ownerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of people) set.add(p.name);
    for (const r of rows) if (r.owner) set.add(r.owner);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [people, rows]);

  const byLinkedId = useMemo(
    () => new Map(linkTargets.map((t) => [t.id, t])),
    [linkTargets],
  );

  const filtered = useMemo(() => {
    const now = new Date();
    const q = search.trim().toLowerCase();
    const base = rows.filter((r) =>
      tab === "resolved" ? !isActive(r.status) : isActive(r.status),
    );
    const afterQuick = base.filter((r) => {
      if (quick === "high")
        return r.urgency === "high" || r.urgency === "critical";
      if (quick === "affecting") return isAffectingSchedule(r);
      if (quick === "dueThisWeek") {
        const d = daysUntil(new Date(r.dueDate), now);
        return d >= 0 && d <= 7;
      }
      if (quick === "overdue") return isOverdue(new Date(r.dueDate), now);
      if (quick === "mine") {
        // "Mine" = rows owned by a Person. Solo workspace, so anything
        // with an owner in the people roster counts as a candidate.
        return r.owner ? nameByPerson.has(r.owner) : false;
      }
      return true;
    });
    const afterStatus = afterQuick.filter(
      (r) => statusFilter === "ALL" || r.status === statusFilter,
    );
    const afterOwner = afterStatus.filter(
      (r) => ownerFilter === "ALL" || (r.owner ?? "") === ownerFilter,
    );
    const afterLinked = afterOwner.filter((r) => {
      if (linkedFilter === "ALL") return true;
      if (linkedFilter === "__unlinked__") return !r.linkedTaskId;
      // Linked-to-this-task OR linked-to-a-child-of-this-workstream.
      return (
        r.linkedTaskId === linkedFilter || r.linkedParentId === linkedFilter
      );
    });
    const afterScope = afterLinked.filter((r) => {
      if (!scope) return true;
      return (
        (r.linkedTaskId && scope.ids.has(r.linkedTaskId)) ||
        (r.linkedParentId && scope.ids.has(r.linkedParentId))
      );
    });
    const afterSearch = afterScope.filter((r) => {
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        (r.owner ?? "").toLowerCase().includes(q) ||
        (r.linkedTaskTitle ?? "").toLowerCase().includes(q) ||
        (r.nextStep ?? "").toLowerCase().includes(q)
      );
    });
    return afterSearch.sort((a, b) => compareStandupOrder(a, b, now));
  }, [
    rows,
    tab,
    search,
    quick,
    statusFilter,
    ownerFilter,
    linkedFilter,
    nameByPerson,
    scope,
  ]);

  const activeFilterChips = [
    quick !== "all" && labelForQuick(quick),
    statusFilter !== "ALL" && `Status: ${STATUS_LABEL[statusFilter]}`,
    ownerFilter !== "ALL" && `Owner: ${ownerFilter}`,
    linkedFilter !== "ALL" &&
      (linkedFilter === "__unlinked__"
        ? "Unlinked"
        : `Linked: ${byLinkedId.get(linkedFilter)?.title ?? linkedFilter}`),
    search.trim() && `Search: ${search.trim()}`,
  ].filter(Boolean) as string[];

  function clearFilters() {
    setQuick("all");
    setStatusFilter("ALL");
    setOwnerFilter("ALL");
    setLinkedFilter("ALL");
    setSearch("");
    setScope(null);
  }

  // ----- Mutations -----

  async function persistIssue(
    id: string,
    patch: Partial<{
      title: string;
      status: IssueStatus;
      owner: string | null;
      urgency: IssueUrgency;
      issueType: IssueType;
      scheduleImpact: ScheduleImpact;
      nextStep: string;
      resolutionNote: string;
      dueDate: string; // ISO
      originalDueDate: string; // ISO
      linkedTaskId: string | null;
      progress: number;
    }>,
  ) {
    const prev = rows;
    let optimistic: ActiveIssueView | null = null;
    setRows((curr) =>
      curr.map((r) => {
        if (r.id !== id) return r;
        const next: ActiveIssueView = {
          ...r,
          title: patch.title ?? r.title,
          status: patch.status ?? r.status,
          owner: patch.owner !== undefined ? patch.owner : r.owner,
          urgency: patch.urgency ?? r.urgency,
          issueType: patch.issueType ?? r.issueType,
          scheduleImpact: patch.scheduleImpact ?? r.scheduleImpact,
          nextStep: patch.nextStep ?? r.nextStep,
          resolutionNote: patch.resolutionNote ?? r.resolutionNote,
          dueDate: patch.dueDate ?? r.dueDate,
          originalDueDate: patch.originalDueDate ?? r.originalDueDate,
          linkedTaskId:
            patch.linkedTaskId !== undefined
              ? patch.linkedTaskId
              : r.linkedTaskId,
          linkedTaskTitle:
            patch.linkedTaskId !== undefined
              ? patch.linkedTaskId
                ? byLinkedId.get(patch.linkedTaskId)?.title ?? null
                : null
              : r.linkedTaskTitle,
          linkedParentId:
            patch.linkedTaskId !== undefined
              ? patch.linkedTaskId
                ? byLinkedId.get(patch.linkedTaskId)?.parentId ?? null
                : null
              : r.linkedParentId,
          linkedParentTitle:
            patch.linkedTaskId !== undefined
              ? patch.linkedTaskId
                ? byLinkedId.get(patch.linkedTaskId)?.parentTitle ?? null
                : null
              : r.linkedParentTitle,
          progress: patch.progress ?? r.progress,
          lastUpdated: new Date().toISOString(),
        };
        optimistic = next;
        return next;
      }),
    );

    try {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.status !== undefined) body.status = patch.status;
      if (patch.owner !== undefined) body.assignee = patch.owner;
      if (patch.progress !== undefined) body.progress = patch.progress;
      if (patch.linkedTaskId !== undefined) {
        // Legacy data uses Task.parentId to link an ISSUE to its
        // primary task. Keep writing there so we don't fork the DB.
        body.parentId = patch.linkedTaskId;
      }
      if (patch.dueDate !== undefined) {
        body.endDate = new Date(patch.dueDate);
      }
      if (patch.originalDueDate !== undefined) {
        body.startDate = new Date(patch.originalDueDate);
      }

      const current = optimistic ?? rows.find((r) => r.id === id);
      if (!current) return;

      const metaChanged =
        patch.urgency !== undefined ||
        patch.issueType !== undefined ||
        patch.scheduleImpact !== undefined;
      if (metaChanged) {
        // We need the full tag list on the server. Since we can't read
        // tags back from ActiveIssueView, re-derive from the known
        // metadata. `otherTags` aren't tracked in the view model, so
        // they're preserved server-side by the helper when we round-
        // trip through the task patch — but since we don't have them
        // client-side, we accept an edge case: editing metadata in the
        // UI strips non-metadata tags. In practice the Notion sync
        // doesn't set any such tags on issues, so this is safe.
        body.tags = serializeIssueMeta({
          urgency: patch.urgency ?? current.urgency,
          issueType: patch.issueType ?? current.issueType,
          scheduleImpact: patch.scheduleImpact ?? current.scheduleImpact,
        });
      }

      const notesChanged =
        patch.nextStep !== undefined || patch.resolutionNote !== undefined;
      if (notesChanged) {
        body.description = serializeNotes({
          nextStep: patch.nextStep ?? current.nextStep,
          resolutionNote:
            patch.resolutionNote ?? current.resolutionNote,
        });
      }

      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e) {
      setRows(prev);
      pushToast(e instanceof Error ? `Save failed: ${e.message}` : "Save failed");
    }
  }

  async function deleteIssue(id: string) {
    if (!confirm("Delete this open issue? This cannot be undone.")) return;
    const prev = rows;
    setRows((curr) => curr.filter((r) => r.id !== id));
    try {
      const res = await fetch(`/api/tasks/${id}?mode=cascade`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      pushToast("Issue deleted.");
    } catch (e) {
      setRows(prev);
      pushToast(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function handleCreated(v: ActiveIssueView) {
    setRows((prev) => [v, ...prev]);
    pushToast("Open issue created.");
    setCreateOpen(false);
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Open Issues
          </h1>
          <p className="text-sm text-slate-500">
            Standup control panel · blockers, risks, and decisions that move the
            schedule.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TabSwitch
            tab={tab}
            setTab={setTab}
            openCount={liveSummary.open}
            resolvedCount={rows.length - liveSummary.open}
          />
          <UploadIssuesButton />
          <button
            type="button"
            onClick={() => setCreateOpen((v) => !v)}
            className={
              "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition " +
              (createOpen
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-900 bg-slate-900 text-white hover:bg-slate-800")
            }
          >
            <PlusIcon className="h-4 w-4" />
            {createOpen ? "Close form" : "New Open Issue"}
          </button>
        </div>
      </header>

      {/* Summary strip */}
      <section className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <SummaryCard
          label="Open issues"
          value={liveSummary.open}
          tone="slate"
        />
        <SummaryCard
          label="High"
          value={liveSummary.high}
          tone="red"
          onClick={() => {
            setTab("open");
            setQuick("high");
          }}
        />
        <SummaryCard
          label="Affecting Schedule"
          value={liveSummary.affectingSchedule}
          tone="amber"
          onClick={() => {
            setTab("open");
            setQuick("affecting");
          }}
        />
        <SummaryCard
          label="Tasks Impacted"
          value={liveSummary.tasksImpacted}
          tone="indigo"
        />
        <SummaryCard
          label="Workstreams at Risk"
          value={liveSummary.workstreamsAtRisk}
          tone="rose"
        />
        <SummaryCard
          label="Overdue Next Actions"
          value={liveSummary.overdueNextActions}
          tone="red"
          onClick={() => {
            setTab("open");
            setQuick("overdue");
          }}
        />
      </section>

      {/* Create form (collapsible) */}
      {createOpen && tab === "open" && (
        <CreateIssueForm
          linkTargets={linkTargets}
          people={people}
          onCancel={() => setCreateOpen(false)}
          onCreated={handleCreated}
          initialLinkedTaskId={initialFocusTaskId}
        />
      )}

      {tab === "open" && (
        <>
          {/* Standup Focus: two-pane layout */}
          <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
            <div className="space-y-3 min-w-0">
              {scope && (
                <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-[12px] text-blue-900">
                  <span className="font-semibold">Scoped to workstream:</span>
                  <span className="truncate">{scope.title}</span>
                  <span className="ml-1 rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-blue-200">
                    {filtered.length}{" "}
                    {filtered.length === 1 ? "issue" : "issues"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setScope(null)}
                    className="ml-auto rounded border border-blue-200 bg-white px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
                    title="Show all workstreams"
                  >
                    Clear scope
                  </button>
                </div>
              )}
              <FilterBar
                search={search}
                setSearch={setSearch}
                quick={quick}
                setQuick={setQuick}
                ownerFilter={ownerFilter}
                setOwnerFilter={setOwnerFilter}
                ownerOptions={ownerOptions}
                linkedFilter={linkedFilter}
                setLinkedFilter={setLinkedFilter}
                linkTargets={linkTargets}
                statusFilter={statusFilter}
                setStatusFilter={setStatusFilter}
                activeChips={activeFilterChips}
                onClear={clearFilters}
                counts={liveSummary}
                total={liveSummary.open}
                shown={filtered.length}
              />
              <ActiveIssuesTable
                rows={filtered}
                people={people}
                linkTargets={linkTargets}
                comments={comments}
                onPatch={persistIssue}
                onDelete={deleteIssue}
                onPushComment={async (id, text) => {
                  try {
                    await pushComment(id, text);
                    pushToast("Comment pushed.");
                  } catch (e) {
                    pushToast(
                      e instanceof Error
                        ? `Comment failed: ${e.message}`
                        : "Comment failed.",
                    );
                  }
                }}
              />
            </div>
            <aside className="min-w-0">
              <ReminderPanel
                reminder={reminder}
                onOpenCreate={(taskId) => {
                  const t = byLinkedId.get(taskId);
                  if (!t) return;
                  setCreateOpen(true);
                  // Scroll up so the form is visible.
                  window.requestAnimationFrame(() => {
                    document
                      .getElementById("create-issue-form")
                      ?.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                      });
                  });
                  const ev = new CustomEvent("open-issues:prefill", {
                    detail: { linkedTaskId: taskId, title: t.title },
                  });
                  window.dispatchEvent(ev);
                }}
              />
            </aside>
          </section>
        </>
      )}

      {tab === "resolved" && (
        <ResolvedTable
          rows={rows.filter((r) => !isActive(r.status))}
          onReopen={(id) =>
            persistIssue(id, { status: "IN_PROGRESS", progress: 50 })
          }
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className="fixed bottom-4 right-4 z-50 rounded-md bg-slate-900 px-3 py-2 text-sm text-white shadow-lg"
          role="status"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ---------------- Sub-components ------------------------------

function TabSwitch({
  tab,
  setTab,
  openCount,
  resolvedCount,
}: {
  tab: "open" | "resolved";
  setTab: (t: "open" | "resolved") => void;
  openCount: number;
  resolvedCount: number;
}) {
  return (
    <div className="flex gap-0.5 rounded-lg bg-slate-100 p-0.5 text-sm">
      {(["open", "resolved"] as const).map((k) => {
        const active = tab === k;
        const count = k === "open" ? openCount : resolvedCount;
        return (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition " +
              (active
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900")
            }
          >
            {k === "open" ? "Active" : "Resolved"}
            <span
              className={
                "inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold " +
                (active
                  ? k === "open"
                    ? "bg-blue-600 text-white"
                    : "bg-emerald-600 text-white"
                  : "bg-slate-200 text-slate-600")
              }
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  tone: "slate" | "red" | "amber" | "indigo" | "rose";
  onClick?: () => void;
}) {
  const toneClasses: Record<typeof tone, string> = {
    slate: "bg-white text-slate-900 border-slate-200",
    red: "bg-red-50 text-red-900 border-red-200",
    amber: "bg-amber-50 text-amber-900 border-amber-200",
    indigo: "bg-indigo-50 text-indigo-900 border-indigo-200",
    rose: "bg-rose-50 text-rose-900 border-rose-200",
  };
  const dotTone: Record<typeof tone, string> = {
    slate: "bg-slate-400",
    red: "bg-red-500",
    amber: "bg-amber-500",
    indigo: "bg-indigo-500",
    rose: "bg-rose-500",
  };
  const content = (
    <div className="flex items-center justify-between gap-2">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
          {label}
        </div>
        <div className="text-2xl font-semibold tabular-nums leading-none mt-1">
          {value}
        </div>
      </div>
      <span className={`h-2.5 w-2.5 rounded-full ${dotTone[tone]}`} />
    </div>
  );
  const base = `rounded-lg border px-3 py-2.5 shadow-sm transition ${toneClasses[tone]}`;
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${base} text-left hover:shadow-md active:shadow-sm`}
      >
        {content}
      </button>
    );
  }
  return <div className={base}>{content}</div>;
}

function FilterBar({
  search,
  setSearch,
  quick,
  setQuick,
  ownerFilter,
  setOwnerFilter,
  ownerOptions,
  linkedFilter,
  setLinkedFilter,
  linkTargets,
  statusFilter,
  setStatusFilter,
  activeChips,
  onClear,
  counts,
  total,
  shown,
}: {
  search: string;
  setSearch: (v: string) => void;
  quick: QuickFilter;
  setQuick: (v: QuickFilter) => void;
  ownerFilter: string;
  setOwnerFilter: (v: string) => void;
  ownerOptions: string[];
  linkedFilter: string;
  setLinkedFilter: (v: string) => void;
  linkTargets: LinkTarget[];
  statusFilter: "ALL" | IssueStatus;
  setStatusFilter: (v: "ALL" | IssueStatus) => void;
  activeChips: string[];
  onClear: () => void;
  counts: SummaryCounts;
  total: number;
  shown: number;
}) {
  const quickOptions: Array<{ id: QuickFilter; label: string; count?: number }> =
    [
      { id: "all", label: "All active", count: counts.open },
      { id: "high", label: "High", count: counts.high },
      {
        id: "affecting",
        label: "Affecting Schedule",
        count: counts.affectingSchedule,
      },
      { id: "dueThisWeek", label: "Due This Week" },
      { id: "overdue", label: "Overdue", count: counts.overdueNextActions },
      { id: "mine", label: "My Issues" },
    ];
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            placeholder="Search issue, owner, linked task, next step…"
            className="w-full rounded-md border border-slate-200 bg-white pl-7 pr-2 py-1.5 text-xs placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {quickOptions.map((q) => {
            const active = quick === q.id;
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => setQuick(q.id)}
                className={
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition " +
                  (active
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-400")
                }
              >
                {q.label}
                {q.count !== undefined && (
                  <span
                    className={
                      "rounded px-1 text-[10px] font-semibold " +
                      (active
                        ? "bg-white/20 text-white"
                        : "bg-slate-100 text-slate-500")
                    }
                  >
                    {q.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <select
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "ALL" | IssueStatus)
            }
          >
            <option value="ALL">All statuses</option>
            {STATUS_ORDER.filter((s) => s !== "DONE").map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
          >
            <option value="ALL">Any owner</option>
            {ownerOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="max-w-[220px] rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
            value={linkedFilter}
            onChange={(e) => setLinkedFilter(e.target.value)}
          >
            <option value="ALL">Any linked task</option>
            <option value="__unlinked__">Unlinked only</option>
            {linkTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.type === "EPIC" ? "Workstream" : t.type} · {t.title}
              </option>
            ))}
          </select>
        </div>
      </div>
      {activeChips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Active
          </span>
          {activeChips.map((chip) => (
            <span
              key={chip}
              className="inline-flex items-center rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700"
            >
              {chip}
            </span>
          ))}
          <button
            type="button"
            onClick={onClear}
            className="ml-auto rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
          >
            Clear all
          </button>
        </div>
      )}
      <div className="mt-1 text-[10px] uppercase tracking-wider text-slate-400">
        Showing {shown} of {total} active issue{total === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function labelForQuick(q: QuickFilter): string {
  switch (q) {
    case "high":
      return "High only";
    case "affecting":
      return "Affecting schedule";
    case "dueThisWeek":
      return "Due this week";
    case "overdue":
      return "Overdue";
    case "mine":
      return "My issues";
    default:
      return "";
  }
}

function isQuickFilter(v: unknown): v is QuickFilter {
  return (
    v === "all" ||
    v === "high" ||
    v === "affecting" ||
    v === "dueThisWeek" ||
    v === "overdue" ||
    v === "mine"
  );
}

// ---------- Active issues table ----------

function ActiveIssuesTable({
  rows,
  people,
  linkTargets,
  comments,
  onPatch,
  onDelete,
  onPushComment,
}: {
  rows: ActiveIssueView[];
  people: PersonRow[];
  linkTargets: LinkTarget[];
  comments: Record<string, IssueComment[]>;
  onPatch: (
    id: string,
    patch: Partial<{
      title: string;
      status: IssueStatus;
      owner: string | null;
      urgency: IssueUrgency;
      issueType: IssueType;
      scheduleImpact: ScheduleImpact;
      nextStep: string;
      resolutionNote: string;
      dueDate: string;
      originalDueDate: string;
      linkedTaskId: string | null;
      progress: number;
    }>,
  ) => void;
  onDelete: (id: string) => void;
  onPushComment: (id: string, text: string) => Promise<void> | void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-slate-900">
          No issues match this view.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Clear the filters to see the full active queue, or create a new Open
          Issue from a task.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <IssueCard
          key={r.id}
          row={r}
          people={people}
          linkTargets={linkTargets}
          comments={comments[r.id] ?? []}
          onPatch={onPatch}
          onDelete={onDelete}
          onPushComment={onPushComment}
        />
      ))}
    </div>
  );
}

/**
 * A single open-issue card. The card is the unit the user reviews,
 * edits, and leaves standup comments on. Layout is fully vertical /
 * wrapping — no horizontal scroll at any breakpoint.
 *
 * Structure:
 *   row 1: urgency dot · title · status · hover actions
 *   row 2: linked task · workstream · owner · updated
 *   row 3: urgency / impact / due / progress pills (wrap)
 *   row 4: next step (always visible, full width)
 *   row 5 (expanded): resolution note, original due, big progress slider
 */
function IssueCard({
  row,
  people,
  linkTargets,
  comments,
  onPatch,
  onDelete,
  onPushComment,
}: {
  row: ActiveIssueView;
  people: PersonRow[];
  linkTargets: LinkTarget[];
  comments: IssueComment[];
  onPatch: (
    id: string,
    patch: Partial<{
      title: string;
      status: IssueStatus;
      owner: string | null;
      urgency: IssueUrgency;
      issueType: IssueType;
      scheduleImpact: ScheduleImpact;
      nextStep: string;
      resolutionNote: string;
      dueDate: string;
      originalDueDate: string;
      linkedTaskId: string | null;
      progress: number;
    }>,
  ) => void;
  onDelete: (id: string) => void;
  onPushComment: (id: string, text: string) => Promise<void> | void;
}) {
  const [expanded, setExpanded] = useState(false);
  const now = new Date();
  const overdue = isOverdue(new Date(row.dueDate), now);
  const impactAffects = isAffectingSchedule(row);
  const accent =
    row.urgency === "high" || row.urgency === "critical"
      ? "before:bg-red-500"
      : impactAffects
        ? "before:bg-orange-500"
        : row.urgency === "medium"
          ? "before:bg-amber-400"
          : "before:bg-emerald-400";

  return (
    <article
      className={
        "relative overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm " +
        "before:absolute before:left-0 before:top-0 before:h-full before:w-1 " +
        accent
      }
    >
      <div className="flex flex-col gap-2 pl-3 pr-3 py-2.5">
        {/* Row 1 — title + status + actions */}
        <div className="flex items-start gap-2">
          <UrgencyDot urgency={row.urgency} />
          <div className="min-w-0 flex-1">
            <InlineText
              value={row.title}
              onCommit={(next) => {
                if (next.trim() && next !== row.title)
                  onPatch(row.id, { title: next.trim() });
              }}
              className="block text-[13px] font-semibold text-slate-900 leading-5 break-words"
              inputClassName="w-full rounded border border-blue-300 bg-white px-1 py-0.5 text-[13px] font-semibold text-slate-900"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <StatusSelect
              value={row.status}
              onChange={(status) =>
                onPatch(row.id, {
                  status,
                  ...(status === "DONE" ? { progress: 100 } : {}),
                })
              }
            />
            <button
              type="button"
              title={row.status === "DONE" ? "Reopen" : "Mark resolved"}
              onClick={() =>
                onPatch(row.id, {
                  status: row.status === "DONE" ? "IN_PROGRESS" : "DONE",
                  progress: row.status === "DONE" ? 50 : 100,
                })
              }
              className={
                "rounded-md border p-1 transition " +
                (row.status === "DONE"
                  ? "border-slate-200 text-slate-500 hover:bg-slate-50"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100")
              }
            >
              <CheckIcon className="h-3.5 w-3.5" />
            </button>
            {row.linkedTaskId && (
              <Link
                href={`/?taskId=${row.linkedTaskId}`}
                title="Open linked task on Gantt"
                className="rounded-md border border-slate-200 p-1 text-slate-500 hover:bg-slate-50"
              >
                <GanttIcon className="h-3.5 w-3.5" />
              </Link>
            )}
            <button
              type="button"
              title="Delete issue"
              onClick={() => onDelete(row.id)}
              className="rounded-md border border-slate-200 p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Row 2 — context strip: linked task, workstream, owner, last update */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-[11px] text-slate-500">
          <LinkedTaskPicker
            value={row.linkedTaskId}
            label={row.linkedTaskTitle}
            linkTargets={linkTargets}
            onChange={(id) => onPatch(row.id, { linkedTaskId: id })}
          />
          {row.linkedParentTitle && (
            <>
              <span className="text-slate-300">·</span>
              <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                {row.linkedParentTitle}
              </span>
            </>
          )}
          <span className="text-slate-300">·</span>
          <div className="inline-flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-400">
              Owner
            </span>
            <OwnerPicker
              value={row.owner}
              people={people}
              onChange={(name) => onPatch(row.id, { owner: name })}
            />
          </div>
          <span className="text-slate-300">·</span>
          <span className="text-[10px] text-slate-400">
            Updated {formatRelative(row.lastUpdated)}
          </span>
          <span className="text-slate-300">·</span>
          <IssueTypePill type={row.issueType} />
        </div>

        {/* Row 3 — urgency / impact / due dates / progress */}
        <div className="flex flex-wrap items-center gap-2 pl-4">
          <FieldInline label="Urgency">
            <UrgencySelect
              value={row.urgency}
              onChange={(urgency) => onPatch(row.id, { urgency })}
            />
          </FieldInline>
          <FieldInline label="Impact">
            <ImpactSelect
              value={row.scheduleImpact}
              onChange={(scheduleImpact) =>
                onPatch(row.id, { scheduleImpact })
              }
            />
          </FieldInline>
          <FieldInline label="Original">
            <input
              type="date"
              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-700"
              value={row.originalDueDate.slice(0, 10)}
              onChange={(e) =>
                onPatch(row.id, {
                  originalDueDate: new Date(e.target.value).toISOString(),
                })
              }
              title="First-committed target date. Slippage is measured against this."
            />
          </FieldInline>
          <FieldInline label="Extended">
            <div className="flex items-center gap-1">
              <input
                type="date"
                className={
                  "rounded border bg-white px-1.5 py-0.5 text-[11px] " +
                  (overdue
                    ? "border-red-300 text-red-700"
                    : "border-slate-200 text-slate-700")
                }
                value={row.dueDate.slice(0, 10)}
                onChange={(e) =>
                  onPatch(row.id, {
                    dueDate: new Date(e.target.value).toISOString(),
                  })
                }
                title="Current / extended due date. Update this when the date slips."
              />
              <SlipPill
                originalIso={row.originalDueDate}
                currentIso={row.dueDate}
              />
              <DueHint row={row} />
            </div>
          </FieldInline>
          <FieldInline label="Progress">
            <ProgressBadge
              value={row.progress}
              onChange={(v) => onPatch(row.id, { progress: v })}
            />
          </FieldInline>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        </div>

        {/* Row 4 — comment thread */}
        <div className="pl-4">
          <CommentsThread
            issueId={row.id}
            comments={comments}
            onPush={onPushComment}
          />
        </div>

        {/* Row 5 — expanded details (resolution note) */}
        {expanded && (
          <div className="border-t border-slate-100 pt-3 pl-4">
            <FieldLabel>Resolution Note</FieldLabel>
            <InlineText
              value={row.resolutionNote}
              placeholder="Captured when resolving — context for retros."
              onCommit={(next) => onPatch(row.id, { resolutionNote: next })}
              className="block min-h-[48px] rounded border border-slate-200 bg-white p-1.5 text-[12px] text-slate-700"
              inputClassName="min-h-[72px] w-full rounded border border-blue-300 bg-white p-1.5 text-[12px]"
              multiline
            />
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * Compact slippage indicator shown next to the Extended date. Reads
 * the delta in days; zero-delta gets hidden so the UI stays quiet when
 * nothing has slipped.
 */
function SlipPill({
  originalIso,
  currentIso,
}: {
  originalIso: string;
  currentIso: string;
}) {
  const delta = Math.round(
    (new Date(currentIso).getTime() - new Date(originalIso).getTime()) /
      86_400_000,
  );
  if (delta === 0) return null;
  const pos = delta > 0;
  return (
    <span
      className={
        "inline-flex items-center rounded px-1 text-[10px] font-semibold tabular-nums " +
        (pos
          ? delta > 7
            ? "bg-red-100 text-red-700"
            : "bg-amber-100 text-amber-800"
          : "bg-sky-100 text-sky-800")
      }
      title={pos ? `Slipped ${delta}d from original` : `Pulled in ${Math.abs(delta)}d`}
    >
      {pos ? `+${delta}d` : `${delta}d`}
    </span>
  );
}

/**
 * Comments thread: shows every OPEN_ISSUE comment chronologically,
 * with a textarea + "Push" button to append a new one. Each comment
 * carries its own timestamp so the standup can reference when a blocker
 * was flagged / updated / resolved.
 */
function CommentsThread({
  issueId,
  comments,
  onPush,
}: {
  issueId: string;
  comments: IssueComment[];
  onPush: (id: string, text: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onPush(issueId, text);
      setDraft("");
    } finally {
      setBusy(false);
    }
  };
  const visible = showAll ? comments : comments.slice(0, 3);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <FieldLabel>Comments</FieldLabel>
        {comments.length > 3 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-[10px] font-medium text-slate-500 hover:text-slate-900"
          >
            {showAll ? "Show fewer" : `Show all ${comments.length}`}
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Push a standup update, blocker, or next step… (⌘/Ctrl+Enter to push)"
          rows={2}
          className="flex-1 resize-y rounded border border-slate-200 bg-white px-2 py-1 text-[12px] leading-5 text-slate-800 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || !draft.trim()}
          className="shrink-0 self-start rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
          title="Push comment with today's timestamp"
        >
          {busy ? "Pushing…" : "Push"}
        </button>
      </div>
      {comments.length === 0 ? (
        <p className="mt-1.5 text-[11px] italic text-slate-400">
          No comments yet. Push the first standup update for this issue.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {visible.map((c) => (
            <li
              key={c.id}
              className="rounded border border-slate-100 bg-slate-50/70 px-2 py-1"
            >
              <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500">
                <span className="font-semibold">
                  {formatCommentDate(c.createdAt)}
                </span>
                <span className="text-slate-300">·</span>
                <span className="normal-case text-slate-400">
                  {formatRelative(c.createdAt)}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-[12px] leading-5 text-slate-700">
                {c.comment}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatCommentDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function FieldInline({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Compact progress chip with a quick popover of 0/25/50/75/100 plus a
 * slider. Lets the user nudge progress in-place without expanding the
 * card.
 */
function ProgressBadge({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  const v = Math.max(0, Math.min(100, value));
  const tone =
    v === 100
      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
      : v >= 66
        ? "bg-blue-100 text-blue-800 border-blue-200"
        : v >= 33
          ? "bg-sky-100 text-sky-800 border-sky-200"
          : "bg-slate-100 text-slate-700 border-slate-200";
  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${tone}`}
      >
        {v}%
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-48 rounded-md border border-slate-200 bg-white p-2 shadow-lg">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={v}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full"
          />
          <div className="mt-1 flex justify-between gap-1">
            {[0, 25, 50, 75, 100].map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => {
                  onChange(q);
                  setOpen(false);
                }}
                className={
                  "flex-1 rounded border px-1 py-0.5 text-[10px] " +
                  (v === q
                    ? "border-blue-400 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
                }
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DueHint({ row }: { row: ActiveIssueView }) {
  const now = new Date();
  const d = daysUntil(new Date(row.dueDate), now);
  if (isOverdue(new Date(row.dueDate), now) && row.status !== "DONE") {
    return (
      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600">
        Overdue {Math.abs(d)}d
      </div>
    );
  }
  if (d === 0) return <div className="mt-0.5 text-[10px] text-amber-600">Due today</div>;
  if (d > 0 && d <= 3)
    return <div className="mt-0.5 text-[10px] text-amber-600">in {d}d</div>;
  return null;
}

// ---------- Pickers ----------

function OwnerPicker({
  value,
  people,
  onChange,
}: {
  value: string | null;
  people: PersonRow[];
  onChange: (name: string | null) => void;
}) {
  return (
    <select
      className="w-full max-w-[140px] rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value ? e.target.value : null)}
    >
      <option value="">Unassigned</option>
      {people.map((p) => (
        <option key={p.id} value={p.name}>
          {p.name}
        </option>
      ))}
      {value && !people.some((p) => p.name === value) && (
        <option value={value}>{value} (external)</option>
      )}
    </select>
  );
}

function LinkedTaskPicker({
  value,
  label,
  linkTargets,
  onChange,
}: {
  value: string | null;
  label: string | null;
  linkTargets: LinkTarget[];
  onChange: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    const arr = q
      ? linkTargets.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            (t.parentTitle ?? "").toLowerCase().includes(q),
        )
      : linkTargets;
    return arr.slice(0, 40);
  }, [linkTargets, query]);
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          "inline-flex max-w-[200px] items-center gap-1 truncate rounded border px-2 py-1 text-[11px] " +
          (label
            ? "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
            : "border-dashed border-slate-300 bg-slate-50 text-slate-400 hover:border-slate-400")
        }
      >
        <span className="truncate">{label ?? "Unlinked"}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-[280px] rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tasks, subtasks…"
              className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] focus:border-blue-400 focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1 text-[11px]">
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="block w-full px-2 py-1 text-left text-slate-500 hover:bg-slate-50"
            >
              Clear link
            </button>
            {hits.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  onChange(t.id);
                  setOpen(false);
                }}
                className={
                  "block w-full px-2 py-1 text-left hover:bg-blue-50 " +
                  (value === t.id ? "bg-blue-50 text-blue-700" : "text-slate-700")
                }
              >
                <div className="flex items-center justify-between">
                  <span className="truncate font-medium">{t.title}</span>
                  <span className="ml-2 rounded bg-slate-100 px-1 text-[9px] uppercase text-slate-500">
                    {t.type === "EPIC" ? "Workstream" : t.type.toLowerCase()}
                  </span>
                </div>
                {t.parentTitle && (
                  <div className="truncate text-[10px] text-slate-400">
                    in {t.parentTitle}
                  </div>
                )}
              </button>
            ))}
            {hits.length === 0 && (
              <div className="px-2 py-3 text-center text-[11px] text-slate-400">
                No matches
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UrgencySelect({
  value,
  onChange,
}: {
  value: IssueUrgency;
  onChange: (v: IssueUrgency) => void;
}) {
  const tone: Record<IssueUrgency, string> = {
    critical: "bg-red-100 text-red-800 border-red-200",
    high: "bg-orange-100 text-orange-800 border-orange-200",
    medium: "bg-amber-100 text-amber-800 border-amber-200",
    low: "bg-emerald-50 text-emerald-700 border-emerald-200",
  };
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as IssueUrgency)}
      className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${tone[value]}`}
    >
      {URGENCIES.map((u) => (
        <option key={u} value={u}>
          {u}
        </option>
      ))}
    </select>
  );
}

function ImpactSelect({
  value,
  onChange,
}: {
  value: ScheduleImpact;
  onChange: (v: ScheduleImpact) => void;
}) {
  const tone: Record<ScheduleImpact, string> = {
    None: "bg-slate-50 text-slate-600 border-slate-200",
    "At Risk": "bg-amber-50 text-amber-800 border-amber-200",
    "Task Slip": "bg-orange-100 text-orange-800 border-orange-200",
    "Workstream Slip": "bg-red-100 text-red-800 border-red-200",
  };
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ScheduleImpact)}
      className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone[value]}`}
    >
      {SCHEDULE_IMPACTS.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function StatusSelect({
  value,
  onChange,
}: {
  value: IssueStatus;
  onChange: (v: IssueStatus) => void;
}) {
  const tone: Record<IssueStatus, string> = {
    TODO: "bg-slate-50 text-slate-700 border-slate-200",
    IN_PROGRESS: "bg-blue-50 text-blue-800 border-blue-200",
    BLOCKED: "bg-violet-50 text-violet-800 border-violet-200",
    DONE: "bg-emerald-50 text-emerald-800 border-emerald-200",
  };
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as IssueStatus)}
      className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone[value]}`}
    >
      {STATUS_ORDER.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

function IssueTypePill({ type }: { type: IssueType }) {
  return (
    <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
      {type}
    </span>
  );
}

function UrgencyDot({ urgency }: { urgency: IssueUrgency }) {
  const tone: Record<IssueUrgency, string> = {
    critical: "bg-red-500",
    high: "bg-orange-500",
    medium: "bg-amber-500",
    low: "bg-emerald-400",
  };
  return (
    <span
      aria-hidden
      className={`mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full ${tone[urgency]}`}
    />
  );
}

// ---------- Inline text primitive ----------

function InlineText({
  value,
  placeholder,
  onCommit,
  className = "",
  inputClassName = "",
  multiline = false,
}: {
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void;
  className?: string;
  inputClassName?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        className={`${className} cursor-text hover:bg-slate-100/60 rounded px-0.5`}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {value || (
          <span className="text-slate-400 italic">{placeholder ?? "—"}</span>
        )}
      </span>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        autoFocus
        className={inputClassName}
        value={draft}
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setEditing(false);
            setDraft(value);
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            commit();
          }
        }}
      />
    );
  }
  return (
    <input
      autoFocus
      className={inputClassName}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setEditing(false);
          setDraft(value);
        }
      }}
    />
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </div>
  );
}

// ---------- Reminder panel ----------

/**
 * Client-side dismissal state for the Standup Reminder panel.
 *
 * Persisted to localStorage keyed by task id → the plannedEnd ISO that
 * was dismissed. Storing the ISO alongside the id lets us silently
 * re-surface an item when the task is rescheduled — the stored ISO
 * won't match the new plannedEnd, so the dismissal is treated as
 * stale and we show the item again. It also auto-expires a dismissal
 * the moment the task's planned-end falls more than 1 day into the
 * past, so stale bucket rows don't live forever in localStorage.
 */
const DISMISSED_STORAGE_KEY = "pm-standup-dismissed-v1";
const DISMISS_GRACE_MS = 24 * 60 * 60 * 1000;

function readDismissedMap(): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function writeDismissedMap(m: Map<string, string>) {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of m) obj[k] = v;
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* quota / disabled storage — dismissals become in-memory only */
  }
}

function useDismissedReminders() {
  const [map, setMap] = useState<Map<string, string>>(() =>
    readDismissedMap(),
  );

  useEffect(() => {
    writeDismissedMap(map);
  }, [map]);

  // Stay in sync across tabs so dismissing on one open-issues tab
  // mirrors on another.
  useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== DISMISSED_STORAGE_KEY) return;
      setMap(readDismissedMap());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isDismissed = (item: ReminderItem): boolean => {
    const stored = map.get(item.id);
    if (!stored) return false;
    // Rescheduling the task invalidates the old dismissal.
    if (stored !== item.plannedEnd) return false;
    // If the task's planned end is more than a grace period in the
    // past, stop suppressing — the standup should flag it again.
    const endMs = new Date(item.plannedEnd).getTime();
    if (Number.isFinite(endMs) && endMs + DISMISS_GRACE_MS < Date.now()) {
      return false;
    }
    return true;
  };

  const dismiss = (item: ReminderItem) => {
    setMap((prev) => {
      const next = new Map(prev);
      next.set(item.id, item.plannedEnd);
      return next;
    });
  };

  const restore = (id: string) => {
    setMap((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const restoreAll = () => {
    setMap((prev) => (prev.size === 0 ? prev : new Map()));
  };

  return { map, isDismissed, dismiss, restore, restoreAll };
}

function ReminderPanel({
  reminder,
  onOpenCreate,
}: {
  reminder: ReminderBuckets;
  onOpenCreate: (taskId: string) => void;
}) {
  const { isDismissed, dismiss, restoreAll, map } = useDismissedReminders();

  const visibleShouldHave = reminder.shouldHaveStarted.filter(
    (it) => !isDismissed(it),
  );
  const visibleComingUp = reminder.comingUp.filter((it) => !isDismissed(it));
  const hiddenShouldHave =
    reminder.shouldHaveStarted.length - visibleShouldHave.length;
  const hiddenComingUp = reminder.comingUp.length - visibleComingUp.length;
  const totalHidden = hiddenShouldHave + hiddenComingUp;

  // Auto-prune dismissals whose referenced task is no longer in either
  // bucket (task deleted, rescheduled out of horizon, completed, etc.)
  // so localStorage never grows unbounded.
  useEffect(() => {
    if (map.size === 0) return;
    const live = new Set<string>();
    for (const it of reminder.shouldHaveStarted) live.add(it.id);
    for (const it of reminder.comingUp) live.add(it.id);
    let dirty = false;
    const next = new Map(map);
    for (const id of map.keys()) {
      if (!live.has(id)) {
        next.delete(id);
        dirty = true;
      }
    }
    if (dirty) writeDismissedMap(next);
    // Intentionally not calling setMap to avoid a re-render loop —
    // next render will pick up the trimmed storage on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reminder.shouldHaveStarted, reminder.comingUp]);

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">
          Standup Reminder
        </h2>
        {totalHidden > 0 ? (
          <button
            type="button"
            onClick={restoreAll}
            className="text-[10px] font-medium uppercase tracking-wide text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
            title="Un-dismiss every reminder you've hidden"
          >
            Show {totalHidden} hidden
          </button>
        ) : (
          <span className="text-[10px] uppercase tracking-wide text-slate-400">
            Dismiss to silence
          </span>
        )}
      </div>
      <ReminderGroup
        label="Should Have Started"
        tone="red"
        items={visibleShouldHave}
        totalCount={reminder.shouldHaveStarted.length}
        hiddenCount={hiddenShouldHave}
        onOpenCreate={onOpenCreate}
        onDismiss={dismiss}
        emptyText={
          reminder.shouldHaveStarted.length === 0
            ? "Every planned task has kicked off."
            : "All late starts are dismissed for now."
        }
        hint="Planned to start today or earlier, not yet in progress, and no linked open issue."
      />
      <ReminderGroup
        label="Coming Up · 5 Days"
        tone="blue"
        items={visibleComingUp}
        totalCount={reminder.comingUp.length}
        hiddenCount={hiddenComingUp}
        onOpenCreate={onOpenCreate}
        onDismiss={dismiss}
        emptyText={
          reminder.comingUp.length === 0
            ? "Nothing new kicks off in the next 5 days."
            : "All upcoming reminders are dismissed for now."
        }
        hint="Scheduled to start within the next five days."
      />
    </div>
  );
}

function ReminderGroup({
  label,
  tone,
  items,
  totalCount,
  hiddenCount,
  onOpenCreate,
  onDismiss,
  emptyText,
  hint,
}: {
  label: string;
  tone: "amber" | "blue" | "red" | "slate";
  items: ReminderItem[];
  totalCount: number;
  hiddenCount: number;
  onOpenCreate: (taskId: string) => void;
  onDismiss: (item: ReminderItem) => void;
  emptyText: string;
  hint?: string;
}) {
  const chipTone: Record<typeof tone, string> = {
    amber: "bg-amber-100 text-amber-800",
    blue: "bg-blue-100 text-blue-800",
    red: "bg-red-100 text-red-800",
    slate: "bg-slate-100 text-slate-700",
  };
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${chipTone[tone]}`}
        >
          {label}
        </span>
        <span className="text-[10px] text-slate-400">
          {items.length}
          {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
          {totalCount !== items.length + hiddenCount
            ? ` / ${totalCount}`
            : ""}
        </span>
      </div>
      {hint && (
        <p className="mb-1.5 pl-1 text-[10px] text-slate-400">{hint}</p>
      )}
      {items.length === 0 ? (
        <p className="pl-1 text-[11px] italic text-slate-400">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {items.slice(0, 8).map((it) => (
            <ReminderRow
              key={`${label}-${it.id}`}
              item={it}
              onOpenCreate={() => onOpenCreate(it.id)}
              onDismiss={() => onDismiss(it)}
            />
          ))}
          {items.length > 8 && (
            <li className="pl-1 text-[10px] text-slate-400">
              +{items.length - 8} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function ReminderRow({
  item,
  onOpenCreate,
  onDismiss,
}: {
  item: ReminderItem;
  onOpenCreate: () => void;
  onDismiss: () => void;
}) {
  return (
    <li className="group rounded border border-slate-100 bg-slate-50/60 px-2 py-1.5 text-[11px] hover:bg-white hover:shadow-sm">
      <div className="flex items-start gap-2">
        <KindBadge kind={item.kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-slate-800">
            {item.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
            {item.parentWorkstream && (
              <span className="truncate">{item.parentWorkstream}</span>
            )}
            {item.owner && (
              <>
                <span>·</span>
                <span className="truncate">{item.owner}</span>
              </>
            )}
            <span>·</span>
            <span>{new Date(item.plannedEnd).toLocaleDateString()}</span>
            {item.atRisk && (
              <span className="rounded bg-red-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-red-700">
                At Risk
              </span>
            )}
          </div>
          <MiniProgress value={item.percentComplete} />
        </div>
        <div className="flex flex-col gap-0.5 opacity-0 transition group-hover:opacity-100">
          <Link
            href={`/?taskId=${item.id}`}
            title="Open in Gantt"
            className="rounded border border-slate-200 bg-white p-1 text-slate-500 hover:bg-slate-50"
          >
            <GanttIcon className="h-3 w-3" />
          </Link>
          <button
            type="button"
            onClick={onOpenCreate}
            title="Create Issue from Task"
            className="rounded border border-slate-200 bg-white p-1 text-slate-500 hover:bg-slate-50"
          >
            <PlusIcon className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onDismiss}
            title="Dismiss this reminder (re-appears if the date changes)"
            aria-label="Dismiss reminder"
            className="rounded border border-slate-200 bg-white p-1 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>
    </li>
  );
}

function KindBadge({
  kind,
}: {
  kind: "task" | "workstream";
}) {
  const label = kind === "workstream" ? "WS" : "T";
  const tone =
    kind === "workstream"
      ? "bg-indigo-100 text-indigo-700"
      : "bg-slate-100 text-slate-600";
  return (
    <span
      aria-hidden
      className={`mt-0.5 inline-flex h-4 w-7 items-center justify-center rounded text-[9px] font-semibold ${tone}`}
    >
      {label}
    </span>
  );
}

function MiniProgress({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  const color =
    v >= 100
      ? "bg-emerald-500"
      : v >= 66
        ? "bg-blue-500"
        : v >= 33
          ? "bg-sky-400"
          : "bg-slate-300";
  return (
    <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-200">
      <div
        className={`h-full rounded-full ${color}`}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

// ---------- Create form ----------

function CreateIssueForm({
  linkTargets,
  people,
  onCancel,
  onCreated,
  initialLinkedTaskId,
}: {
  linkTargets: LinkTarget[];
  people: PersonRow[];
  onCancel: () => void;
  onCreated: (v: ActiveIssueView) => void;
  initialLinkedTaskId: string | null;
}) {
  const byLinkedId = useMemo(
    () => new Map(linkTargets.map((t) => [t.id, t])),
    [linkTargets],
  );
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const [urgency, setUrgency] = useState<IssueUrgency>("medium");
  const [issueType, setIssueType] = useState<IssueType>("Blocker");
  const [impact, setImpact] = useState<ScheduleImpact>("None");
  const [linkedTaskId, setLinkedTaskId] = useState<string | null>(
    initialLinkedTaskId,
  );
  const [due, setDue] = useState<string>(
    new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
  );
  const [nextStep, setNextStep] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        linkedTaskId?: string;
        title?: string;
      };
      if (detail?.linkedTaskId) setLinkedTaskId(detail.linkedTaskId);
      if (detail?.title)
        setTitle((prev) =>
          prev ? prev : `Issue — ${detail.title}`,
        );
    };
    window.addEventListener("open-issues:prefill", onPrefill);
    return () => window.removeEventListener("open-issues:prefill", onPrefill);
  }, []);

  const linked = linkedTaskId ? byLinkedId.get(linkedTaskId) : undefined;

  async function submit() {
    setErr("");
    if (!title.trim()) {
      setErr("Title is required.");
      return;
    }
    if (!due) {
      setErr("Due date is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: serializeNotes({ nextStep: nextStep.trim() }),
          type: "ISSUE",
          status: "TODO",
          startDate: new Date(due),
          endDate: new Date(due),
          progress: 0,
          parentId: linkedTaskId ?? null,
          assignee: owner ?? null,
          tags: serializeIssueMeta({
            urgency,
            issueType,
            scheduleImpact: impact,
          }),
          sortOrder: 9999,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const created = (await res.json()) as {
        id: string;
        title: string;
        status: IssueStatus;
        assignee: string | null;
        startDate: string;
        endDate: string;
        parentId: string | null;
        progress: number;
        tags?: string[];
        updatedAt: string;
      };
      const meta = parseIssueMeta(created.tags ?? []);
      const view: ActiveIssueView = {
        id: created.id,
        title: created.title,
        status: created.status,
        urgency: meta.urgency,
        issueType: meta.issueType,
        scheduleImpact: meta.scheduleImpact,
        owner: created.assignee,
        nextStep: nextStep.trim(),
        resolutionNote: "",
        dueDate: created.endDate,
        originalDueDate: created.startDate,
        linkedTaskId: created.parentId,
        linkedTaskTitle: created.parentId
          ? byLinkedId.get(created.parentId)?.title ?? null
          : null,
        linkedParentId: created.parentId
          ? byLinkedId.get(created.parentId)?.parentId ?? null
          : null,
        linkedParentTitle: created.parentId
          ? byLinkedId.get(created.parentId)?.parentTitle ?? null
          : null,
        progress: created.progress,
        lastUpdated: created.updatedAt ?? new Date().toISOString(),
      };
      onCreated(view);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      id="create-issue-form"
      className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">
          New Open Issue
        </h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>
      <div className="grid gap-2 md:grid-cols-6">
        <input
          className="md:col-span-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          placeholder="Issue title — e.g. Gas regulator lead time"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <select
          className="rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          value={owner ?? ""}
          onChange={(e) => setOwner(e.target.value || null)}
        >
          <option value="">Owner…</option>
          {people.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className="rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          value={issueType}
          onChange={(e) => setIssueType(e.target.value as IssueType)}
        >
          {ISSUE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          className="rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          value={urgency}
          onChange={(e) => setUrgency(e.target.value as IssueUrgency)}
        >
          {URGENCIES.map((u) => (
            <option key={u} value={u}>
              Urgency: {u}
            </option>
          ))}
        </select>
        <select
          className="rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          value={impact}
          onChange={(e) => setImpact(e.target.value as ScheduleImpact)}
        >
          {SCHEDULE_IMPACTS.map((s) => (
            <option key={s} value={s}>
              Impact: {s}
            </option>
          ))}
        </select>
        <LinkedTaskPicker
          value={linkedTaskId}
          label={linked?.title ?? null}
          linkTargets={linkTargets}
          onChange={setLinkedTaskId}
        />
        <input
          type="date"
          className="rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        <input
          className="md:col-span-3 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          placeholder="Next step (what unblocks this?)"
          value={nextStep}
          onChange={(e) => setNextStep(e.target.value)}
        />
      </div>
      {linked?.parentTitle && (
        <p className="mt-2 text-[11px] text-slate-500">
          Workstream:{" "}
          <span className="font-medium text-slate-700">
            {linked.parentTitle}
          </span>
        </p>
      )}
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Create issue"}
        </button>
      </div>
    </section>
  );
}

// ---------- Resolved tab ----------

function ResolvedTable({
  rows,
  onReopen,
}: {
  rows: ActiveIssueView[];
  onReopen: (id: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
        No resolved issues yet.
      </div>
    );
  }
  const sorted = rows
    .slice()
    .sort(
      (a, b) =>
        new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
    );
  return (
    <div className="space-y-2">
      {sorted.map((r) => (
        <article
          key={r.id}
          className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-slate-900 break-words">
                {r.title}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                {r.linkedTaskTitle && (
                  <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                    {r.linkedTaskTitle}
                  </span>
                )}
                {r.owner && <span>{r.owner}</span>}
                <span>Resolved {formatRelative(r.lastUpdated)}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onReopen(r.id)}
              className="shrink-0 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
            >
              Reopen
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-slate-600">
            {r.resolutionNote || (
              <span className="italic text-slate-400">
                No retrospective note captured.
              </span>
            )}
          </p>
        </article>
      ))}
    </div>
  );
}

// ---------- Misc utilities ----------

function formatRelative(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------- Icons ----------

function PlusIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SearchIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function CheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function TrashIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function GanttIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="6" width="10" height="3" rx="1" />
      <rect x="7" y="11" width="12" height="3" rx="1" />
      <rect x="5" y="16" width="8" height="3" rx="1" />
    </svg>
  );
}

function ChevronDownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
