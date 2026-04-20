"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import "@svar-ui/react-gantt/all.css";
import "./gantt-theme.css";

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
  type: "summary" | "task" | "milestone";
  rowType: "EPIC" | "TASK" | "ISSUE";
  urgency?: "high" | "medium" | "low";
  effortHours?: number | null;
  assignee?: string | null;
  resourceAllocated?: string | null;
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
}: {
  tasks: GanttTaskInput[];
  links: GanttLinkInput[];
  emptyState?: React.ReactNode;
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
  const [zoom, setZoom] = useState<ZoomLevel>("week");
  const [dark, setDark] = useState(false);
  const [depEditorTaskId, setDepEditorTaskId] = useState<string | null>(null);
  const [depEditorQuery, setDepEditorQuery] = useState("");
  const [depEditorSelected, setDepEditorSelected] = useState<string[]>([]);
  const [depEditorSaving, setDepEditorSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  const [savedTick, setSavedTick] = useState(0);
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

  function markSaved() {
    setLastSavedAt(Date.now());
  }

  // Shared commit path for the inline single-click cell editors. Cells are
  // intentionally referentially stable (see TaskNameCell notes) so they
  // call through this ref instead of closing over the latest handler.
  // Wiring is populated below once patchTask / applyAffected are defined.
  const commitInlineEditRef = useRef<
    (id: string, payload: Record<string, unknown>) => Promise<void>
  >(async () => {});

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setDark(mq.matches);
    const listener = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  const initialTasks: GanttTaskRuntime[] = useMemo(
    () =>
      tasks.map((t) => {
        const s = new Date(t.start);
        const e = new Date(t.end);
        return {
          ...t,
          parent: t.parent ?? undefined,
          start: s,
          end: e,
          duration: daysBetween(s, e),
        };
      }),
    [tasks],
  );

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

  const childCountById = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (!t.parent) continue;
      map.set(t.parent, (map.get(t.parent) ?? 0) + 1);
    }
    return map;
  }, [tasks]);

  // Mirror of `childCountById` held in a ref so memoized cell components
  // (EffortCell, DepsLabelCell, …) can read the current value without being
  // invalidated every time a single row changes.
  const childCountByIdRef = useRef(childCountById);
  useEffect(() => {
    childCountByIdRef.current = childCountById;
  }, [childCountById]);

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


  const TaskTemplate = ({
    data,
  }: {
    data: {
      id?: string | number;
      text?: string;
      progress?: number;
      urgency?: "high" | "medium" | "low";
      end?: Date | string;
    };
  }) => {
    const id = data?.id != null ? String(data.id) : "";
    const level = Math.min(levelById.get(id) ?? 0, 2);
    const urgency = urgencyById.get(id) ?? data?.urgency ?? "medium";
    const pct = Math.max(0, Math.min(100, Number(data?.progress ?? 0)));
    const overdue = data?.end ? isOverdue(data.end, pct) : false;
    const palette: Record<
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
    const colors = palette[urgency];
    return (
      <div
        className={
          `task-pill level-${level} urgency-${urgency}` +
          (overdue ? " task-pill--overdue" : "")
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
        <div className="task-pill__text">
          <span className="task-pill__name" title={data?.text ?? ""}>
            {data?.text ?? ""}
          </span>
          <span className="task-pill__pct">{pct}%</span>
        </div>
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
            onClick={(e) => {
              if (readOnly) return;
              e.stopPropagation();
              setEditing(true);
            }}
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
          <svg
            className="deps-cell-edit-icon"
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
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
            const d = new Date(s);
            if (Number.isNaN(d.getTime())) return null;
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
            const d = new Date(s);
            if (Number.isNaN(d.getTime())) return null;
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
      const assignee = String(row?.assignee ?? "").trim();
      const allocated = String(row?.resourceAllocated ?? "").trim();
      const parts: string[] = [];
      if (assignee) parts.push(assignee);
      if (allocated && allocated !== assignee) parts.push(allocated);
      if (parts.length === 0)
        return <span className="grid-cell-meta grid-cell-meta--empty">—</span>;
      const label = parts.join(" · ");
      return (
        <span className="grid-cell-meta" title={label}>
          {label}
        </span>
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
        // Wide enough that the drag handle, hierarchy chip, full task name,
        // child-count badge, and hover actions all breathe. Resizable in the
        // grid, but this default is tuned for real workstream/task names.
        width: 380,
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
          },
          eventSource: "server-reschedule",
        });
        setTimeout(() => suppressUpdateIds.current.delete(id), 800);
      }

      applyAffected(affected);
      markSaved();
      setStatus("");
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
      fetch(`/api/dependencies/${id}`, { method: "DELETE" }).catch(() => {
        /* ignore */
      });
    });

    api.on("delete-task", (raw: unknown) => {
      const data = raw as { id: string };
      fetch(`/api/tasks/${data.id}`, { method: "DELETE" }).catch(() => {
        /* ignore */
      });
    });
  }

  const Theme = dark ? WillowDark : Willow;

  async function createTask() {
    if (addingTask) return;
    setAddingTask(true);
    setStatus("Creating task…");
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
          startDate: start,
          endDate: end,
          progress: 0,
          sortOrder: 9999,
          tags: [],
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      markSaved();
      setStatus("Task added. Drag it onto another task to nest it.");
      router.refresh();
      setTimeout(() => setStatus(""), 1800);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Create task failed");
    } finally {
      setAddingTask(false);
    }
  }

  async function reparentTask(
    childId: string,
    newParentId: string | null,
  ) {
    const child = tasks.find((t) => t.id === childId);
    if (!child) return;
    if (childId === newParentId) return;
    if (child.parent === newParentId) return;

    // Prevent cycles: walk up from newParentId and ensure we never hit childId.
    if (newParentId) {
      const byId = new Map(tasks.map((t) => [t.id, t]));
      let cursor: string | null | undefined = newParentId;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === childId) {
          setStatus("Can't nest a task under its own descendant.");
          setTimeout(() => setStatus(""), 2000);
          return;
        }
        if (seen.has(cursor)) break;
        seen.add(cursor);
        cursor = byId.get(cursor)?.parent ?? null;
      }
    }

    const targetName =
      newParentId
        ? (tasks.find((t) => t.id === newParentId)?.text ?? "parent")
        : "top level";
    setStatus(`Moving "${child.text}" under ${targetName}…`);
    try {
      const res = await fetch(`/api/tasks/${childId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentId: newParentId }),
      });
      if (!res.ok) throw new Error(await res.text());
      markSaved();
      setStatus(`Moved under ${targetName}.`);
      router.refresh();
      setTimeout(() => setStatus(""), 1500);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Move failed");
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
      const depCell = target?.closest(
        "[data-deps-cell-edit]",
      ) as HTMLElement | null;
      if (depCell) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = depCell.getAttribute("data-deps-cell-edit");
        if (id) openDependencyEditor(id);
      }
    };

    // HTML5 drag-and-drop for reparenting: drag any task cell onto another
    // task cell to make the dragged task a child of the drop target.
    const DRAG_MIME = "application/x-pm-task-id";
    let dragSourceId: string | null = null;

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
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData(DRAG_MIME, id);
      ev.dataTransfer.setData("text/plain", id);
      src.classList.add("task-cell-wrap--dragging");
    };

    const onDragEnd = () => {
      dragSourceId = null;
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
      if (!dropId || dropId === dragSourceId) return;
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
      const sourceId =
        ev.dataTransfer?.getData(DRAG_MIME) ||
        ev.dataTransfer?.getData("text/plain") ||
        dragSourceId;
      clearDropHover();
      if (!dropId || !sourceId || dropId === sourceId) return;
      ev.preventDefault();
      ev.stopPropagation();
      void reparentTask(sourceId, dropId);
    };

    // SVAR attaches a container-level mousedown listener that boots its own
    // row-reorder drag on every mousedown inside the grid. That reorder runs
    // in parallel with our HTML5 drag, and on drop the two try to move the
    // same task (one via our API PATCH, one via SVAR's in-memory tree) — the
    // visible result is stale rows and ghost positions. Capture mousedown on
    // draggable task rows and stop it before SVAR sees it, so only our drag
    // logic runs. Clicks and selection still work because `click` is a
    // synthesized event with its own dispatch.
    const onMouseDownCapture = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-task-drag-id]")) {
        ev.stopPropagation();
      }
    };

    root.addEventListener("click", onClick);
    root.addEventListener("mousedown", onMouseDownCapture, true);
    // Capture phase: run before SVAR's internal dragstart handler
    // (which would otherwise preventDefault and cancel the drag).
    root.addEventListener("dragstart", onDragStart, true);
    root.addEventListener("dragend", onDragEnd, true);
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("dragleave", onDragLeave);
    root.addEventListener("drop", onDrop);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("mousedown", onMouseDownCapture, true);
      root.removeEventListener("dragstart", onDragStart, true);
      root.removeEventListener("dragend", onDragEnd, true);
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("dragleave", onDragLeave);
      root.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, depsByDependent]);

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
        </div>
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

      <div className="gantt-frame" ref={frameRef}>
        {tasks.length === 0 && emptyState ? (
          <div className="gantt-empty-overlay">{emptyState}</div>
        ) : (
          <Theme>
            <Gantt
              tasks={initialTasks}
              links={links}
              scales={scales}
              zoom={false}
              columns={columns}
              cellHeight={56}
              scaleHeight={28}
              cellWidth={zoom === "quarter" ? 80 : zoom === "month" ? 100 : 40}
              cellBorders="full"
              init={init}
              taskTemplate={TaskTemplate}
            />
          </Theme>
        )}
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
