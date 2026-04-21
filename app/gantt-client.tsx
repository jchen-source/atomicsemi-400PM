"use client";

import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import "@svar-ui/react-gantt/all.css";
import "./gantt-theme.css";
import { AllocationPicker } from "./tasks/allocation-picker";

/**
 * Parse the JSON-encoded percent split stored on a task. We accept both
 * null and malformed rows without crashing the render — the picker will
 * just show the legacy single-owner path in that case. Kept inline in
 * the Gantt module so we don't pull more of the /tasks client tree into
 * this file.
 */
function parseAllocationsJSON(
  raw: string | null | undefined,
): Array<{ name: string; percent: number }> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Array<{ name?: unknown; percent?: unknown }>;
    if (!Array.isArray(parsed)) return null;
    const rows = parsed
      .map((r) => ({
        name: typeof r.name === "string" ? r.name.trim() : "",
        percent: typeof r.percent === "number" ? r.percent : 0,
      }))
      .filter((r) => r.name && r.percent > 0);
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

// We dynamically import every SVAR component with ssr:false so Next's server
// renderer doesn't try to reach into the client-only library.
const Gantt = dynamic(
  () => import("@svar-ui/react-gantt").then((m) => ({ default: m.Gantt })),
  { ssr: false },
);
const Willow = dynamic(
  () => import("@svar-ui/react-gantt").then((m) => ({ default: m.Willow })),
  { ssr: false },
);
const WillowDark = dynamic(
  () =>
    import("@svar-ui/react-gantt").then((m) => ({ default: m.WillowDark })),
  { ssr: false },
);

export type GanttTaskInput = {
  id: string;
  text: string;
  start: string;
  end: string;
  depsLabel?: string;
  depsCount?: number;
  progress: number;
  parent: string | null;
  open?: boolean;
  type: "summary" | "task";
  rowType: "EPIC" | "TASK" | "ISSUE";
  urgency?: "high" | "medium" | "low";
  /**
   * Cached task health from the last progress snapshot. Renders as a
   * thin colored rail on the left of the bar so slipping work surfaces
   * at a glance in addition to its urgency color.
   */
  health?: "green" | "yellow" | "red" | null;
  effortHours?: number | null;
  assignee?: string | null;
  resourceAllocated?: string | null;
  /** JSON-encoded per-person percent split; null/missing falls back to
   *  legacy single-owner behavior. */
  allocations?: string | null;
};

export type GanttLinkInput = {
  id: string;
  source: string;
  target: string;
  type: "e2s" | "s2s" | "e2e" | "s2e";
};

const LINK_TYPE_TO_DEP: Record<
  GanttLinkInput["type"],
  "FS" | "SS" | "FF" | "SF"
> = { e2s: "FS", s2s: "SS", e2e: "FF", s2e: "SF" };

function daysBetween(a: Date, b: Date) {
  return Math.max(
    1,
    Math.round(
      (new Date(b).setHours(0, 0, 0, 0) -
        new Date(a).setHours(0, 0, 0, 0)) /
        86400000,
    ),
  );
}

type GanttTaskRuntime = Omit<GanttTaskInput, "start" | "end" | "parent"> & {
  start: Date;
  end: Date;
  duration: number;
  parent?: string;
  /** Seed whether a parent row opens expanded on first render. */
  open?: boolean;
};

type ZoomLevel = "day" | "week" | "month" | "quarter";

function fmtMonthDay(date: Date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtMonthYear(date: Date) {
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

function fmtYear(date: Date) {
  return date.toLocaleDateString(undefined, { year: "numeric" });
}

// ---------------------------------------------------------------------------
// Gantt bar label helpers
// ---------------------------------------------------------------------------
// Domain-specific abbreviation table for hardware / fab tooling names.
// Ordered longest-first so multi-word terms are matched before any of
// their component words. Extend this list as new tool categories show
// up in the Notion import.
const TASK_TERM_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bAtomic Layer Deposition\b/gi, "ALD"],
  [/\bRapid Thermal Processing\b/gi, "RTP"],
  [/\bReactive Ion Etching\b/gi, "RIE"],
  [/\bWafer Automated Delivery\b/gi, "WAD"],
  [/\bMachine Vision\b/gi, "MV"],
  [/\bMagnetron Sputtering\b/gi, "Sputter"],
  [/\bOzone Generator\b/gi, "Ozone Gen"],
  [/\bPick and Place(?: System)?\b/gi, "Pick & Place"],
  [/\bSpinal Column\b/gi, "Spine"],
  [/\bInspection\b/gi, "Insp"],
  [/\bEllipsometer\b/gi, "ELPS"],
];

// Repetitive "workstream :" prefixes that are already obvious from the
// row's hierarchy context. Strip them so the bar text focuses on what's
// actually unique.
const REDUNDANT_PREFIX_RE =
  /^(?:Tool Delivery|Cube Delivery|Tool Procurement|Cube Procurement|Delivery)\s*[:\-–]\s*/i;

// Turn a raw task title into a compact display label by stripping
// redundant prefixes, applying known abbreviations, and collapsing any
// parenthetical that just restates the abbreviation. Pure + memoizable.
export function formatTaskDisplayLabel(raw: string): string {
  if (!raw) return "";
  let s = raw.trim().replace(REDUNDANT_PREFIX_RE, "");
  for (const [re, sub] of TASK_TERM_ABBREVIATIONS) s = s.replace(re, sub);
  // After abbreviation, "ALD (ALD)" / "RTP (RTP)" are common. Drop the
  // parenthetical if its contents appear anywhere in the non-paren part.
  s = s.replace(/\s*\(([^()]+)\)/g, (_m, inner) => {
    const token = String(inner).trim().toUpperCase();
    const outside = s.replace(/\s*\([^()]+\)/g, "").toUpperCase();
    return outside.includes(token) ? "" : ` (${inner})`;
  });
  return s.replace(/\s+/g, " ").trim();
}

// Bar-width thresholds that drive the responsive label. Exposed as a
// named const so they're easy to tweak in one place.
const LABEL_WIDTH_THRESHOLDS = {
  /** Under this many pixels: don't render any label, just the % chip. */
  hide: 34,
  /** Under this many pixels: strip parentheticals / trailing qualifiers. */
  compact: 110,
} as const;

// Given the compact display label and the live bar width, return the
// string that should actually render inside the bar.
export function getVisibleBarLabel(
  displayLabel: string,
  barWidthPx: number,
): string {
  if (!displayLabel) return "";
  if (barWidthPx < LABEL_WIDTH_THRESHOLDS.hide) return "";
  if (barWidthPx < LABEL_WIDTH_THRESHOLDS.compact) {
    // Keep only the leading chunk before the first separator — usually
    // just the abbreviation + count (e.g. "ALD x4").
    return displayLabel.split(/\s+[(:–-]/)[0].trim();
  }
  return displayLabel;
}

function fmtTipDate(raw: unknown): string {
  if (!raw) return "—";
  const d = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Given a total span (in days) across all tasks, pick the zoom level
// that lets the whole project fit on screen without being cramped or
// empty. Thresholds are tuned so that day-level is used for a sprint,
// week for a quarter, month for a year, and quarter for multi-year
// programs. Mirrors the "Fit" button logic below.
function pickZoomForSpanDays(days: number): ZoomLevel {
  if (!Number.isFinite(days) || days <= 0) return "week";
  if (days <= 21) return "day";
  if (days <= 120) return "week";
  if (days <= 540) return "month";
  return "quarter";
}

const ZOOM_SCALES: Record<
  ZoomLevel,
  Array<{ unit: string; step: number; format: (date: Date) => string }>
> = {
  day: [
    { unit: "month", step: 1, format: fmtMonthYear },
    { unit: "day", step: 1, format: fmtMonthDay },
  ],
  week: [
    { unit: "year", step: 1, format: fmtYear },
    { unit: "week", step: 1, format: fmtMonthDay },
  ],
  month: [
    { unit: "year", step: 1, format: fmtYear },
    { unit: "month", step: 1, format: fmtMonthYear },
  ],
  quarter: [
    { unit: "year", step: 1, format: fmtYear },
    {
      unit: "quarter",
      step: 1,
      format: (date: Date) => `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`,
    },
  ],
};

export default function GanttClient({
  tasks,
  links,
  emptyState,
  issueIndicatorByTaskId = {},
  openIssueCountByTaskId = {},
}: {
  tasks: GanttTaskInput[];
  links: GanttLinkInput[];
  emptyState?: React.ReactNode;
  /**
   * Per-task indicator state, computed server-side from linked open
   * issues. "active" = has active issues but none confirmed to slip,
   * "slipping" = at least one issue reports a schedule slip,
   * "resolved" = all linked issues were recently resolved (we fade
   * this out on the client after a short period).
   */
  issueIndicatorByTaskId?: Record<string, "active" | "slipping" | "resolved">;
  /**
   * Per-task rollup of open issues. `direct` is the number of active
   * issues linked directly to this task; `rollup` is self + every
   * descendant (so a workstream shows the total nested beneath it).
   * Rendered as a visible "N open" badge on the bar.
   */
  openIssueCountByTaskId?: Record<string, { direct: number; rollup: number }>;
}) {
  const router = useRouter();
  const apiRef = useRef<{
    exec: (action: string, payload: unknown) => void;
    on: (action: string, cb: (data: unknown) => boolean | void) => void;
  } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const suppressUpdateIds = useRef(new Set<string>());
  const inFlightIds = useRef(new Set<string>());
  const linkIdAlias = useRef(new Map<string, string>());
  const knownTaskState = useRef(
    new Map<
      string,
      {
        text: string;
        progress: number;
        startMs: number;
        endMs: number;
        effortHours: number | null;
      }
    >(),
  );
  const [status, setStatus] = useState<string>("");
  // Pick the zoom that fits the entire project into the timeline on
  // first paint. Without this, new users land on "week" and see the
  // chart end mid-way, which reads as "dates take forever to populate"
  // because they have to scroll/zoom to see the rest.
  const [zoom, setZoom] = useState<ZoomLevel>(() => {
    if (!tasks.length) return "week";
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const t of tasks) {
      const s = new Date(t.start).getTime();
      const e = new Date(t.end).getTime();
      if (Number.isFinite(s) && s < minMs) minMs = s;
      if (Number.isFinite(e) && e > maxMs) maxMs = e;
    }
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return "week";
    return pickZoomForSpanDays((maxMs - minMs) / 86_400_000);
  });
  const [dark, setDark] = useState(false);
  const [depEditorTaskId, setDepEditorTaskId] = useState<string | null>(null);
  const [depEditorQuery, setDepEditorQuery] = useState("");
  const [depEditorSelected, setDepEditorSelected] = useState<string[]>([]);
  const [depEditorSaving, setDepEditorSaving] = useState(false);
  // Parent-picker state: lets the user re-home any task under another
  // task (or move it to top level) without dragging. An array because
  // the picker also handles bulk moves (select many rows, then Move under
  // parent… from the context menu or the hover icon).
  const [parentEditorIds, setParentEditorIds] = useState<string[]>([]);
  const [parentEditorQuery, setParentEditorQuery] = useState("");
  const [parentEditorSaving, setParentEditorSaving] = useState(false);

  // Multi-select: shift-click extends a contiguous range from the last
  // anchor; cmd/ctrl-click toggles an individual row; plain click on the
  // drag grip selects just that row. Selection drives bulk drag-to-reparent
  // and bulk context-menu actions.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);
  const selectAnchorIdRef = useRef<string | null>(null);

  // Critical-path focus. When the user clicks a bar (any level), we
  // compute the chain of predecessors (+ that bar's own ancestors,
  // so the workstream rolls up with the chain) that most constrains
  // its start date, and paint them in red. Clicking empty space or
  // pressing Esc clears the focus.
  const [criticalPathTargetId, setCriticalPathTargetId] = useState<
    string | null
  >(null);
  const criticalPathTargetIdRef = useRef<string | null>(null);
  useEffect(() => {
    criticalPathTargetIdRef.current = criticalPathTargetId;
  }, [criticalPathTargetId]);

  // Mirror of each parent row's open/closed state. Populated from
  // SVAR's `open-task` events so the in-bar chevron (rendered by
  // TaskTemplate) can point the right direction even when another
  // code path toggled the row (e.g. Expand all, critical-path auto
  // expand, keyboard shortcut).
  const openByIdRef = useRef<Map<string, boolean>>(new Map());

  // Task IDs that were just created but haven't been placed yet. Their
  // bars render as faded "ghost" pills and clicking anywhere in the
  // timeline on that row snaps the bar to the click's date. Client-only
  // state — if the user refreshes before placing, the task simply keeps
  // its default dates and can still be repositioned by dragging the
  // bar like any other task.
  const [needsPlacementIds, setNeedsPlacementIds] = useState<Set<string>>(
    () => new Set(),
  );
  const needsPlacementIdsRef = useRef(needsPlacementIds);
  useEffect(() => {
    needsPlacementIdsRef.current = needsPlacementIds;
  }, [needsPlacementIds]);

  // Floating right-click menu anchored at the cursor. `scope` captures
  // the target row ids at open time so bulk actions keep working even if
  // the user shifts the selection while the menu is mounted.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    taskId: string;
    scope: string[];
  } | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  // Roster for the Resources column dropdown. Fetched once on mount so
  // every task's picker shows the same canonical list of contributors
  // without re-hitting the API per open.
  const [people, setPeople] = useState<
    Array<{ id: string; name: string; role: string | null; active: boolean }>
  >([]);
  const [resourcePicker, setResourcePicker] = useState<
    | { taskId: string; anchor: { top: number; left: number; width: number } }
    | null
  >(null);
  const [resourceQuery, setResourceQuery] = useState("");

  // Floating "quick edit" popover opened by double-clicking a bar in
  // the timeline. Anchored to the bar's client rect and closed by
  // Escape / outside click / explicit Save.
  const [barEditor, setBarEditor] = useState<
    | { taskId: string; anchor: { top: number; left: number; width: number } }
    | null
  >(null);
  const [savedTick, setSavedTick] = useState(0);

  // Full-chart mode: hides the left-side task table so the timeline
  // gets the whole frame. Purely a CSS toggle on the frame wrapper —
  // doesn't touch SVAR's columns prop, so we avoid re-initializing the
  // chart and losing user state (scroll position, opened rows, etc).
  const [chartOnly, setChartOnly] = useState(false);

  // Task search. `searchOpen` toggles the inline input in the toolbar;
  // `searchQuery` is the live text. Matches are applied to rows via a
  // DOM effect so we don't have to rebuild the tasks array (which would
  // re-init SVAR and flash the chart).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Notion-style filter menu on the Gantt toolbar. Lets the user hide
  // whole programs/workstreams (and their subtrees), and hide tasks by
  // urgency. Hidden subtrees are fully removed from the Gantt data, so
  // SVAR doesn't render any orphaned links or dangling children.
  const [filterOpen, setFilterOpen] = useState(false);
  const [hiddenSubtreeIds, setHiddenSubtreeIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [hiddenUrgencies, setHiddenUrgencies] = useState<
    Set<"high" | "medium" | "low">
  >(() => new Set());
  const filterMenuRef = useRef<HTMLDivElement | null>(null);

  // Close the filter popover on outside click / Escape.
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (ev: MouseEvent) => {
      const el = filterMenuRef.current;
      if (!el) return;
      if (el.contains(ev.target as Node)) return;
      setFilterOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  // Undo stack. Each entry knows how to reverse a user-visible mutation
  // (patch a task back to prior values, recreate a deleted link, etc.).
  // We hold the stack in a ref so pushes don't trigger renders — a
  // separate tick state re-renders the Undo button when its enabled
  // state changes.
  type UndoAction = { label: string; run: () => Promise<void> | void };
  const undoStackRef = useRef<UndoAction[]>([]);
  const [undoTick, setUndoTick] = useState(0);
  const isUndoingRef = useRef(false);
  const bumpUndoTick = () => setUndoTick((n) => (n + 1) & 0xfffffff);
  const pushUndo = (a: UndoAction) => {
    if (isUndoingRef.current) return;
    undoStackRef.current.push(a);
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    bumpUndoTick();
  };
  const undoLastRef = useRef<() => Promise<void>>(async () => {});

  const [deleteModal, setDeleteModal] = useState<{
    id: string;
    title: string;
    childCount: number;
  } | null>(null);

  // Refresh "last saved" label every 15s so the relative time stays accurate.
  useEffect(() => {
    const t = setInterval(() => setSavedTick((v) => v + 1), 15000);
    return () => clearInterval(t);
  }, []);

  // Fetch the contributor roster once. The People page also triggers
  // the default-seed flow server-side on first visit; here we just read
  // whatever's in the database so the dropdown reflects the same list
  // users see on /people.
  useEffect(() => {
    let alive = true;
    fetch("/api/people")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!alive) return;
        if (Array.isArray(data)) {
          setPeople(
            data.filter(
              (p: { active?: boolean }) => p?.active !== false,
            ) as typeof people,
          );
        }
      })
      .catch(() => {
        /* roster is non-critical; the column just shows empty */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function markSaved() {
    setLastSavedAt(Date.now());
  }

  // Debounced server resync. Used by commit paths that update SVAR's
  // internal store directly (inline cell edits) so that derived data
  // from the server prop (levelById / urgencyById / depsByDependent /
  // rollups) eventually catches up without hammering the server on
  // every keystroke. Rapid consecutive edits coalesce into a single
  // refresh after the user stops typing.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleServerSync = () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      router.refresh();
    }, 350);
  };
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // Cmd/Ctrl+Z runs the top of the undo stack. The actual run fn is
  // held in a ref so it can close over current values without us
  // needing to reattach the listener on every render.
  undoLastRef.current = async () => {
    const a = undoStackRef.current.pop();
    bumpUndoTick();
    if (!a) {
      setStatus("Nothing to undo.");
      setTimeout(() => setStatus(""), 1200);
      return;
    }
    isUndoingRef.current = true;
    setStatus(`Undoing: ${a.label}…`);
    try {
      await a.run();
      markSaved();
      setStatus("Undone.");
      setTimeout(() => setStatus(""), 1200);
    } catch (err) {
      setStatus(err instanceof Error ? `Undo failed: ${err.message}` : "Undo failed");
      setTimeout(() => setStatus(""), 2400);
    } finally {
      isUndoingRef.current = false;
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isZ = e.key === "z" || e.key === "Z";
      if (!isZ) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return; // reserve shift-Z for redo (future)
      const t = e.target as HTMLElement | null;
      // Don't hijack undo inside a focused text input / contenteditable —
      // the user expects the browser's native text-edit undo there.
      if (t) {
        const tag = t.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          t.isContentEditable
        ) {
          return;
        }
      }
      e.preventDefault();
      void undoLastRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cmd/Ctrl+F opens the inline task search. We only hijack the
  // browser's find shortcut when focus is inside the roadmap wrapper
  // so the user can still page-search elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      const wrap = frameRef.current;
      if (!wrap) return;
      const active = document.activeElement as HTMLElement | null;
      const insideRoadmap = active ? wrap.contains(active) : false;
      // Also trigger if nothing's focused (common state after a click
      // on the chart): the user clearly wants to find a task here.
      const noFocus = !active || active === document.body;
      if (!insideRoadmap && !noFocus) return;
      e.preventDefault();
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Shared commit path for the inline single-click cell editors. Cells are
  // intentionally referentially stable (see TaskNameCell notes) so they
  // call through this ref instead of closing over the latest handler.
  // Wiring is populated below once patchTask / applyAffected are defined.
  const commitInlineEditRef = useRef<
    (id: string, payload: Record<string, unknown>) => Promise<void>
  >(async () => {});

  // Registry of open-editor callbacks keyed by `${rowId}:${field}`. Every
  // InlineEditable registers its `setEditing(true)` here on mount and
  // cleans up on unmount. The frame-level pointer handler uses this to
  // toggle a cell into edit mode without depending on the native click
  // event firing — browsers can silently drop clicks that land on text
  // inside a draggable ancestor, which was the root cause of the
  // “sometimes I can’t edit the task name” bug.
  const editorOpenersRef = useRef<Map<string, () => void>>(new Map());

  // Size the Task column once, on initial mount, to fit the longest task
  // name that actually ships with the page. Locked in via useState
  // initializer so later edits don't reflow the column under the user.
  // They can still drag-resize it manually afterward.
  const [taskColumnWidth] = useState<number>(() =>
    computeInitialTaskColumnWidth(tasks),
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setDark(mq.matches);
    const listener = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  // Expand the "visible filter" state into the actual set of task ids
  // that should be hidden: uncheck a program → hide its entire subtree;
  // hide urgency=high → hide every task tagged high (and its subtree,
  // so no child bars dangle underneath a missing parent).
  const filterHiddenIds = useMemo(() => {
    const childrenByParent = new Map<string, string[]>();
    for (const t of tasks) {
      if (!t.parent) continue;
      const arr = childrenByParent.get(t.parent) ?? [];
      arr.push(t.id);
      childrenByParent.set(t.parent, arr);
    }
    const hidden = new Set<string>();
    const addSubtree = (rootId: string) => {
      const queue = [rootId];
      while (queue.length) {
        const cur = queue.shift()!;
        if (hidden.has(cur)) continue;
        hidden.add(cur);
        const kids = childrenByParent.get(cur) ?? [];
        queue.push(...kids);
      }
    };
    for (const id of hiddenSubtreeIds) addSubtree(id);
    if (hiddenUrgencies.size > 0) {
      for (const t of tasks) {
        if (t.urgency && hiddenUrgencies.has(t.urgency)) addSubtree(t.id);
      }
    }
    return hidden;
  }, [tasks, hiddenSubtreeIds, hiddenUrgencies]);

  const initialTasks: GanttTaskRuntime[] = useMemo(() => {
    // Compute "has children" locally rather than reading
    // `childCountById` (declared below) — avoids a temporal-dead-zone
    // reference during render.
    const parentIds = new Set<string>();
    for (const t of tasks) {
      if (t.parent) parentIds.add(t.parent);
    }
    return tasks
      .filter((t) => !filterHiddenIds.has(t.id))
      .map((t) => {
        const s = new Date(t.start);
        const e = new Date(t.end);
        // Seed every parent row as open so the chevron on the bar
        // matches SVAR's initial state. Otherwise the very first
        // render has our chevron pointing "expanded" while SVAR
        // shows the row collapsed, and the first click appears to
        // do nothing.
        const hasChildren = parentIds.has(t.id);
        return {
          ...t,
          parent: t.parent ?? undefined,
          start: s,
          end: e,
          duration: daysBetween(s, e),
          ...(hasChildren ? { open: true } : {}),
        };
      });
  }, [tasks, filterHiddenIds]);

  // SVAR will warn / misrender if a link references a hidden task, so
  // drop any link whose source or target has been filtered out.
  const visibleLinks = useMemo(
    () =>
      filterHiddenIds.size === 0
        ? links
        : links.filter(
            (l) =>
              !filterHiddenIds.has(l.source) &&
              !filterHiddenIds.has(l.target),
          ),
    [links, filterHiddenIds],
  );

  // Explicit timeline range so SVAR renders the entire date scale up
  // front instead of lazily filling in ticks as the user scrolls — the
  // old behavior looked like "dates take a while to populate".
  //
  // Padding is asymmetric on purpose:
  //   - Left: 2 weeks, just enough breathing room before the earliest
  //     bar and the today-line.
  //   - Right: 6 months, so users can always scroll into the future
  //     to drop in planning tasks, even when no bar lives there yet.
  //     (Previously we padded by only 2 weeks on both sides, which
  //     made the timeline feel like it "ended" at the last bar.)
  const dateRange = useMemo<{ start: Date; end: Date } | null>(() => {
    if (!tasks.length) return null;
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const t of tasks) {
      const s = new Date(t.start).getTime();
      const e = new Date(t.end).getTime();
      if (Number.isFinite(s) && s < minMs) minMs = s;
      if (Number.isFinite(e) && e > maxMs) maxMs = e;
    }
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null;
    // Always include "today" so the red Today line has somewhere to
    // live even on projects that haven't started yet or are finished.
    const nowMs = Date.now();
    minMs = Math.min(minMs, nowMs);
    maxMs = Math.max(maxMs, nowMs);
    const dayMs = 86_400_000;
    const leftPad = 14 * dayMs;
    const rightPad = 183 * dayMs; // ~6 months of scrollable headroom
    return {
      start: new Date(minMs - leftPad),
      end: new Date(maxMs + rightPad),
    };
  }, [tasks]);

  useEffect(() => {
    const next = new Map<
      string,
      {
        text: string;
        progress: number;
        startMs: number;
        endMs: number;
        effortHours: number | null;
      }
    >();
    for (const t of tasks) {
      next.set(t.id, {
        text: t.text,
        progress: Number(t.progress ?? 0),
        startMs: new Date(t.start).getTime(),
        endMs: new Date(t.end).getTime(),
        effortHours: t.effortHours == null ? null : Number(t.effortHours),
      });
    }
    knownTaskState.current = next;
  }, [tasks]);

  const scales = useMemo(() => ZOOM_SCALES[zoom], [zoom]);

  const depsByDependent = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const l of links) {
      const arr = map.get(l.target) ?? [];
      arr.push(l.source);
      map.set(l.target, arr);
    }
    return map;
  }, [links]);

  const levelById = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const cache = new Map<string, number>();
    const depthOf = (id: string): number => {
      if (cache.has(id)) return cache.get(id)!;
      const t = byId.get(id);
      if (!t || !t.parent) {
        cache.set(id, 0);
        return 0;
      }
      const d = 1 + depthOf(t.parent);
      cache.set(id, d);
      return d;
    };
    for (const t of tasks) depthOf(t.id);
    return cache;
  }, [tasks]);

  const urgencyById = useMemo(() => {
    const map = new Map<string, "high" | "medium" | "low">();
    for (const t of tasks) map.set(t.id, t.urgency ?? "medium");
    return map;
  }, [tasks]);

  // Cached health (green / yellow / red) keyed by task id. Populated from
  // `Task.health` server-side. Rendered as a thin left-side rail on the bar
  // so the visual hierarchy of urgency (bar color) and health (rail) stays
  // readable instead of fighting each other.
  const healthById = useMemo(() => {
    const map = new Map<string, "green" | "yellow" | "red">();
    for (const t of tasks) {
      if (t.health === "green" || t.health === "yellow" || t.health === "red") {
        map.set(t.id, t.health);
      }
    }
    return map;
  }, [tasks]);

  const childCountById = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (!t.parent) continue;
      map.set(t.parent, (map.get(t.parent) ?? 0) + 1);
    }
    return map;
  }, [tasks]);

  // DFS traversal of the tree in the order rows appear in the grid. We
  // need this for shift-click range selection — the anchor row and the
  // clicked row bracket a contiguous slice of this list.
  const visualOrder = useMemo(() => {
    const childrenOf = new Map<string | null, typeof tasks>();
    for (const t of tasks) {
      const key = t.parent ?? null;
      const arr = childrenOf.get(key) ?? [];
      arr.push(t);
      childrenOf.set(key, arr);
    }
    const order: string[] = [];
    const visit = (parent: string | null) => {
      const kids = childrenOf.get(parent) ?? [];
      for (const k of kids) {
        order.push(k.id);
        visit(k.id);
      }
    };
    visit(null);
    return order;
  }, [tasks]);
  const visualOrderRef = useRef(visualOrder);
  useEffect(() => {
    visualOrderRef.current = visualOrder;
  }, [visualOrder]);

  // Mirror of `childCountById` held in a ref so memoized cell components
  // (EffortCell, DepsLabelCell, …) can read the current value without being
  // invalidated every time a single row changes.
  const childCountByIdRef = useRef(childCountById);
  useEffect(() => {
    childCountByIdRef.current = childCountById;
  }, [childCountById]);

  // Health rail lookup — see `healthById` above. Stored in a ref so the
  // memoized TaskTemplate picks up server-side health updates without a full
  // component reinstantiation.
  const healthByIdRef = useRef(healthById);
  useEffect(() => {
    healthByIdRef.current = healthById;
  }, [healthById]);

  // Row type (EPIC / TASK / ISSUE) by id. Read via a ref so every
  // task edit doesn't invalidate TaskTemplate.
  const rowTypeByIdRef = useRef<Map<string, "EPIC" | "TASK" | "ISSUE">>(
    new Map(),
  );
  useEffect(() => {
    const m = new Map<string, "EPIC" | "TASK" | "ISSUE">();
    for (const t of tasks) m.set(t.id, t.rowType);
    rowTypeByIdRef.current = m;
  }, [tasks]);

  // Same trick for depth. Previously TaskNameCell closed over `depthById`
  // directly which meant every task change re-created the cell component,
  // which re-created the `columns` array, which forced SVAR to fully
  // re-initialize the grid. That re-init occasionally rendered in a broken
  // state with only the first 3 columns (Task/Start/End) visible — a ref
  // mirror lets the cell read current depths without triggering any of
  // that churn.
  const depthByIdRef = useRef<Map<string, number>>(new Map());

  // Depth of each task in the hierarchy, used to label rows as
  // Program / Workstream / Task / Subtask.
  const depthById = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    const depths = new Map<string, number>();
    const resolve = (id: string, seen: Set<string>): number => {
      if (depths.has(id)) return depths.get(id)!;
      if (seen.has(id)) {
        depths.set(id, 0);
        return 0;
      }
      const task = byId.get(id);
      if (!task || !task.parent) {
        depths.set(id, 0);
        return 0;
      }
      seen.add(id);
      const d = resolve(task.parent, seen) + 1;
      depths.set(id, d);
      return d;
    };
    for (const t of tasks) resolve(t.id, new Set());
    return depths;
  }, [tasks]);

  useEffect(() => {
    depthByIdRef.current = depthById;
  }, [depthById]);

  // --- Critical path computation ---------------------------------
  // For a user-selected target, the "critical path" here is the
  // predecessor chain that most constrains its start date: at each
  // fork we follow the predecessor with the latest end date (the one
  // whose finish is actually pushing the target). We also include the
  // target's own ancestor chain so the workstream / program that the
  // path rolls up into visually lights up with it.
  const predecessorsByTaskId = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const l of links) {
      const arr = m.get(l.target) ?? [];
      arr.push(l.source);
      m.set(l.target, arr);
    }
    return m;
  }, [links]);

  const {
    criticalPathTaskIds,
    criticalPathLinkIds,
  }: { criticalPathTaskIds: Set<string>; criticalPathLinkIds: Set<string> } =
    useMemo(() => {
      const emptyTasks = new Set<string>();
      const emptyLinks = new Set<string>();
      const targetId = criticalPathTargetId;
      if (!targetId) {
        return {
          criticalPathTaskIds: emptyTasks,
          criticalPathLinkIds: emptyLinks,
        };
      }
      const byId = new Map(tasks.map((t) => [t.id, t] as const));
      if (!byId.has(targetId)) {
        return {
          criticalPathTaskIds: emptyTasks,
          criticalPathLinkIds: emptyLinks,
        };
      }

      const childrenByParent = new Map<string, string[]>();
      for (const t of tasks) {
        if (!t.parent) continue;
        const arr = childrenByParent.get(t.parent) ?? [];
        arr.push(t.id);
        childrenByParent.set(t.parent, arr);
      }

      const pathTasks = new Set<string>();
      const pathLinks = new Set<string>();

      // Greedy backward walk along the predecessor with the latest
      // end date — that's the predecessor most actively pushing the
      // start of the cursor, i.e. the critical edge.
      const walkBack = (startId: string) => {
        const seen = new Set<string>();
        let cursor: string | undefined = startId;
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor);
          pathTasks.add(cursor);
          const preds: string[] = predecessorsByTaskId.get(cursor) ?? [];
          if (preds.length === 0) break;
          let bestPred: string | null = null;
          let bestEndMs = -Infinity;
          for (const p of preds) {
            const pt = byId.get(p);
            if (!pt) continue;
            const endMs = new Date(pt.end).getTime();
            if (endMs > bestEndMs) {
              bestEndMs = endMs;
              bestPred = p;
            }
          }
          if (!bestPred) break;
          for (const l of links) {
            if (l.source === bestPred && l.target === cursor) {
              pathLinks.add(l.id);
              break;
            }
          }
          cursor = bestPred;
        }
      };

      const target = byId.get(targetId)!;
      const isParent = (childrenByParent.get(targetId)?.length ?? 0) > 0;

      // The clicked node's own subtree. Used below to scope the
      // ancestor walk: we explicitly do NOT light up the clicked
      // target's own parents — the user wants only the target, its
      // children, and the predecessor chain(s) that feed into it.
      const subtreeSet = new Set<string>([targetId]);

      if (isParent) {
        // Clicking a Program or Workstream: light up everything nested
        // under it + the chain of predecessors feeding into each leaf,
        // so the user sees "everything that has to happen to get us
        // here". Walk the subtree, collect all descendants, and run a
        // predecessor walk from each leaf descendant.
        const descendants: string[] = [];
        const queue: string[] = [targetId];
        while (queue.length) {
          const cur = queue.shift()!;
          descendants.push(cur);
          const kids = childrenByParent.get(cur) ?? [];
          queue.push(...kids);
        }
        for (const id of descendants) {
          pathTasks.add(id);
          subtreeSet.add(id);
        }
        // Include intra-subtree links (e.g. dependency arrows between
        // tasks inside the same program).
        for (const l of links) {
          if (subtreeSet.has(l.source) && subtreeSet.has(l.target)) {
            pathLinks.add(l.id);
          }
        }
        // Predecessor chains from every leaf descendant back toward
        // the project root.
        for (const id of descendants) {
          const isLeaf = (childrenByParent.get(id)?.length ?? 0) === 0;
          if (!isLeaf) continue;
          walkBack(id);
        }
      } else {
        // Leaf task: classic critical path = chain of predecessors.
        walkBack(targetId);
      }

      // Ancestor rollup — only for the feeder chain, not for the
      // clicked subtree itself. User request: "I dont want its parents
      // just its children and any parents that might feed into it".
      // We start from every path task that lives OUTSIDE the target's
      // subtree (i.e. a predecessor/feeder), then walk up, stopping
      // the moment we cross into the target's subtree so we never
      // climb past the clicked node into its own parents.
      const withAncestors = new Set<string>(pathTasks);
      for (const id of pathTasks) {
        if (subtreeSet.has(id)) continue;
        let p = byId.get(id)?.parent ?? null;
        while (p) {
          if (subtreeSet.has(p)) break;
          if (withAncestors.has(p)) break;
          withAncestors.add(p);
          p = byId.get(p)?.parent ?? null;
        }
      }

      // target is only used to pin target for type inference; keep for
      // clarity that we validated its existence above.
      void target;

      return {
        criticalPathTaskIds: withAncestors,
        criticalPathLinkIds: pathLinks,
      };
    }, [criticalPathTargetId, tasks, links, predecessorsByTaskId]);

  // When the user focuses a parent (Program/Workstream), auto-expand
  // every descendant parent so the whole red-highlighted subtree is
  // visible — matches the user expectation that "click on a program
  // and a workstream for all the children to auto open up".
  useEffect(() => {
    if (!criticalPathTargetId) return;
    const api = apiRef.current;
    if (!api) return;
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    const target = byId.get(criticalPathTargetId);
    if (!target) return;
    const childrenByParent = new Map<string, string[]>();
    for (const t of tasks) {
      if (!t.parent) continue;
      const arr = childrenByParent.get(t.parent) ?? [];
      arr.push(t.id);
      childrenByParent.set(t.parent, arr);
    }
    const isParent = (childrenByParent.get(criticalPathTargetId)?.length ?? 0) > 0;
    if (!isParent) return;
    const queue: string[] = [criticalPathTargetId];
    while (queue.length) {
      const cur = queue.shift()!;
      const kids = childrenByParent.get(cur) ?? [];
      if (kids.length === 0) continue;
      try {
        api.exec("open-task", { id: cur, mode: true });
      } catch {
        /* leaves aren't openable */
      }
      queue.push(...kids);
    }
  }, [criticalPathTargetId, tasks]);

  // Click a bar (any level) to focus its critical path. We deliberately
  // listen in the bubble phase so any interactive children in the bar
  // (drag handles, delete button, issue badge, open-editor hotspot) can
  // stop propagation and avoid triggering a focus.
  //
  // `.task-pill` sets `pointer-events: none` inline so SVAR can keep
  // owning drag/resize/link-create on the bar's surface — which means
  // click targets are almost always SVAR elements, not our pill. We
  // therefore resolve the clicked bar by looking for the nearest
  // `.wx-bar` ancestor and then digging back inside it for the
  // `data-bar-id` our TaskTemplate renders.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      // Don't steal clicks that landed in one of our own editors.
      if (
        target.closest(
          ".bar-quick-editor, .deps-modal, .deps-picker, .context-menu, .bq-editor",
        )
      )
        return;
      // Ignore clicks on interactive controls inside the bar — each
      // has its own handler and shouldn't hijack critical-path focus.
      if (
        target.closest(
          ".task-delete-btn, .task-pill__open-issues, .task-row-grip, .wx-action-icon, .wx-delete-button-icon, .wx-delete-icon, .wx-button-expand-box, .wx-progress-marker, .wx-progress-wrapper, .wx-line, input, textarea, select, button, a",
        )
      ) {
        return;
      }

      const wxBar = target.closest(".wx-bar") as HTMLElement | null;
      if (wxBar) {
        const inner = wxBar.querySelector(
          "[data-bar-id]",
        ) as HTMLElement | null;
        const id = inner?.getAttribute("data-bar-id");
        if (id) {
          setCriticalPathTargetId((prev) => (prev === id ? null : id));
          return;
        }
      }

      // Click in the chart body but not on a bar → clear focus.
      if (
        criticalPathTargetIdRef.current &&
        target.closest(".wx-area, .wx-chart, .wx-bars")
      ) {
        setCriticalPathTargetId(null);
      }
    };
    frame.addEventListener("click", onClick);
    return () => {
      frame.removeEventListener("click", onClick);
    };
  }, []);

  // Esc clears the critical path focus.
  useEffect(() => {
    if (!criticalPathTargetId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Only steal Escape if nothing else is open (rough heuristic).
        const hasOpenUI = document.querySelector(
          ".bar-quick-editor, .deps-modal, .deps-picker, .context-menu, .bq-editor",
        );
        if (hasOpenUI) return;
        setCriticalPathTargetId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [criticalPathTargetId]);

  // Paint the critical-path highlight in the DOM. SVAR virtualizes
  // rows and the link SVG is redrawn on every layout change, so we
  // reapply classes via a MutationObserver rather than rely on a
  // single pass.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const focusActive =
      criticalPathTaskIds.size > 0 || criticalPathLinkIds.size > 0;
    frame.classList.toggle("gantt-frame--crit-focus", focusActive);

    const apply = () => {
      // Bars
      const bars = frame.querySelectorAll<HTMLElement>("[data-bar-id]");
      bars.forEach((b) => {
        const id = b.getAttribute("data-bar-id");
        if (!id) return;
        const onPath = criticalPathTaskIds.has(id);
        b.classList.toggle("task-pill-wrap--crit", onPath);
        b.classList.toggle(
          "task-pill-wrap--crit-dim",
          focusActive && !onPath,
        );
      });
      // Links
      const links = frame.querySelectorAll<SVGPolylineElement>(
        "polyline[data-link-id]",
      );
      links.forEach((l) => {
        const id = l.getAttribute("data-link-id");
        if (!id) return;
        const onPath = criticalPathLinkIds.has(id);
        l.classList.toggle("wx-line--crit", onPath);
        l.classList.toggle("wx-line--crit-dim", focusActive && !onPath);
      });
    };

    apply();
    if (!focusActive) {
      return () => {
        frame.classList.remove("gantt-frame--crit-focus");
      };
    }

    const mo = new MutationObserver(() => apply());
    mo.observe(frame, { subtree: true, childList: true, attributes: false });

    return () => {
      mo.disconnect();
      frame.classList.remove("gantt-frame--crit-focus");
      frame
        .querySelectorAll<HTMLElement>(
          ".task-pill-wrap--crit, .task-pill-wrap--crit-dim",
        )
        .forEach((b) => {
          b.classList.remove("task-pill-wrap--crit");
          b.classList.remove("task-pill-wrap--crit-dim");
        });
      frame
        .querySelectorAll<SVGPolylineElement>(
          "polyline.wx-line--crit, polyline.wx-line--crit-dim",
        )
        .forEach((l) => {
          l.classList.remove("wx-line--crit");
          l.classList.remove("wx-line--crit-dim");
        });
    };
  }, [criticalPathTaskIds, criticalPathLinkIds]);

  // Hover-to-highlight dependencies. When the user points at a bar, we
  // light up its direct predecessors, successors, and the links joining
  // them — a lightweight, always-on preview of what a task blocks /
  // depends on without having to click. Skipped while a critical-path
  // focus is active so the two modes don't fight.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const outgoing = new Map<string, Array<{ linkId: string; to: string }>>();
    const incoming = new Map<string, Array<{ linkId: string; from: string }>>();
    for (const l of links) {
      const o = outgoing.get(l.source) ?? [];
      o.push({ linkId: l.id, to: l.target });
      outgoing.set(l.source, o);
      const i = incoming.get(l.target) ?? [];
      i.push({ linkId: l.id, from: l.source });
      incoming.set(l.target, i);
    }

    let hoveredId: string | null = null;

    const clearClasses = () => {
      frame.classList.remove("gantt-frame--dep-hover");
      frame
        .querySelectorAll<HTMLElement>(
          ".task-pill-wrap--dep-hover, .task-pill-wrap--dep-hover-root",
        )
        .forEach((el) => {
          el.classList.remove("task-pill-wrap--dep-hover");
          el.classList.remove("task-pill-wrap--dep-hover-root");
        });
      frame
        .querySelectorAll<SVGPolylineElement>("polyline.wx-line--dep-hover")
        .forEach((el) => el.classList.remove("wx-line--dep-hover"));
    };

    const applyFor = (id: string) => {
      const relatedTasks = new Set<string>();
      const relatedLinks = new Set<string>();
      for (const o of outgoing.get(id) ?? []) {
        relatedTasks.add(o.to);
        relatedLinks.add(o.linkId);
      }
      for (const i of incoming.get(id) ?? []) {
        relatedTasks.add(i.from);
        relatedLinks.add(i.linkId);
      }
      clearClasses();
      if (relatedTasks.size === 0 && relatedLinks.size === 0) return;
      frame.classList.add("gantt-frame--dep-hover");
      frame
        .querySelectorAll<HTMLElement>("[data-bar-id]")
        .forEach((el) => {
          const bid = el.getAttribute("data-bar-id");
          if (!bid) return;
          if (bid === id) {
            el.classList.add("task-pill-wrap--dep-hover-root");
          } else if (relatedTasks.has(bid)) {
            el.classList.add("task-pill-wrap--dep-hover");
          }
        });
      frame
        .querySelectorAll<SVGPolylineElement>("polyline[data-link-id]")
        .forEach((el) => {
          const lid = el.getAttribute("data-link-id");
          if (lid && relatedLinks.has(lid)) el.classList.add("wx-line--dep-hover");
        });
    };

    const onOver = (ev: MouseEvent) => {
      // Don't overwrite the click-focused critical-path highlight.
      if (criticalPathTargetIdRef.current) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const wxBar = target.closest(".wx-bar") as HTMLElement | null;
      if (!wxBar) {
        if (hoveredId) {
          hoveredId = null;
          clearClasses();
        }
        return;
      }
      const inner = wxBar.querySelector("[data-bar-id]") as HTMLElement | null;
      const id = inner?.getAttribute("data-bar-id");
      if (!id || id === hoveredId) return;
      hoveredId = id;
      applyFor(id);
    };

    const onLeave = (ev: MouseEvent) => {
      const to = ev.relatedTarget as Node | null;
      if (to && frame.contains(to)) return;
      hoveredId = null;
      clearClasses();
    };

    frame.addEventListener("mouseover", onOver);
    frame.addEventListener("mouseleave", onLeave);
    return () => {
      frame.removeEventListener("mouseover", onOver);
      frame.removeEventListener("mouseleave", onLeave);
      clearClasses();
    };
  }, [links, tasks]);

  // Per-task open-issue indicator state. Held in a ref so TaskTemplate
  // can read without re-memoizing on every prop change.
  const issueIndicatorByIdRef = useRef<
    Map<string, "active" | "slipping" | "resolved">
  >(new Map());
  useEffect(() => {
    issueIndicatorByIdRef.current = new Map(
      Object.entries(issueIndicatorByTaskId ?? {}),
    );
  }, [issueIndicatorByTaskId]);

  // Open-issue rollup counts (self + descendants). Held in a ref so
  // the memoized TaskTemplate doesn't need to be rebuilt when counts
  // change — we just repaint.
  const issueCountByIdRef = useRef<
    Map<string, { direct: number; rollup: number }>
  >(new Map());
  useEffect(() => {
    issueCountByIdRef.current = new Map(
      Object.entries(openIssueCountByTaskId ?? {}),
    );
  }, [openIssueCountByTaskId]);


  const TaskTemplate = ({
    data,
  }: {
    data: {
      id?: string | number;
      text?: string;
      progress?: number;
      urgency?: "high" | "medium" | "low";
      start?: Date | string;
      end?: Date | string;
      assignee?: string | null;
    };
  }) => {
    const id = data?.id != null ? String(data.id) : "";
    const level = Math.min(levelById.get(id) ?? 0, 2);
    const urgency = urgencyById.get(id) ?? data?.urgency ?? "medium";
    const health = healthByIdRef.current.get(id);
    const pct = Math.max(0, Math.min(100, Number(data?.progress ?? 0)));
    const overdue = data?.end ? isOverdue(data.end, pct) : false;
    const childCount = childCountByIdRef.current.get(id) ?? 0;

    // Color by hierarchy LEVEL, not "has children". Previously a
    // workstream with no children rendered as a leaf (urgency-colored),
    // so workstreams and tasks looked identical. Now programs + workstreams
    // always read as summary bars and tasks always read with urgency, even
    // when the workstream hasn't been filled out yet.
    const isParentBar = level <= 1;
    const needsPlacement = needsPlacementIds.has(id);
    // Leaf tasks show urgency to surface risk at a glance. Programs
    // and workstreams get a muted slate/indigo "summary" palette so the
    // hierarchy reads visually — parents look like groupings regardless
    // of whether children exist yet.
    const taskPalette: Record<
      "high" | "medium" | "low",
      { bg: string; border: string; text: string; fill: string }
    > = {
      high: {
        bg: "#fee2e2",
        border: "#f87171",
        text: "#7f1d1d",
        fill: "#dc2626",
      },
      medium: {
        bg: "#fef3c7",
        border: "#f59e0b",
        text: "#78350f",
        fill: "#d97706",
      },
      low: {
        bg: "#dcfce7",
        border: "#4ade80",
        text: "#14532d",
        fill: "#16a34a",
      },
    };
    // Level-aware parent palette. Program (level 0) reads deeper, workstream
    // (level 1+) slightly lighter so they're distinguishable from each other
    // and from leaf task bars at a glance.
    const parentPalette: Record<
      0 | 1 | 2,
      { bg: string; border: string; text: string; fill: string }
    > = {
      0: {
        bg: "#e0e7ff",
        border: "#6366f1",
        text: "#312e81",
        fill: "#4f46e5",
      },
      1: {
        bg: "#e2e8f0",
        border: "#64748b",
        text: "#1e293b",
        fill: "#475569",
      },
      2: {
        bg: "#dbeafe",
        border: "#60a5fa",
        text: "#1e3a8a",
        fill: "#3b82f6",
      },
    };
    const colors = isParentBar
      ? parentPalette[Math.min(level, 2) as 0 | 1 | 2]
      : taskPalette[urgency];
    const fullLabel = data?.text ?? "";
    const displayLabel = useMemo(
      () => formatTaskDisplayLabel(fullLabel),
      [fullLabel],
    );

    // Live bar width drives the responsive label. When the bar is
    // narrow we progressively strip parentheticals / qualifiers or
    // hide the label entirely so the UI stays clean — the full name
    // is always available in the hover tooltip below.
    const pillRef = useRef<HTMLDivElement | null>(null);
    const [barWidth, setBarWidth] = useState(0);
    useLayoutEffect(() => {
      const el = pillRef.current;
      if (!el) return;
      const update = () => setBarWidth(el.clientWidth);
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    const visibleLabel = useMemo(
      () => getVisibleBarLabel(displayLabel, barWidth),
      [displayLabel, barWidth],
    );

    // Hover tooltip. We portal it to <body> with fixed coords so it's
    // never clipped by SVAR's `.wx-area` / `.wx-bars` overflow. Coords
    // are resolved from the pill's live bounding rect so zoom, scroll,
    // and date drags always produce an accurate anchor.
    const [tipPos, setTipPos] = useState<
      | { top: number; left: number; placement: "top" | "bottom" }
      | null
    >(null);
    const showTooltip = () => {
      const el = pillRef.current;
      if (!el || typeof window === "undefined") return;
      const r = el.getBoundingClientRect();
      // Default above the bar; flip below if we'd clip the viewport top.
      const placement = r.top < 96 ? "bottom" : "top";
      const top =
        placement === "top" ? r.top - 8 : r.bottom + 8;
      const left = Math.max(
        12,
        Math.min(window.innerWidth - 12, r.left + r.width / 2),
      );
      setTipPos({ top, left, placement });
    };
    const hideTooltip = () => setTipPos(null);

    const owner = (data?.assignee ?? "").trim();

    // In-bar expand/collapse chevron for Programs / Workstreams.
    // Local state keeps the chevron's orientation in sync with
    // whatever toggled the row — our chevron click, Expand all,
    // critical-path auto-expand, etc. — by listening for the
    // `gantt-open-toggle` CustomEvent dispatched from the api.on
    // "open-task" handler.
    const hasChildBars = isParentBar && childCount > 0;
    const [isOpen, setIsOpen] = useState<boolean>(() =>
      openByIdRef.current.get(id) ?? true,
    );
    useEffect(() => {
      if (!hasChildBars) return;
      const onToggle = (ev: Event) => {
        const ce = ev as CustomEvent<{ id: string; mode: boolean }>;
        if (!ce.detail) return;
        if (ce.detail.id !== id) return;
        setIsOpen(Boolean(ce.detail.mode));
      };
      window.addEventListener("gantt-open-toggle", onToggle);
      return () => {
        window.removeEventListener("gantt-open-toggle", onToggle);
      };
    }, [id, hasChildBars]);

    return (
      <div
        className="task-pill-wrap"
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
      >
        <div
          ref={pillRef}
          data-bar-id={id}
          className={
            `task-pill level-${level} urgency-${urgency}` +
            (health ? ` task-pill--health-${health}` : "") +
            (isParentBar ? " task-pill--parent" : " task-pill--leaf") +
            (overdue ? " task-pill--overdue" : "") +
            (needsPlacement ? " task-pill--unplaced" : "")
          }
          style={{
            pointerEvents: "none",
            background: colors.bg,
            borderColor: colors.border,
            color: colors.text,
          }}
        >
          <div
            className="task-pill__fill"
            style={{ width: `${pct}%`, background: colors.fill }}
          />
          {health ? (
            <span
              className={`task-pill__health-rail task-pill__health-rail--${health}`}
              aria-hidden
            />
          ) : null}
          {hasChildBars ? (
            <button
              type="button"
              className={
                "task-pill__expand" + (isOpen ? " is-open" : "")
              }
              style={{ pointerEvents: "auto" }}
              title={isOpen ? "Collapse children" : "Expand children"}
              aria-label={isOpen ? "Collapse children" : "Expand children"}
              aria-expanded={isOpen}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                const next = !isOpen;
                setIsOpen(next);
                openByIdRef.current.set(id, next);
                try {
                  apiRef.current?.exec("open-task", { id, mode: next });
                } catch {
                  /* leaves or already-disposed api */
                }
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
          ) : null}
          <div className="task-pill__text">
            {visibleLabel ? (
              <span className="task-pill__name">{visibleLabel}</span>
            ) : null}
            {(() => {
              const counts = issueCountByIdRef.current.get(id);
              if (!counts || counts.rollup <= 0) return null;
              // On leaf tasks with only their own issues, the dot
              // indicator already communicates presence — the badge
              // duplicates it. Still show it for leaves because the
              // number is more informative than a dot.
              const label =
                counts.rollup === 1 ? "1 open issue" : `${counts.rollup} open issues`;
              const title =
                counts.direct === counts.rollup
                  ? `${label} linked to this task`
                  : `${counts.rollup} open issues nested here (${counts.direct} direct)`;
              const href =
                counts.rollup === counts.direct
                  ? `/open-issues?taskId=${encodeURIComponent(id)}`
                  : `/open-issues?workstreamId=${encodeURIComponent(id)}`;
              return (
                <a
                  href={href}
                  className="task-pill__open-issues"
                  title={title}
                  aria-label={title}
                  style={{ pointerEvents: "auto" }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <span aria-hidden="true" className="task-pill__open-issues-dot" />
                  {label}
                </a>
              );
            })()}
            <span className="task-pill__pct">{pct}%</span>
          </div>
        </div>
        {(() => {
          const state = issueIndicatorByIdRef.current.get(id);
          if (!state) return null;
          const title =
            state === "slipping"
              ? "Issue is slipping the schedule — click to review"
              : state === "active"
                ? "Active issue linked to this task — click to review"
                : "Recently resolved issue";
          return (
            <a
              href={`/open-issues?taskId=${encodeURIComponent(id)}`}
              className={`task-issue-indicator task-issue-indicator--${state}`}
              title={title}
              aria-label={title}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
          );
        })()}
        {tipPos && typeof document !== "undefined"
          ? createPortal(
              <div
                className={`task-pill-tooltip task-pill-tooltip--${tipPos.placement} urgency-${urgency}`}
                style={{
                  top: tipPos.top,
                  left: tipPos.left,
                }}
                role="tooltip"
              >
                <div className="task-pill-tooltip__name">{fullLabel}</div>
                <dl className="task-pill-tooltip__meta">
                  <div>
                    <dt>Progress</dt>
                    <dd>{pct}%</dd>
                  </div>
                  <div>
                    <dt>Start</dt>
                    <dd>{fmtTipDate(data?.start)}</dd>
                  </div>
                  <div>
                    <dt>End</dt>
                    <dd>{fmtTipDate(data?.end)}</dd>
                  </div>
                  {owner && (
                    <div>
                      <dt>Owner</dt>
                      <dd>{owner}</dd>
                    </div>
                  )}
                  {(() => {
                    const c = issueCountByIdRef.current.get(id);
                    if (!c || c.rollup <= 0) return null;
                    return (
                      <div>
                        <dt>Open issues</dt>
                        <dd>
                          {c.rollup}
                          {c.direct !== c.rollup
                            ? ` (${c.direct} direct)`
                            : ""}
                        </dd>
                      </div>
                    );
                  })()}
                </dl>
              </div>,
              document.body,
            )
          : null}
      </div>
    );
  };

  // Generic click-to-edit inline input for single-click grid edits.
  // Renders as a display span until it's clicked; click swaps it to a
  // native input that commits on Enter or blur and cancels on Escape.
  // Intentionally defined at component scope (not inside a useMemo) so it
  // can be a real React component with its own hooks.
  const InlineEditable = useMemo(() => {
    type Props = {
      rowId: string;
      field: string;
      rawValue: string;
      inputType: "text" | "number" | "date";
      toPayload: (raw: string) => Record<string, unknown> | null;
      display: React.ReactNode;
      className?: string;
      inputClassName?: string;
      readOnly?: boolean;
      readOnlyReason?: string;
      placeholder?: string;
      min?: number;
      max?: number;
      step?: number | string;
      align?: "left" | "center" | "right";
    };
    function Inline(props: Props) {
      const {
        rowId,
        field,
        rawValue,
        inputType,
        toPayload,
        display,
        className,
        inputClassName,
        readOnly,
        readOnlyReason,
        placeholder,
        min,
        max,
        step,
        align = "left",
      } = props;
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState(rawValue);
      const inputRef = useRef<HTMLInputElement | null>(null);
      const editKey = `${rowId}:${field}`;

      // Register the opener so the frame-level pointerup handler can
      // switch this cell into edit mode regardless of whether the
      // native click event made it through. Read-only cells never
      // register — there's no editor to open.
      useEffect(() => {
        if (readOnly) return;
        const open = () => setEditing(true);
        editorOpenersRef.current.set(editKey, open);
        return () => {
          if (editorOpenersRef.current.get(editKey) === open) {
            editorOpenersRef.current.delete(editKey);
          }
        };
      }, [editKey, readOnly]);

      useEffect(() => {
        if (!editing) setDraft(rawValue);
      }, [rawValue, editing]);

      useEffect(() => {
        if (editing && inputRef.current) {
          inputRef.current.focus();
          if (inputType === "text") {
            try {
              inputRef.current.select();
            } catch {
              /* ignore */
            }
          }
        }
      }, [editing, inputType]);

      const commit = () => {
        setEditing(false);
        if (draft === rawValue) return;
        const payload = toPayload(draft);
        if (!payload) {
          setDraft(rawValue);
          return;
        }
        void commitInlineEditRef.current(rowId, payload);
      };

      const cancel = () => {
        setDraft(rawValue);
        setEditing(false);
      };

      if (!editing) {
        const justify =
          align === "center"
            ? "center"
            : align === "right"
              ? "flex-end"
              : "flex-start";
        return (
          <span
            className={
              (className ?? "grid-cell-meta") +
              " inline-edit-display" +
              (readOnly ? " inline-edit-display--readonly" : "")
            }
            role={readOnly ? undefined : "button"}
            tabIndex={readOnly ? -1 : 0}
            title={readOnly ? readOnlyReason : "Click to edit"}
            style={{ justifyContent: justify }}
            // Everything activation-related lives at the frame level.
            // The span intentionally declares no onClick / onMouseDown /
            // onPointerDown / onPointerUp — those all compete with the
            // ancestor's draggable=true behavior, which is what made
            // clicks on text characters feel flaky. The frame handler
            // reads `data-edit-key` off this span and calls the
            // registered opener on a clean pointerup that didn't travel.
            draggable={false}
            data-edit-key={editKey}
            onKeyDown={(e) => {
              if (readOnly) return;
              if (e.key === "Enter" || e.key === " " || e.key === "F2") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(true);
              }
            }}
          >
            {display}
          </span>
        );
      }

      return (
        <input
          ref={inputRef}
          type={inputType}
          className={inputClassName ?? "inline-edit-input"}
          style={{ textAlign: align }}
          value={draft}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      );
    }
    Inline.displayName = "InlineEditable";
    return Inline;
  }, []);

  const DepsLabelCell = useMemo(() => {
    function Cell({ row }: { row: Record<string, unknown> }) {
      const id = String(row?.id ?? "");
      const rowType = String(row?.rowType ?? "TASK");
      const rawLabel = String(row?.depsLabel ?? "").trim();
      // The pre-formatted issue label ("Linked to: …") isn't editable as a
      // dependency list, so keep it display-only for ISSUE rows.
      const editable = rowType !== "ISSUE";
      // For non-issue rows, strip the open-issues prefix since the editor
      // only manages predecessor dependencies.
      const label =
        editable && rawLabel.startsWith("Open issues:") ? "" : rawLabel;
      const isEmpty = !label || label === "—";
      if (!editable) {
        return (
          <span className="deps-cell-text" title={label}>
            {label || "—"}
          </span>
        );
      }
      return (
        <button
          type="button"
          className={
            "deps-cell-edit" + (isEmpty ? " deps-cell-edit--empty" : "")
          }
          data-deps-cell-edit={id}
          title={
            isEmpty ? "Click to add a dependency" : `${label} — click to edit`
          }
        >
          <span className="deps-cell-edit-text">
            {isEmpty ? "Add dependency…" : label}
          </span>
          <span className="deps-cell-edit-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </span>
        </button>
      );
    }
    Cell.displayName = "DepsLabelCell";
    return Cell;
  }, []);

  const StartDateCell = useMemo(() => {
    function Cell({ row }: { row: Record<string, unknown> }) {
      const id = String(row?.id ?? "");
      const raw = row?.start;
      const dateVal = raw ? new Date(String(raw)) : null;
      const iso = dateVal ? shortDate(dateVal) : "";
      return (
        <InlineEditable
          rowId={id}
          field="start"
          rawValue={iso}
          inputType="date"
          align="center"
          toPayload={(s) => {
            if (!s) return null;
            const d = parseDateInputLocal(s);
            if (!d) return null;
            return { startDate: d.toISOString() };
          }}
          display={
            dateVal ? (
              shortDate(dateVal)
            ) : (
              <span className="grid-cell-meta--empty">—</span>
            )
          }
        />
      );
    }
    Cell.displayName = "StartDateCell";
    return Cell;
  }, [InlineEditable]);

  const EndDateCell = useMemo(() => {
    function Cell({ row }: { row: Record<string, unknown> }) {
      const id = String(row?.id ?? "");
      const raw = row?.end;
      const dateVal = raw ? new Date(String(raw)) : null;
      const iso = dateVal ? shortDate(dateVal) : "";
      const progress = Number(row?.progress ?? 0);
      const overdue = dateVal ? isOverdue(dateVal, progress) : false;
      return (
        <InlineEditable
          rowId={id}
          field="end"
          rawValue={iso}
          inputType="date"
          align="center"
          className={
            "grid-cell-meta" + (overdue ? " grid-cell-meta--overdue" : "")
          }
          toPayload={(s) => {
            if (!s) return null;
            const d = parseDateInputLocal(s);
            if (!d) return null;
            return { endDate: d.toISOString() };
          }}
          display={
            dateVal ? (
              shortDate(dateVal)
            ) : (
              <span className="grid-cell-meta--empty">—</span>
            )
          }
        />
      );
    }
    Cell.displayName = "EndDateCell";
    return Cell;
  }, [InlineEditable]);

  const ProgressCell = useMemo(() => {
    function Cell({ row }: { row: Record<string, unknown> }) {
      const id = String(row?.id ?? "");
      const pct = Math.max(0, Math.min(100, Math.round(Number(row?.progress ?? 0))));
      return (
        <InlineEditable
          rowId={id}
          field="progress"
          rawValue={String(pct)}
          inputType="number"
          align="center"
          min={0}
          max={100}
          step={5}
          toPayload={(s) => {
            const n = Number(s);
            if (!Number.isFinite(n)) return null;
            return { progress: Math.max(0, Math.min(100, Math.round(n))) };
          }}
          display={`${pct}%`}
        />
      );
    }
    Cell.displayName = "ProgressCell";
    return Cell;
  }, [InlineEditable]);

  const EffortCell = useMemo(() => {
    function Cell({ row }: { row: Record<string, unknown> }) {
      const rowId = String(row?.id ?? "");
      const kids = childCountByIdRef.current.get(rowId) ?? 0;
      const isParent = kids > 0;
      const raw = row?.effortHours;
      const hasValue = raw != null && raw !== "";
      const hrs = hasValue ? Math.max(0, Math.round(Number(raw))) : 0;
      const progress = Math.max(0, Math.min(100, Number(row?.progress ?? 0)));
      const remaining = hasValue ? Math.round(hrs * ((100 - progress) / 100)) : 0;
      const readOnlyReason = isParent
        ? `Rolls up from ${kids} child ${kids === 1 ? "task" : "tasks"} — edit children instead.`
        : undefined;
      const baseCls = "grid-cell-meta" + (isParent ? " grid-cell-meta--rollup" : "");
      const display = hasValue ? (
        <>
          {remaining}h
          {isParent ? <span className="grid-cell-rollup">Σ</span> : null}
        </>
      ) : (
        <>
          <span className="grid-cell-meta--empty">—</span>
          {isParent ? <span className="grid-cell-rollup">Σ</span> : null}
        </>
      );
      return (
        <InlineEditable
          rowId={rowId}
          field="effortHours"
          rawValue={hasValue ? String(hrs) : ""}
          inputType="number"
          align="center"
          min={0}
          step={1}
          className={baseCls}
          readOnly={isParent}
          readOnlyReason={readOnlyReason}
          placeholder="0"
          toPayload={(s) => {
            if (s === "") return { effortHours: null };
            const n = Number(s);
            if (!Number.isFinite(n) || n < 0) return null;
            return { effortHours: Math.round(n) };
          }}
          display={display}
        />
      );
    }
    Cell.displayName = "EffortCell";
    return Cell;
  }, [InlineEditable]);

  const ResourcesCell = useMemo(() => {
    function Cell({ row }: { row: Record<string, unknown> }) {
      const id = String(row?.id ?? "");
      const assignee = String(row?.assignee ?? "").trim();
      const label = assignee || "Assign…";
      return (
        <button
          type="button"
          className={
            "grid-cell-meta grid-cell-meta--picker" +
            (assignee ? "" : " grid-cell-meta--empty-picker")
          }
          data-resource-picker={id}
          title={assignee ? `Assigned to ${assignee}` : "Assign a contributor"}
        >
          <span className="grid-cell-meta-picker__label">{label}</span>
          <svg
            className="grid-cell-meta-picker__chevron"
            viewBox="0 0 20 20"
            width="10"
            height="10"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M5 7l5 6 5-6z" />
          </svg>
        </button>
      );
    }
    Cell.displayName = "ResourcesCell";
    return Cell;
  }, []);

  const DaysCell = useMemo(() => {
    function Cell({ row }: { row: Record<string, unknown> }) {
      const endRaw = row?.end;
      if (!endRaw) return <span className="grid-cell-meta grid-cell-meta--empty">—</span>;
      const end = new Date(String(endRaw));
      const progress = Number(row?.progress ?? 0);
      const days = daysUntil(end);
      if (progress >= 100) {
        return (
          <span className="grid-cell-meta grid-cell-meta--done" title="Done">
            done
          </span>
        );
      }
      if (days < 0) {
        return (
          <span
            className="grid-cell-meta grid-cell-meta--overdue"
            title={`${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`}
          >
            {days}d
          </span>
        );
      }
      if (days === 0) {
        return (
          <span className="grid-cell-meta grid-cell-meta--due" title="Due today">
            today
          </span>
        );
      }
      return (
        <span
          className="grid-cell-meta"
          title={`${days} day${days === 1 ? "" : "s"} until completion`}
        >
          {days}d
        </span>
      );
    }
    Cell.displayName = "DaysCell";
    return Cell;
  }, []);

  const TaskNameCell = useMemo(() => {
    function Cell({ row }: { row: Record<string, unknown> }) {
      const id = String(row?.id ?? "");
      const text = String(row?.text ?? "");
      const rowType = String(row?.rowType ?? "TASK");
      // Read hierarchy data from refs rather than closed-over maps so this
      // component stays referentially stable and doesn't force the whole
      // `columns` array to recreate on every task change.
      const depth = depthByIdRef.current.get(id) ?? 0;
      const childCount = childCountByIdRef.current.get(id) ?? 0;
      const level = levelForRow(rowType, depth, childCount);
      const overdue = row?.end
        ? isOverdue(new Date(String(row.end)), Number(row?.progress ?? 0))
        : false;
      return (
        <div
          className={
            "task-cell-wrap task-cell-wrap--" +
            level.slug +
            (overdue ? " task-cell-wrap--overdue" : "")
          }
          draggable
          data-task-drag-id={id}
          data-task-drop-id={id}
        >
          <span className="task-cell-label">
            <span
              className="task-row-drag"
              data-task-drag-handle={id}
              title="Drag onto another task to nest it"
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="9" cy="6" r="1.4" />
                <circle cx="15" cy="6" r="1.4" />
                <circle cx="9" cy="12" r="1.4" />
                <circle cx="15" cy="12" r="1.4" />
                <circle cx="9" cy="18" r="1.4" />
                <circle cx="15" cy="18" r="1.4" />
              </svg>
            </span>
            {level.showChip && (
              <span
                className={`task-row-kind task-row-kind--${level.slug}`}
                title={level.title}
              >
                {level.label}
              </span>
            )}
            <InlineEditable
              rowId={id}
              field="text"
              rawValue={text}
              inputType="text"
              className="task-cell-text"
              inputClassName="task-cell-text-input"
              align="left"
              toPayload={(s) => {
                const trimmed = s.trim();
                if (!trimmed) return null;
                return { title: trimmed };
              }}
              display={text || "Untitled"}
            />
            {childCount > 0 && rowType !== "ISSUE" && (
              <span className="task-row-badge" title="Child count">
                {childCount}
              </span>
            )}
          </span>
          <span className="task-row-actions" data-row-actions>
            <button
              className="task-row-icon-btn"
              data-assign-parent={id}
              title="Move under another task"
              aria-label="Move under another task"
              type="button"
            >
              {/* Folder/tree icon — represents nesting under a parent. */}
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <path d="M8 13h8" />
              </svg>
            </button>
            <button
              className="task-row-icon-btn"
              data-deps-edit={id}
              title="Edit dependencies"
              aria-label="Edit dependencies"
              type="button"
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
                aria-hidden="true"
              >
                <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07l-1.41 1.41" />
                <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.41-1.41" />
              </svg>
            </button>
            <button
              className="task-row-icon-btn task-row-icon-btn--danger"
              data-task-delete={id}
              title="Delete task"
              aria-label="Delete task"
              type="button"
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
                aria-hidden="true"
              >
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
          </span>
        </div>
      );
    }
    Cell.displayName = "TaskNameCell";
    return Cell;
    // Empty deps on purpose: the cell reads hierarchy data via refs
    // (childCountByIdRef / depthByIdRef), so it never needs to be
    // re-created. Keeping this cell stable keeps the `columns` array
    // stable, which keeps SVAR from fully re-initializing the grid on
    // every task change — the root cause of the "only 3 columns render"
    // layout bug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns = useMemo(
    () => [
      {
        id: "text",
        header: "Task",
        // Auto-sized once on mount to fit the longest task name actually
        // present in the initial payload (clamped 260–560px). Users can
        // still drag-resize the column afterwards — we only set the
        // starting value so they don't land on a squished column.
        width: taskColumnWidth,
        align: "left" as const,
        editor: "text",
        cell: TaskNameCell,
      },
      {
        id: "start",
        header: "Start",
        width: 104,
        align: "center" as const,
        cell: StartDateCell,
        editor: "datepicker",
      },
      {
        id: "end",
        header: "End",
        width: 104,
        align: "center" as const,
        cell: EndDateCell,
        editor: "datepicker",
      },
      {
        id: "depsLabel",
        header: "Depends On",
        width: 320,
        align: "left" as const,
        cell: DepsLabelCell,
      },
      {
        id: "progress",
        header: "% Complete",
        width: 110,
        align: "center" as const,
        cell: ProgressCell,
        editor: "text",
      },
      {
        id: "effortHours",
        header: "Hours",
        width: 84,
        align: "center" as const,
        cell: EffortCell,
        editor: "text",
      },
      {
        id: "resources",
        header: "Resources",
        width: 180,
        align: "left" as const,
        cell: ResourcesCell,
      },
      {
        id: "duration",
        header: "Due",
        width: 78,
        align: "center" as const,
        cell: DaysCell,
      },
    ],
    [
      TaskNameCell,
      DepsLabelCell,
      StartDateCell,
      EndDateCell,
      ProgressCell,
      EffortCell,
      ResourcesCell,
      DaysCell,
      taskColumnWidth,
    ],
  );

  async function patchTask(id: string, payload: Record<string, unknown>) {
    const res = await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<{
      task: { id: string };
      affected: Array<{
        id: string;
        startDate: string;
        endDate: string;
        progress: number;
      }>;
    }>;
  }

  function applyAffected(
    affected: Array<{
      id: string;
      startDate: string;
      endDate: string;
      progress: number;
    }>,
  ) {
    if (!apiRef.current) return;
    for (const a of affected) {
      const s = new Date(a.startDate);
      const e = new Date(a.endDate);
      suppressUpdateIds.current.add(a.id);
      const prev = knownTaskState.current.get(a.id);
      knownTaskState.current.set(a.id, {
        text: prev?.text ?? "",
        progress: Number(a.progress ?? 0),
        startMs: s.getTime(),
        endMs: e.getTime(),
        effortHours: prev?.effortHours ?? null,
      });
      apiRef.current.exec("update-task", {
        id: a.id,
        task: {
          start: s,
          end: e,
          duration: daysBetween(s, e),
          progress: a.progress,
        },
        eventSource: "server-reschedule",
      });
      setTimeout(() => suppressUpdateIds.current.delete(a.id), 1500);
    }
  }

  // Keep the inline-edit commit handler fresh. This is the single-click
  // save path for the grid cells (task name, start, end, hours, % complete).
  commitInlineEditRef.current = async (id, payload) => {
    if (Object.keys(payload).length === 0) return;

    // Parents derive effortHours from children — reject direct edits here
    // the same way the SVAR update-task path does, so the two entry points
    // stay consistent.
    if ("effortHours" in payload) {
      const kidCount = childCountByIdRef.current.get(id) ?? 0;
      if (kidCount > 0) {
        setStatus(
          `Estimated hours rolls up from ${kidCount} child ${kidCount === 1 ? "task" : "tasks"} — edit children instead.`,
        );
        setTimeout(() => setStatus(""), 2400);
        return;
      }
    }

    // Snapshot the pre-edit values of the exact fields being changed so
    // we can push a reversible undo action after the save succeeds.
    // We pull from knownTaskState (source of truth for the currently
    // rendered row) and the server tasks prop (for fields we don't
    // cache locally, like assignee).
    const preState = knownTaskState.current.get(id);
    const preTask = tasks.find((x) => x.id === id);
    const inversePayload: Record<string, unknown> = {};
    const labelBits: string[] = [];
    if ("title" in payload && preState) {
      inversePayload.title = preState.text;
      labelBits.push("name");
    }
    if ("progress" in payload && preState) {
      inversePayload.progress = preState.progress;
      labelBits.push("%");
    }
    if ("startDate" in payload && preState) {
      inversePayload.startDate = new Date(preState.startMs).toISOString();
      labelBits.push("start");
    }
    if ("endDate" in payload && preState) {
      inversePayload.endDate = new Date(preState.endMs).toISOString();
      labelBits.push("end");
    }
    if ("effortHours" in payload && preState) {
      inversePayload.effortHours = preState.effortHours;
      labelBits.push("hours");
    }
    if ("assignee" in payload) {
      inversePayload.assignee = preTask?.assignee ?? null;
      labelBits.push("assignee");
    }

    setStatus("Saving…");
    inFlightIds.current.add(id);
    try {
      const { affected, task } = await patchTask(id, payload);
      const t = task as unknown as {
        id: string;
        title?: string;
        progress?: number;
        startDate?: string | Date;
        endDate?: string | Date;
        effortHours?: number | null;
        assignee?: string | null;
        resourceAllocated?: string | null;
      };
      const prevState = knownTaskState.current.get(id);
      const startMs = t.startDate ? new Date(t.startDate).getTime() : prevState?.startMs ?? 0;
      const endMs = t.endDate ? new Date(t.endDate).getTime() : prevState?.endMs ?? 0;
      knownTaskState.current.set(id, {
        text: t.title ?? prevState?.text ?? "",
        progress: Number(t.progress ?? prevState?.progress ?? 0),
        startMs,
        endMs,
        effortHours:
          t.effortHours === undefined
            ? prevState?.effortHours ?? null
            : t.effortHours,
      });

      // Nudge SVAR with the authoritative server values so the grid row
      // reflects the commit immediately (title, progress, effort don't
      // come back through applyAffected since they don't necessarily
      // reschedule anything).
      if (apiRef.current) {
        suppressUpdateIds.current.add(id);
        apiRef.current.exec("update-task", {
          id,
          task: {
            text: t.title ?? prevState?.text ?? "",
            progress: Number(t.progress ?? prevState?.progress ?? 0),
            start: new Date(startMs),
            end: new Date(endMs),
            effortHours:
              t.effortHours === undefined ? prevState?.effortHours ?? null : t.effortHours,
            // Push the new assignee straight into SVAR's row so the
            // Resources cell and bar tooltip update instantly, without
            // waiting on the debounced server refresh.
            assignee: t.assignee ?? null,
            resourceAllocated: t.resourceAllocated ?? null,
          },
          eventSource: "server-reschedule",
        });
        setTimeout(() => suppressUpdateIds.current.delete(id), 800);
      }

      applyAffected(affected);
      markSaved();
      setStatus("");

      // Push the inverse edit onto the undo stack (unless we're
      // already in the middle of replaying one).
      if (Object.keys(inversePayload).length > 0) {
        const name = preTask?.text ?? preState?.text ?? "task";
        const label =
          labelBits.length === 0
            ? `edit ${name}`
            : `${labelBits.join(", ")} on ${name}`;
        pushUndo({
          label,
          run: async () => {
            await commitInlineEditRef.current(id, inversePayload);
          },
        });
      }
      // Intentionally do NOT call router.refresh() here. The server already
      // returned the authoritative row + all affected rollups, and we just
      // pushed them into SVAR's store directly. Triggering a Next.js
      // route refresh on every cell edit caused the whole chart to flash
      // and jump (the user sees it as "the entire webapp refreshes"),
      // and it wasn't adding any data the user couldn't already see.
      // Anything purely server-derived (e.g. other tasks' depsLabel text
      // after a rename) will catch up on the next structural sync —
      // dep add/delete, parent reassign, task add/delete, or the manual
      // "Refresh" button.
    } catch (err) {
      console.error(err);
      setStatus("Save failed");
      setTimeout(() => setStatus(""), 2000);
    } finally {
      inFlightIds.current.delete(id);
    }
  };

  function init(api: {
    exec: (action: string, payload: unknown) => void;
    on: (action: string, cb: (data: unknown) => boolean | void) => void;
    intercept: (action: string, cb: (data: unknown) => boolean | void) => void;
  }) {
    apiRef.current = api;

    // Track open/closed state for parent rows. The in-bar chevron
    // rendered by TaskTemplate reads from this ref to draw itself
    // pointing right (closed) or down (open) and we broadcast a
    // custom event so live templates can re-render.
    api.on("open-task", (raw: unknown) => {
      const d = raw as { id?: string | number; mode?: boolean };
      if (d == null || d.id == null) return;
      const id = String(d.id);
      const mode = Boolean(d.mode);
      openByIdRef.current.set(id, mode);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("gantt-open-toggle", {
            detail: { id, mode },
          }),
        );
      }
    });

    api.on("update-task", (raw: unknown) => {
      const data = raw as {
        id: string;
        task: Partial<GanttTaskRuntime> & { start?: Date; end?: Date };
        inProgress?: boolean;
        eventSource?: string;
      };
      if (data.inProgress) return;
      if (data.eventSource === "server-reschedule") return;
      if (suppressUpdateIds.current.has(data.id)) return;
      if (inFlightIds.current.has(data.id)) return;

      const prev = knownTaskState.current.get(data.id);
      const nextText =
        typeof data.task.text === "string"
          ? data.task.text
          : (prev?.text ?? "");
      const nextProgressRaw =
        typeof data.task.progress === "number"
          ? data.task.progress
          : prev?.progress;
      const nextProgress =
        nextProgressRaw == null
          ? undefined
          : Math.max(0, Math.min(100, Math.round(Number(nextProgressRaw))));
      const nextStartMs = data.task.start
        ? new Date(data.task.start).getTime()
        : prev?.startMs;
      const nextEndMs = data.task.end
        ? new Date(data.task.end).getTime()
        : prev?.endMs;
      const rawEffort = (data.task as Record<string, unknown>)?.effortHours;
      let nextEffort: number | null | undefined;
      if (rawEffort === undefined) {
        nextEffort = prev?.effortHours;
      } else if (rawEffort === "" || rawEffort === null) {
        nextEffort = null;
      } else {
        const parsed = Number(rawEffort);
        // Ignore garbage input — leave effortHours untouched on NaN.
        nextEffort = Number.isFinite(parsed)
          ? Math.max(0, Math.round(parsed))
          : prev?.effortHours;
      }

      // If this event doesn't materially change data, ignore it.
      if (
        prev &&
        nextText === prev.text &&
        nextProgress === prev.progress &&
        nextStartMs === prev.startMs &&
        nextEndMs === prev.endMs &&
        (nextEffort ?? null) === (prev.effortHours ?? null)
      ) {
        return;
      }

      const payload: Record<string, unknown> = {};
      if (prev) {
        if (nextText !== prev.text) payload.title = nextText;
        if (
          nextProgress !== undefined &&
          Number(nextProgress) !== Number(prev.progress)
        ) {
          payload.progress = nextProgress;
        }
        if (
          nextStartMs !== undefined &&
          Number(nextStartMs) !== Number(prev.startMs)
        ) {
          payload.startDate = new Date(nextStartMs);
        }
        if (nextEndMs !== undefined && Number(nextEndMs) !== Number(prev.endMs)) {
          payload.endDate = new Date(nextEndMs);
        }
        if (
          rawEffort !== undefined &&
          (nextEffort ?? null) !== (prev.effortHours ?? null)
        ) {
          payload.effortHours = nextEffort;
        }
      } else {
        if (nextText) payload.title = nextText;
        if (nextProgress !== undefined) payload.progress = nextProgress;
        if (nextStartMs !== undefined) payload.startDate = new Date(nextStartMs);
        if (nextEndMs !== undefined) payload.endDate = new Date(nextEndMs);
        if (rawEffort !== undefined) payload.effortHours = nextEffort;
      }

      // Parent rows derive effort from their children, so refuse any direct
      // edit of effortHours on them. Revert the grid's optimistic value back
      // to the rolled-up number so the user sees the rule without a round
      // trip, and show a brief hint in the status bar.
      const parentKidCount = childCountByIdRef.current.get(data.id) ?? 0;
      if (parentKidCount > 0 && "effortHours" in payload) {
        delete payload.effortHours;
        if (prev) {
          suppressUpdateIds.current.add(data.id);
          apiRef.current?.exec("update-task", {
            id: data.id,
            task: { effortHours: prev.effortHours },
            eventSource: "server-reschedule",
          });
          setTimeout(() => suppressUpdateIds.current.delete(data.id), 800);
        }
        setStatus(
          `Estimated hours rolls up from ${parentKidCount} child ${parentKidCount === 1 ? "task" : "tasks"} — edit children instead.`,
        );
        setTimeout(() => setStatus(""), 2400);
      }

      if (Object.keys(payload).length === 0) return;

      // Capture pre-edit values for the same set of fields actually
      // being changed, so Cmd+Z can revert a bar drag / resize / inline
      // SVAR edit.
      const inverseSvarPayload: Record<string, unknown> = {};
      const svarLabelBits: string[] = [];
      if ("title" in payload && prev) {
        inverseSvarPayload.title = prev.text;
        svarLabelBits.push("name");
      }
      if ("progress" in payload && prev) {
        inverseSvarPayload.progress = prev.progress;
        svarLabelBits.push("%");
      }
      if ("startDate" in payload && prev) {
        inverseSvarPayload.startDate = new Date(prev.startMs).toISOString();
        svarLabelBits.push("start");
      }
      if ("endDate" in payload && prev) {
        inverseSvarPayload.endDate = new Date(prev.endMs).toISOString();
        svarLabelBits.push("end");
      }
      if ("effortHours" in payload && prev) {
        inverseSvarPayload.effortHours = prev.effortHours;
        svarLabelBits.push("hours");
      }
      const svarTaskName = prev?.text ?? "task";

      setStatus("Saving…");
      inFlightIds.current.add(data.id);
      patchTask(data.id, payload)
        .then(({ affected, task }) => {
          const t = task as unknown as {
            id: string;
            title?: string;
            progress?: number;
            startDate?: string | Date;
            endDate?: string | Date;
            effortHours?: number | null;
          };
          const prevState = knownTaskState.current.get(data.id);
          knownTaskState.current.set(data.id, {
            text: t.title ?? prevState?.text ?? nextText,
            progress:
              t.progress != null
                ? Number(t.progress)
                : Number(nextProgress ?? prevState?.progress ?? 0),
            startMs:
              t.startDate != null
                ? new Date(t.startDate).getTime()
                : Number(nextStartMs ?? prevState?.startMs ?? Date.now()),
            endMs:
              t.endDate != null
                ? new Date(t.endDate).getTime()
                : Number(nextEndMs ?? prevState?.endMs ?? Date.now()),
            effortHours:
              t.effortHours === undefined
                ? (nextEffort ?? prevState?.effortHours ?? null)
                : t.effortHours,
          });
          applyAffected(affected);
          markSaved();
          setStatus("Saved");
          setTimeout(() => setStatus(""), 1000);

          if (Object.keys(inverseSvarPayload).length > 0) {
            const label =
              svarLabelBits.length === 0
                ? `edit ${svarTaskName}`
                : `${svarLabelBits.join(", ")} on ${svarTaskName}`;
            pushUndo({
              label,
              run: async () => {
                await commitInlineEditRef.current(data.id, inverseSvarPayload);
              },
            });
          }
        })
        .catch((e: unknown) =>
          setStatus(e instanceof Error ? e.message : "Save failed"),
        )
        .finally(() => {
          inFlightIds.current.delete(data.id);
        });
    });

    // Persist drag-created dependencies from chart interactions.
    api.on("add-link", (raw: unknown) => {
      const ev = raw as {
        id?: string | number;
        link?: {
          source: string | number;
          target: string | number;
          type: GanttLinkInput["type"];
        };
      };
      const link = ev?.link;
      if (!link) return;
      const source = String(link.source);
      const target = String(link.target);
      if (!source || !target || source === target) return false;

      setStatus("Saving dependency…");
      fetch("/api/dependencies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          predecessorId: source,
          dependentId: target,
          type: LINK_TYPE_TO_DEP[link.type] ?? "FS",
        }),
      })
        .then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data?.error ?? "Dependency create failed");
          const tempId = ev?.id != null ? String(ev.id) : "";
          const realId = data?.dependency?.id ? String(data.dependency.id) : "";
          if (tempId && realId && tempId !== realId) {
            linkIdAlias.current.set(tempId, realId);
          }
          // Server reschedules downstream tasks and rolls up their
          // Workstream/Program ancestors. Apply those to the chart so the
          // parent bars realign without a page refresh.
          const affected = Array.isArray(data?.affected)
            ? (data.affected as Array<{
                id: string;
                startDate: string;
                endDate: string;
                progress: number;
              }>)
            : [];
          if (affected.length) applyAffected(affected);
          setStatus(
            data?.existed ? "Dependency already exists." : "Dependency created.",
          );
          if (!data?.existed) markSaved();
          setTimeout(() => setStatus(""), 900);

          // Push undo: deleting the just-created dependency both on
          // the server and in SVAR's store.
          if (!data?.existed && realId) {
            const srcName = tasks.find((t) => t.id === source)?.text ?? source;
            const tgtName = tasks.find((t) => t.id === target)?.text ?? target;
            pushUndo({
              label: `dependency ${srcName} → ${tgtName}`,
              run: async () => {
                await fetch(`/api/dependencies/${realId}`, { method: "DELETE" });
                try {
                  apiRef.current?.exec("delete-link", { id: realId });
                } catch {
                  /* link may already be gone from the chart */
                }
                scheduleServerSync();
              },
            });
          }
          // Resync the server-fetched tasks so the left-pane
          // "Depends on" column rebuilds with the new predecessor name.
          // Without this, a drag-drawn arrow on the chart shows as a
          // link but the row still reads "Add dependency…".
          scheduleServerSync();
        })
        .catch((e: unknown) => {
          // Revert unsaved visual link on failure.
          const tempId = ev?.id != null ? String(ev.id) : "";
          if (tempId) api.exec("delete-link", { id: tempId });
          setStatus(e instanceof Error ? e.message : "Dependency create failed");
        });
    });

    // Persist deleted dependency lines.
    api.on("delete-link", (raw: unknown) => {
      const ev = raw as { id?: string | number };
      const incomingId = ev?.id != null ? String(ev.id) : "";
      const id = linkIdAlias.current.get(incomingId) ?? incomingId;
      if (!id) return;
      linkIdAlias.current.delete(incomingId);
      // Capture the link's endpoints & type from the current `links`
      // snapshot before we kill it server-side — we need these to
      // recreate it on undo.
      const deleted = links.find((l) => l.id === id);
      fetch(`/api/dependencies/${id}`, { method: "DELETE" })
        .then(() => {
          // Rebuild the left-pane "Depends on" column text so the
          // deleted predecessor name disappears immediately.
          scheduleServerSync();

          if (deleted) {
            const srcName =
              tasks.find((t) => t.id === deleted.source)?.text ?? deleted.source;
            const tgtName =
              tasks.find((t) => t.id === deleted.target)?.text ?? deleted.target;
            pushUndo({
              label: `delete dependency ${srcName} → ${tgtName}`,
              run: async () => {
                const res = await fetch("/api/dependencies", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    predecessorId: deleted.source,
                    dependentId: deleted.target,
                    type: LINK_TYPE_TO_DEP[deleted.type] ?? "FS",
                  }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  throw new Error(data?.error ?? "Dependency restore failed");
                }
                const newId = data?.dependency?.id
                  ? String(data.dependency.id)
                  : "";
                if (newId) {
                  try {
                    apiRef.current?.exec("add-link", {
                      id: newId,
                      link: {
                        source: deleted.source,
                        target: deleted.target,
                        type: deleted.type,
                      },
                    });
                  } catch {
                    /* SVAR may reject duplicates; server refresh catches up */
                  }
                }
                scheduleServerSync();
              },
            });
          }
        })
        .catch(() => {
          /* ignore */
        });
    });

    api.on("delete-task", (raw: unknown) => {
      const data = raw as { id: string };
      fetch(`/api/tasks/${data.id}`, { method: "DELETE" }).catch(() => {
        /* ignore */
      });
    });

    // Double-clicking a bar normally asks SVAR to open its built-in side
    // editor. We intercept that action, cancel it, and open our own
    // quick-edit popover anchored to the bar so the user stays inside
    // the chart. Intercept returns false to cancel the default.
    const openQuickEditorFor = (id: string) => {
      const root = frameRef.current;
      const barEl = root?.querySelector<HTMLElement>(
        `[data-bar-id="${CSS.escape(id)}"]`,
      );
      const POPOVER_W = 320;
      let anchor = { top: 120, left: 120, width: POPOVER_W };
      if (barEl) {
        const rect = barEl.getBoundingClientRect();
        const left = Math.max(
          12,
          Math.min(
            window.innerWidth - POPOVER_W - 12,
            rect.left + rect.width / 2 - POPOVER_W / 2,
          ),
        );
        const top =
          rect.bottom + 8 + 360 > window.innerHeight
            ? Math.max(12, rect.top - 8 - 360)
            : rect.bottom + 8;
        anchor = { top, left, width: POPOVER_W };
      }
      setBarEditor({ taskId: id, anchor });
    };

    const interceptEditor = (raw: unknown) => {
      const data = raw as { id?: string | number };
      if (data?.id == null) return false;
      openQuickEditorFor(String(data.id));
      return false;
    };
    try {
      api.intercept("show-editor", interceptEditor);
    } catch {
      /* older SVAR versions may not expose this action */
    }
    try {
      api.intercept("open-editor", interceptEditor);
    } catch {
      /* noop */
    }
  }

  const Theme = dark ? WillowDark : Willow;

  async function createTask() {
    if (addingTask) return;
    setAddingTask(true);
    setStatus("Creating task…");
    // The task needs real dates on the backend (schema enforces it), so we
    // still seed a today → +7 placeholder window. That bar is immediately
    // flagged as "unplaced" on the client; clicking anywhere in the timeline
    // row snaps it to the click position.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 1000 * 60 * 60 * 24 * 7);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "New Task",
          description: "",
          type: "TASK",
          status: "TODO",
          startDate: start,
          endDate: end,
          progress: 0,
          sortOrder: 9999,
          tags: [],
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const created = (await res.json()) as { id?: string };
      if (created?.id) {
        setNeedsPlacementIds((prev) => {
          const next = new Set(prev);
          next.add(created.id!);
          return next;
        });
        const newId = created.id;
        pushUndo({
          label: "create task",
          run: async () => {
            await fetch(`/api/tasks/${newId}?mode=cascade`, { method: "DELETE" });
            try {
              apiRef.current?.exec("delete-task", { id: newId });
            } catch {
              /* already gone */
            }
            router.refresh();
          },
        });
      }
      markSaved();
      setStatus("Click anywhere on the timeline to place your new task.");
      router.refresh();
      setTimeout(() => setStatus(""), 4500);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Create task failed");
    } finally {
      setAddingTask(false);
    }
  }

  async function reparentTasks(
    childIds: string[],
    newParentId: string | null,
  ) {
    const byId = new Map(tasks.map((t) => [t.id, t]));

    // Prevent cycles and no-ops: drop tasks that would either be moved
    // under themselves, a descendant of themselves, or already have the
    // desired parent.
    const valid: string[] = [];
    for (const childId of childIds) {
      const child = byId.get(childId);
      if (!child) continue;
      if (childId === newParentId) continue;
      if ((child.parent ?? null) === newParentId) continue;
      if (newParentId) {
        let cursor: string | null | undefined = newParentId;
        const seen = new Set<string>();
        let cyclic = false;
        while (cursor) {
          if (cursor === childId) {
            cyclic = true;
            break;
          }
          if (seen.has(cursor)) break;
          seen.add(cursor);
          cursor = byId.get(cursor)?.parent ?? null;
        }
        if (cyclic) continue;
      }
      valid.push(childId);
    }

    if (valid.length === 0) {
      setStatus("Nothing to move.");
      setTimeout(() => setStatus(""), 1500);
      return;
    }

    const targetName = newParentId
      ? (byId.get(newParentId)?.text ?? "parent")
      : "top level";
    setStatus(
      valid.length === 1
        ? `Moving "${byId.get(valid[0])?.text ?? "task"}" under ${targetName}…`
        : `Moving ${valid.length} tasks under ${targetName}…`,
    );
    // Snapshot the prior parent of each child being moved so Undo can
    // restore the exact previous nesting (including multiple children
    // that came from different parents).
    const priorParents = new Map<string, string | null>();
    for (const id of valid) {
      priorParents.set(id, byId.get(id)?.parent ?? null);
    }

    try {
      await Promise.all(
        valid.map((id) =>
          fetch(`/api/tasks/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ parentId: newParentId }),
          }).then(async (r) => {
            if (!r.ok) throw new Error(await r.text());
          }),
        ),
      );
      markSaved();
      setStatus(
        valid.length === 1
          ? `Moved under ${targetName}.`
          : `Moved ${valid.length} tasks under ${targetName}.`,
      );
      router.refresh();
      setTimeout(() => setStatus(""), 1500);

      pushUndo({
        label:
          valid.length === 1
            ? `move ${byId.get(valid[0])?.text ?? "task"}`
            : `move ${valid.length} tasks`,
        run: async () => {
          // Group ids by their prior parent so we send one PATCH per
          // group instead of N requests.
          const groups = new Map<string | null, string[]>();
          for (const id of valid) {
            const p = priorParents.get(id) ?? null;
            const arr = groups.get(p) ?? [];
            arr.push(id);
            groups.set(p, arr);
          }
          await Promise.all(
            Array.from(groups.entries()).flatMap(([parent, ids]) =>
              ids.map((id) =>
                fetch(`/api/tasks/${id}`, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ parentId: parent }),
                }).then(async (r) => {
                  if (!r.ok) throw new Error(await r.text());
                }),
              ),
            ),
          );
          router.refresh();
        },
      });
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Move failed");
    }
  }

  function reparentTask(childId: string, newParentId: string | null) {
    return reparentTasks([childId], newParentId);
  }

  async function createChildTask(parentId: string) {
    if (addingTask) return;
    setAddingTask(true);
    setStatus("Adding child task…");
    const start = new Date();
    const end = new Date(start.getTime() + 1000 * 60 * 60 * 24 * 7);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "New Task",
          description: "",
          type: "TASK",
          status: "TODO",
          parentId,
          startDate: start,
          endDate: end,
          progress: 0,
          sortOrder: 9999,
          tags: [],
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      markSaved();
      setStatus("Child task added.");
      router.refresh();
      setTimeout(() => setStatus(""), 1400);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Create task failed");
    } finally {
      setAddingTask(false);
    }
  }

  async function deleteTaskRequest(taskId: string, mode: "cascade" | "parent-only") {
    try {
      const res = await fetch(`/api/tasks/${taskId}?mode=${mode}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      markSaved();
      setStatus(
        mode === "parent-only"
          ? "Parent removed. Children promoted to top level."
          : "Task and descendants deleted.",
      );
      router.refresh();
      setTimeout(() => setStatus(""), 1600);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Delete failed");
    }
  }

  function deleteTaskById(taskId: string) {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    const kids = childCountById.get(taskId) ?? 0;
    if (kids > 0) {
      // Parent with children: open the structured modal.
      setDeleteModal({
        id: taskId,
        title: t.text,
        childCount: kids,
      });
      return;
    }
    const ok = window.confirm(`Delete "${t.text}"?`);
    if (!ok) return;
    void deleteTaskRequest(taskId, "cascade");
  }

  function openDependencyEditor(taskId: string) {
    setDepEditorTaskId(taskId);
    setDepEditorQuery("");
    setDepEditorSelected([...(depsByDependent.get(taskId) ?? [])]);
  }

  function openParentEditor(taskIds: string | string[]) {
    const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
    if (ids.length === 0) return;
    setParentEditorIds(ids);
    setParentEditorQuery("");
  }

  async function saveParentEditor(nextParentId: string | null) {
    const ids = parentEditorIds;
    if (ids.length === 0) return;
    setParentEditorSaving(true);
    try {
      await reparentTasks(ids, nextParentId);
      setParentEditorIds([]);
    } finally {
      setParentEditorSaving(false);
    }
  }

  // Persist an assignee / allocation selection for the currently-open
  // resource picker. Goes through the shared commit path so we get the
  // same optimistic update / server resync / rollup behavior as other
  // inline edits. When `allocations` is null we keep the legacy single-
  // owner path so we don't store a 100% split JSON for simple cases.
  async function assignResource(payload: {
    assignee: string | null;
    allocations: Array<{ name: string; percent: number }> | null;
  }) {
    if (!resourcePicker) return;
    const { taskId } = resourcePicker;
    setResourcePicker(null);
    setResourceQuery("");
    await commitInlineEditRef.current(taskId, {
      assignee: payload.assignee,
      allocations: payload.allocations,
    });
  }

  useEffect(() => {
    const root = frameRef.current;
    if (!root) return;
    const onClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      const delBtn = target?.closest("[data-task-delete]") as HTMLElement | null;
      if (delBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = delBtn.getAttribute("data-task-delete");
        if (id) void deleteTaskById(id);
        return;
      }
      const depBtn = target?.closest("[data-deps-edit]") as HTMLElement | null;
      if (depBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = depBtn.getAttribute("data-deps-edit");
        if (id) openDependencyEditor(id);
        return;
      }
      const parentBtn = target?.closest(
        "[data-assign-parent]",
      ) as HTMLElement | null;
      if (parentBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = parentBtn.getAttribute("data-assign-parent");
        if (id) openParentEditor(id);
        return;
      }
      const depCell = target?.closest(
        "[data-deps-cell-edit]",
      ) as HTMLElement | null;
      if (depCell) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = depCell.getAttribute("data-deps-cell-edit");
        if (id) openDependencyEditor(id);
        return;
      }
      const resourceBtn = target?.closest(
        "[data-resource-picker]",
      ) as HTMLElement | null;
      if (resourceBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = resourceBtn.getAttribute("data-resource-picker");
        if (id) {
          // Anchor the dropdown just below the cell button so the menu
          // feels attached to the cell.
          const rect = resourceBtn.getBoundingClientRect();
          setResourceQuery("");
          setResourcePicker({
            taskId: id,
            anchor: {
              top: rect.bottom + 4,
              left: rect.left,
              width: Math.max(rect.width, 220),
            },
          });
        }
        return;
      }

      // Selection: modifier-click selects rows for bulk drag / bulk
      // context-menu actions. We explicitly avoid activating on inline
      // edit inputs, action buttons (handled above), and anywhere outside
      // a task row — those either bubble to existing handlers or clear
      // the selection at the end of this function.
      const row = target?.closest("[data-task-drag-id]") as HTMLElement | null;
      const onInlineInput = !!target?.closest(".inline-edit-input");
      const onGrip = !!target?.closest("[data-task-drag-handle]");
      const hasModifier = ev.shiftKey || ev.metaKey || ev.ctrlKey;

      // Modifier clicks still drive bulk selection. We specifically do
      // NOT treat a plain grip click as "select the row" anymore — users
      // kept clicking near the grip expecting to edit the task name, and
      // got a silent selection instead. Drag still works because drag
      // uses `dragstart`, not `click`.
      if (row && hasModifier) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = row.getAttribute("data-task-drag-id");
        if (!id) return;
        if (ev.shiftKey) {
          const anchor = selectAnchorIdRef.current;
          const order = visualOrderRef.current;
          if (!anchor) {
            selectAnchorIdRef.current = id;
            setSelectedIds(new Set([id]));
          } else {
            const i = order.indexOf(anchor);
            const j = order.indexOf(id);
            if (i === -1 || j === -1) {
              selectAnchorIdRef.current = id;
              setSelectedIds(new Set([id]));
            } else {
              const [lo, hi] = i < j ? [i, j] : [j, i];
              setSelectedIds(new Set(order.slice(lo, hi + 1)));
            }
          }
        } else {
          selectAnchorIdRef.current = id;
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }
        return;
      }

      // Click-to-place: if the user just created a task (or several) and
      // hasn't placed them yet, a click anywhere in the timeline row for
      // that task snaps the bar to the click's date. This is the "no
      // typing dates" affordance — the new task is dropped where you
      // click, with a 1-week default duration that the user can resize
      // afterwards.
      if (!onInlineInput && needsPlacementIdsRef.current.size > 0) {
        // Scope: must be inside the chart pane, not the left table or
        // scale header, and not on a real interactive element.
        const chartPane = target?.closest('[class*="wx-chart"]');
        const isLeftTable = !!target?.closest('[class*="wx-table"]');
        const isScale = !!target?.closest('[class*="wx-scale"]');
        const isOnControl =
          !!target?.closest("button") ||
          !!target?.closest("input") ||
          !!target?.closest("[data-deps-cell-edit]") ||
          !!target?.closest("[data-resource-picker]") ||
          !!target?.closest("[data-task-drag-handle]");
        if (chartPane && !isLeftTable && !isScale && !isOnControl) {
          // Figure out which task row the click landed in by scanning
          // the left-pane mirror rows (same vertical alignment).
          const rowsEls =
            root.querySelectorAll<HTMLElement>("[data-task-drag-id]");
          let placeId: string | null = null;
          for (const r of rowsEls) {
            const rect = r.getBoundingClientRect();
            if (ev.clientY >= rect.top && ev.clientY < rect.bottom) {
              placeId = r.getAttribute("data-task-drag-id");
              break;
            }
          }
          if (placeId && needsPlacementIdsRef.current.has(placeId)) {
            const task = tasks.find((t) => t.id === placeId);
            if (task) {
              // Derive the date-under-click from the task's own bar:
              // we know the bar's pixel rect and its start/end dates,
              // so linear interpolation gives us a clean ms-per-pixel.
              const ownEl = root.querySelector<HTMLElement>(
                `[data-bar-id="${CSS.escape(placeId)}"]`,
              );
              const startOwnMs = new Date(task.start).getTime();
              const endOwnMs = new Date(task.end).getTime();
              let clickMs = Date.now();
              if (ownEl) {
                const rect = ownEl.getBoundingClientRect();
                const span = Math.max(1, endOwnMs - startOwnMs);
                const pxPerMs = rect.width / span;
                if (pxPerMs > 0 && Number.isFinite(pxPerMs)) {
                  clickMs =
                    startOwnMs + (ev.clientX - rect.left) / pxPerMs;
                }
              }
              const duration = Math.max(1, endOwnMs - startOwnMs);
              const start = new Date(clickMs);
              start.setHours(0, 0, 0, 0);
              const end = new Date(start.getTime() + duration);
              ev.preventDefault();
              ev.stopPropagation();
              // Clear the flag optimistically so the pill de-fades
              // immediately, before the server round-trip completes.
              setNeedsPlacementIds((prev) => {
                if (!prev.has(placeId!)) return prev;
                const next = new Set(prev);
                next.delete(placeId!);
                return next;
              });
              void commitInlineEditRef.current(placeId, {
                startDate: start.toISOString(),
                endDate: end.toISOString(),
              });
              return;
            }
          }
        }
      }

      // Click landed outside a task row (e.g. blank toolbar area). If it
      // wasn't inside an input, clear the selection so it doesn't linger.
      // (Actual edit activation happens on pointerup — see below.)
      if (!row && !onInlineInput && selectedIdsRef.current.size > 0) {
        setSelectedIds(new Set());
        selectAnchorIdRef.current = null;
      }
    };

    // Unified edit activation. A "click" that's meant to open a cell's
    // editor is any pointerdown + pointerup pair that didn't travel far
    // (so it isn't a drag) and didn't land on a real control. We track
    // it at the frame level because native `click` gets silently dropped
    // when the pointer lands on text inside a draggable ancestor, which
    // was the source of "sometimes I can't edit the task string".
    const INTERACTIVE_SELECTOR = [
      "button",
      "input",
      "select",
      "textarea",
      ".inline-edit-input",
      "[data-deps-cell-edit]",
      "[data-resource-picker]",
      "[data-assign-parent]",
      "[data-deps-edit]",
      "[data-task-delete]",
      "[data-task-drag-handle]",
    ].join(",");
    let pdX = 0;
    let pdY = 0;
    let pdValid = false;
    const onEditPointerDown = (ev: PointerEvent) => {
      // Primary button only.
      if (ev.button !== 0) {
        pdValid = false;
        return;
      }
      pdX = ev.clientX;
      pdY = ev.clientY;
      pdValid = true;
    };
    const onEditPointerUp = (ev: PointerEvent) => {
      if (!pdValid) return;
      pdValid = false;
      if (ev.button !== 0) return;
      // Modifier-click is reserved for bulk selection — skip editing.
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const dx = Math.abs(ev.clientX - pdX);
      const dy = Math.abs(ev.clientY - pdY);
      if (dx > 4 || dy > 4) return;

      const target = ev.target as HTMLElement | null;
      if (!target) return;
      // Real controls handle their own clicks (and have their own click
      // listeners installed on this frame). Don't hijack them.
      if (target.closest(INTERACTIVE_SELECTOR)) return;

      // Find the editable span sitting in this grid cell. Fall back to
      // the task row for cases where the .wx-cell wrapper isn't present.
      const cell = target.closest(".wx-cell") as HTMLElement | null;
      const row = target.closest("[data-task-drag-id]") as HTMLElement | null;
      const scope = cell ?? row;
      if (!scope) return;
      const span = scope.querySelector(
        ".inline-edit-display:not(.inline-edit-display--readonly)",
      ) as HTMLElement | null;
      if (!span) return;
      const key = span.dataset.editKey;
      if (!key) return;
      const opener = editorOpenersRef.current.get(key);
      if (!opener) return;
      ev.preventDefault();
      ev.stopPropagation();
      opener();
    };

    // Right-click on any task row opens a small floating action menu.
    // When the clicked row is already part of the selection, the menu's
    // actions apply to the whole selection (bulk move / bulk delete).
    // Otherwise it scopes to just this one row and selects it so the
    // visual highlight matches what the menu will act on.
    const onContextMenu = (ev: MouseEvent) => {
      const wrap = (ev.target as HTMLElement | null)?.closest(
        "[data-task-drag-id]",
      ) as HTMLElement | null;
      if (!wrap) return;
      const id = wrap.getAttribute("data-task-drag-id");
      if (!id) return;
      ev.preventDefault();
      ev.stopPropagation();
      const currentSel = selectedIdsRef.current;
      let scope: string[];
      if (currentSel.has(id) && currentSel.size > 1) {
        scope = Array.from(currentSel);
      } else {
        scope = [id];
        selectAnchorIdRef.current = id;
        setSelectedIds(new Set([id]));
      }
      setContextMenu({ x: ev.clientX, y: ev.clientY, taskId: id, scope });
    };

    // HTML5 drag-and-drop for reparenting: drag any task cell onto another
    // task cell to make the dragged task a child of the drop target.
    const DRAG_MIME = "application/x-pm-task-id";
    let dragSourceId: string | null = null;
    let dragIds: string[] = [];

    const clearDropHover = () => {
      root
        .querySelectorAll<HTMLElement>(".task-cell-wrap--drop-target")
        .forEach((el) => el.classList.remove("task-cell-wrap--drop-target"));
    };

    const onDragStart = (ev: DragEvent) => {
      const src = (ev.target as HTMLElement | null)?.closest(
        "[data-task-drag-id]",
      ) as HTMLElement | null;
      if (!src || !ev.dataTransfer) return;
      const id = src.getAttribute("data-task-drag-id");
      if (!id) return;
      // SVAR's react-grid attaches a container-level `dragstart` listener that
      // unconditionally calls preventDefault(), which cancels every HTML5
      // drag. We run in capture phase and stop propagation so SVAR's handler
      // never sees the event. Without this our drag-to-reparent no-ops.
      ev.stopPropagation();
      dragSourceId = id;

      // If the dragged row is part of a multi-row selection, the drop
      // reparents every selected row at once. Otherwise only the grabbed
      // row moves (even if the user had some unrelated selection).
      const sel = selectedIdsRef.current;
      if (sel.has(id) && sel.size > 1) {
        dragIds = Array.from(sel);
      } else {
        dragIds = [id];
      }

      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData(DRAG_MIME, dragIds.join(","));
      ev.dataTransfer.setData("text/plain", id);

      // Paint all rows that are part of this drag so the user sees the
      // full scope lifting together, not just the grabbed one.
      for (const movingId of dragIds) {
        const el = root.querySelector<HTMLElement>(
          `[data-task-drag-id="${CSS.escape(movingId)}"]`,
        );
        el?.classList.add("task-cell-wrap--dragging");
      }
    };

    const onDragEnd = () => {
      dragSourceId = null;
      dragIds = [];
      clearDropHover();
      root
        .querySelectorAll<HTMLElement>(".task-cell-wrap--dragging")
        .forEach((el) => el.classList.remove("task-cell-wrap--dragging"));
    };

    const onDragOver = (ev: DragEvent) => {
      const wrap = (ev.target as HTMLElement | null)?.closest(
        "[data-task-drop-id]",
      ) as HTMLElement | null;
      if (!wrap) return;
      const dropId = wrap.getAttribute("data-task-drop-id");
      if (!dropId) return;
      // Can't drop onto any of the rows we're currently dragging.
      if (dragIds.length > 0 && dragIds.includes(dropId)) return;
      if (dropId === dragSourceId) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      if (!wrap.classList.contains("task-cell-wrap--drop-target")) {
        clearDropHover();
        wrap.classList.add("task-cell-wrap--drop-target");
      }
    };

    const onDragLeave = (ev: DragEvent) => {
      const wrap = (ev.target as HTMLElement | null)?.closest(
        "[data-task-drop-id]",
      ) as HTMLElement | null;
      if (wrap) wrap.classList.remove("task-cell-wrap--drop-target");
    };

    const onDrop = (ev: DragEvent) => {
      const wrap = (ev.target as HTMLElement | null)?.closest(
        "[data-task-drop-id]",
      ) as HTMLElement | null;
      if (!wrap) return;
      const dropId = wrap.getAttribute("data-task-drop-id");
      clearDropHover();
      if (!dropId) return;

      // Prefer the batch payload; fall back to legacy single-id channel.
      const raw = ev.dataTransfer?.getData(DRAG_MIME) ?? "";
      const batch = raw
        ? raw.split(",").filter(Boolean)
        : dragIds.length > 0
          ? dragIds
          : dragSourceId
            ? [dragSourceId]
            : [];
      if (batch.length === 0) return;
      if (batch.includes(dropId)) return;
      ev.preventDefault();
      ev.stopPropagation();
      void reparentTasks(batch, dropId);
    };

    // SVAR attaches a container-level mousedown listener that boots its
    // own row-reorder drag on every mousedown inside the grid. We stop
    // that propagation for non-interactive row chrome so SVAR's drag
    // doesn't fight with ours. Interactive controls (inputs, buttons,
    // the grip, etc.) are allowed through so their native behavior
    // still works.
    const onMouseDownCapture = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest("[data-task-drag-id]")) return;

      const allowThrough =
        target.closest(".inline-edit-display") ||
        target.closest(".inline-edit-input") ||
        target.closest("[data-task-drag-handle]") ||
        target.closest("[data-deps-cell-edit]") ||
        target.closest("[data-resource-picker]") ||
        target.closest("[data-assign-parent]") ||
        target.closest("[data-deps-edit]") ||
        target.closest("[data-task-delete]") ||
        target.closest("button") ||
        target.closest("input") ||
        target.closest("select") ||
        target.closest("textarea");

      if (allowThrough) return;
      ev.stopPropagation();
    };

    // Double-click a bar to open the quick-edit popover. We anchor off
    // the .task-pill-wrap (our template root — has data-bar-id) so the
    // popover lines up with the bar regardless of SVAR's internal
    // container chrome around it.
    const onDblClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const barEl = target.closest("[data-bar-id]") as HTMLElement | null;
      if (!barEl) return;
      const id = barEl.getAttribute("data-bar-id");
      if (!id) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = barEl.getBoundingClientRect();
      const POPOVER_W = 320;
      const left = Math.max(
        12,
        Math.min(
          window.innerWidth - POPOVER_W - 12,
          rect.left + rect.width / 2 - POPOVER_W / 2,
        ),
      );
      // Prefer anchoring below the bar; flip above if we'd fall off
      // the viewport bottom.
      const top =
        rect.bottom + 8 + 360 > window.innerHeight
          ? Math.max(12, rect.top - 8 - 360)
          : rect.bottom + 8;
      setBarEditor({ taskId: id, anchor: { top, left, width: POPOVER_W } });
    };

    root.addEventListener("click", onClick);
    root.addEventListener("dblclick", onDblClick, true);
    root.addEventListener("mousedown", onMouseDownCapture, true);
    // Pointer events bubble to us regardless of whether the browser
    // decides to synthesize a click (draggable ancestors can suppress
    // clicks on text nodes). We use them as the single source of truth
    // for opening inline cell editors.
    root.addEventListener("pointerdown", onEditPointerDown);
    root.addEventListener("pointerup", onEditPointerUp);
    // Capture phase: run before SVAR's internal dragstart handler
    // (which would otherwise preventDefault and cancel the drag).
    root.addEventListener("dragstart", onDragStart, true);
    root.addEventListener("dragend", onDragEnd, true);
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("dragleave", onDragLeave);
    root.addEventListener("drop", onDrop);
    // Capture phase so we reach the event before SVAR's internal handlers,
    // which otherwise swallow the contextmenu.
    root.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("dblclick", onDblClick, true);
      root.removeEventListener("mousedown", onMouseDownCapture, true);
      root.removeEventListener("pointerdown", onEditPointerDown);
      root.removeEventListener("pointerup", onEditPointerUp);
      root.removeEventListener("dragstart", onDragStart, true);
      root.removeEventListener("dragend", onDragEnd, true);
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("dragleave", onDragLeave);
      root.removeEventListener("drop", onDrop);
      root.removeEventListener("contextmenu", onContextMenu, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, depsByDependent]);

  // Paint the visual selection directly on the DOM. We deliberately
  // don't thread `selectedIds` through the memoized cell components —
  // that would invalidate them on every click and force SVAR to rebuild
  // the grid. A simple classList pass over existing rows is cheaper
  // and keeps the cells referentially stable.
  useEffect(() => {
    const root = frameRef.current;
    if (!root) return;
    const rows = root.querySelectorAll<HTMLElement>("[data-task-drag-id]");
    rows.forEach((el) => {
      const id = el.getAttribute("data-task-drag-id");
      if (!id) return;
      if (selectedIds.has(id)) {
        el.classList.add("task-cell-wrap--selected");
      } else {
        el.classList.remove("task-cell-wrap--selected");
      }
    });
  }, [selectedIds, tasks]);

  // Dismiss the context menu on any outside click, escape, or scroll.
  // We rely on a window-level listener because the menu floats above
  // the Gantt frame, and we want it to dismiss regardless of what the
  // user clicks next.
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    const onWindowClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-task-context-menu]")) return;
      setContextMenu(null);
    };
    const onScroll = () => setContextMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onWindowClick);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onWindowClick);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [contextMenu]);

  async function saveDependencyEditor() {
    if (!depEditorTaskId) return;
    setDepEditorSaving(true);
    setStatus("Saving dependencies…");
    try {
      const res = await fetch(`/api/tasks/${depEditorTaskId}/dependencies`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ predecessorIds: depEditorSelected }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Failed to save dependencies");
      setDepEditorTaskId(null);
      setStatus("Dependencies updated.");
      markSaved();
      router.refresh();
      setTimeout(() => setStatus(""), 1200);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Failed to save dependencies");
    } finally {
      setDepEditorSaving(false);
    }
  }

  /**
   * Expand / collapse every parent row (anything with children) via SVAR's
   * `open-task` action. SVAR doesn't expose a "close-task" action —
   * instead, `open-task` takes `{ id, mode }` where `mode: true` opens
   * and `mode: false` closes. We iterate only the actual parent ids
   * (those with children) both for performance and to avoid bumping
   * SVAR's store with no-op updates on leaf rows.
   */
  function setAllExpanded(expanded: boolean) {
    const api = apiRef.current;
    if (!api) {
      setStatus("Chart not ready yet.");
      setTimeout(() => setStatus(""), 1200);
      return;
    }
    let touched = 0;
    for (const t of tasks) {
      const kids = childCountByIdRef.current.get(t.id) ?? 0;
      if (kids <= 0) continue;
      try {
        api.exec("open-task", { id: t.id, mode: expanded });
        touched++;
      } catch {
        /* some rows may not be openable (leaves) */
      }
    }
    setStatus(
      expanded
        ? `Expanded ${touched} parent${touched === 1 ? "" : "s"}.`
        : `Collapsed ${touched} parent${touched === 1 ? "" : "s"}.`,
    );
    setTimeout(() => setStatus(""), 1200);
  }

  // Compute the set of task ids relevant to the current search query.
  // `directMatchIds` = rows whose text actually contains the query;
  // `searchMatchIds` extends that with all their ancestors so matches
  // aren't hidden inside collapsed parents. Null means "no active
  // search" — the effect below skips masking DOM rows in that case.
  const directMatchIds = useMemo<Set<string> | null>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;
    const m = new Set<string>();
    for (const t of tasks) if (t.text.toLowerCase().includes(q)) m.add(t.id);
    return m;
  }, [searchQuery, tasks]);

  const searchMatchIds = useMemo<Set<string> | null>(() => {
    if (!directMatchIds) return null;
    if (directMatchIds.size === 0) return directMatchIds;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const full = new Set<string>(directMatchIds);
    for (const id of directMatchIds) {
      let cur = byId.get(id)?.parent ?? null;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        full.add(cur);
        cur = byId.get(cur)?.parent ?? null;
      }
    }
    return full;
  }, [directMatchIds, tasks]);

  // Keep the latest match set in a ref so the MutationObserver-driven
  // painter below always re-paints against current state without needing
  // to be torn down and rebuilt on every keystroke.
  const searchMatchRef = useRef<Set<string> | null>(null);
  const searchPaintRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    searchMatchRef.current = searchMatchIds;
  }, [searchMatchIds]);

  // Apply the search to DOM rows. We paint .is-search-hidden and
  // .is-search-match classes directly instead of rebuilding the tasks
  // array (which would re-init the SVAR chart). SVAR virtualizes rows,
  // so a MutationObserver re-runs the painter whenever rows mount or
  // re-render. On first keystroke we also open all ancestors of
  // matches so nothing stays buried inside a collapsed parent, and
  // scroll the first match into view.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const paint = () => {
      const matches = searchMatchRef.current;
      const rows = frame.querySelectorAll<HTMLElement>("[data-task-drag-id]");
      if (!matches) {
        rows.forEach((r) => {
          r.classList.remove("is-search-match");
          const rowEl = r.closest(".wx-row") as HTMLElement | null;
          rowEl?.classList.remove("is-search-hidden", "is-search-match");
        });
        frame
          .querySelectorAll<HTMLElement>(".wx-bar.is-search-match")
          .forEach((el) => el.classList.remove("is-search-match"));
        return;
      }
      rows.forEach((r) => {
        const id = r.getAttribute("data-task-drag-id");
        const rowEl = r.closest(".wx-row") as HTMLElement | null;
        if (id && matches.has(id)) {
          r.classList.add("is-search-match");
          rowEl?.classList.add("is-search-match");
          rowEl?.classList.remove("is-search-hidden");
        } else {
          r.classList.remove("is-search-match");
          rowEl?.classList.remove("is-search-match");
          rowEl?.classList.add("is-search-hidden");
        }
      });
      frame.querySelectorAll<HTMLElement>(".wx-bar").forEach((bar) => {
        const inner = bar.querySelector<HTMLElement>("[data-bar-id]");
        const id = inner?.getAttribute("data-bar-id");
        if (id && matches.has(id)) bar.classList.add("is-search-match");
        else bar.classList.remove("is-search-match");
      });
    };

    // Re-paint when SVAR swaps or reorders row DOM (virtualization,
    // expand/collapse, drag, etc). Coalesce with rAF so bursts of
    // mutations turn into a single paint.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        paint();
      });
    };
    const mo = new MutationObserver(schedule);
    mo.observe(frame, { subtree: true, childList: true });

    paint();

    // Expose the painter + any pending first-match scroll for the
    // query-driven effect below.
    searchPaintRef.current = paint;

    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      searchPaintRef.current = null;
    };
  }, []);

  // When the query changes: expand ancestors of matches, ask the
  // painter to repaint, and scroll the first match into view.
  useEffect(() => {
    searchPaintRef.current?.();
    if (!searchMatchIds || searchMatchIds.size === 0) return;
    const api = apiRef.current;
    if (api) {
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const id of searchMatchIds) {
        let cur = byId.get(id)?.parent ?? null;
        const seen = new Set<string>();
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          try {
            api.exec("open-task", { id: cur });
          } catch {
            /* ignore */
          }
          cur = byId.get(cur)?.parent ?? null;
        }
      }
    }
    // Defer the scroll so open-task mutations have a chance to land
    // in the DOM before we ask the browser to center on the row.
    const t = setTimeout(() => {
      const frame = frameRef.current;
      if (!frame) return;
      const firstId = directMatchIds
        ? Array.from(directMatchIds)[0]
        : undefined;
      if (!firstId) return;
      const el = frame.querySelector<HTMLElement>(
        `[data-task-drag-id="${CSS.escape(firstId)}"]`,
      );
      const rowEl = (el?.closest(".wx-row") as HTMLElement | null) ?? el;
      rowEl?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMatchIds, directMatchIds]);

  async function autoChainDependencies() {
    setStatus("Creating automatic dependencies…");
    try {
      const res = await fetch("/api/dependencies/auto-chain", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Auto-chain failed");
      const created: Array<{
        id: string;
        source: string;
        target: string;
        type: "e2s" | "s2s" | "e2e" | "s2e";
      }> = data?.created ?? [];
      setStatus(
        created.length
          ? `Created ${created.length} dependencies.`
          : "No new dependencies needed.",
      );
      if (apiRef.current) {
        for (const l of created) {
          await apiRef.current.exec("add-link", {
            link: {
              id: l.id,
              source: l.source,
              target: l.target,
              type: l.type,
            },
          });
        }
      }
      setTimeout(() => setStatus(""), 1000);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Auto-chain failed");
    }
  }

  return (
    <div className="gantt-wrap">
      <div className="gantt-controls">
        <div className="gantt-zoom" role="group" aria-label="Zoom level">
          {(["day", "week", "month", "quarter"] as ZoomLevel[]).map((z) => (
            <button
              key={z}
              onClick={() => setZoom(z)}
              className={`gantt-zoom-btn ${zoom === z ? "is-active" : ""}`}
            >
              {z[0].toUpperCase() + z.slice(1)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              if (!dateRange) return;
              const days =
                (dateRange.end.getTime() - dateRange.start.getTime()) /
                86_400_000;
              const next = pickZoomForSpanDays(days);
              setZoom(next);
              // After the scale re-renders, scroll so the earliest
              // task sits just inside the timeline's left edge. SVAR
              // keeps scrolling state on the outer gantt frame.
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  const frame = frameRef.current;
                  if (!frame) return;
                  let earliestLeft = Infinity;
                  let earliestEl: HTMLElement | null = null;
                  frame
                    .querySelectorAll<HTMLElement>("[data-bar-id]")
                    .forEach((el) => {
                      const r = el.getBoundingClientRect();
                      if (r.width === 0) return;
                      if (r.left < earliestLeft) {
                        earliestLeft = r.left;
                        earliestEl = el;
                      }
                    });
                  if (!earliestEl) return;
                  const area =
                    (frame.querySelector(".wx-area") as HTMLElement | null) ??
                    (frame.querySelector(".wx-chart") as HTMLElement | null);
                  if (!area) return;
                  const areaRect = area.getBoundingClientRect();
                  const barRect = (
                    earliestEl as HTMLElement
                  ).getBoundingClientRect();
                  area.scrollBy({
                    left: barRect.left - areaRect.left - 72,
                    behavior: "smooth",
                  });
                });
              });
            }}
            className="gantt-zoom-btn"
            title="Fit the whole project in view"
            disabled={!dateRange}
          >
            Fit
          </button>
        </div>
        <div className="gantt-controls-divider" aria-hidden />
        <button
          type="button"
          onClick={() => void undoLastRef.current()}
          className="gantt-undo-btn"
          disabled={undoStackRef.current.length === 0}
          title={
            undoStackRef.current.length === 0
              ? "Nothing to undo"
              : `Undo ${undoStackRef.current[undoStackRef.current.length - 1]?.label ?? "last change"} (⌘Z)`
          }
          data-undo-tick={undoTick}
          aria-label="Undo last change"
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
            aria-hidden="true"
          >
            <path d="M3 7v6h6" />
            <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
          </svg>
          <span>Undo</span>
          <kbd className="gantt-undo-kbd" aria-hidden="true">⌘Z</kbd>
        </button>
        <div className="gantt-controls-divider" aria-hidden />
        <div className="gantt-search" role="search">
          {searchOpen ? (
            <>
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="gantt-search__icon"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSearchQuery("");
                    setSearchOpen(false);
                  }
                }}
                placeholder="Search tasks…"
                className="gantt-search__input"
                aria-label="Search tasks"
              />
              {searchQuery && directMatchIds && (
                <span className="gantt-search__count">
                  {directMatchIds.size} match
                  {directMatchIds.size === 1 ? "" : "es"}
                </span>
              )}
              <button
                type="button"
                className="gantt-search__close"
                onClick={() => {
                  setSearchQuery("");
                  setSearchOpen(false);
                }}
                title="Close search (Esc)"
                aria-label="Close search"
              >
                ×
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 0);
              }}
              className="gantt-linkmode-btn"
              title="Search tasks"
            >
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ marginRight: 5, verticalAlign: "-1px" }}
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              Search
            </button>
          )}
        </div>
        <GanttFilterMenu
          ref={filterMenuRef}
          open={filterOpen}
          setOpen={setFilterOpen}
          tasks={tasks}
          hiddenSubtreeIds={hiddenSubtreeIds}
          setHiddenSubtreeIds={setHiddenSubtreeIds}
          hiddenUrgencies={hiddenUrgencies}
          setHiddenUrgencies={setHiddenUrgencies}
        />
        <button
          type="button"
          onClick={() => setAllExpanded(true)}
          className="gantt-linkmode-btn"
          title="Expand all parent rows"
        >
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ marginRight: 5, verticalAlign: "-1px" }}
          >
            <path d="M6 9l6 6 6-6" />
            <path d="M6 4l6 6 6-6" />
          </svg>
          Expand all
        </button>
        <button
          type="button"
          onClick={() => setAllExpanded(false)}
          className="gantt-linkmode-btn"
          title="Collapse all parent rows"
        >
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ marginRight: 5, verticalAlign: "-1px" }}
          >
            <path d="M6 15l6-6 6 6" />
            <path d="M6 20l6-6 6 6" />
          </svg>
          Collapse all
        </button>
        <button
          type="button"
          onClick={() => setChartOnly((v) => !v)}
          className={
            "gantt-linkmode-btn" + (chartOnly ? " is-active" : "")
          }
          title={
            chartOnly
              ? "Show the task table again"
              : "Hide the task table and give the timeline the full width"
          }
          aria-pressed={chartOnly}
        >
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ marginRight: 5, verticalAlign: "-1px" }}
          >
            {chartOnly ? (
              <>
                {/* Two panes icon — clicking returns the table. */}
                <rect x="3" y="4" width="7" height="16" rx="1.5" />
                <rect x="13" y="4" width="8" height="16" rx="1.5" />
              </>
            ) : (
              <>
                {/* Single wide pane icon — clicking hides the table. */}
                <rect x="3" y="4" width="18" height="16" rx="1.5" />
                <path d="M8 9h9M8 13h9M8 17h6" />
              </>
            )}
          </svg>
          {chartOnly ? "Show table" : "Hide table"}
        </button>
        <div className="gantt-controls-divider" aria-hidden />
        <button
          type="button"
          onClick={createTask}
          className="gantt-linkmode-btn is-active"
          title="Create a task. Drag it onto another to nest it (Program → Workstream → Task → Subtask)"
          disabled={addingTask}
        >
          {addingTask ? "Adding…" : "+ Create task"}
        </button>
        <button
          type="button"
          onClick={autoChainDependencies}
          className="gantt-linkmode-btn"
          title="Create sequential dependencies with one click"
        >
          Auto-link
        </button>
        {criticalPathTargetId ? (
          <button
            type="button"
            onClick={() => setCriticalPathTargetId(null)}
            className="gantt-linkmode-btn gantt-crit-clear"
            title="Clear critical-path highlight (Esc)"
          >
            <span className="gantt-crit-dot" aria-hidden />
            Clear critical path
            <span className="gantt-crit-target">
              {tasks.find((t) => t.id === criticalPathTargetId)?.text ?? ""}
            </span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setStatus("Refreshing…");
            router.refresh();
            setTimeout(() => setStatus(""), 900);
          }}
          className="gantt-linkmode-btn"
          title="Reload roadmap from server"
        >
          Refresh
        </button>
        <div className="gantt-saved" aria-live="polite" title="Auto-save status">
          <span className="gantt-saved-dot" />
          {status
            ? status
            : lastSavedAt
              ? `Saved ${formatRelative(lastSavedAt, savedTick)}`
              : "Auto-saves as you edit"}
        </div>
      </div>

      <div
        className={"gantt-frame" + (chartOnly ? " gantt-frame--chart-only" : "")}
        ref={frameRef}
      >
        {tasks.length === 0 && emptyState ? (
          <div className="gantt-empty-overlay">{emptyState}</div>
        ) : (
          <Theme>
            <Gantt
              tasks={initialTasks}
              links={visibleLinks}
              scales={scales}
              zoom={false}
              columns={columns}
              cellHeight={56}
              scaleHeight={28}
              cellWidth={zoom === "quarter" ? 80 : zoom === "month" ? 100 : 40}
              cellBorders="full"
              init={init}
              taskTemplate={TaskTemplate}
              {...(dateRange
                ? { start: dateRange.start, end: dateRange.end }
                : {})}
            />
          </Theme>
        )}
        {tasks.length > 0 ? (
          <HierarchyOverlay tasks={tasks} frameRef={frameRef} />
        ) : null}
        {tasks.length > 0 ? (
          <TodayOverlay tasks={tasks} frameRef={frameRef} />
        ) : null}
      </div>
      {depEditorTaskId && (
        <DepsPicker
          taskId={depEditorTaskId}
          tasks={tasks}
          depsByDependent={depsByDependent}
          selected={depEditorSelected}
          setSelected={setDepEditorSelected}
          query={depEditorQuery}
          setQuery={setDepEditorQuery}
          saving={depEditorSaving}
          onCancel={() => setDepEditorTaskId(null)}
          onSave={saveDependencyEditor}
          levelForRow={levelForRow}
          depthById={depthById}
          childCountById={childCountById}
        />
      )}

      {deleteModal && (
        <div
          className="deps-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteModal(null);
          }}
        >
          <div className="deps-modal">
            <h3 className="deps-modal-title">Delete this task?</h3>
            <p className="deps-modal-subtitle">
              <strong>{deleteModal.title}</strong> has {deleteModal.childCount}{" "}
              nested{" "}
              {deleteModal.childCount === 1 ? "item" : "items"} under it. Choose
              how to handle them.
            </p>
            <div className="delete-modal-options">
              <button
                type="button"
                className="delete-modal-option"
                onClick={() => {
                  const m = deleteModal;
                  setDeleteModal(null);
                  void deleteTaskRequest(m.id, "parent-only");
                }}
              >
                <span className="delete-modal-option-title">
                  Delete this one only
                </span>
                <span className="delete-modal-option-desc">
                  Keep everything nested below and promote it up to the top
                  level.
                </span>
              </button>
              <button
                type="button"
                className="delete-modal-option delete-modal-option--danger"
                onClick={() => {
                  const m = deleteModal;
                  setDeleteModal(null);
                  void deleteTaskRequest(m.id, "cascade");
                }}
              >
                <span className="delete-modal-option-title">
                  Delete this and everything nested below
                </span>
                <span className="delete-modal-option-desc">
                  Permanently removes {deleteModal.childCount}{" "}
                  {deleteModal.childCount === 1 ? "item" : "items"} and related
                  dependencies.
                </span>
              </button>
            </div>
            <div className="deps-modal-actions">
              <button
                className="gantt-linkmode-btn"
                onClick={() => setDeleteModal(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {parentEditorIds.length > 0 && (
        <ParentPicker
          scopeIds={parentEditorIds}
          tasks={tasks}
          query={parentEditorQuery}
          setQuery={setParentEditorQuery}
          saving={parentEditorSaving}
          onCancel={() => setParentEditorIds([])}
          onSave={saveParentEditor}
          levelForRow={levelForRow}
          depthById={depthById}
          childCountById={childCountById}
        />
      )}

      {resourcePicker &&
        (() => {
          const t = tasks.find((x) => x.id === resourcePicker.taskId);
          const parsed = parseAllocationsJSON(t?.allocations ?? null);
          // Clamp inside viewport so a picker opened near the bottom of
          // the grid doesn't render half off-screen. 500 is a generous
          // estimate of max picker height (see .alloc-picker max-height
          // in globals.css — 480 + a touch of breathing room).
          const top = Math.min(
            resourcePicker.anchor.top,
            Math.max(8, window.innerHeight - 500),
          );
          const left = Math.min(
            resourcePicker.anchor.left,
            Math.max(8, window.innerWidth - 360),
          );
          return (
            <AllocationPicker
              people={people}
              currentAllocations={parsed}
              currentAssignee={t?.assignee ?? null}
              taskEffortHours={t?.effortHours ?? null}
              style={{
                position: "fixed",
                top,
                left,
                right: "auto",
              }}
              onClose={() => {
                setResourcePicker(null);
                setResourceQuery("");
              }}
              onSave={async (payload) => {
                await assignResource(payload);
              }}
            />
          );
        })()}

      {barEditor &&
        (() => {
          const t = tasks.find((x) => x.id === barEditor.taskId);
          if (!t) return null;
          return (
            <BarQuickEditor
              anchor={barEditor.anchor}
              task={t}
              people={people}
              onCancel={() => setBarEditor(null)}
              onSave={async (patch) => {
                await commitInlineEditRef.current(barEditor.taskId, patch);
                setBarEditor(null);
              }}
            />
          );
        })()}

      {contextMenu && (
        <div
          className="task-context-menu"
          data-task-context-menu
          style={{ top: contextMenu.y, left: contextMenu.x }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="task-context-header">
            {contextMenu.scope.length > 1
              ? `${contextMenu.scope.length} tasks selected`
              : (tasks.find((t) => t.id === contextMenu.taskId)?.text ??
                "Task")}
          </div>
          {contextMenu.scope.length === 1 && (
            <button
              type="button"
              className="task-context-item"
              onClick={() => {
                const id = contextMenu.taskId;
                setContextMenu(null);
                void createChildTask(id);
              }}
            >
              <span className="task-context-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              Add child task
            </button>
          )}
          {contextMenu.scope.length === 1 && (
            <button
              type="button"
              className="task-context-item"
              onClick={() => {
                const id = contextMenu.taskId;
                setContextMenu(null);
                // Deep-link to Open Issues with this task prefilled as
                // the linked task in the create form.
                if (typeof window !== "undefined") {
                  window.location.href = `/open-issues?taskId=${encodeURIComponent(id)}&focus=all`;
                }
              }}
            >
              <span className="task-context-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v4M12 16h.01" />
                </svg>
              </span>
              Create Issue from Task
            </button>
          )}
          <button
            type="button"
            className="task-context-item"
            onClick={() => {
              const scope = contextMenu.scope;
              setContextMenu(null);
              openParentEditor(scope);
            }}
          >
            <span className="task-context-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <path d="M8 13h8" />
              </svg>
            </span>
            {contextMenu.scope.length > 1
              ? `Move ${contextMenu.scope.length} tasks under parent…`
              : "Move under parent…"}
          </button>
          <div className="task-context-sep" />
          <button
            type="button"
            className="task-context-item task-context-item--danger"
            onClick={() => {
              const scope = contextMenu.scope;
              setContextMenu(null);
              if (scope.length === 1) {
                deleteTaskById(scope[0]);
                return;
              }
              const ok = window.confirm(
                `Delete ${scope.length} tasks (and everything nested under them)?`,
              );
              if (!ok) return;
              setSelectedIds(new Set());
              void Promise.all(
                scope.map((id) => deleteTaskRequest(id, "cascade")),
              );
            }}
          >
            <span className="task-context-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
            </span>
            {contextMenu.scope.length > 1
              ? `Delete ${contextMenu.scope.length} tasks`
              : "Delete task"}
          </button>
        </div>
      )}
    </div>
  );
}

const LEVEL_DEFS = [
  { slug: "program", label: "Program", title: "Program — top-level initiative" },
  { slug: "workstream", label: "Workstream", title: "Workstream — major area of work" },
  { slug: "task", label: "Task", title: "Task" },
  { slug: "subtask", label: "Subtask", title: "Subtask" },
] as const;

function levelForRow(
  rowType: string,
  depth: number,
  childCount: number,
): {
  slug: "program" | "workstream" | "task" | "subtask" | "issue";
  label: string;
  title: string;
  showChip: boolean;
} {
  if (rowType === "ISSUE") {
    return {
      slug: "issue",
      label: "Issue",
      title: "Open issue linked to a task",
      showChip: true,
    };
  }
  // Clamp deeper nesting into the deepest label bucket (Subtask).
  const idx = Math.min(Math.max(depth, 0), LEVEL_DEFS.length - 1);
  const def = LEVEL_DEFS[idx];
  // Only hide the chip for a leaf task that hasn't been nested under anything
  // yet AND has no children of its own. Everything else shows a chip so the
  // level is always explicit.
  const showChip = depth > 0 || childCount > 0;
  return {
    slug: def.slug,
    label: def.label,
    title: def.title,
    showChip,
  };
}

function DepsPicker({
  taskId,
  tasks,
  depsByDependent,
  selected,
  setSelected,
  query,
  setQuery,
  saving,
  onCancel,
  onSave,
  levelForRow,
  depthById,
  childCountById,
}: {
  taskId: string;
  tasks: GanttTaskInput[];
  depsByDependent: Map<string, string[]>;
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  query: string;
  setQuery: (q: string) => void;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  levelForRow: (
    rowType: string,
    depth: number,
    childCount: number,
  ) => {
    slug: string;
    label: string;
    title: string;
    showChip: boolean;
  };
  depthById: Map<string, number>;
  childCountById: Map<string, number>;
}) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    // Focus search as soon as the picker opens.
    searchRef.current?.focus();
  }, []);

  const selfTask = useMemo(
    () => tasks.find((t) => t.id === taskId) ?? null,
    [tasks, taskId],
  );

  // Compute descendants of the current task (via depsByDependent *reverse* —
  // but here we use parent hierarchy since deps graph cycles are blocked by
  // the server). Simpler: block the task itself plus anything currently
  // listing it as a dependency ancestor. For now keep cycle prevention on
  // the server and only filter self + ISSUE rows here.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (t.id === taskId) return false;
      if (t.rowType === "ISSUE") return false;
      if (!q) return true;
      return t.text.toLowerCase().includes(q);
    });
  }, [tasks, taskId, query]);

  const selectedTasks = useMemo(
    () =>
      selected
        .map((id) => tasks.find((t) => t.id === id))
        .filter((t): t is GanttTaskInput => Boolean(t)),
    [selected, tasks],
  );

  const currentDepIds = depsByDependent.get(taskId) ?? [];
  const selectedSet = new Set(selected);
  const currentSet = new Set(currentDepIds);
  const hasChanges =
    selected.length !== currentDepIds.length ||
    selected.some((id) => !currentSet.has(id)) ||
    currentDepIds.some((id) => !selectedSet.has(id));

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function onSearchKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onCancel();
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, candidates.length - 1)));
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      const hit = candidates[activeIndex];
      if (hit) toggle(hit.id);
      return;
    }
    if (ev.key === "Backspace" && query === "" && selected.length > 0) {
      // Quick-remove the last chip when the input is empty.
      ev.preventDefault();
      setSelected((prev) => prev.slice(0, -1));
    }
  }

  // Reset active index when query changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  return (
    <div
      className="deps-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="deps-modal deps-picker"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <div className="deps-picker-header">
          <div className="deps-picker-title-block">
            <h3 className="deps-modal-title">Depends on</h3>
            {selfTask && (
              <p className="deps-modal-subtitle">
                Tasks that must finish before{" "}
                <strong>{selfTask.text}</strong> can start.
              </p>
            )}
          </div>
          <span className="deps-picker-count">
            {selected.length} selected
          </span>
        </div>

        <div className="deps-picker-combo">
          <div className="deps-picker-chips">
            {selectedTasks.length === 0 && (
              <span className="deps-picker-chips-empty">No dependencies yet</span>
            )}
            {selectedTasks.map((t) => (
              <span key={t.id} className="deps-picker-chip" title={t.text}>
                <span className="deps-picker-chip-text">{t.text}</span>
                <button
                  type="button"
                  className="deps-picker-chip-remove"
                  onClick={() => toggle(t.id)}
                  aria-label={`Remove ${t.text}`}
                  title="Remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <input
            ref={searchRef}
            className="deps-picker-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={
              selectedTasks.length === 0
                ? "Search tasks to add as dependency…"
                : "Search to add more…"
            }
          />
        </div>

        <div className="deps-picker-list">
          {candidates.length === 0 && (
            <div className="deps-picker-empty">
              {query
                ? `No tasks match "${query}".`
                : "No other tasks available."}
            </div>
          )}
          {candidates.map((t, idx) => {
            const checked = selectedSet.has(t.id);
            const isActive = idx === activeIndex;
            const depth = depthById.get(t.id) ?? 0;
            const childCount = childCountById.get(t.id) ?? 0;
            const level = levelForRow(t.rowType, depth, childCount);
            return (
              <button
                key={t.id}
                type="button"
                className={
                  "deps-picker-item" +
                  (checked ? " deps-picker-item--checked" : "") +
                  (isActive ? " deps-picker-item--active" : "")
                }
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => toggle(t.id)}
              >
                <span className="deps-picker-item-check" aria-hidden="true">
                  {checked ? (
                    <svg
                      viewBox="0 0 24 24"
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : null}
                </span>
                {level.showChip && (
                  <span
                    className={`task-row-kind task-row-kind--${level.slug}`}
                  >
                    {level.label}
                  </span>
                )}
                <span className="deps-picker-item-text">{t.text}</span>
              </button>
            );
          })}
        </div>

        <div className="deps-picker-footer">
          <span className="deps-picker-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> to navigate, <kbd>Enter</kbd> to toggle,{" "}
            <kbd>Esc</kbd> to close
          </span>
          <div className="deps-modal-actions">
            <button
              className="gantt-linkmode-btn"
              onClick={onCancel}
              disabled={saving}
              type="button"
            >
              Cancel
            </button>
            <button
              className="gantt-linkmode-btn is-active"
              onClick={onSave}
              disabled={saving || !hasChanges}
              type="button"
            >
              {saving ? "Saving…" : hasChanges ? "Save" : "No changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function shortDate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Draws subtle L-shaped translucent lines from each parent bar down to
 * every directly-nested child bar visible in the Gantt chart. Bars are
 * located via `data-bar-id` attributes on each task pill, so the
 * overlay follows scroll, zoom, expand/collapse, and drag-to-reschedule
 * automatically without any coordination from the SVAR internals.
 *
 * The overlay lives *inside* the gantt-frame as an absolutely
 * positioned SVG so it naturally inherits the frame's clipping — lines
 * that would fall off the visible timeline are never painted. Pointer
 * events are disabled so the overlay never steals clicks from bars.
 */
function HierarchyOverlay({
  tasks,
  frameRef,
}: {
  tasks: Array<{ id: string; parent: string | null }>;
  frameRef: React.RefObject<HTMLDivElement | null>;
}) {
  // A monotonically increasing tick we bump whenever the geometry of
  // the bars could have changed. Used as the sole dep that forces a
  // re-render so the useMemo below recomputes positions against fresh
  // `getBoundingClientRect()` values.
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setTick((t) => t + 1);
      });
    };

    // Resize of the frame or any descendant (bars growing, columns
    // resizing) invalidates cached positions.
    const ro = new ResizeObserver(schedule);
    ro.observe(frame);

    // Bars move around whenever SVAR updates its DOM — drag, expand,
    // zoom, task edits. Watching mutations is overkill but cheap given
    // the request-animation-frame coalescing above.
    const mo = new MutationObserver(schedule);
    mo.observe(frame, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "transform"],
      childList: true,
    });

    // Horizontal/vertical scroll of the timeline body shifts bar
    // positions relative to the frame. Capture so we see every
    // scrollable inside SVAR's shadow containers.
    const onScroll = () => schedule();
    frame.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", schedule);

    schedule();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      frame.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedule);
    };
  }, [frameRef]);

  const childrenByParent = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of tasks) {
      if (!t.parent) continue;
      const arr = m.get(t.parent) ?? [];
      arr.push(t.id);
      m.set(t.parent, arr);
    }
    return m;
  }, [tasks]);

  // Recompute every render. useMemo on `tick` is sufficient — the dep
  // array is intentionally shallow because we rely on DOM reads, not
  // on React state to track bar positions.
  const segments = useMemo(() => {
    const frame = frameRef.current;
    if (!frame) return { spines: [] as string[], stubs: [] as string[] };
    const frameRect = frame.getBoundingClientRect();
    const spines: string[] = [];
    const stubs: string[] = [];
    for (const [parentId, childIds] of childrenByParent) {
      const parentEl = frame.querySelector(
        `[data-bar-id="${CSS.escape(parentId)}"]`,
      ) as HTMLElement | null;
      if (!parentEl) continue;
      const pRect = parentEl.getBoundingClientRect();
      // Spine hugs the parent's left edge a few pixels in, visually
      // reading as a "hangs off the parent" line rather than a border.
      const spineX = pRect.left - frameRect.left + 8;
      const spineTop = pRect.bottom - frameRect.top;
      let spineBottom = spineTop;

      for (const cid of childIds) {
        const cEl = frame.querySelector(
          `[data-bar-id="${CSS.escape(cid)}"]`,
        ) as HTMLElement | null;
        if (!cEl) continue;
        const cRect = cEl.getBoundingClientRect();
        const cy = cRect.top - frameRect.top + cRect.height / 2;
        const cx = cRect.left - frameRect.left;
        // Only draw the horizontal stub if the child bar starts to the
        // right of the spine. If a child starts before its parent (can
        // happen after drag rescheduling) we still extend the spine so
        // the grouping visual doesn't vanish.
        if (cx > spineX + 2) {
          stubs.push(`M${spineX},${cy} L${cx},${cy}`);
        }
        if (cy > spineBottom) spineBottom = cy;
      }

      if (spineBottom > spineTop) {
        spines.push(`M${spineX},${spineTop} L${spineX},${spineBottom}`);
      }
    }
    return { spines, stubs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, childrenByParent]);

  if (segments.spines.length === 0 && segments.stubs.length === 0) {
    return null;
  }

  return (
    <svg className="hierarchy-overlay" aria-hidden>
      {/* Single path per visual role keeps the SVG cheap even with
          hundreds of bars — SVG compositing batches identical strokes. */}
      <path className="hierarchy-overlay__spine" d={segments.spines.join(" ")} />
      <path className="hierarchy-overlay__stub" d={segments.stubs.join(" ")} />
    </svg>
  );
}

/**
 * Renders a single red vertical line that marks "today" across the
 * Gantt's timeline. We derive a pixels-per-millisecond ratio from the
 * first rendered task bar (data-bar-id → DOM rect + known start/end
 * dates from the tasks prop) so the line stays anchored through
 * scroll, resize, and zoom without needing to reach into SVAR's
 * internal time scale.
 *
 * If the timeline doesn't yet contain any rendered bars (e.g. empty
 * state) the overlay silently renders nothing.
 */
function TodayOverlay({
  tasks,
  frameRef,
}: {
  tasks: GanttTaskInput[];
  frameRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [tick, setTick] = useState(0);
  // Last successfully-computed placement. Used as a fallback when a
  // mid-render DOM snapshot briefly fails the compute (no bars yet,
  // 0-width anchor, area detached), which was causing the red line
  // to flicker every time SVAR mutated the bar styles during hover,
  // scroll, or re-render.
  const lastPlacementRef = useRef<{
    xInArea: number;
    areaHeight: number;
    areaEl: HTMLElement;
  } | null>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setTick((t) => t + 1);
      });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(frame);

    // Narrow the MutationObserver: we care about bars being ADDED or
    // REMOVED (childList) — not about SVAR thrashing inline styles on
    // hover/focus, which fires hundreds of mutations a second and
    // used to drive the today-line to flicker as each frame briefly
    // lost an anchor. Bar position changes are already covered by the
    // ResizeObserver + scroll listener.
    const mo = new MutationObserver(schedule);
    mo.observe(frame, {
      subtree: true,
      childList: true,
    });

    const onScroll = () => schedule();
    frame.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", schedule);

    // Repaint at midnight so the line moves without a page refresh.
    const now = new Date();
    const msUntilMidnight =
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      ).getTime() - now.getTime();
    const timer = window.setTimeout(schedule, msUntilMidnight + 1000);

    schedule();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      frame.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedule);
      window.clearTimeout(timer);
    };
  }, [frameRef]);

  const placement = useMemo(() => {
    const frame = frameRef.current;
    if (!frame) return null;

    // Anchor to the widest rendered bar we can find, so pixels-per-ms
    // is as precise as possible. Skip unplaced ghosts (0 width). We
    // also derive the "area" (positioning reference) by walking up
    // from a bar to its nearest `.wx-area` ancestor — this is the
    // content-width container the bars actually live in, which is
    // different from the viewport-width wrapper SVAR also renders as
    // `.wx-area`. Using the inner one means `left: x` lives in the
    // same coordinate system the bars use, so the line scrolls with
    // the timeline instead of being clipped to the visible viewport.
    let anchorEl: HTMLElement | null = null;
    let anchorStart = 0;
    let anchorEnd = 0;
    let bestWidth = 0;
    let area: HTMLElement | null = null;
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    const bars = frame.querySelectorAll<HTMLElement>("[data-bar-id]");
    for (const el of Array.from(bars)) {
      const id = el.getAttribute("data-bar-id");
      if (!id) continue;
      const t = byId.get(id);
      if (!t) continue;
      const s = new Date(t.start).getTime();
      const e = new Date(t.end).getTime();
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= bestWidth) continue;
      bestWidth = r.width;
      anchorEl = el;
      anchorStart = s;
      anchorEnd = e;
      const a = el.closest(".wx-area") as HTMLElement | null;
      if (a) area = a;
    }
    if (!anchorEl || !area) {
      // Fallback: no bars yet (empty state / still rendering). Pick
      // the inner `.wx-area` inside `.wx-chart` if present, so at
      // least the node resolution is correct when bars do appear.
      area =
        (frame.querySelector(".wx-chart .wx-area") as HTMLElement | null) ??
        (frame.querySelector(".wx-area") as HTMLElement | null);
      if (!anchorEl || !area) return null;
    }

    // `.wx-area` is *inside* the horizontally-scrolling `.wx-chart`
    // but is not itself scrollable — its rendered box is the full
    // content width. That means `aRect.left - areaRect.left` is the
    // anchor's offset in content coordinates and stays constant
    // across scroll, so our computed x also lives in content coords.
    // `areaRect.width` is the full timeline width (not viewport),
    // so the bounds check only hides when today is outside the
    // entire chart — which dateRange explicitly pads to include.
    const areaRect = area.getBoundingClientRect();
    const aRect = anchorEl.getBoundingClientRect();
    const msPerPx = (anchorEnd - anchorStart) / aRect.width;
    if (!Number.isFinite(msPerPx) || msPerPx <= 0) return null;
    const anchorLeftInArea = aRect.left - areaRect.left;
    const todayMs = Date.now();
    const xInArea = anchorLeftInArea + (todayMs - anchorStart) / msPerPx;

    const contentWidth = Math.max(areaRect.width, area.scrollWidth || 0);
    if (xInArea < -2 || xInArea > contentWidth + 2) {
      // Today is genuinely outside the chart window — clear the
      // cache so we don't keep painting a stale line.
      lastPlacementRef.current = null;
      return null;
    }

    const next = {
      xInArea,
      areaHeight: area.scrollHeight || area.offsetHeight || areaRect.height,
      areaEl: area,
    };
    lastPlacementRef.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, tasks]);

  // When a compute returns null mid-render (no bars this frame, anchor
  // briefly detached, etc.) keep the last known-good placement so the
  // line doesn't flicker. We only fall back if the cached area is still
  // connected to the DOM — otherwise it's truly invalid.
  const effective =
    placement ??
    (lastPlacementRef.current &&
    lastPlacementRef.current.areaEl.isConnected
      ? lastPlacementRef.current
      : null);

  // Render the line as a child of `.wx-area` via a portal. That makes
  // `left: X` live in the area's own content coordinate system, which
  // scrolls naturally with the timeline without any math on our side.
  if (!effective) return null;
  return createPortal(
    <div
      className="today-overlay"
      aria-hidden="false"
      style={{
        left: effective.xInArea,
        top: 0,
        height: effective.areaHeight,
      }}
    >
      <span className="today-overlay__tick" aria-hidden="true" />
      <span className="today-overlay__label">Today</span>
    </div>,
    effective.areaEl,
  );
}

// Parse a `YYYY-MM-DD` string from a native date input into a Date at
// local noon. The default `new Date("YYYY-MM-DD")` parses as UTC
// midnight, which in any negative UTC offset (e.g. PDT) resolves to the
// *previous* calendar day once rendered through local getters — that's
// why "selecting a date picks the day before it" showed up. Using local
// noon keeps the round-trip stable on the picker's own machine and
// survives a ±11h timezone shift by any viewer.
function parseDateInputLocal(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Floating popover opened by double-clicking a bar in the Gantt chart.
 * Lets the user edit the most frequently changed task fields in one
 * place — name, dates, %, hours, and assignee — without leaving the
 * chart. Commits the full diff in a single patch on Save so server-side
 * rollups / dependency rescheduling see everything at once.
 */
function BarQuickEditor({
  anchor,
  task,
  people,
  onCancel,
  onSave,
}: {
  anchor: { top: number; left: number; width: number };
  task: GanttTaskInput;
  people: Array<{ id: string; name: string; role: string | null; active: boolean }>;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const startISO = useMemo(() => {
    const d = new Date(task.start);
    return Number.isNaN(d.getTime()) ? "" : shortDate(d);
  }, [task.start]);
  const endISO = useMemo(() => {
    const d = new Date(task.end);
    return Number.isNaN(d.getTime()) ? "" : shortDate(d);
  }, [task.end]);

  const [name, setName] = useState(task.text);
  const [start, setStart] = useState(startISO);
  const [end, setEnd] = useState(endISO);
  const [progress, setProgress] = useState(
    String(Math.round(Number(task.progress ?? 0))),
  );
  const [effort, setEffort] = useState(
    task.effortHours == null ? "" : String(task.effortHours),
  );
  const [assignee, setAssignee] = useState(task.assignee ?? "");
  const [saving, setSaving] = useState(false);

  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    // Focus the name field on open for keyboard-first editing.
    const el = ref.current?.querySelector<HTMLInputElement>(
      "input[data-autofocus]",
    );
    el?.focus();
    el?.select();
  }, []);

  // Escape to close; click outside to close. The popover itself swallows
  // its own clicks so internal interactions don't count as "outside".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onCancel]);

  const trySave = async () => {
    if (saving) return;
    setSaving(true);
    const patch: Record<string, unknown> = {};
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== task.text) patch.title = trimmedName;
    if (start && start !== startISO) {
      const d = parseDateInputLocal(start);
      if (d) patch.startDate = d.toISOString();
    }
    if (end && end !== endISO) {
      const d = parseDateInputLocal(end);
      if (d) patch.endDate = d.toISOString();
    }
    const p = Number(progress);
    if (Number.isFinite(p)) {
      const clamped = Math.max(0, Math.min(100, Math.round(p)));
      if (clamped !== Math.round(Number(task.progress ?? 0))) {
        patch.progress = clamped;
      }
    }
    const e = effort.trim();
    if (e === "") {
      if (task.effortHours != null) patch.effortHours = null;
    } else {
      const n = Number(e);
      if (Number.isFinite(n) && n !== Number(task.effortHours ?? NaN)) {
        patch.effortHours = Math.max(0, n);
      }
    }
    const aTrim = assignee.trim();
    const currentAssignee = (task.assignee ?? "").trim();
    if (aTrim !== currentAssignee) {
      patch.assignee = aTrim === "" ? null : aTrim;
    }

    if (Object.keys(patch).length === 0) {
      setSaving(false);
      onCancel();
      return;
    }
    try {
      await onSave(patch);
    } finally {
      setSaving(false);
    }
  };

  const popover = (
    <div
      ref={ref}
      className="bar-quick-editor"
      role="dialog"
      aria-label="Edit task"
      style={{
        top: anchor.top,
        left: anchor.left,
        width: anchor.width,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="bar-quick-editor__header">
        <span className="bar-quick-editor__title">Edit task</span>
        <button
          type="button"
          className="bar-quick-editor__close"
          onClick={onCancel}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <label className="bar-quick-editor__field">
        <span>Name</span>
        <input
          data-autofocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void trySave();
            }
          }}
        />
      </label>

      <div className="bar-quick-editor__row">
        <label className="bar-quick-editor__field">
          <span>Start</span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="bar-quick-editor__field">
          <span>End</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </div>

      <div className="bar-quick-editor__row">
        <label className="bar-quick-editor__field">
          <span>% complete</span>
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            value={progress}
            onChange={(e) => setProgress(e.target.value)}
          />
        </label>
        <label className="bar-quick-editor__field">
          <span>Hours</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={effort}
            placeholder="—"
            onChange={(e) => setEffort(e.target.value)}
          />
        </label>
      </div>

      <label className="bar-quick-editor__field">
        <span>Assignee</span>
        <input
          type="text"
          list="bar-quick-editor-people"
          value={assignee}
          placeholder="Unassigned"
          onChange={(e) => setAssignee(e.target.value)}
        />
        <datalist id="bar-quick-editor-people">
          {people
            .filter((p) => p.active)
            .map((p) => (
              <option key={p.id} value={p.name}>
                {p.role ?? ""}
              </option>
            ))}
        </datalist>
      </label>

      <div className="bar-quick-editor__actions">
        <button
          type="button"
          className="bar-quick-editor__btn bar-quick-editor__btn--ghost"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="bar-quick-editor__btn bar-quick-editor__btn--primary"
          onClick={() => void trySave()}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(popover, document.body);
}

function ParentPicker({
  scopeIds,
  tasks,
  query,
  setQuery,
  saving,
  onCancel,
  onSave,
  levelForRow,
  depthById,
  childCountById,
}: {
  scopeIds: string[];
  tasks: GanttTaskInput[];
  query: string;
  setQuery: (q: string) => void;
  saving: boolean;
  onCancel: () => void;
  onSave: (nextParentId: string | null) => void;
  levelForRow: (
    rowType: string,
    depth: number,
    childCount: number,
  ) => {
    slug: string;
    label: string;
    title: string;
    showChip: boolean;
  };
  depthById: Map<string, number>;
  childCountById: Map<string, number>;
}) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const scopeSet = useMemo(() => new Set(scopeIds), [scopeIds]);

  // Forbid moving a task under itself or any of its descendants — that
  // would create a cycle. Precompute the union of descendants of every
  // task in scope.
  const forbiddenSet = useMemo(() => {
    const childrenOf = new Map<string, GanttTaskInput[]>();
    for (const t of tasks) {
      if (!t.parent) continue;
      const arr = childrenOf.get(t.parent) ?? [];
      arr.push(t);
      childrenOf.set(t.parent, arr);
    }
    const forbidden = new Set<string>(scopeIds);
    const walk = (id: string) => {
      const kids = childrenOf.get(id) ?? [];
      for (const k of kids) {
        if (forbidden.has(k.id)) continue;
        forbidden.add(k.id);
        walk(k.id);
      }
    };
    for (const id of scopeIds) walk(id);
    return forbidden;
  }, [tasks, scopeIds]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (t.rowType === "ISSUE") return false;
      if (forbiddenSet.has(t.id)) return false;
      if (!q) return true;
      return t.text.toLowerCase().includes(q);
    });
  }, [tasks, forbiddenSet, query]);

  // Everything the picker can pick, including the synthetic "Top level"
  // entry at index 0. Keyboard nav treats the combined list as one.
  const totalCount = candidates.length + 1;

  const currentParents = useMemo(() => {
    const set = new Set<string | null>();
    for (const id of scopeIds) {
      const t = tasks.find((x) => x.id === id);
      set.add(t?.parent ?? null);
    }
    return set;
  }, [scopeIds, tasks]);
  const sameParentForAll = currentParents.size === 1;

  function commit(nextParentId: string | null) {
    onSave(nextParentId);
  }

  function onSearchKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onCancel();
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, totalCount - 1)));
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (activeIndex === 0) {
        commit(null);
      } else {
        const t = candidates[activeIndex - 1];
        if (t) commit(t.id);
      }
    }
  }

  const scopeLabel =
    scopeIds.length === 1
      ? (tasks.find((t) => t.id === scopeIds[0])?.text ?? "this task")
      : `${scopeIds.length} tasks`;

  return (
    <div
      className="deps-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="deps-modal deps-picker parent-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="parent-picker-title"
      >
        <div className="deps-picker-header">
          <div className="deps-picker-title-block">
            <h3 className="deps-modal-title" id="parent-picker-title">
              Move under parent
            </h3>
            <p className="deps-modal-subtitle">
              Pick a new parent for <strong>{scopeLabel}</strong>, or promote
              {scopeIds.length > 1 ? " them " : " it "}
              back to the top level. Tasks can&apos;t be moved under themselves
              or any of their descendants.
            </p>
          </div>
          <span className="deps-picker-count">
            {scopeIds.length} selected
          </span>
        </div>

        <div className="deps-picker-combo">
          <input
            ref={searchRef}
            className="deps-picker-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search for a parent task…"
          />
        </div>

        <div className="deps-picker-list">
          {/* Always-visible synthetic option: move to top level. */}
          <button
            type="button"
            className={
              "deps-picker-item" +
              (activeIndex === 0 ? " deps-picker-item--active" : "") +
              (sameParentForAll && currentParents.has(null)
                ? " deps-picker-item--checked"
                : "")
            }
            onMouseEnter={() => setActiveIndex(0)}
            onClick={() => commit(null)}
          >
            <span className="deps-picker-item-check" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            </span>
            <span className="task-row-kind task-row-kind--program">Top</span>
            <span className="deps-picker-item-text">
              Move to top level (no parent)
            </span>
          </button>

          {candidates.length === 0 && (
            <div className="deps-picker-empty">
              {query
                ? `No tasks match "${query}".`
                : "No eligible parent tasks."}
            </div>
          )}
          {candidates.map((t, idx) => {
            const menuIdx = idx + 1;
            const isActive = menuIdx === activeIndex;
            const depth = depthById.get(t.id) ?? 0;
            const childCount = childCountById.get(t.id) ?? 0;
            const level = levelForRow(t.rowType, depth, childCount);
            const isCurrent =
              sameParentForAll && currentParents.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                className={
                  "deps-picker-item" +
                  (isCurrent ? " deps-picker-item--checked" : "") +
                  (isActive ? " deps-picker-item--active" : "")
                }
                onMouseEnter={() => setActiveIndex(menuIdx)}
                onClick={() => commit(t.id)}
              >
                <span className="deps-picker-item-check" aria-hidden="true">
                  {isCurrent ? (
                    <svg
                      viewBox="0 0 24 24"
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : null}
                </span>
                {level.showChip && (
                  <span
                    className={`task-row-kind task-row-kind--${level.slug}`}
                    title={level.title}
                  >
                    {level.label}
                  </span>
                )}
                <span className="deps-picker-item-text">{t.text}</span>
              </button>
            );
          })}
        </div>

        <div className="deps-picker-footer">
          <span className="deps-picker-hint">
            Enter selects. Esc cancels.
          </span>
          <div className="deps-modal-actions">
            <button
              className="gantt-linkmode-btn"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// DEPRECATED (kept temporarily): the Gantt resource column now opens
// the shared <AllocationPicker/> (app/tasks/allocation-picker.tsx) so
// single- and multi-owner tasks with a percent split use the exact
// same editor as the /tasks drawer. This function is retained for one
// release cycle in case we need to roll back quickly — it's not
// referenced anywhere else in this module.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ResourcePicker({
  anchor,
  people,
  currentAssignee,
  query,
  setQuery,
  onCancel,
  onSelect,
}: {
  anchor: { top: number; left: number; width: number };
  people: Array<{ id: string; name: string; role: string | null }>;
  currentAssignee: string | null;
  query: string;
  setQuery: (q: string) => void;
  onCancel: () => void;
  onSelect: (name: string | null) => void;
}) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Dismiss on outside click, outside scroll, resize, or Escape.
  // IMPORTANT: scrolls originating *inside* the picker (e.g. the
  // option list's own overflow-y scroll when there are many
  // contributors) must not close the menu — otherwise the user can
  // never reach the bottom of the list because the first wheel
  // event dismisses it. We gate the scroll handler on whether the
  // event target is inside `menuRef`.
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && menuRef.current && menuRef.current.contains(t)) return;
      onCancel();
    };
    const onScrollOutside = (e: Event) => {
      const t = e.target as Node | null;
      if (t && menuRef.current && menuRef.current.contains(t)) return;
      onCancel();
    };
    const onResize = () => onCancel();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("scroll", onScrollOutside, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("scroll", onScrollOutside, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel]);

  type Option = { id: string; name: string | null; role: string | null };
  const options: Option[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? people.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.role ?? "").toLowerCase().includes(q),
        )
      : people;
    return [
      { id: "__unassigned__", name: null, role: null },
      ...filtered.map((p) => ({ id: p.id, name: p.name, role: p.role })),
    ];
  }, [people, query]);

  // Keep the highlight within bounds as the option list shrinks.
  useEffect(() => {
    if (activeIndex >= options.length) setActiveIndex(0);
  }, [options.length, activeIndex]);

  const commit = (idx: number) => {
    const opt = options[idx];
    if (!opt) return;
    onSelect(opt.name);
  };

  // Clamp within viewport so menus opened near the bottom of the grid
  // don't render off-screen.
  const top = Math.min(anchor.top, window.innerHeight - 340);
  const left = Math.min(anchor.left, window.innerWidth - anchor.width - 12);

  return (
    <div
      ref={menuRef}
      className="resource-picker"
      style={{ top, left, width: anchor.width }}
      role="listbox"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={searchRef}
        type="text"
        className="resource-picker__search"
        placeholder="Search contributors…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(options.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit(activeIndex);
          }
        }}
      />
      <div className="resource-picker__list">
        {options.length === 1 && query.trim() ? (
          <div className="resource-picker__empty">
            No contributors match “{query.trim()}”.
          </div>
        ) : null}
        {options.map((opt, idx) => {
          const isSelected =
            (opt.name ?? null) === (currentAssignee ?? null);
          const isActive = idx === activeIndex;
          return (
            <button
              key={opt.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              className={
                "resource-picker__item" +
                (isActive ? " resource-picker__item--active" : "") +
                (isSelected ? " resource-picker__item--selected" : "") +
                (opt.name === null ? " resource-picker__item--unassign" : "")
              }
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                commit(idx);
              }}
            >
              <span className="resource-picker__avatar" aria-hidden="true">
                {opt.name
                  ? opt.name
                      .split(/\s+/)
                      .map((p) => p[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase()
                  : "∅"}
              </span>
              <span className="resource-picker__text">
                <span className="resource-picker__name">
                  {opt.name ?? "Unassigned"}
                </span>
                {opt.role ? (
                  <span className="resource-picker__role">{opt.role}</span>
                ) : null}
              </span>
              {isSelected ? (
                <svg
                  className="resource-picker__check"
                  viewBox="0 0 20 20"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 10l4 4 8-9" />
                </svg>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Cached offscreen canvas for text width measurement. The Task column
// uses this on first mount to size itself to whatever the longest task
// name actually needs, so users don't land on a squished column by
// default. Falls back to a rough character count during SSR.
let _measureCanvas: HTMLCanvasElement | null = null;
function measureTextPx(text: string, font: string): number {
  if (typeof document === "undefined") return text.length * 7;
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d");
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * Pick a Task column width that fits the widest task name in `tasks`
 * once on first mount. Budget accounts for the grip icon, hierarchy
 * chip, child-count badge, and the hover action buttons so the row
 * never overlaps its own UI. Clamped so a single very long name
 * doesn't push the column past a laptop-friendly size.
 */
function computeInitialTaskColumnWidth(
  tasks: Array<{ text?: string }>,
  defaultWidth = 380,
): number {
  if (!tasks || tasks.length === 0) return defaultWidth;
  const font =
    '500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ' +
    '"Helvetica Neue", Arial, sans-serif';
  let maxTextPx = 0;
  for (const t of tasks) {
    const w = measureTextPx(String(t?.text ?? ""), font);
    if (w > maxTextPx) maxTextPx = w;
  }
  // Fixed UI budget next to the task name inside the cell:
  //   grip (12) + gap (8) + chip (~72 worst-case "WORKSTREAM") + gap (8)
  //   + child-count badge (~22) + actions space (~52) + cell padding (~24)
  const uiBudget = 12 + 8 + 72 + 8 + 22 + 52 + 24;
  const desired = Math.ceil(maxTextPx + uiBudget);
  const MIN_WIDTH = 260;
  const MAX_WIDTH = 560;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, desired));
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days from today (00:00 local) until `date`. Negative = in the past. */
function daysUntil(date: Date | string | number): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - today.getTime()) / MS_PER_DAY);
}

/** A task is overdue if its end is before today and it's not yet 100%. */
function isOverdue(end: Date | string | number, progress: number): boolean {
  return daysUntil(end) < 0 && Number(progress) < 100;
}

function formatRelative(ts: number, _tick: number): string {
  void _tick;
  const diffMs = Date.now() - ts;
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = new Date(ts);
  return d.toLocaleString();
}

/**
 * Notion-style filter menu rendered inline in the Gantt toolbar. Lets
 * the user hide Programs / Workstreams (uncheck a row → the whole
 * subtree disappears from the chart) and hide tasks by urgency. All
 * state is controlled by the parent so filter choices can participate
 * in the same memoized data pipeline as the Gantt itself.
 */
const GanttFilterMenu = forwardRef<
  HTMLDivElement,
  {
    open: boolean;
    setOpen: (v: boolean) => void;
    tasks: GanttTaskInput[];
    hiddenSubtreeIds: Set<string>;
    setHiddenSubtreeIds: React.Dispatch<React.SetStateAction<Set<string>>>;
    hiddenUrgencies: Set<"high" | "medium" | "low">;
    setHiddenUrgencies: React.Dispatch<
      React.SetStateAction<Set<"high" | "medium" | "low">>
    >;
  }
>(function GanttFilterMenu(
  {
    open,
    setOpen,
    tasks,
    hiddenSubtreeIds,
    setHiddenSubtreeIds,
    hiddenUrgencies,
    setHiddenUrgencies,
  },
  ref,
) {
  // Build the two-level tree (Program → Workstreams) we show in the
  // menu. We intentionally stop at depth 1 — showing every leaf task
  // would make the dropdown unusable on real programs.
  const tree = useMemo(() => {
    const programs = tasks.filter((t) => !t.parent);
    const childrenOf = (pid: string) =>
      tasks.filter((t) => t.parent === pid);
    return programs.map((p) => ({
      program: p,
      workstreams: childrenOf(p.id),
    }));
  }, [tasks]);

  const activeCount = hiddenSubtreeIds.size + hiddenUrgencies.size;

  const toggleSubtree = (id: string) => {
    setHiddenSubtreeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleUrgency = (u: "high" | "medium" | "low") => {
    setHiddenUrgencies((prev) => {
      const next = new Set(prev);
      if (next.has(u)) next.delete(u);
      else next.add(u);
      return next;
    });
  };
  const clearAll = () => {
    setHiddenSubtreeIds(new Set());
    setHiddenUrgencies(new Set());
  };

  const URGENCIES: Array<{
    key: "high" | "medium" | "low";
    label: string;
    dot: string;
  }> = [
    { key: "high", label: "High", dot: "#ef4444" },
    { key: "medium", label: "Medium", dot: "#f59e0b" },
    { key: "low", label: "Low", dot: "#22c55e" },
  ];

  return (
    <div className="gantt-filter" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={
          "gantt-linkmode-btn" + (activeCount > 0 ? " is-active" : "")
        }
        title="Hide or show parts of the chart"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ marginRight: 5, verticalAlign: "-1px" }}
          aria-hidden="true"
        >
          <path d="M4 5h16" />
          <path d="M7 12h10" />
          <path d="M10 19h4" />
        </svg>
        Filter
        {activeCount > 0 ? (
          <span className="gantt-filter__count">{activeCount}</span>
        ) : null}
      </button>
      {open ? (
        <div
          className="gantt-filter__menu"
          role="dialog"
          aria-label="Filter tasks"
        >
          <div className="gantt-filter__header">
            <span>Show on board</span>
            {activeCount > 0 ? (
              <button
                type="button"
                className="gantt-filter__clear"
                onClick={clearAll}
              >
                Reset
              </button>
            ) : null}
          </div>

          <div className="gantt-filter__section">
            <div className="gantt-filter__section-title">Urgency</div>
            <div className="gantt-filter__chips">
              {URGENCIES.map((u) => {
                const hidden = hiddenUrgencies.has(u.key);
                return (
                  <button
                    key={u.key}
                    type="button"
                    onClick={() => toggleUrgency(u.key)}
                    className={
                      "gantt-filter__chip" + (hidden ? " is-off" : "")
                    }
                    aria-pressed={!hidden}
                    title={
                      hidden
                        ? `Show ${u.label.toLowerCase()}-urgency tasks`
                        : `Hide ${u.label.toLowerCase()}-urgency tasks`
                    }
                  >
                    <span
                      className="gantt-filter__chip-dot"
                      style={{ background: u.dot }}
                      aria-hidden="true"
                    />
                    {u.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="gantt-filter__section">
            <div className="gantt-filter__section-title">
              Programs &amp; workstreams
            </div>
            {tree.length === 0 ? (
              <div className="gantt-filter__empty">
                No programs yet. Create a task to start organizing your
                board.
              </div>
            ) : (
              <div className="gantt-filter__tree">
                {tree.map(({ program, workstreams }) => {
                  const programHidden = hiddenSubtreeIds.has(program.id);
                  return (
                    <div key={program.id} className="gantt-filter__group">
                      <label className="gantt-filter__row is-program">
                        <input
                          type="checkbox"
                          checked={!programHidden}
                          onChange={() => toggleSubtree(program.id)}
                        />
                        <span className="gantt-filter__row-label">
                          {program.text}
                        </span>
                      </label>
                      {workstreams.length > 0 ? (
                        <div className="gantt-filter__children">
                          {workstreams.map((ws) => {
                            const wsHidden =
                              programHidden || hiddenSubtreeIds.has(ws.id);
                            return (
                              <label
                                key={ws.id}
                                className={
                                  "gantt-filter__row" +
                                  (programHidden ? " is-disabled" : "")
                                }
                              >
                                <input
                                  type="checkbox"
                                  disabled={programHidden}
                                  checked={!wsHidden}
                                  onChange={() => toggleSubtree(ws.id)}
                                />
                                <span className="gantt-filter__row-label">
                                  {ws.text}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
});
