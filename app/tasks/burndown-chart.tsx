"use client";

import { useState } from "react";

/**
 * Shared burndown primitives used by /burndown and /tasks.
 *
 * Semantics: this is an *effort burndown* — Y axis is "hours of estimated
 * effort remaining", not percent complete. The curve descends as tasks get
 * knocked out. Two lines:
 *
 *   1. Required — ideal linear descent from total effort at `startMs` to
 *      zero at `endMs`. This is the work the team committed to.
 *   2. Actual — stepped. Each progress update (`TaskUpdate`) becomes a
 *      point; between snapshots the value holds flat because nothing has
 *      been reported.
 *
 * Leaves that don't have `effortHours` set fall back to `DEFAULT_EFFORT`
 * so the chart never vanishes when estimates are missing. The default is
 * called out in the chart header so users know it's a fallback.
 */

export type BurndownTaskInput = {
  id: string;
  title: string;
  parentId: string | null;
  startDate: string;
  endDate: string;
  progress: number;
  status: string;
  health: "green" | "yellow" | "red" | null;
  effortHours: number | null;
  assignee: string | null;
  blocked: boolean;
};

export type BurndownSnapshotInput = {
  id: string;
  taskId: string;
  createdAt: string;
  progress: number;
  remainingEffort: number | null;
  status: string | null;
  health: "green" | "yellow" | "red" | null;
  /** Comment text pushed with this snapshot. Surfaced in the chart tooltip. */
  comment?: string;
};

export type Series = {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  totalEffort: number;         // hours committed at the start of the window
  remainingNow: number;        // hours still to burn right now
  completedNow: number;        // totalEffort - remainingNow
  idealNow: number;            // hours the required line says we should have left
  ideal: Point[];              // 2 points: (start, total) -> (end, 0)
  actual: ActualPoint[];       // stepped descent, one point per update + start + now
  health: "green" | "yellow" | "red";
  atRisk: boolean;
  leafCount: number;
  usesDefaultEffort: boolean;  // true if any leaf had null effortHours
};

type Point = { t: number; v: number };

/**
 * A single dot on the "actual" line. `t` is the real timestamp of the
 * underlying snapshot (used for the tooltip). `displayT` is what the chart
 * should render at on the x-axis — this matters when a snapshot happened
 * BEFORE the task's start date (or after its end): we keep the dot visible
 * by clamping its x-position while preserving the real time in the tip.
 */
export type ActualPoint = {
  t: number;
  displayT: number;
  v: number;
  /** True when the snapshot was pushed before the task's scheduled start. */
  preStart: boolean;
  /** True when the snapshot was pushed after the task's scheduled end. */
  postEnd: boolean;
  /** Optional comment pushed alongside this snapshot. */
  comment?: string;
  /** One entry per leaf task that pushed a snapshot at this timestamp.
   *  Lets the project-wide tooltip tell users *which* task moved the line
   *  when multiple tasks publish updates at the same moment. */
  sources?: Array<{
    taskId: string;
    taskTitle: string;
    comment?: string;
  }>;
  /** True for synthetic anchor points (start baseline, "now" tip) that the
   *  user didn't explicitly push. These don't need a tooltip. */
  synthetic?: boolean;
};

export type SeriesInputs = {
  tasks: BurndownTaskInput[];
  snapshots: BurndownSnapshotInput[];
  nowMs: number;
};

const DEFAULT_EFFORT_HOURS = 8;

// ---------- helpers ----------

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function effortOf(t: BurndownTaskInput): number {
  return t.effortHours && t.effortHours > 0
    ? t.effortHours
    : DEFAULT_EFFORT_HOURS;
}

function indexSnapshots(
  snapshots: BurndownSnapshotInput[],
): Map<string, BurndownSnapshotInput[]> {
  const m = new Map<string, BurndownSnapshotInput[]>();
  for (const s of snapshots) {
    const arr = m.get(s.taskId) ?? [];
    arr.push(s);
    m.set(s.taskId, arr);
  }
  for (const arr of m.values()) {
    arr.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }
  return m;
}

function indexChildren(
  tasks: BurndownTaskInput[],
): Map<string | null, BurndownTaskInput[]> {
  const m = new Map<string | null, BurndownTaskInput[]>();
  for (const t of tasks) {
    const arr = m.get(t.parentId) ?? [];
    arr.push(t);
    m.set(t.parentId, arr);
  }
  return m;
}

function leavesUnder(
  rootId: string,
  taskById: Map<string, BurndownTaskInput>,
  childrenByParent: Map<string | null, BurndownTaskInput[]>,
): BurndownTaskInput[] {
  const out: BurndownTaskInput[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const t = taskById.get(id);
    if (!t) continue;
    const kids = childrenByParent.get(id) ?? [];
    if (kids.length === 0) out.push(t);
    else for (const k of kids) stack.push(k.id);
  }
  return out;
}

/**
 * Hours remaining on a single leaf at time `t`.
 *
 * Precedence (most to least trusted):
 *   1. `remainingEffort` from the latest snapshot at or before `t`.
 *   2. `effortHours * (1 - progress/100)` using the progress from that snapshot.
 *   3. Full `effortHours` (leaf hasn't been touched yet at time `t`).
 *
 * For `t === nowMs` we also fold in `leaf.progress` directly — edits made
 * outside the progress API (e.g. dragging a bar on the Gantt) wouldn't have
 * written a snapshot but should still be reflected in the "right now" tip.
 */
function remainingAtLeaf(
  leaf: BurndownTaskInput,
  snaps: BurndownSnapshotInput[],
  t: number,
  nowMs: number,
): number {
  const E = effortOf(leaf);

  if (t === nowMs) {
    // Prefer the explicit remaining field if the most recent snapshot carries
    // one, otherwise derive from the leaf's live progress.
    const latest = snaps.length ? snaps[snaps.length - 1] : null;
    if (
      latest &&
      latest.remainingEffort != null &&
      new Date(latest.createdAt).getTime() >= (snaps[0]?.createdAt ? 0 : 0)
    ) {
      return Math.max(0, latest.remainingEffort);
    }
    const prog = clamp(leaf.progress, 0, 100);
    return Math.max(0, E * (1 - prog / 100));
  }

  let snap: BurndownSnapshotInput | null = null;
  for (const s of snaps) {
    if (new Date(s.createdAt).getTime() > t) break;
    snap = s;
  }
  if (!snap) return E;
  if (snap.remainingEffort != null) return Math.max(0, snap.remainingEffort);
  const prog = clamp(snap.progress, 0, 100);
  return Math.max(0, E * (1 - prog / 100));
}

function classifyHealth(
  idealNow: number,
  remainingNow: number,
  totalEffort: number,
  blocked: boolean,
): "green" | "yellow" | "red" {
  if (blocked) return "red";
  // Positive delta = behind schedule (more remaining than the line says).
  const delta = remainingNow - idealNow;
  const tol = Math.max(1, totalEffort * 0.05);
  const tolYellow = Math.max(2, totalEffort * 0.15);
  if (delta <= tol) return "green";
  if (delta <= tolYellow) return "yellow";
  return "red";
}

function buildSeriesForLeaves(
  id: string,
  title: string,
  leaves: BurndownTaskInput[],
  startMs: number,
  endMs: number,
  parentBlocked: boolean,
  inputs: SeriesInputs,
): Series | null {
  if (leaves.length === 0) return null;
  const snapshotsByTask = indexSnapshots(inputs.snapshots);

  // Per-leaf baseline: the stored estimate OR the highest remaining-hours
  // value ever reported in a snapshot for that leaf, whichever is bigger.
  // This keeps the chart honest when a user types a larger `Remaining (h)`
  // than the original estimate — the required line rises to meet reality
  // instead of clamping the actual line off the chart.
  function leafCeiling(l: BurndownTaskInput): number {
    const base = effortOf(l);
    let maxReported = 0;
    for (const s of snapshotsByTask.get(l.id) ?? []) {
      if (s.remainingEffort != null && s.remainingEffort > maxReported) {
        maxReported = s.remainingEffort;
      }
    }
    return Math.max(base, maxReported);
  }

  const totalEffort = leaves.reduce((acc, l) => acc + leafCeiling(l), 0);
  const usesDefaultEffort = leaves.some(
    (l) => !(l.effortHours && l.effortHours > 0),
  );

  // Collect every snapshot across all leaves in scope, then group by
  // timestamp so one moment in time becomes one dot on the chart even
  // if multiple leaves got updates in the same second. We also hold a
  // parallel index back to the source leaf so each dot can say *which*
  // task(s) caused it on the project-wide tooltip.
  const perTime = new Map<
    number,
    Array<{ snap: BurndownSnapshotInput; leaf: BurndownTaskInput }>
  >();
  for (const l of leaves) {
    for (const s of snapshotsByTask.get(l.id) ?? []) {
      const ts = new Date(s.createdAt).getTime();
      if (ts > inputs.nowMs) continue; // never forecast into the future
      const arr = perTime.get(ts) ?? [];
      arr.push({ snap: s, leaf: l });
      perTime.set(ts, arr);
    }
  }
  const timeline = [...perTime.keys()].sort((a, b) => a - b);

  // One point per snapshot timestamp. v = sum of remaining across all leaves
  // at that moment. displayT clamps into [startMs, endMs] so a snapshot
  // pushed before the task officially starts still shows up at the chart's
  // left edge — the real time is preserved in `t` for the hover tooltip.
  const actual: ActualPoint[] = timeline.map((t) => {
    let sum = 0;
    for (const l of leaves) {
      sum += remainingAtLeaf(
        l,
        snapshotsByTask.get(l.id) ?? [],
        t,
        inputs.nowMs,
      );
    }
    const here = perTime.get(t) ?? [];
    // Only surface non-empty comments; when multiple leaves pushed at the
    // exact same instant we concatenate so nothing gets lost.
    const comment = here
      .map(({ snap }) => (snap.comment ?? "").trim())
      .filter(Boolean)
      .join(" · ");
    const sources = here.map(({ snap, leaf }) => ({
      taskId: leaf.id,
      taskTitle: leaf.title,
      comment: (snap.comment ?? "").trim() || undefined,
    }));
    return {
      t,
      displayT: clamp(t, startMs, endMs),
      v: sum,
      preStart: t < startMs,
      postEnd: t > endMs,
      comment: comment || undefined,
      sources,
    };
  });

  // Anchor the line: if there's no point at or before startMs, drop a
  // baseline at (startMs, totalEffort) so the line starts honestly at the
  // top-left of the chart instead of floating mid-air.
  if (actual.length === 0 || actual[0].t > startMs) {
    actual.unshift({
      t: startMs,
      displayT: startMs,
      v: totalEffort,
      preStart: false,
      postEnd: false,
      synthetic: true,
    });
  }

  // Always include a "now" tip so the actual line reaches today (or the
  // task's end, whichever comes first). No tooltip on this one — it's a
  // synthetic marker, not something the user pushed.
  const cutoffNow = Math.min(inputs.nowMs, endMs);
  if (cutoffNow >= startMs) {
    const lastT = actual[actual.length - 1].t;
    if (cutoffNow > lastT) {
      let sumNow = 0;
      for (const l of leaves) {
        sumNow += remainingAtLeaf(
          l,
          snapshotsByTask.get(l.id) ?? [],
          inputs.nowMs,
          inputs.nowMs,
        );
      }
      actual.push({
        t: cutoffNow,
        displayT: cutoffNow,
        v: sumNow,
        preStart: false,
        postEnd: false,
        synthetic: true,
      });
    }
  }

  const span = Math.max(1, endMs - startMs);
  const idealAt = (t: number) =>
    totalEffort * (1 - clamp((t - startMs) / span, 0, 1));

  const remainingNow = actual[actual.length - 1]?.v ?? totalEffort;
  const idealNow = idealAt(inputs.nowMs);
  const health = classifyHealth(
    idealNow,
    remainingNow,
    totalEffort,
    parentBlocked,
  );
  const atRisk = remainingNow > idealNow + totalEffort * 0.15;

  return {
    id,
    title,
    startMs,
    endMs,
    totalEffort,
    remainingNow,
    completedNow: Math.max(0, totalEffort - remainingNow),
    idealNow,
    ideal: [
      { t: startMs, v: totalEffort },
      { t: endMs, v: 0 },
    ],
    actual,
    health,
    atRisk,
    leafCount: leaves.length,
    usesDefaultEffort,
  };
}

// ---------- public series builders ----------

/**
 * Burndown for a single leaf task. `rootId` must be a leaf; if it's a parent
 * you want `buildParentSeries` instead.
 */
export function buildTaskSeries(
  rootId: string,
  inputs: SeriesInputs,
): Series | null {
  const taskById = new Map(inputs.tasks.map((t) => [t.id, t]));
  const t = taskById.get(rootId);
  if (!t) return null;
  return buildSeriesForLeaves(
    t.id,
    t.title,
    [t],
    new Date(t.startDate).getTime(),
    new Date(t.endDate).getTime(),
    t.blocked,
    inputs,
  );
}

/**
 * Burndown rolled up across every leaf descendant of `rootId`. Used by
 * workstream and project tabs on /burndown and by the drawer on /tasks when
 * the opened row has children.
 */
export function buildParentSeries(
  rootId: string,
  inputs: SeriesInputs,
  labelOverride?: string,
): Series | null {
  const taskById = new Map(inputs.tasks.map((t) => [t.id, t]));
  const parent = taskById.get(rootId);
  if (!parent) return null;
  const childrenByParent = indexChildren(inputs.tasks);

  const leaves =
    (childrenByParent.get(parent.id)?.length ?? 0) === 0
      ? [parent]
      : leavesUnder(parent.id, taskById, childrenByParent);

  const startMs = Math.min(
    ...leaves.map((l) => new Date(l.startDate).getTime()),
    new Date(parent.startDate).getTime(),
  );
  const endMs = Math.max(
    ...leaves.map((l) => new Date(l.endDate).getTime()),
    new Date(parent.endDate).getTime(),
  );

  return buildSeriesForLeaves(
    parent.id,
    labelOverride ?? parent.title,
    leaves,
    startMs,
    endMs,
    parent.blocked,
    inputs,
  );
}

/**
 * Project-wide burndown — every leaf in the hierarchy.
 */
export function buildProjectSeries(
  inputs: SeriesInputs,
  title = "Project",
): Series | null {
  const childrenByParent = indexChildren(inputs.tasks);
  const leaves: BurndownTaskInput[] = [];
  for (const t of inputs.tasks) {
    if ((childrenByParent.get(t.id)?.length ?? 0) === 0) leaves.push(t);
  }
  if (leaves.length === 0) return null;
  const startMs = Math.min(
    ...leaves.map((l) => new Date(l.startDate).getTime()),
  );
  const endMs = Math.max(...leaves.map((l) => new Date(l.endDate).getTime()));
  return buildSeriesForLeaves(
    "__project__",
    title,
    leaves,
    startMs,
    endMs,
    false,
    inputs,
  );
}

// ---------- chart component ----------

export function BurndownChart({
  series,
  compact = false,
}: {
  series: Series;
  compact?: boolean;
}) {
  const W = compact ? 640 : 720;
  const H = compact ? 200 : 340;
  const pad = compact
    ? { l: 48, r: 16, t: 18, b: 26 }
    : { l: 60, r: 20, t: 22, b: 34 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const span = Math.max(1, series.endMs - series.startMs);
  const maxY = Math.max(1, series.totalEffort);

  // Hovered dot index — null when nothing is hovered. Driven by
  // mouse/focus on each circle so the chart can render a comment tooltip
  // near the cursor without going through a portal.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const xOf = (t: number) =>
    pad.l +
    ((clamp(t, series.startMs, series.endMs) - series.startMs) / span) *
      innerW;
  const yOf = (v: number) =>
    pad.t + innerH - (clamp(v, 0, maxY) / maxY) * innerH;

  const idealD = series.ideal
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.t)} ${yOf(p.v)}`)
    .join(" ");

  // Stepped actual: hold previous value until the next snapshot, then drop.
  // Uses `displayT` so pre-start / post-end points stay inside the panel.
  let actualD = "";
  series.actual.forEach((p, i) => {
    const x = xOf(p.displayT);
    const y = yOf(p.v);
    if (i === 0) actualD += `M ${x} ${y}`;
    else {
      const prev = series.actual[i - 1];
      actualD += ` L ${x} ${yOf(prev.v)} L ${x} ${y}`;
    }
  });

  const todayX = xOf(Date.now());
  const todayInside =
    Date.now() >= series.startMs && Date.now() <= series.endMs;

  const hColor =
    series.health === "red"
      ? "#ef4444"
      : series.health === "yellow"
        ? "#eab308"
        : "#16a34a";

  const yTicks = niceTicks(0, maxY, compact ? 3 : 5);
  const xT = xTicks(series.startMs, series.endMs, compact ? 4 : 6);

  return (
    <div className={"burn-chart" + (compact ? " burn-chart--compact" : "")}>
      <header className="burn-chart-head">
        <div>
          <h3>{series.title}</h3>
          <p className="burn-chart-sub">
            {fmtDate(new Date(series.startMs))} →{" "}
            {fmtDate(new Date(series.endMs))}
            {series.leafCount > 1 ? ` · ${series.leafCount} leaf tasks` : ""}
          </p>
        </div>
        <div className="burn-chart-stats">
          <Stat label="Total" value={fmtHours(series.totalEffort)} />
          <Stat label="Remaining" value={fmtHours(series.remainingNow)} />
          <Stat label="Done" value={fmtHours(series.completedNow)} />
          <span className="burn-stat">
            <span className="burn-healthdot" style={{ background: hColor }} />
            {series.health === "red"
              ? "Red"
              : series.health === "yellow"
                ? "Yellow"
                : "Green"}
          </span>
          {series.atRisk && <span className="burn-risk">Behind plan</span>}
        </div>
      </header>

      <svg viewBox={`0 0 ${W} ${H}`} className="burn-svg">
        <rect x={0} y={0} width={W} height={H} fill="#ffffff" />

        {/* Y gridlines + hour labels */}
        {yTicks.map((v) => (
          <g key={`y-${v}`}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={yOf(v)}
              y2={yOf(v)}
              stroke="#eef2f6"
              strokeDasharray={v === 0 ? undefined : "2 4"}
            />
            <text
              x={pad.l - 8}
              y={yOf(v) + 3}
              fontSize="10"
              textAnchor="end"
              fill="#94a3b8"
            >
              {fmtHours(v)}
            </text>
          </g>
        ))}

        {/* X axis labels (faint, no vertical gridlines to keep the chart to 2 lines) */}
        {xT.map((t) => (
          <text
            key={`x-${t}`}
            x={xOf(t)}
            y={H - pad.b + 14}
            fontSize="10"
            textAnchor="middle"
            fill="#94a3b8"
          >
            {fmtShort(new Date(t))}
          </text>
        ))}

        {/* axis rules */}
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} stroke="#cbd5e1" />
        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={H - pad.b}
          y2={H - pad.b}
          stroke="#cbd5e1"
        />

        {/* required line */}
        <path
          d={idealD}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />

        {/* actual line */}
        <path
          d={actualD}
          fill="none"
          stroke="rgb(90 95 223)"
          strokeWidth={2.2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {series.actual.map((p, i) => {
          const cx = xOf(p.displayT);
          const cy = yOf(p.v);
          const baseR = compact ? 2.8 : 3.4;
          const isHovered = hoverIdx === i;
          // Synthetic anchors (startMs baseline + "now" tip) render smaller
          // and without hover so the user's real updates are visually dominant.
          if (p.synthetic) {
            return (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={baseR - 0.6}
                fill="#ffffff"
                stroke="rgb(90 95 223)"
                strokeWidth={1.3}
              />
            );
          }
          const strokeColor = p.preStart || p.postEnd ? "#b45309" : "#ffffff";
          return (
            <g key={i}>
              <circle
                cx={cx}
                cy={cy}
                r={isHovered ? baseR + 2 : baseR}
                fill="rgb(90 95 223)"
                stroke={strokeColor}
                strokeWidth={isHovered ? 2 : 1.4}
                style={{ cursor: "pointer", transition: "r 120ms ease" }}
                tabIndex={0}
                role="button"
                aria-label={
                  p.comment
                    ? `Update on ${new Date(p.t).toLocaleString()}: ${p.comment}`
                    : `Update on ${new Date(p.t).toLocaleString()}`
                }
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() =>
                  setHoverIdx((h) => (h === i ? null : h))
                }
                onFocus={() => setHoverIdx(i)}
                onBlur={() =>
                  setHoverIdx((h) => (h === i ? null : h))
                }
              />
              {/* Fallback native tip for keyboard users / no-JS. */}
              <title>
                {(() => {
                  const head = `${new Date(p.t).toLocaleString()} — ${fmtHours(p.v)}`;
                  const srcs = p.sources ?? [];
                  const multiLeaf = series.leafCount > 1;
                  if (multiLeaf && srcs.length > 0) {
                    const lines = srcs.map((s) =>
                      s.comment ? `${s.taskTitle} — ${s.comment}` : s.taskTitle,
                    );
                    return head + "\n" + lines.join("\n");
                  }
                  return p.comment ? `${head}\n${p.comment}` : head;
                })()}
              </title>
            </g>
          );
        })}

        {/* today marker */}
        {todayInside && (
          <g>
            <line
              x1={todayX}
              x2={todayX}
              y1={pad.t}
              y2={H - pad.b}
              stroke="#ef4444"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <text
              x={todayX + 4}
              y={pad.t + 10}
              fontSize="10"
              fill="#ef4444"
            >
              today
            </text>
          </g>
        )}

        {/* Hover tooltip — rendered last so it draws over axes + dots.
            Strongly biased ABOVE the hovered dot so we never eclipse the
            comment field / update form that sits below the chart. Height
            grows with content; we estimate per-line height + wrapping so
            long comments don't get clipped mid-sentence. */}
        {hoverIdx != null &&
          (() => {
            const p = series.actual[hoverIdx];
            if (!p || p.synthetic) return null;
            const cx = xOf(p.displayT);
            const cy = yOf(p.v);
            const bodyLines: string[] = [];
            bodyLines.push(
              `${fmtHours(p.v)} remaining · ${new Date(p.t).toLocaleString()}`,
            );
            if (p.preStart) {
              bodyLines.push(
                "Pushed before task start — plotted at the start date.",
              );
            } else if (p.postEnd) {
              bodyLines.push(
                "Pushed after task end — plotted at the end date.",
              );
            }
            // Attribution: which leaf task(s) pushed this update. Only
            // meaningful when the series rolls up multiple leaves (the
            // project/workstream view); a single-leaf series would just
            // echo its own title, so we hide it there.
            const sources = p.sources ?? [];
            const multiLeaf = series.leafCount > 1;
            if (multiLeaf && sources.length > 0) {
              if (sources.length === 1) {
                const src = sources[0];
                const line = src.comment
                  ? `${src.taskTitle} — ${src.comment}`
                  : src.taskTitle;
                bodyLines.push(line);
              } else {
                bodyLines.push(
                  `${sources.length} tasks updated at this time:`,
                );
                // Cap to 5 leaves so the tooltip stays within chart
                // bounds even on an extremely busy timestamp; users
                // can drill into the rest via the task drawer.
                const MAX_LEAVES = 5;
                for (const src of sources.slice(0, MAX_LEAVES)) {
                  bodyLines.push(
                    src.comment
                      ? `• ${src.taskTitle} — ${src.comment}`
                      : `• ${src.taskTitle}`,
                  );
                }
                if (sources.length > MAX_LEAVES) {
                  bodyLines.push(
                    `…and ${sources.length - MAX_LEAVES} more`,
                  );
                }
              }
            } else if (p.comment) {
              // Single-leaf series: just the comment, no task echo.
              bodyLines.push(p.comment);
            }

            const tipW = compact ? 240 : 280;
            const lineH = compact ? 16 : 18;
            // Rough character-wrap estimate so multi-line comments get room.
            const charsPerLine = Math.max(
              20,
              Math.floor((tipW - 20) / (compact ? 6.2 : 6.8)),
            );
            let visualLines = 0;
            for (const line of bodyLines) {
              visualLines += Math.max(
                1,
                Math.ceil(line.length / charsPerLine),
              );
            }
            const tipH = 16 + visualLines * lineH;

            // Prefer ABOVE the dot so the user's update form underneath
            // the chart never gets blocked. Flip below only when there's
            // genuinely no room (first row of the chart).
            const gap = 14;
            const roomAbove = cy - pad.t;
            const placeAbove = roomAbove >= tipH + gap + 2;
            let tipY = placeAbove ? cy - tipH - gap : cy + gap;

            let tipX = cx - tipW / 2;
            // Let the tip breathe slightly past the chart edges — the
            // translucent background keeps it from looking like a block.
            tipX = Math.max(4, Math.min(W - tipW - 4, tipX));

            return (
              <foreignObject
                x={tipX}
                y={tipY}
                width={tipW}
                height={tipH}
                style={{ pointerEvents: "none", overflow: "visible" }}
              >
                <div className="burn-tip">
                  {bodyLines.map((line, i) => (
                    <div
                      key={i}
                      className={
                        i === 0 ? "burn-tip-head" : "burn-tip-line"
                      }
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </foreignObject>
            );
          })()}
      </svg>

      <div className="burn-legend">
        <span>
          <span
            className="burn-legend-dot burn-legend-dot--dashed"
            style={{ background: "#94a3b8" }}
          />
          Required (estimated hours remaining)
        </span>
        <span>
          <span
            className="burn-legend-dot"
            style={{ background: "rgb(90 95 223)" }}
          />
          Actual (from progress updates)
        </span>
        {series.usesDefaultEffort && (
          <span className="burn-legend-note">
            Some leaves have no estimate — defaulted to {DEFAULT_EFFORT_HOURS}h.
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="burn-stat">
      <span className="burn-stat-label">{label}</span>
      <span className="burn-stat-value">{value}</span>
    </span>
  );
}

function fmtHours(h: number): string {
  if (h <= 0) return "0h";
  if (h >= 1000) return `${(h / 1000).toFixed(1)}k h`;
  if (h >= 100) return `${Math.round(h)}h`;
  if (h >= 10) return `${h.toFixed(0)}h`;
  return `${h.toFixed(1)}h`;
}

function niceTicks(min: number, max: number, target = 5): number[] {
  const raw = (max - min) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const n = raw / mag;
  const step =
    n < 1.5 ? 1 * mag : n < 3 ? 2 * mag : n < 7 ? 5 * mag : 10 * mag;
  const out: number[] = [];
  let v = Math.ceil(min / step) * step;
  while (v <= max + 1e-6) {
    out.push(v);
    v += step;
  }
  if (out[0] !== min) out.unshift(min);
  if (out[out.length - 1] !== max) out.push(max);
  return [...new Set(out)].sort((a, b) => a - b);
}

function xTicks(startMs: number, endMs: number, target = 6): number[] {
  const span = endMs - startMs;
  const days = Math.max(1, Math.round(span / 86_400_000));
  const step = Math.max(1, Math.round(days / target));
  const ticks: number[] = [];
  for (let i = 0; i <= days; i += step) {
    ticks.push(startMs + i * 86_400_000);
  }
  if (ticks[ticks.length - 1] !== endMs) ticks.push(endMs);
  return ticks;
}

function fmtDate(d: Date) {
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtShort(d: Date) {
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
