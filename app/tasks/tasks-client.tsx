"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DATE_RANGES,
  SAVED_VIEWS,
  dateRangeMatches,
  filterPredicate,
  type DateRange,
  type FilterContext,
  type SavedView,
  type TaskLike,
} from "@/lib/filters";
import {
  BurndownChart,
  buildParentSeries,
  buildProjectSeries,
  buildTaskSeries,
  type BurndownSnapshotInput,
  type BurndownTaskInput,
} from "./burndown-chart";
import { AllocationPicker } from "./allocation-picker";

export type TaskRow = {
  id: string;
  title: string;
  parentId: string | null;
  depth: number;
  hasChildren: boolean;
  rowType: "program" | "workstream" | "task" | "subtask";
  status: string;
  assignee: string | null;
  /** Explicit percent split persisted on the task. When null, `assignee`
   *  is the source of truth (single owner or comma-separated even-split). */
  allocations: Array<{ name: string; percent: number }> | null;
  priority: "high" | "medium" | "low" | null;
  startDate: string;
  endDate: string;
  progress: number;
  effortHours: number | null;
  remainingEffort: number | null;
  blocked: boolean;
  nextStep: string | null;
  health: "green" | "yellow" | "red" | null;
  expectedProgress: number;
  lastProgressAt: string | null;
  latestComment: string | null;
  latestCommentAt: string | null;
  tags: string;
  updatedAt: string;
};

export type TaskSnapshot = {
  id: string;
  taskId: string;
  createdAt: string;
  comment: string;
  progress: number | null;
  remainingEffort: number | null;
  status: string | null;
  blocked: boolean | null;
  health: string | null;
};

export type PersonOption = {
  id: string;
  name: string;
  role: string | null;
  active: boolean;
  // "roster" = comes from the Person table and /people manages it.
  // "freeform" = only exists as a string on a task's assignee field.
  // The picker treats both as selectable, but tags roster entries with a
  // subtle badge so the team knows which are "real" people vs. imported names.
  source: "roster" | "freeform";
};

type FilterRow = Omit<TaskLike, "startDate" | "endDate" | "lastProgressAt"> & {
  startDate: string;
  endDate: string;
  lastProgressAt: string | null;
};

type Props = {
  rows: TaskRow[];
  filterRows: FilterRow[];
  predEndDatesByDependent: Record<string, string[]>;
  initialSnapshots: TaskSnapshot[];
  burnTasks: BurndownTaskInput[];
  burnSnapshots: BurndownSnapshotInput[];
  nowISO: string;
  people: PersonOption[];
};

const STATUS_OPTIONS = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"] as const;

export default function TasksClient({
  rows: initialRows,
  filterRows: initialFilterRows,
  predEndDatesByDependent,
  burnTasks: initialBurnTasks,
  burnSnapshots: initialBurnSnapshots,
  nowISO,
  people,
}: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<TaskRow[]>(initialRows);
  const [filterRows, setFilterRows] = useState<FilterRow[]>(initialFilterRows);
  const [view, setView] = useState<SavedView>("all");
  const [dateRange, setDateRange] = useState<DateRange>("any");
  const [search, setSearch] = useState("");
  // "all" = every program, otherwise the id of a specific program (depth-0
  // row) that scopes the table, burndown, and drawer. Persisted to
  // localStorage so navigating away and back doesn't lose your context.
  const [programId, setProgramId] = useState<string>("all");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("tasks.programId");
    if (saved) setProgramId(saved);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("tasks.programId", programId);
  }, [programId]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<TaskSnapshot[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [burnChartOpen, setBurnChartOpen] = useState(true);

  // Burndown inputs — grow as the user saves updates in this session so the
  // project-wide strip and the in-drawer chart reflect new snapshots without
  // waiting for router.refresh() to repaint.
  const [burnTasks, setBurnTasks] = useState<BurndownTaskInput[]>(
    initialBurnTasks,
  );
  const [burnSnapshots, setBurnSnapshots] = useState<BurndownSnapshotInput[]>(
    initialBurnSnapshots,
  );

  // Keep rows in sync when the server re-renders after router.refresh().
  useEffect(() => setRows(initialRows), [initialRows]);
  useEffect(() => setFilterRows(initialFilterRows), [initialFilterRows]);
  useEffect(() => setBurnTasks(initialBurnTasks), [initialBurnTasks]);
  useEffect(
    () => setBurnSnapshots(initialBurnSnapshots),
    [initialBurnSnapshots],
  );

  // Passive auto-refresh: if a teammate pushes an update in another tab
  // (or the same user toggles back after editing elsewhere), re-pull
  // server data so the burndown chart picks up the new snapshots without
  // requiring a manual reload. We only refresh when the tab is visible
  // to keep background tabs idle.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (!cancelled && document.visibilityState === "visible") {
        router.refresh();
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onFocus = () => refresh();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    // Gentle poll every 30s — cheap enough to stay live on the standup
    // view without hammering Render. The server RSC response is cached
    // per-request so this is a single PG round-trip per tick.
    const id = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, [router]);

  const filterCtx: FilterContext = useMemo(() => {
    const map = new Map<string, Date[]>();
    for (const [k, v] of Object.entries(predEndDatesByDependent)) {
      map.set(
        k,
        v.map((d) => new Date(d)),
      );
    }
    return { now: new Date(nowISO), predEndDatesByDependent: map };
  }, [predEndDatesByDependent, nowISO]);

  // Chip counts use the shared predicate so server vs. client stay aligned.
  // We AND the active date range into each chip's count so the numbers
  // reflect what the user will actually see once they click a chip — e.g.
  // "At risk (2)" after choosing This month means 2 at-risk rows that also
  // touch this month.
  const counts = useMemo(() => {
    const out: Record<SavedView, number> = {
      all: 0,
      inProgress: 0,
      blocked: 0,
      overdue: 0,
      lateStart: 0,
      atRisk: 0,
      needsUpdate: 0,
      byOwner: 0,
      byWorkstream: 0,
    };
    for (const row of filterRows) {
      if (!dateRangeMatches(row, dateRange, filterCtx.now)) continue;
      for (const v of SAVED_VIEWS) {
        if (filterPredicate(v.id, row, filterCtx)) out[v.id]++;
      }
    }
    return out;
  }, [filterRows, filterCtx, dateRange]);

  // Build set of ids matching the current view + date range (AND).
  const matchingIds = useMemo(() => {
    const s = new Set<string>();
    for (const row of filterRows) {
      if (!filterPredicate(view, row, filterCtx)) continue;
      if (!dateRangeMatches(row, dateRange, filterCtx.now)) continue;
      s.add(row.id);
    }
    return s;
  }, [filterRows, view, filterCtx, dateRange]);

  // Search filter (client-only, substring on title / assignee).
  const searchIds = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const s = new Set<string>();
    for (const r of rows) {
      if (
        r.title.toLowerCase().includes(q) ||
        (r.assignee ?? "").toLowerCase().includes(q)
      ) {
        s.add(r.id);
      }
    }
    return s;
  }, [rows, search]);

  // Rows to render: matches view + search. Also include all ancestors of a
  // match so the hierarchy stays legible (a filtered Subtask still shows its
  // Program/Workstream/Task chain).
  const rowById = useMemo(() => {
    const m = new Map<string, TaskRow>();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);

  // Programs (depth-0 rows) drive the top-level dropdown. Sorted by title
  // so the menu is stable as rows reshuffle.
  const programOptions = useMemo(() => {
    return rows
      .filter((r) => r.rowType === "program")
      .map((r) => ({ id: r.id, title: r.title }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [rows]);

  // If the saved programId no longer exists (program deleted, or initial
  // hydration before programs loaded), snap back to "all" so the table
  // doesn't silently hide everything.
  useEffect(() => {
    if (
      programId !== "all" &&
      programOptions.length > 0 &&
      !programOptions.some((p) => p.id === programId)
    ) {
      setProgramId("all");
    }
  }, [programId, programOptions]);

  // Set of task ids inside the active program: the program row itself
  // plus every descendant. `null` means "no scoping" (All programs).
  const programScopeIds = useMemo<Set<string> | null>(() => {
    if (programId === "all") return null;
    const kidsByParent = new Map<string | null, TaskRow[]>();
    for (const r of rows) {
      const arr = kidsByParent.get(r.parentId) ?? [];
      arr.push(r);
      kidsByParent.set(r.parentId, arr);
    }
    const out = new Set<string>([programId]);
    const stack = [programId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const kid of kidsByParent.get(cur) ?? []) {
        if (out.has(kid.id)) continue;
        out.add(kid.id);
        stack.push(kid.id);
      }
    }
    return out;
  }, [programId, rows]);

  const visibleIds = useMemo(() => {
    const intersection = new Set<string>();
    for (const id of matchingIds) {
      if (searchIds && !searchIds.has(id)) continue;
      if (programScopeIds && !programScopeIds.has(id)) continue;
      intersection.add(id);
    }
    // Add ancestors so filtered descendants render in context.
    const withAncestors = new Set(intersection);
    for (const id of intersection) {
      let cur = rowById.get(id)?.parentId ?? null;
      while (cur) {
        if (withAncestors.has(cur)) break;
        withAncestors.add(cur);
        cur = rowById.get(cur)?.parentId ?? null;
      }
    }
    return withAncestors;
  }, [matchingIds, searchIds, rowById, programScopeIds]);

  // Apply collapsed folders: if any ancestor is collapsed, hide this row.
  const isHiddenByCollapse = useCallback(
    (row: TaskRow): boolean => {
      let cur = row.parentId;
      while (cur) {
        if (collapsed.has(cur)) return true;
        cur = rowById.get(cur)?.parentId ?? null;
      }
      return false;
    },
    [collapsed, rowById],
  );

  // Group-by renderers for byOwner / byWorkstream. Everything else renders
  // as the indented flat table.
  const groupKey = useCallback(
    (row: TaskRow): string => {
      if (view === "byOwner") return row.assignee?.trim() || "Unassigned";
      if (view === "byWorkstream") {
        let cur: TaskRow | undefined = row;
        while (cur && cur.parentId) {
          const parent = rowById.get(cur.parentId);
          if (!parent) break;
          cur = parent;
        }
        return cur?.title ?? "Top level";
      }
      return "";
    },
    [view, rowById],
  );

  const displayRows = useMemo(() => {
    const out = rows.filter(
      (r) => visibleIds.has(r.id) && !isHiddenByCollapse(r),
    );
    if (view === "byOwner" || view === "byWorkstream") {
      // Group + sort inside group by title.
      const groups = new Map<string, TaskRow[]>();
      for (const r of out) {
        const k = groupKey(r);
        const arr = groups.get(k) ?? [];
        arr.push(r);
        groups.set(k, arr);
      }
      const groupList: { key: string; items: TaskRow[] }[] = [];
      for (const [k, v] of groups) {
        v.sort((a, b) => a.title.localeCompare(b.title));
        groupList.push({ key: k, items: v });
      }
      groupList.sort((a, b) => a.key.localeCompare(b.key));
      return { mode: "grouped" as const, groups: groupList };
    }
    return { mode: "flat" as const, items: out };
  }, [rows, visibleIds, isHiddenByCollapse, view, groupKey]);

  // Drawer actions
  const active = activeId ? rowById.get(activeId) ?? null : null;

  const loadSnapshots = useCallback(async (taskId: string) => {
    setLoadingSnapshots(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (!res.ok) return;
      const json = (await res.json()) as {
        updates?: Array<TaskSnapshot & { commentType?: string }>;
      };
      const snaps = (json.updates ?? [])
        .filter((u) => (u.commentType ?? "PROGRESS") === "PROGRESS")
        .slice(0, 20)
        .map((u) => ({
          id: u.id,
          taskId,
          createdAt: u.createdAt,
          comment: u.comment,
          progress: u.progress ?? null,
          remainingEffort: u.remainingEffort ?? null,
          status: u.status ?? null,
          blocked: u.blocked ?? null,
          health: u.health ?? null,
        }));
      setSnapshots(snaps);
    } finally {
      setLoadingSnapshots(false);
    }
  }, []);

  useEffect(() => {
    if (activeId) loadSnapshots(activeId);
    else setSnapshots([]);
  }, [activeId, loadSnapshots]);

  // Project-wide burndown: every leaf task in the hierarchy rolled into one
  // effort-weighted curve. Recomputes on every local state change so a save
  // updates the strip instantly. When a specific program is selected the
  // strip narrows to that program's rollup so the user sees the curve that
  // matches the rest of the page.
  const projectSeries = useMemo(() => {
    const inputs = {
      tasks: burnTasks,
      snapshots: burnSnapshots,
      nowMs: Date.now(),
    };
    if (programId !== "all") {
      const title =
        programOptions.find((p) => p.id === programId)?.title ?? "Program";
      return buildParentSeries(programId, inputs, title);
    }
    return buildProjectSeries(inputs, "All programs");
  }, [burnTasks, burnSnapshots, programId, programOptions]);

  // Keep table "Rem" aligned with the burndown's live math.
  const remainingNowByTaskId = useMemo(
    () => buildRemainingNowByTaskId(burnTasks, burnSnapshots),
    [burnTasks, burnSnapshots],
  );

  // The drawer's mini chart. Leaves get a single-task series; parents (rows
  // with children) get a parent rollup so workstream/program rows show
  // aggregate progress.
  const drawerSeries = useMemo(() => {
    if (!activeId) return null;
    const row = rowById.get(activeId);
    if (!row) return null;
    const inputs = {
      tasks: burnTasks,
      snapshots: burnSnapshots,
      nowMs: Date.now(),
    };
    return row.hasChildren
      ? buildParentSeries(activeId, inputs)
      : buildTaskSeries(activeId, inputs);
  }, [activeId, rowById, burnTasks, burnSnapshots]);

  const patchRowLocally = useCallback(
    (affected: Array<Partial<TaskRow> & { id: string }>) => {
      setRows((prev) =>
        prev.map((r) => {
          const hit = affected.find((a) => a.id === r.id);
          if (!hit) return r;
          return { ...r, ...hit };
        }),
      );
      setFilterRows((prev) =>
        prev.map((r) => {
          const hit = affected.find((a) => a.id === r.id);
          if (!hit) return r;
          return {
            ...r,
            status: (hit.status as string | undefined) ?? r.status,
            progress:
              hit.progress !== undefined ? (hit.progress as number) : r.progress,
            blocked:
              hit.blocked !== undefined ? (hit.blocked as boolean) : r.blocked,
            startDate:
              (hit.startDate as string | undefined) ?? r.startDate,
            endDate: (hit.endDate as string | undefined) ?? r.endDate,
            lastProgressAt:
              (hit.lastProgressAt as string | null | undefined) ??
              r.lastProgressAt,
            priority:
              hit.priority !== undefined
                ? (hit.priority as FilterRow["priority"])
                : r.priority,
            assignee:
              hit.assignee !== undefined
                ? (hit.assignee as string | null)
                : r.assignee,
          } as FilterRow;
        }),
      );
    },
    [],
  );

  return (
    <div className="tasks-page">
      <FilterBar
        view={view}
        setView={setView}
        counts={counts}
        search={search}
        setSearch={setSearch}
        dateRange={dateRange}
        setDateRange={setDateRange}
        rangeCount={matchingIds.size}
        programId={programId}
        setProgramId={setProgramId}
        programOptions={programOptions}
      />

      {projectSeries && (
        <section
          className={
            "tasks-burn-strip" + (burnChartOpen ? "" : " tasks-burn-strip--collapsed")
          }
        >
          <header className="tasks-burn-strip-head">
            <div>
              <h2>Project burndown</h2>
              <p>
                Live rollup of every leaf task — each progress update appends a
                point to the actual line.
              </p>
            </div>
            <button
              type="button"
              className="tasks-burn-toggle"
              onClick={() => setBurnChartOpen((v) => !v)}
              aria-expanded={burnChartOpen}
            >
              {burnChartOpen ? "Hide chart" : "Show chart"}
            </button>
          </header>
          {burnChartOpen && <BurndownChart series={projectSeries} compact />}
        </section>
      )}

      <div className="tasks-shell">
        <div className="tasks-table-wrap">
          <TasksTableHeader />
          {displayRows.mode === "flat" ? (
            displayRows.items.length === 0 ? (
              <EmptyState view={view} />
            ) : (
              displayRows.items.map((r) => (
                <TasksRow
                  key={r.id}
                  row={r}
                  remainingNow={remainingNowByTaskId.get(r.id) ?? null}
                  active={r.id === activeId}
                  collapsed={collapsed.has(r.id)}
                  onToggleCollapse={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.id)) next.delete(r.id);
                      else next.add(r.id);
                      return next;
                    })
                  }
                  onOpen={() => {
                    // Programs and workstreams always open the dedicated
                    // drill-in page, even when they don't have children
                    // yet — the workstream page now renders a single
                    // self-card when it's empty, so the user gets a
                    // consistent surface for pushing updates at that
                    // level of the hierarchy. Tasks/subtasks with
                    // children also use the drill-in page; leaf tasks /
                    // subtasks keep the inline drawer for quick edits.
                    const usePage =
                      r.hasChildren ||
                      r.rowType === "program" ||
                      r.rowType === "workstream";
                    if (usePage) {
                      router.push(`/tasks/${r.id}`);
                    } else {
                      setActiveId(r.id);
                    }
                  }}
                />
              ))
            )
          ) : displayRows.groups.length === 0 ? (
            <EmptyState view={view} />
          ) : (
            displayRows.groups.map((g) => (
              <div key={g.key} className="tasks-group">
                <div className="tasks-group-header">{g.key}</div>
                {g.items.map((r) => (
                  <TasksRow
                    key={r.id}
                    row={{ ...r, depth: 0, hasChildren: false }}
                    remainingNow={remainingNowByTaskId.get(r.id) ?? null}
                    active={r.id === activeId}
                    collapsed={false}
                    onToggleCollapse={() => {}}
                    onOpen={() => {
                      // Grouped views flatten hierarchy visually but keep
                      // the original rowType on `r` — route programs and
                      // workstreams to the drill-in page for consistency
                      // with the tree view, everyone else opens the
                      // inline drawer.
                      const usePage =
                        r.hasChildren ||
                        r.rowType === "program" ||
                        r.rowType === "workstream";
                      if (usePage) router.push(`/tasks/${r.id}`);
                      else setActiveId(r.id);
                    }}
                  />
                ))}
              </div>
            ))
          )}
        </div>
        {active && (
          <UpdateDrawer
            key={active.id}
            row={active}
            snapshots={snapshots}
            loadingSnapshots={loadingSnapshots}
            series={drawerSeries}
            people={people}
            onClose={() => setActiveId(null)}
            onSaved={({ affected, newSnapshot }) => {
              patchRowLocally(
                affected.map((a) => ({
                  id: a.id,
                  status: a.status,
                  progress: a.progress,
                  blocked: a.blocked,
                  priority: a.priority ?? null,
                  startDate: a.startDate,
                  endDate: a.endDate,
                  health: a.health ?? null,
                  remainingEffort: a.remainingEffort ?? null,
                  nextStep: a.nextStep ?? null,
                  lastProgressAt: a.lastProgressAt ?? null,
                  effortHours: a.effortHours ?? null,
                })),
              );
              if (newSnapshot) {
                setSnapshots((prev) => [newSnapshot, ...prev].slice(0, 20));
                setRows((prev) =>
                  prev.map((r) =>
                    r.id === active.id
                      ? {
                          ...r,
                          latestComment:
                            newSnapshot.comment || r.latestComment,
                          latestCommentAt: newSnapshot.createdAt,
                        }
                      : r,
                  ),
                );
                // Push the new snapshot into the burndown input list so the
                // project strip + drawer chart redraw with the fresh point
                // without waiting for router.refresh() to round-trip.
                setBurnSnapshots((prev) => [
                  ...prev,
                  {
                    id: newSnapshot.id,
                    taskId: active.id,
                    createdAt: newSnapshot.createdAt,
                    commentType: "PROGRESS",
                    progress: newSnapshot.progress ?? 0,
                    remainingEffort: newSnapshot.remainingEffort ?? null,
                    status: newSnapshot.status ?? null,
                    health:
                      (newSnapshot.health as "green" | "yellow" | "red" | null) ??
                      null,
                    comment: newSnapshot.comment ?? "",
                  },
                ]);
              }
              // Also keep the burnTasks cache current so parent rollups (and
              // the task-level series when the drawer is open on a parent)
              // reflect the just-saved progress/status/health.
              setBurnTasks((prev) =>
                prev.map((t) => {
                  const hit = affected.find((a) => a.id === t.id);
                  if (!hit) return t;
                  return {
                    ...t,
                    progress:
                      typeof hit.progress === "number" ? hit.progress : t.progress,
                    status: hit.status ?? t.status,
                    blocked:
                      typeof hit.blocked === "boolean" ? hit.blocked : t.blocked,
                    health:
                      (hit.health as
                        | "green"
                        | "yellow"
                        | "red"
                        | null
                        | undefined) ?? t.health,
                    startDate: hit.startDate ?? t.startDate,
                    endDate: hit.endDate ?? t.endDate,
                  };
                }),
              );
              router.refresh();
            }}
            onSnapshotDeleted={(deletedId, nextState) => {
              // Drop the row from the drawer's local history list.
              setSnapshots((prev) => prev.filter((x) => x.id !== deletedId));
              // Drop the matching ping from the burndown state so the
              // chart redraws without the deleted dot.
              setBurnSnapshots((prev) =>
                prev.filter((x) => x.id !== deletedId),
              );
              if (nextState && active) {
                // The deleted row was the latest PROGRESS snapshot —
                // mirror the task's restored state into the row cache
                // and the burndown task cache so the drawer numbers,
                // chip colors, and rollups match the server.
                setRows((prev) =>
                  prev.map((r) =>
                    r.id === active.id
                      ? {
                          ...r,
                          progress: nextState.progress,
                          status: nextState.status,
                          health: nextState.health,
                          blocked: nextState.blocked,
                          remainingEffort: nextState.remainingEffort,
                        }
                      : r,
                  ),
                );
                setBurnTasks((prev) =>
                  prev.map((t) =>
                    t.id === active.id
                      ? {
                          ...t,
                          progress: nextState.progress,
                          status: nextState.status,
                          blocked: nextState.blocked,
                          health: nextState.health,
                        }
                      : t,
                  ),
                );
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function FilterBar({
  view,
  setView,
  counts,
  search,
  setSearch,
  dateRange,
  setDateRange,
  rangeCount,
  programId,
  setProgramId,
  programOptions,
}: {
  view: SavedView;
  setView: (v: SavedView) => void;
  counts: Record<SavedView, number>;
  search: string;
  setSearch: (v: string) => void;
  dateRange: DateRange;
  setDateRange: (r: DateRange) => void;
  /** Total matches under the current (view ∩ dateRange) filter — shown
   *  inline with the dropdown so the user gets a quick confirmation. */
  rangeCount: number;
  /** Active program id, or "all" for every program. */
  programId: string;
  setProgramId: (id: string) => void;
  /** Depth-0 rows available for selection. */
  programOptions: Array<{ id: string; title: string }>;
}) {
  return (
    <div className="tasks-filterbar">
      {programOptions.length > 1 && (
        <label
          className={
            "tasks-rangepicker tasks-programpicker" +
            (programId !== "all" ? " tasks-rangepicker--active" : "")
          }
          title="Scope the list, burndown, and drawer to a single program"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3 7h18M3 12h18M3 17h18" />
          </svg>
          <select
            value={programId}
            onChange={(e) => setProgramId(e.target.value)}
            aria-label="Filter by program"
          >
            <option value="all">All programs</option>
            {programOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="tasks-filter-chips">
        {SAVED_VIEWS.map((v) => {
          // Severity chips get a tint hook in CSS so they telegraph urgency
          // even when inactive. Non-severity chips stay neutral.
          const tone =
            v.id === "overdue" || v.id === "blocked"
              ? " tasks-chip--danger"
              : v.id === "lateStart" || v.id === "atRisk"
                ? " tasks-chip--warn"
                : "";
          return (
            <button
              key={v.id}
              type="button"
              className={
                "tasks-chip" +
                tone +
                (view === v.id ? " tasks-chip--active" : "")
              }
              onClick={() => setView(v.id)}
              data-chip-id={v.id}
            >
              <span>{v.label}</span>
              <span className="tasks-chip-count">{counts[v.id]}</span>
            </button>
          );
        })}
      </div>

      <label
        className={
          "tasks-rangepicker" +
          (dateRange !== "any" ? " tasks-rangepicker--active" : "")
        }
        title="Limit the list to tasks that overlap this window"
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M16 3v4M8 3v4M3 11h18" />
        </svg>
        <select
          value={dateRange}
          onChange={(e) => setDateRange(e.target.value as DateRange)}
          aria-label="Filter by date range"
        >
          {DATE_RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        {dateRange !== "any" && (
          <span className="tasks-rangepicker__count">{rangeCount}</span>
        )}
      </label>
      <label className="tasks-search">
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          placeholder="Search tasks or owners…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
    </div>
  );
}

function TasksTableHeader() {
  return (
    <div className="tasks-row tasks-row--header">
      <div className="tasks-col tasks-col--title">Task</div>
      <div className="tasks-col tasks-col--owner">Owner</div>
      <div className="tasks-col tasks-col--priority">Priority</div>
      <div className="tasks-col tasks-col--status">Status</div>
      <div className="tasks-col tasks-col--date">Start</div>
      <div className="tasks-col tasks-col--date">Due</div>
      <div className="tasks-col tasks-col--progress">%</div>
      <div className="tasks-col tasks-col--effort">Plan / Rem</div>
      <div className="tasks-col tasks-col--health">Health</div>
      <div className="tasks-col tasks-col--comment">Latest comment</div>
      <div className="tasks-col tasks-col--updated">Updated</div>
    </div>
  );
}

function TasksRow({
  row,
  remainingNow,
  active,
  collapsed,
  onToggleCollapse,
  onOpen,
}: {
  row: TaskRow;
  remainingNow: number | null;
  active: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpen: () => void;
}) {
  const start = new Date(row.startDate);
  const end = new Date(row.endDate);
  const updated = row.latestCommentAt
    ? new Date(row.latestCommentAt)
    : new Date(row.updatedAt);
  const indent = row.depth * 14;
  const remainingDisplay = remainingNow ?? row.remainingEffort;

  return (
    <div
      className={
        "tasks-row" +
        (active ? " tasks-row--active" : "") +
        (row.blocked ? " tasks-row--blocked" : "") +
        ` tasks-row--${row.rowType}`
      }
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div
        className="tasks-col tasks-col--title"
        style={{ paddingLeft: 12 + indent }}
      >
        {row.hasChildren ? (
          <button
            type="button"
            className={
              "tasks-chevron" + (collapsed ? "" : " tasks-chevron--open")
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse();
            }}
            aria-label={collapsed ? "Expand" : "Collapse"}
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
        ) : (
          <span className="tasks-chevron tasks-chevron--spacer" aria-hidden />
        )}
        <RowTypeBadge rowType={row.rowType} />
        <span className="tasks-title" title={row.title}>
          {row.title}
        </span>
      </div>
      <div className="tasks-col tasks-col--owner" title={row.assignee ?? ""}>
        {row.assignee || <span className="tasks-muted">Unassigned</span>}
      </div>
      <div className="tasks-col tasks-col--priority">
        <PriorityBadge priority={row.priority} />
      </div>
      <div className="tasks-col tasks-col--status">
        <StatusBadge status={row.status} blocked={row.blocked} />
      </div>
      <div className="tasks-col tasks-col--date">{fmtDate(start)}</div>
      <div className="tasks-col tasks-col--date">{fmtDate(end)}</div>
      <div className="tasks-col tasks-col--progress">
        <ProgressCell value={row.progress} expected={row.expectedProgress} />
      </div>
      <div className="tasks-col tasks-col--effort">
        <span className="tasks-muted">
          {row.effortHours ?? "—"}h
          {remainingDisplay != null
            ? ` · ${formatHours(remainingDisplay)}h left`
            : ""}
        </span>
      </div>
      <div className="tasks-col tasks-col--health">
        <HealthDot health={row.health} />
      </div>
      <div className="tasks-col tasks-col--comment" title={row.latestComment ?? ""}>
        {row.latestComment ? (
          <span>{row.latestComment}</span>
        ) : (
          <span className="tasks-muted">No comments yet</span>
        )}
      </div>
      <div className="tasks-col tasks-col--updated">{fmtRelative(updated)}</div>
    </div>
  );
}

function RowTypeBadge({ rowType }: { rowType: TaskRow["rowType"] }) {
  const label: Record<TaskRow["rowType"], string> = {
    program: "Program",
    workstream: "Workstream",
    task: "Task",
    subtask: "Subtask",
  };
  return (
    <span className={`tasks-typebadge tasks-typebadge--${rowType}`}>
      {label[rowType]}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: TaskRow["priority"] }) {
  if (!priority) return <span className="tasks-muted">—</span>;
  return (
    <span className={`tasks-priority tasks-priority--${priority}`}>
      {priority === "high" ? "High" : priority === "medium" ? "Med" : "Low"}
    </span>
  );
}

function StatusBadge({ status, blocked }: { status: string; blocked: boolean }) {
  if (blocked && status !== "DONE") {
    return <span className="tasks-status tasks-status--blocked">Blocked</span>;
  }
  const map: Record<string, { label: string; cls: string }> = {
    TODO: { label: "To do", cls: "tasks-status--todo" },
    IN_PROGRESS: { label: "In progress", cls: "tasks-status--ip" },
    BLOCKED: { label: "Blocked", cls: "tasks-status--blocked" },
    DONE: { label: "Done", cls: "tasks-status--done" },
  };
  const s = map[status] ?? { label: status, cls: "tasks-status--todo" };
  return <span className={`tasks-status ${s.cls}`}>{s.label}</span>;
}

function ProgressCell({
  value,
  expected,
}: {
  value: number;
  expected: number;
}) {
  return (
    <div className="tasks-progress" title={`${value}% (expected ${expected}%)`}>
      <div className="tasks-progress-bar">
        <div
          className="tasks-progress-fill"
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
        <div
          className="tasks-progress-expected"
          style={{ left: `${Math.max(0, Math.min(100, expected))}%` }}
        />
      </div>
      <span className="tasks-progress-num">{value}%</span>
    </div>
  );
}

function HealthDot({ health }: { health: TaskRow["health"] }) {
  const color =
    health === "red"
      ? "#ef4444"
      : health === "yellow"
        ? "#eab308"
        : health === "green"
          ? "#16a34a"
          : "#cbd5e1";
  return (
    <span
      className="tasks-healthdot"
      style={{ backgroundColor: color }}
      title={health ?? "Unknown"}
    />
  );
}

function EmptyState({ view }: { view: SavedView }) {
  const msg: Record<SavedView, string> = {
    all: "No tasks yet. Add tasks from the Gantt.",
    inProgress: "No tasks are currently in progress.",
    blocked: "No blockers reported. Nice.",
    overdue: "Nothing overdue — keep it up.",
    lateStart:
      "No tasks waiting to start — every scheduled row has momentum.",
    atRisk: "No tasks falling behind pace. Keep it rolling.",
    needsUpdate: "Every task is up to date.",
    byOwner: "No owners assigned yet.",
    byWorkstream: "No tasks grouped under a workstream.",
  };
  return <div className="tasks-empty">{msg[view]}</div>;
}

// ---------- Drawer ----------

function UpdateDrawer({
  row,
  snapshots,
  loadingSnapshots,
  series,
  people,
  onClose,
  onSaved,
  onSnapshotDeleted,
}: {
  row: TaskRow;
  snapshots: TaskSnapshot[];
  loadingSnapshots: boolean;
  series: import("./burndown-chart").Series | null;
  people: PersonOption[];
  onClose: () => void;
  onSaved: (r: {
    affected: Array<
      Partial<TaskRow> & {
        id: string;
        startDate?: string;
        endDate?: string;
        lastProgressAt?: string | null;
        health?: TaskRow["health"];
      }
    >;
    newSnapshot: TaskSnapshot | null;
  }) => void;
  onSnapshotDeleted: (
    deletedId: string,
    // Populated by the parent when it knows the task's current state
    // just changed because the deleted row was the most recent PROGRESS
    // snapshot — lets the parent mirror the same fields back into its
    // row / burndown caches without refetching.
    nextState: {
      progress: number;
      status: TaskRow["status"];
      health: TaskRow["health"];
      blocked: boolean;
      remainingEffort: number | null;
    } | null,
  ) => void;
}) {
  const router = useRouter();
  const [progress, setProgress] = useState(row.progress);
  const [status, setStatus] = useState(row.status);
  const [blocked, setBlocked] = useState(row.blocked);
  const [priority, setPriority] = useState<TaskRow["priority"]>(row.priority);
  const [assignee, setAssignee] = useState<string | null>(row.assignee);
  const [allocations, setAllocations] = useState<
    Array<{ name: string; percent: number }> | null
  >(row.allocations);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerSaving, setOwnerSaving] = useState(false);
  const [estimate, setEstimate] = useState<number | "">(
    row.effortHours ?? "",
  );
  const [remainingEffort, setRemainingEffort] = useState<number | "">(
    row.remainingEffort ?? "",
  );
  // Track whether the user has manually edited Remaining. If they haven't,
  // Remaining auto-derives from estimate × (1 − progress%) as they move the
  // slider — same UX as the workstream standup form, kept in sync on every
  // keystroke so what the burndown shows matches what's posted.
  const [remainingDirty, setRemainingDirty] = useState<boolean>(
    row.remainingEffort !== null && row.remainingEffort !== undefined,
  );
  const [nextStep, setNextStep] = useState(row.nextStep ?? "");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-derived remaining = estimate × (1 − progress/100). Only computed
  // when the user hasn't overridden it manually; this mirrors the standup
  // form on /tasks/[id] so the two surfaces agree on what "Remaining" means.
  const derivedRemaining =
    estimate !== "" && Number(estimate) > 0
      ? Math.max(
          0,
          Math.round(Number(estimate) * (1 - progress / 100)),
        )
      : null;
  const effectiveRemaining = remainingDirty
    ? remainingEffort
    : (derivedRemaining ?? remainingEffort);

  // Owner/allocation change is a dedicated PATCH so parents can be
  // reassigned too (the progress route is leaf-only and would 409).
  // Optimistic locally so the chip flips immediately, then we let the
  // parent patch the row state via onSaved so the row list + burnTasks
  // stay consistent.
  async function saveOwner(payload: {
    allocations: Array<{ name: string; percent: number }> | null;
    assignee: string | null;
  }) {
    const prevAssignee = assignee;
    const prevAllocations = allocations;
    setOwnerSaving(true);
    setError(null);
    setAssignee(payload.assignee);
    setAllocations(payload.allocations);
    try {
      const res = await fetch(`/api/tasks/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assignee: payload.assignee,
          allocations: payload.allocations,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        task: { id: string; assignee: string | null };
      };
      onSaved({
        affected: [
          {
            id: data.task.id,
            assignee: data.task.assignee,
            allocations: payload.allocations,
          },
        ],
        newSnapshot: null,
      });
    } catch (e) {
      setAssignee(prevAssignee);
      setAllocations(prevAllocations);
      setError(e instanceof Error ? e.message : "Failed to update owner");
      throw e;
    } finally {
      setOwnerSaving(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${row.id}/progress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          progress,
          status,
          blocked,
          priority,
          // Leaf-only: server strips effortHours on parents, but gating it
          // here too keeps the request clean and avoids confusing log noise.
          ...(row.hasChildren
            ? {}
            : {
                effortHours:
                  estimate === "" ? null : Number(estimate),
              }),
          remainingEffort:
            effectiveRemaining === "" ? null : Number(effectiveRemaining),
          nextStep: nextStep.trim() ? nextStep : null,
          comment,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        task: {
          id: string;
          status: string;
          progress: number;
          blocked: boolean;
          priority: string | null;
          health: string | null;
          lastProgressAt: string | null;
          remainingEffort: number | null;
          nextStep: string | null;
          effortHours: number | null;
          startDate: string;
          endDate: string;
        };
        snapshot: TaskSnapshot;
        affected: Array<{
          id: string;
          status: string;
          progress: number;
          blocked: boolean;
          health: string | null;
          startDate: string;
          endDate: string;
          effortHours: number | null;
          remainingEffort: number | null;
          lastProgressAt: string | null;
          nextStep: string | null;
          priority: string | null;
        }>;
      };
      onSaved({
        affected: data.affected.map((a) => ({
          id: a.id,
          status: a.status,
          progress: a.progress,
          blocked: a.blocked,
          health: (a.health as TaskRow["health"]) ?? null,
          startDate: a.startDate,
          endDate: a.endDate,
          effortHours: a.effortHours ?? null,
          remainingEffort: a.remainingEffort ?? null,
          lastProgressAt: a.lastProgressAt ?? null,
          nextStep: a.nextStep ?? null,
          priority: (a.priority as TaskRow["priority"]) ?? null,
        })),
        newSnapshot: data.snapshot
          ? {
              id: data.snapshot.id,
              taskId: row.id,
              createdAt: data.snapshot.createdAt,
              comment: data.snapshot.comment,
              progress: data.snapshot.progress ?? null,
              remainingEffort: data.snapshot.remainingEffort ?? null,
              status: data.snapshot.status ?? null,
              blocked: data.snapshot.blocked ?? null,
              health: data.snapshot.health ?? null,
            }
          : null,
      });
      setComment("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="tasks-drawer" role="dialog" aria-label="Update task">
      <header className="tasks-drawer-header">
        <div>
          <p className="tasks-drawer-eyebrow">
            <RowTypeBadge rowType={row.rowType} />
          </p>
          <h2 className="tasks-drawer-title">{row.title}</h2>
        </div>
        <button
          type="button"
          className="tasks-drawer-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </header>

      <div className="tasks-drawer-owner">
        <span className="tasks-drawer-owner__label">Owner</span>
        <OwnerChip
          assignee={assignee}
          allocations={allocations}
          onClick={() => setOwnerOpen((v) => !v)}
          saving={ownerSaving}
        />
        {ownerOpen && (
          <AllocationPicker
            people={people}
            currentAllocations={allocations}
            currentAssignee={assignee}
            taskEffortHours={typeof estimate === "number" ? estimate : null}
            onSave={saveOwner}
            onClose={() => setOwnerOpen(false)}
          />
        )}
      </div>

      {row.hasChildren ? (
        // Parent row in the master list — progress, remaining hours, and
        // health are all rollups of this row's leaves. A manual update
        // here would be immediately clobbered by the next child save,
        // so we gate the editor entirely and point the user at the
        // workstream drill-in where the leaves live.
        <aside className="tasks-drawer-rollup">
          <div className="tasks-drawer-rollup__icon" aria-hidden>
            ↯
          </div>
          <div className="tasks-drawer-rollup__body">
            <p className="tasks-drawer-rollup__head">
              Updates roll up from subtasks
            </p>
            <p className="tasks-drawer-rollup__sub">
              This row summarizes its leaves. Push progress, comments,
              and remaining hours on a subtask — everything aggregates
              back up here automatically.
            </p>
            <button
              type="button"
              className="roadmap-btn roadmap-btn--primary tasks-drawer-rollup__cta"
              onClick={() => {
                onClose();
                router.push(`/tasks/${row.id}`);
              }}
            >
              Open workstream →
            </button>
          </div>
        </aside>
      ) : (
        <>
          <div className="tasks-drawer-grid">
            <label className="tasks-field">
              <span>% complete</span>
              <div className="tasks-field-row">
                <input
                  ref={firstFieldRef}
                  type="range"
                  min={0}
                  max={100}
                  value={progress}
                  onChange={(e) => setProgress(Number(e.target.value))}
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={progress}
                  onChange={(e) =>
                    setProgress(
                      Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                    )
                  }
                />
              </div>
            </label>

            <label className="tasks-field">
              <span>Estimate (h)</span>
              <input
                type="number"
                min={0}
                step={1}
                placeholder="—"
                value={estimate}
                onChange={(e) =>
                  setEstimate(
                    e.target.value === ""
                      ? ""
                      : Math.max(0, Number(e.target.value)),
                  )
                }
                title="Total estimated hours. Remaining auto-derives from this × (1 − progress%) until you override it."
              />
            </label>

            <label className="tasks-field">
              <span>
                Remaining (h)
                {!remainingDirty && derivedRemaining != null && (
                  <span className="tasks-field-hint"> · auto</span>
                )}
                {remainingDirty && (
                  <button
                    type="button"
                    className="tasks-field-reset"
                    onClick={() => setRemainingDirty(false)}
                    title="Reset to estimate × (1 − progress%)"
                  >
                    reset
                  </button>
                )}
              </span>
              <input
                type="number"
                min={0}
                placeholder={
                  derivedRemaining != null ? String(derivedRemaining) : "—"
                }
                value={effectiveRemaining}
                onChange={(e) => {
                  setRemainingDirty(true);
                  setRemainingEffort(
                    e.target.value === ""
                      ? ""
                      : Math.max(0, Number(e.target.value)),
                  );
                }}
              />
            </label>

            <label className="tasks-field">
              <span>Status</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>

            <label className="tasks-field">
              <span>Priority</span>
              <select
                value={priority ?? ""}
                onChange={(e) =>
                  setPriority(
                    (e.target.value || null) as TaskRow["priority"],
                  )
                }
              >
                <option value="">—</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>

            <label className="tasks-field tasks-field--toggle">
              <input
                type="checkbox"
                checked={blocked}
                onChange={(e) => setBlocked(e.target.checked)}
              />
              <span>Blocked</span>
            </label>
          </div>

          <label className="tasks-field tasks-field--full">
            <span>Next step</span>
            <textarea
              rows={2}
              placeholder="What's the single next thing needed to move this forward?"
              value={nextStep}
              onChange={(e) => setNextStep(e.target.value)}
            />
          </label>

          <label className="tasks-field tasks-field--full">
            <span>Progress comment</span>
            <textarea
              rows={3}
              placeholder="One-line status update. This gets timestamped and feeds the burndown chart."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>

          {error && <p className="tasks-drawer-error">{error}</p>}

          <div className="tasks-drawer-actions">
            <button
              type="button"
              className="roadmap-btn roadmap-btn--ghost"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="roadmap-btn roadmap-btn--primary"
              onClick={save}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save update"}
            </button>
          </div>
        </>
      )}

      {series && (
        <section className="tasks-drawer-chart">
          <h3>
            {row.hasChildren ? "Rollup burndown" : "Task burndown"}
          </h3>
          <BurndownChart series={series} compact />
        </section>
      )}

      <section className="tasks-drawer-history">
        <h3>History</h3>
        {loadingSnapshots ? (
          <p className="tasks-muted">Loading…</p>
        ) : snapshots.length === 0 ? (
          <p className="tasks-muted">No snapshots yet. Save one above.</p>
        ) : (
          <ol className="tasks-snapshot-list">
            {snapshots.map((s) => (
              <SnapshotRow
                key={s.id}
                snap={s}
                taskId={row.id}
                onDeleted={(deletedId, nextState) => {
                  onSnapshotDeleted(deletedId, nextState);
                  router.refresh();
                }}
              />
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

// A single history row with a trash button. Pulled out so the delete
// request, its pending state, and the confirm dialog all live in one
// spot — keeping the list render above focused on layout.
function SnapshotRow({
  snap,
  taskId,
  onDeleted,
}: {
  snap: TaskSnapshot;
  taskId: string;
  onDeleted: (
    deletedId: string,
    nextState: {
      progress: number;
      status: TaskRow["status"];
      health: TaskRow["health"];
      blocked: boolean;
      remainingEffort: number | null;
    } | null,
  ) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (busy) return;
    const ok = window.confirm(
      "Delete this update? It will disappear from the history and the burndown chart.",
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/updates/${snap.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => ({}))) as {
        nextTaskState?: {
          progress: number;
          status: TaskRow["status"];
          health: TaskRow["health"];
          blocked: boolean;
          remainingEffort: number | null;
        } | null;
      };
      onDeleted(snap.id, body.nextTaskState ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  return (
    <li
      className={"tasks-snapshot" + (busy ? " tasks-snapshot--busy" : "")}
    >
      <div className="tasks-snapshot-meta">
        <time>{fmtDateTime(new Date(snap.createdAt))}</time>
        <span className="tasks-snapshot-numbers">
          {snap.progress ?? 0}%
          {snap.remainingEffort != null
            ? ` · ${snap.remainingEffort}h left`
            : ""}
        </span>
        <HealthDot health={(snap.health as TaskRow["health"]) ?? null} />
        <button
          type="button"
          className="tasks-snapshot-delete"
          onClick={remove}
          disabled={busy}
          aria-label="Delete this update"
          title="Delete this update"
        >
          {busy ? "…" : "✕"}
        </button>
      </div>
      {snap.comment && <p>{snap.comment}</p>}
      {error && <p className="tasks-snapshot-error">{error}</p>}
    </li>
  );
}

// ---------- Owner chip + autocomplete picker ----------

// Exported so workstream-client.tsx (and anything else inside /tasks) can
// reuse the exact same picker behavior. Keeping one implementation means
// the "legacy" tagging, freeform-add flow, and keyboard handling stay
// consistent across surfaces.
export function initialsOf(name: string | null): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  return (
    trimmed
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s.charAt(0).toUpperCase())
      .join("") || "?"
  );
}

export function OwnerChip({
  assignee,
  allocations,
  onClick,
  saving,
}: {
  assignee: string | null;
  /** Optional: when a percent split is persisted we show a "split" badge
   *  and use the allocation list to build the hover title so the user
   *  sees Alice 60% / Bob 40% without opening the picker. */
  allocations?: Array<{ name: string; percent: number }> | null;
  onClick: () => void;
  saving: boolean;
}) {
  const has = !!(assignee && assignee.trim());
  const splitNames = allocations && allocations.length > 1 ? allocations : null;
  const displayLabel = saving
    ? "Saving…"
    : splitNames
      ? `${splitNames.length} owners · split`
      : has
        ? (assignee as string)
        : "Unassigned";
  const titleText = splitNames
    ? splitNames.map((a) => `${a.name} — ${a.percent}%`).join("\n")
    : has
      ? `Owner: ${assignee}`
      : "Assign owners";
  return (
    <button
      type="button"
      className={
        "tasks-owner-chip" + (has ? "" : " tasks-owner-chip--empty")
      }
      onClick={onClick}
      disabled={saving}
      title={titleText}
    >
      <span className="tasks-owner-chip__avatar" aria-hidden>
        {splitNames ? splitNames.length : initialsOf(assignee)}
      </span>
      <span className="tasks-owner-chip__name">{displayLabel}</span>
      <span className="tasks-owner-chip__chev" aria-hidden>
        ▾
      </span>
    </button>
  );
}

export function OwnerPicker({
  people,
  currentAssignee,
  onSelect,
  onClose,
}: {
  people: PersonOption[];
  currentAssignee: string | null;
  onSelect: (name: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? people.filter((p) => p.name.toLowerCase().includes(q))
    : people;
  // Surface an "Add as new owner" row when the query doesn't match any
  // existing name. This lets the user type someone who isn't in the roster
  // yet without bouncing them out to the People page.
  const exact = people.some((p) => p.name.toLowerCase() === q);
  const canCreate = q.length > 0 && !exact;

  return (
    <div ref={rootRef} className="tasks-owner-picker" role="dialog">
      <input
        ref={inputRef}
        type="text"
        className="tasks-owner-picker__input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search or type a new owner…"
      />
      <ul className="tasks-owner-picker__list">
        <li>
          <button
            type="button"
            className={
              "tasks-owner-picker__row tasks-owner-picker__row--clear" +
              (!currentAssignee ? " tasks-owner-picker__row--current" : "")
            }
            onClick={() => onSelect(null)}
          >
            <span className="tasks-owner-picker__avatar" aria-hidden>
              —
            </span>
            <span className="tasks-owner-picker__name">Unassigned</span>
          </button>
        </li>
        {filtered.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className={
                "tasks-owner-picker__row" +
                (currentAssignee === p.name
                  ? " tasks-owner-picker__row--current"
                  : "") +
                (!p.active ? " tasks-owner-picker__row--inactive" : "")
              }
              onClick={() => onSelect(p.name)}
            >
              <span className="tasks-owner-picker__avatar" aria-hidden>
                {initialsOf(p.name)}
              </span>
              <span className="tasks-owner-picker__meta">
                <span className="tasks-owner-picker__name">{p.name}</span>
                {p.role && (
                  <span className="tasks-owner-picker__role">{p.role}</span>
                )}
              </span>
              {p.source === "freeform" && (
                <span
                  className="tasks-owner-picker__tag"
                  title="Used on a task but not in the roster"
                >
                  legacy
                </span>
              )}
              {!p.active && (
                <span className="tasks-owner-picker__tag">inactive</span>
              )}
            </button>
          </li>
        ))}
        {canCreate && (
          <li>
            <button
              type="button"
              className="tasks-owner-picker__row tasks-owner-picker__row--new"
              onClick={() => onSelect(query.trim())}
            >
              <span className="tasks-owner-picker__avatar" aria-hidden>
                +
              </span>
              <span className="tasks-owner-picker__name">
                Assign to &ldquo;{query.trim()}&rdquo;
              </span>
            </button>
          </li>
        )}
        {!canCreate && filtered.length === 0 && (
          <li className="tasks-owner-picker__empty">No matches.</li>
        )}
      </ul>
    </div>
  );
}

// ---------- helpers ----------

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// Mirrors burndown-chart.tsx — leaves without an explicit estimate
// contribute 0 so this column agrees with the burndown total and with
// the resource-matrix capacity numbers.
function effortOfTask(task: BurndownTaskInput): number {
  return task.effortHours && task.effortHours > 0 ? task.effortHours : 0;
}

function remainingNowAtLeaf(
  task: BurndownTaskInput,
  snapshots: BurndownSnapshotInput[],
): number {
  // Same precedence as burndown-chart.tsx for "now":
  //   1) latest snapshot remainingEffort
  //   2) derive from current task.progress and effort
  const stateSnaps = snapshots.filter(
    (s) => s.remainingEffort != null || s.progress != null,
  );
  const latest = stateSnaps.length ? stateSnaps[stateSnaps.length - 1] : null;
  if (latest?.remainingEffort != null) return Math.max(0, latest.remainingEffort);
  return Math.max(0, effortOfTask(task) * (1 - clamp(task.progress, 0, 100) / 100));
}

function buildRemainingNowByTaskId(
  tasks: BurndownTaskInput[],
  snapshots: BurndownSnapshotInput[],
): Map<string, number> {
  const taskById = new Map(tasks.map((t) => [t.id, t] as const));
  const childrenByParent = new Map<string | null, BurndownTaskInput[]>();
  for (const t of tasks) {
    const arr = childrenByParent.get(t.parentId) ?? [];
    arr.push(t);
    childrenByParent.set(t.parentId, arr);
  }
  const snapsByTask = new Map<string, BurndownSnapshotInput[]>();
  for (const s of snapshots) {
    const arr = snapsByTask.get(s.taskId) ?? [];
    arr.push(s);
    snapsByTask.set(s.taskId, arr);
  }
  for (const arr of snapsByTask.values()) {
    arr.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  const out = new Map<string, number>();
  const walking = new Set<string>();
  const visit = (id: string): number => {
    const cached = out.get(id);
    if (cached != null) return cached;
    if (walking.has(id)) return 0;
    walking.add(id);

    const task = taskById.get(id);
    if (!task) {
      walking.delete(id);
      return 0;
    }
    const kids = childrenByParent.get(id) ?? [];
    const value =
      kids.length === 0
        ? remainingNowAtLeaf(task, snapsByTask.get(id) ?? [])
        : kids.reduce((sum, k) => sum + visit(k.id), 0);
    out.set(id, value);
    walking.delete(id);
    return value;
  };

  for (const t of tasks) visit(t.id);
  return out;
}

function formatHours(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function fmtDate(d: Date) {
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtDateTime(d: Date) {
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtRelative(d: Date) {
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
