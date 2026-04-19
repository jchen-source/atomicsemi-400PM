"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

function escapeHtml(v: string) {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type GanttTaskRuntime = Omit<GanttTaskInput, "start" | "end"> & {
  start: Date;
  end: Date;
  duration: number;
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
}: {
  tasks: GanttTaskInput[];
  links: GanttLinkInput[];
}) {
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
      { text: string; progress: number; startMs: number; endMs: number }
    >(),
  );
  const [status, setStatus] = useState<string>("");
  const [zoom, setZoom] = useState<ZoomLevel>("week");
  const [dark, setDark] = useState(false);
  const [depEditorTaskId, setDepEditorTaskId] = useState<string | null>(null);
  const [depEditorQuery, setDepEditorQuery] = useState("");
  const [depEditorSelected, setDepEditorSelected] = useState<string[]>([]);
  const [depEditorSaving, setDepEditorSaving] = useState(false);

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
      { text: string; progress: number; startMs: number; endMs: number }
    >();
    for (const t of tasks) {
      next.set(t.id, {
        text: t.text,
        progress: Number(t.progress ?? 0),
        startMs: new Date(t.start).getTime(),
        endMs: new Date(t.end).getTime(),
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

  const TaskTemplate = ({
    data,
  }: {
    data: {
      id?: string | number;
      text?: string;
      progress?: number;
      urgency?: "high" | "medium" | "low";
    };
  }) => {
    const id = data?.id != null ? String(data.id) : "";
    const level = Math.min(levelById.get(id) ?? 0, 2);
    const urgency = urgencyById.get(id) ?? data?.urgency ?? "medium";
    const pct = Math.max(0, Math.min(100, Number(data?.progress ?? 0)));
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
        className={`task-pill level-${level} urgency-${urgency}`}
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
          <span className="truncate">{data?.text ?? ""}</span>
          <span className="task-pill__pct">{pct}%</span>
        </div>
      </div>
    );
  };

  const columns = useMemo(
    () => [
      {
        id: "text",
        header: "Task",
        width: 260,
        align: "left" as const,
        editor: "text",
        template: (value: unknown, row: Record<string, unknown>) => {
          const id = String(row?.id ?? "");
          const text = escapeHtml(String(value ?? ""));
          const rowType = String(row?.rowType ?? "TASK");
          const startRaw = row?.start ? new Date(String(row.start)).toISOString() : "";
          const endRaw = row?.end ? new Date(String(row.end)).toISOString() : "";
          return `<div class="task-cell-wrap">
            <span class="task-row-actions" data-row-actions>
              <button class="task-row-btn task-row-btn-delete" data-task-delete="${id}" title="Delete task">Delete</button>
              <button class="task-row-btn task-row-btn-add" data-task-add="${id}" data-task-start="${startRaw}" data-task-end="${endRaw}" data-task-rowtype="${rowType}" title="Add child task">+Task</button>
              <button class="task-row-btn task-row-btn-link" data-deps-edit="${id}" title="Edit dependencies">Depends</button>
            </span>
            <span class="task-cell-text">${text}</span>
          </div>`;
        },
      },
      {
        id: "start",
        header: "Start",
        width: 104,
        align: "center" as const,
        template: (value: unknown) => shortDate(new Date(String(value))),
        editor: "datepicker",
      },
      {
        id: "end",
        header: "End",
        width: 104,
        align: "center" as const,
        template: (value: unknown) => shortDate(new Date(String(value))),
        editor: "datepicker",
      },
      {
        id: "depsLabel",
        header: "Depends On",
        width: 420,
        align: "left" as const,
      },
      {
        id: "progress",
        header: "%",
        width: 56,
        align: "center" as const,
        editor: "text",
      },
      {
        id: "duration",
        header: "Days",
        width: 56,
        align: "center" as const,
      },
    ],
    [],
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
      knownTaskState.current.set(a.id, {
        text: knownTaskState.current.get(a.id)?.text ?? "",
        progress: Number(a.progress ?? 0),
        startMs: s.getTime(),
        endMs: e.getTime(),
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

      // If this event doesn't materially change data, ignore it.
      if (
        prev &&
        nextText === prev.text &&
        nextProgress === prev.progress &&
        nextStartMs === prev.startMs &&
        nextEndMs === prev.endMs
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
      } else {
        if (nextText) payload.title = nextText;
        if (nextProgress !== undefined) payload.progress = nextProgress;
        if (nextStartMs !== undefined) payload.startDate = new Date(nextStartMs);
        if (nextEndMs !== undefined) payload.endDate = new Date(nextEndMs);
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
          });
          applyAffected(affected);
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
          setStatus(
            data?.existed ? "Dependency already exists." : "Dependency created.",
          );
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

  async function addChildTaskFor(parentId: string) {
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent) return;
    const start = new Date(parent.start);
    const end = new Date(parent.end);
    const childType = parent.rowType === "ISSUE" ? "ISSUE" : "TASK";
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "New Task",
          description: "",
          type: childType,
          status: "TODO",
          startDate: start,
          endDate: end,
          progress: 0,
          parentId,
          sortOrder: 9999,
          tags: [],
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setStatus(`Task added under ${parent.text}.`);
      window.location.reload();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Add task failed");
    }
  }

  async function deleteTaskById(taskId: string) {
    const t = tasks.find((x) => x.id === taskId);
    const ok = window.confirm("Delete selected task and all descendants?");
    if (!ok) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      setStatus(`${t?.text ?? "Task"} deleted.`);
      window.location.reload();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Delete failed");
    }
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
      const addBtn = target?.closest("[data-task-add]") as HTMLElement | null;
      if (addBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = addBtn.getAttribute("data-task-add");
        if (id) void addChildTaskFor(id);
        return;
      }
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
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
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
      window.location.reload();
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
        <button
          type="button"
          onClick={autoChainDependencies}
          className="gantt-linkmode-btn"
          title="Create sequential dependencies with one click"
        >
          Auto Dependencies
        </button>
        <div className="gantt-status" aria-live="polite">
          {status ||
            "Draw dependency: drag from the circle handle on one bar to another bar"}
        </div>
      </div>

      <div className="gantt-frame" ref={frameRef}>
        <Theme>
          <Gantt
            tasks={initialTasks}
            links={links}
            scales={scales}
            zoom={false}
            columns={columns}
            cellHeight={40}
            scaleHeight={40}
            cellWidth={zoom === "quarter" ? 80 : zoom === "month" ? 100 : 40}
            cellBorders="full"
            init={init}
            taskTemplate={TaskTemplate}
          />
        </Theme>
      </div>
      {depEditorTaskId && (
        <div className="deps-modal-backdrop">
          <div className="deps-modal">
            <h3 className="deps-modal-title">Edit Dependencies</h3>
            <p className="deps-modal-subtitle">
              Select tasks this item depends on (Notion-style relation).
            </p>
            <input
              className="deps-modal-search"
              value={depEditorQuery}
              onChange={(e) => setDepEditorQuery(e.target.value)}
              placeholder="Filter tasks..."
            />
            <div className="deps-modal-list">
              {tasks
                .filter((t) => t.id !== depEditorTaskId)
                .filter((t) =>
                  t.text.toLowerCase().includes(depEditorQuery.toLowerCase()),
                )
                .map((t) => {
                  const checked = depEditorSelected.includes(t.id);
                  return (
                    <label key={t.id} className="deps-modal-item">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setDepEditorSelected((prev) => [...prev, t.id]);
                          } else {
                            setDepEditorSelected((prev) =>
                              prev.filter((x) => x !== t.id),
                            );
                          }
                        }}
                      />
                      <span>{t.text}</span>
                    </label>
                  );
                })}
            </div>
            <div className="deps-modal-actions">
              <button
                className="gantt-linkmode-btn"
                onClick={() => setDepEditorTaskId(null)}
                disabled={depEditorSaving}
              >
                Cancel
              </button>
              <button
                className="gantt-linkmode-btn is-active"
                onClick={saveDependencyEditor}
                disabled={depEditorSaving}
              >
                {depEditorSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function shortDate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
