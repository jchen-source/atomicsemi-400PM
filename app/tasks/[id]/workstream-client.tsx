"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ISSUE_TYPES,
  SCHEDULE_IMPACTS,
  URGENCIES,
  serializeIssueMeta,
  type IssueStatus,
  type IssueType,
  type IssueUrgency,
  type ScheduleImpact,
} from "@/lib/open-issues";
import {
  BurndownChart,
  buildParentSeries,
  buildTaskSeries,
  type BurndownSnapshotInput,
  type BurndownTaskInput,
} from "../burndown-chart";
import {
  OwnerPicker,
  initialsOf,
  type PersonOption,
} from "../tasks-client";

/**
 * Workstream standup client.
 *
 * Layout:
 *   ┌─ header (title, stats, health) ─────────────────────────┐
 *   │ big burndown chart (rollup of every leaf below parent)  │
 *   └─────────────────────────────────────────────────────────┘
 *   ┌─ child card ─┐ ┌─ child card ─┐ ...
 *   │ mini chart   │ │ mini chart   │
 *   │ quick update │ │ quick update │
 *   │ ▾ history    │ │ ▾ history    │
 *   └──────────────┘ └──────────────┘
 *
 * Update loop:
 *   1. User types comment + nudges progress in a card's inline form.
 *   2. Save POSTs /api/tasks/[id]/progress (the shared progress endpoint).
 *   3. On success we splice the returned snapshot into local state — the big
 *      chart, the card's mini chart, and the history dropdown all redraw in
 *      the same React render without a full page refresh.
 */

export type WorkstreamHeader = {
  id: string;
  title: string;
  type: string;
  status: string;
  blocked: boolean;
  assignee: string | null;
  startDate: string;
  endDate: string;
  progress: number;
  effortHours: number | null;
  remainingEffort: number | null;
  health: "green" | "yellow" | "red" | null;
};

export type LinkedIssue = {
  id: string;
  title: string;
  status: IssueStatus;
  urgency: IssueUrgency;
  issueType: IssueType;
  scheduleImpact: ScheduleImpact;
  owner: string | null;
  dueDate: string;
  createdAt: string;
  linkedTaskId: string;
};

export type ChildCard = {
  id: string;
  title: string;
  type: string;
  hasChildren: boolean;
  childCount: number;
  assignee: string | null;
  status: string;
  blocked: boolean;
  progress: number;
  effortHours: number | null;
  remainingEffort: number | null;
  startDate: string;
  endDate: string;
  nextStep: string | null;
  health: "green" | "yellow" | "red" | null;
  lastProgressAt: string | null;
  issues: LinkedIssue[];
};

export type WorkstreamSnapshot = {
  id: string;
  taskId: string;
  createdAt: string;
  comment: string;
  progress: number;
  remainingEffort: number | null;
  status: string | null;
  blocked: boolean | null;
  health: "green" | "yellow" | "red" | null;
};

type Props = {
  header: WorkstreamHeader;
  cards: ChildCard[];
  burnTasks: BurndownTaskInput[];
  burnSnapshots: BurndownSnapshotInput[];
  displaySnapshots: WorkstreamSnapshot[];
  nowISO: string;
  people: PersonOption[];
};

export default function WorkstreamClient({
  header,
  cards: initialCards,
  burnTasks: initialBurnTasks,
  burnSnapshots: initialBurnSnapshots,
  displaySnapshots: initialDisplay,
  nowISO,
  people,
}: Props) {
  // Everything is client-owned from here so saves stay optimistic.
  const [cards, setCards] = useState<ChildCard[]>(initialCards);
  const [burnTasks, setBurnTasks] =
    useState<BurndownTaskInput[]>(initialBurnTasks);
  const [burnSnapshots, setBurnSnapshots] = useState<BurndownSnapshotInput[]>(
    initialBurnSnapshots,
  );
  const [history, setHistory] =
    useState<WorkstreamSnapshot[]>(initialDisplay);
  const [headerState, setHeaderState] = useState<WorkstreamHeader>(header);

  const nowMs = new Date(nowISO).getTime();

  // Big chart: rollup of every leaf under the parent.
  const bigSeries = useMemo(
    () =>
      buildParentSeries(
        header.id,
        { tasks: burnTasks, snapshots: burnSnapshots, nowMs },
        header.title,
      ),
    [header.id, header.title, burnTasks, burnSnapshots, nowMs],
  );

  // Snapshots grouped by task for the dropdown histories on each card. Newest
  // first so the most recent update is always at the top of the list.
  const historyByTask = useMemo(() => {
    const m = new Map<string, WorkstreamSnapshot[]>();
    for (const s of history) {
      const arr = m.get(s.taskId) ?? [];
      arr.push(s);
      m.set(s.taskId, arr);
    }
    for (const arr of m.values()) {
      arr.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    }
    return m;
  }, [history]);

  const onSaved = (
    cardId: string,
    affected: Array<{
      id: string;
      progress?: number;
      status?: string;
      blocked?: boolean;
      startDate?: string;
      endDate?: string;
      health?: "green" | "yellow" | "red" | null;
      remainingEffort?: number | null;
      nextStep?: string | null;
      effortHours?: number | null;
      lastProgressAt?: string | null;
    }>,
    newSnapshot: WorkstreamSnapshot,
  ) => {
    // 1. Patch the card that was edited.
    setCards((prev) =>
      prev.map((c) => {
        const hit = affected.find((a) => a.id === c.id);
        if (!hit) return c;
        return {
          ...c,
          progress: hit.progress ?? c.progress,
          status: hit.status ?? c.status,
          blocked: hit.blocked ?? c.blocked,
          health: hit.health ?? c.health,
          remainingEffort:
            hit.remainingEffort !== undefined
              ? hit.remainingEffort
              : c.remainingEffort,
          effortHours:
            hit.effortHours !== undefined ? hit.effortHours : c.effortHours,
          nextStep: hit.nextStep !== undefined ? hit.nextStep : c.nextStep,
          startDate: hit.startDate ?? c.startDate,
          endDate: hit.endDate ?? c.endDate,
          lastProgressAt: hit.lastProgressAt ?? c.lastProgressAt,
        };
      }),
    );

    // 2. Patch the header if the parent rolled up.
    const parentHit = affected.find((a) => a.id === header.id);
    if (parentHit) {
      setHeaderState((prev) => ({
        ...prev,
        progress: parentHit.progress ?? prev.progress,
        status: parentHit.status ?? prev.status,
        blocked: parentHit.blocked ?? prev.blocked,
        health: parentHit.health ?? prev.health,
        startDate: parentHit.startDate ?? prev.startDate,
        endDate: parentHit.endDate ?? prev.endDate,
      }));
    }

    // 3. Mirror the same changes into the burndown task list — parent series
    // and mini series both read from this array.
    setBurnTasks((prev) =>
      prev.map((t) => {
        const hit = affected.find((a) => a.id === t.id);
        if (!hit) return t;
        return {
          ...t,
          progress: hit.progress ?? t.progress,
          status: hit.status ?? t.status,
          blocked: hit.blocked ?? t.blocked,
          health: hit.health ?? t.health,
          startDate: hit.startDate ?? t.startDate,
          endDate: hit.endDate ?? t.endDate,
          effortHours:
            hit.effortHours !== undefined ? hit.effortHours : t.effortHours,
        };
      }),
    );

    // 4. Append the snapshot — big chart gets a new point, mini chart for
    //    the card steps down, and the history dropdown picks it up.
    setBurnSnapshots((prev) => [
      ...prev,
      {
        id: newSnapshot.id,
        taskId: cardId,
        createdAt: newSnapshot.createdAt,
        commentType: "PROGRESS",
        progress: newSnapshot.progress,
        remainingEffort: newSnapshot.remainingEffort,
        status: newSnapshot.status,
        health: newSnapshot.health,
        comment: newSnapshot.comment,
      },
    ]);
    setHistory((prev) => [newSnapshot, ...prev]);
  };

  // Remove a snapshot (history entry + burndown ping). The API
  // also rewinds task state when the deleted row was the latest
  // PROGRESS snapshot for its task — we mirror that locally so
  // the workstream's big chart, mini cards, and chip colors stay
  // consistent without waiting for a full server round-trip.
  const onSnapshotDeleted = (
    cardId: string,
    deletedId: string,
    nextState:
      | {
          progress: number;
          status: string;
          health: "green" | "yellow" | "red" | null;
          blocked: boolean;
          remainingEffort: number | null;
        }
      | null,
  ) => {
    setHistory((prev) => prev.filter((s) => s.id !== deletedId));
    setBurnSnapshots((prev) => prev.filter((s) => s.id !== deletedId));
    if (nextState) {
      setCards((prev) =>
        prev.map((c) =>
          c.id === cardId
            ? {
                ...c,
                progress: nextState.progress,
                status: nextState.status,
                health: nextState.health,
                blocked: nextState.blocked,
                remainingEffort: nextState.remainingEffort,
              }
            : c,
        ),
      );
      setBurnTasks((prev) =>
        prev.map((t) =>
          t.id === cardId
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
      if (header.id === cardId) {
        setHeaderState((prev) => ({
          ...prev,
          progress: nextState.progress,
          status: nextState.status,
          health: nextState.health,
          blocked: nextState.blocked,
        }));
      }
    }
  };

  // Owner change: card's chip popover PATCHes assignee. No rollup / chart
  // changes to mirror — just keep `cards` in sync so the card's own chip
  // re-renders with the new value on next re-render. Extracted out of
  // onSaved because it has no snapshot and doesn't affect burndown state.
  const onOwnerChanged = (cardId: string, assignee: string | null) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, assignee } : c)),
    );
    if (header.id === cardId) {
      setHeaderState((prev) => ({ ...prev, assignee }));
    }
  };

  // Reschedule: PATCH the task with new start/end dates. Used by the
  // late-start banner so the standup can move a slipped task forward
  // without jumping back to the Gantt. We mirror the affected rows into
  // `cards` / `burnTasks` / header to keep every chart consistent.
  const onRescheduled = (
    cardId: string,
    affected: Array<{
      id: string;
      startDate?: string;
      endDate?: string;
      progress?: number;
      status?: string;
    }>,
  ) => {
    setCards((prev) =>
      prev.map((c) => {
        const hit = affected.find((a) => a.id === c.id);
        if (!hit) return c;
        return {
          ...c,
          startDate: hit.startDate ?? c.startDate,
          endDate: hit.endDate ?? c.endDate,
          status: hit.status ?? c.status,
          progress: hit.progress ?? c.progress,
        };
      }),
    );
    setBurnTasks((prev) =>
      prev.map((t) => {
        const hit = affected.find((a) => a.id === t.id);
        if (!hit) return t;
        return {
          ...t,
          startDate: hit.startDate ?? t.startDate,
          endDate: hit.endDate ?? t.endDate,
          status: hit.status ?? t.status,
          progress: hit.progress ?? t.progress,
        };
      }),
    );
    const parentHit = affected.find((a) => a.id === header.id);
    if (parentHit) {
      setHeaderState((prev) => ({
        ...prev,
        startDate: parentHit.startDate ?? prev.startDate,
        endDate: parentHit.endDate ?? prev.endDate,
        status: parentHit.status ?? prev.status,
        progress: parentHit.progress ?? prev.progress,
      }));
    }
    // Silence unused-variable warning while keeping the signature stable.
    void cardId;
  };

  // File-issue handler: attaches a new ISSUE-type row to the card's task
  // and injects it into the card's linked issue list so the red banner
  // disappears on the next render (tracked). The Gantt at "/" picks up
  // the same data on its next server render thanks to revalidatePath.
  const onIssueFiled = (cardId: string, issue: LinkedIssue) => {
    setCards((prev) =>
      prev.map((c) =>
        c.id === cardId ? { ...c, issues: [issue, ...c.issues] } : c,
      ),
    );
  };

  // Resolve-issue handler: flips the linked issue to DONE in place.
  const onIssueResolved = (cardId: string, issueId: string) => {
    setCards((prev) =>
      prev.map((c) =>
        c.id === cardId
          ? {
              ...c,
              issues: c.issues.map((i) =>
                i.id === issueId ? { ...i, status: "DONE" } : i,
              ),
            }
          : c,
      ),
    );
  };

  return (
    <div className="workstream-shell">
      <section className="workstream-bigchart">
        <div className="workstream-headline">
          <h1>{headerState.title}</h1>
          <div className="workstream-headline-meta">
            <MetaPill label="Owner" value={headerState.assignee ?? "—"} />
            <MetaPill
              label="Dates"
              value={`${fmtDate(headerState.startDate)} → ${fmtDate(headerState.endDate)}`}
            />
            <MetaPill
              label="Progress"
              value={`${Math.round(headerState.progress)}%`}
            />
            <StatusPill
              status={headerState.status}
              blocked={headerState.blocked}
            />
            <HealthPill health={headerState.health} />
          </div>
        </div>
        {bigSeries ? (
          <BurndownChart series={bigSeries} />
        ) : (
          <p className="workstream-empty">
            No effort data yet — add tasks underneath to see the burndown.
          </p>
        )}
      </section>

      <section className="workstream-cards">
        <div className="workstream-cards-head">
          {(() => {
            // When the parent has no children the server sends a single
            // "self card" so the user can push updates directly on the
            // workstream/leaf. Retitle the section so it's obvious
            // they're editing the row itself, not a child of it.
            const selfOnly =
              cards.length === 1 && cards[0].id === headerState.id;
            if (selfOnly) {
              return (
                <>
                  <h2>Update this item</h2>
                  <p className="workstream-muted">
                    No subtasks yet — push updates here to edit this row
                    directly. Add child tasks from the Gantt to split the
                    work down into individual cards.
                  </p>
                </>
              );
            }
            return (
              <>
                <h2>Tasks in this workstream</h2>
                <p className="workstream-muted">
                  {cards.length} {cards.length === 1 ? "task" : "tasks"} —
                  push an update on any card and the big chart above
                  redraws instantly.
                </p>
              </>
            );
          })()}
        </div>
        {cards.length === 0 ? (
          <p className="workstream-empty">
            No child tasks yet. Create some from the Gantt chart and they'll
            appear here.
          </p>
        ) : (
          <div className="workstream-cards-grid">
            {cards.map((c) => (
              <TaskCard
                key={c.id}
                card={c}
                history={historyByTask.get(c.id) ?? []}
                burnTasks={burnTasks}
                burnSnapshots={burnSnapshots}
                nowMs={nowMs}
                people={people}
                onSaved={onSaved}
                onOwnerChanged={onOwnerChanged}
                onRescheduled={onRescheduled}
                onIssueFiled={onIssueFiled}
                onIssueResolved={onIssueResolved}
                onSnapshotDeleted={onSnapshotDeleted}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- Task card ----------

function TaskCard({
  card,
  history,
  burnTasks,
  burnSnapshots,
  nowMs,
  people,
  onSaved,
  onOwnerChanged,
  onRescheduled,
  onIssueFiled,
  onIssueResolved,
  onSnapshotDeleted,
}: {
  card: ChildCard;
  history: WorkstreamSnapshot[];
  burnTasks: BurndownTaskInput[];
  burnSnapshots: BurndownSnapshotInput[];
  nowMs: number;
  people: PersonOption[];
  onOwnerChanged: (cardId: string, assignee: string | null) => void;
  onSnapshotDeleted: (
    cardId: string,
    deletedId: string,
    nextState: {
      progress: number;
      status: string;
      health: "green" | "yellow" | "red" | null;
      blocked: boolean;
      remainingEffort: number | null;
    } | null,
  ) => void;
  onSaved: (
    cardId: string,
    affected: Array<{
      id: string;
      progress?: number;
      status?: string;
      blocked?: boolean;
      startDate?: string;
      endDate?: string;
      health?: "green" | "yellow" | "red" | null;
      remainingEffort?: number | null;
      nextStep?: string | null;
      effortHours?: number | null;
      lastProgressAt?: string | null;
    }>,
    newSnapshot: WorkstreamSnapshot,
  ) => void;
  onRescheduled: (
    cardId: string,
    affected: Array<{
      id: string;
      startDate?: string;
      endDate?: string;
      progress?: number;
      status?: string;
    }>,
  ) => void;
  onIssueFiled: (cardId: string, issue: LinkedIssue) => void;
  onIssueResolved: (cardId: string, issueId: string) => void;
}) {
  // Mini series: leaf → its own single-task burndown; parent → rollup of its
  // leaves. Both share the same SVG primitives via the compact chart variant.
  const miniSeries = useMemo(() => {
    const inputs = { tasks: burnTasks, snapshots: burnSnapshots, nowMs };
    return card.hasChildren
      ? buildParentSeries(card.id, inputs)
      : buildTaskSeries(card.id, inputs);
  }, [card.id, card.hasChildren, burnTasks, burnSnapshots, nowMs]);

  // Inline form state. Initialized from the card but controlled so a save
  // can clear the comment without losing numeric fields if the user rolls
  // straight into another update.
  //
  // `remaining` is a DERIVED quantity: by default it tracks
  // `estimate × (1 − progress/100)` so the user only has to move the
  // progress slider to see the burndown shift. If the user types in the
  // Remaining box directly, we flip `remainingDirty` on and stop auto-
  // deriving until the form is re-synced from the card props.
  const [progress, setProgress] = useState<number>(card.progress);
  const [estimate, setEstimate] = useState<number | "">(
    card.effortHours ?? "",
  );
  const [remaining, setRemaining] = useState<number | "">(() => {
    if (card.remainingEffort != null) return card.remainingEffort;
    if (card.effortHours && card.effortHours > 0) {
      return Math.max(
        0,
        Math.round(card.effortHours * (1 - card.progress / 100)),
      );
    }
    return "";
  });
  const [remainingDirty, setRemainingDirty] = useState<boolean>(false);
  const [statusValue, setStatusValue] = useState<string>(card.status);
  const [blocked, setBlocked] = useState<boolean>(card.blocked);
  const [comment, setComment] = useState<string>("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Owner chip is now a popover trigger. Optimistically update so the chip
  // flips immediately; the PATCH below syncs the server + triggers rollup.
  const [assignee, setAssignee] = useState<string | null>(card.assignee);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerSaving, setOwnerSaving] = useState(false);

  // Reset form fields when card prop changes (e.g. after save affects them).
  useMemo(() => {
    setProgress(card.progress);
    setEstimate(card.effortHours ?? "");
    // Prefer the card's saved remainingEffort if set, else derive from
    // estimate × (1 − progress) so the chip reflects the latest math.
    if (card.remainingEffort != null) {
      setRemaining(card.remainingEffort);
    } else if (card.effortHours && card.effortHours > 0) {
      setRemaining(
        Math.max(
          0,
          Math.round(card.effortHours * (1 - card.progress / 100)),
        ),
      );
    } else {
      setRemaining("");
    }
    setRemainingDirty(false);
    setStatusValue(card.status);
    setBlocked(card.blocked);
    setAssignee(card.assignee);
  }, [
    card.progress,
    card.remainingEffort,
    card.effortHours,
    card.status,
    card.blocked,
    card.assignee,
  ]);

  // Derived value shown whenever the user hasn't manually overridden
  // Remaining in this form session. Kept out of component state so it
  // recomputes on every render — cheap and avoids a stale-closure effect.
  const derivedRemaining: number | null =
    estimate !== "" && Number(estimate) > 0
      ? Math.max(
          0,
          Math.round(Number(estimate) * (1 - progress / 100)),
        )
      : null;
  const effectiveRemaining: number | "" = remainingDirty
    ? remaining
    : derivedRemaining ?? "";

  async function saveOwner(name: string | null) {
    const next = name && name.trim() ? name.trim() : null;
    if ((assignee ?? null) === next) {
      setOwnerOpen(false);
      return;
    }
    setOwnerSaving(true);
    setError(null);
    setAssignee(next);
    try {
      const res = await fetch(`/api/tasks/${card.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignee: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onOwnerChanged(card.id, next);
      setOwnerOpen(false);
    } catch (e) {
      setAssignee(card.assignee);
      setError(e instanceof Error ? e.message : "Failed to update owner");
    } finally {
      setOwnerSaving(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        progress,
        status: statusValue,
        blocked,
      };
      // Leaf tasks can set estimated hours; parents ignore it on the server.
      if (!card.hasChildren && estimate !== "") {
        body.effortHours = Number(estimate);
      }
      // Always snapshot a remaining value so the burndown can step. Fall
      // back to the derived value if the user didn't type one in.
      const toSend =
        effectiveRemaining === "" ? null : Number(effectiveRemaining);
      if (toSend !== null) body.remainingEffort = toSend;
      if (comment.trim()) body.comment = comment.trim();
      const res = await fetch(`/api/tasks/${card.id}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        task: unknown;
        snapshot: {
          id: string;
          createdAt: string;
          comment: string;
          progress: number | null;
          remainingEffort: number | null;
          status: string | null;
          blocked: boolean | null;
          health: string | null;
        };
        affected: Array<{
          id: string;
          progress?: number;
          status?: string;
          blocked?: boolean;
          startDate?: string;
          endDate?: string;
          health?: string | null;
          remainingEffort?: number | null;
          nextStep?: string | null;
          effortHours?: number | null;
          lastProgressAt?: string | null;
        }>;
      };
      onSaved(
        card.id,
        data.affected.map((a) => ({
          ...a,
          health: (a.health as "green" | "yellow" | "red" | null) ?? null,
        })),
        {
          id: data.snapshot.id,
          taskId: card.id,
          createdAt: data.snapshot.createdAt,
          comment: data.snapshot.comment ?? comment.trim(),
          progress: data.snapshot.progress ?? progress,
          remainingEffort: data.snapshot.remainingEffort ?? null,
          status: data.snapshot.status ?? statusValue,
          blocked: data.snapshot.blocked ?? blocked,
          health:
            (data.snapshot.health as "green" | "yellow" | "red" | null) ??
            null,
        },
      );
      setComment("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const lastUpdatedLabel = history[0]?.createdAt
    ? fmtRelative(new Date(history[0].createdAt))
    : card.lastProgressAt
      ? fmtRelative(new Date(card.lastProgressAt))
      : "no updates yet";

  // Late-to-start detection. We only flag a card "late" if its planned
  // start is in the past AND nothing has been reported on it yet
  // (progress === 0, no active DONE/IN_PROGRESS status). Active slipping
  // issues also tint the card so the user sees the red without doing any
  // math on the due dates.
  const daysLate = Math.max(
    0,
    Math.floor(
      (nowMs - new Date(card.startDate).getTime()) / 86_400_000,
    ),
  );
  const isLateToStart =
    daysLate > 0 &&
    card.progress === 0 &&
    card.status !== "DONE" &&
    card.status !== "IN_PROGRESS";

  const activeIssues = card.issues.filter((i) => i.status !== "DONE");
  const slippingIssues = activeIssues.filter(
    (i) =>
      i.scheduleImpact === "Task Slip" ||
      i.scheduleImpact === "Workstream Slip",
  );
  const hasSlippingIssue = slippingIssues.length > 0;
  // Ownership lookup for the avatar chip. The server stores `assignee`
  // as a free-form string; we derive initials so even Notion imports
  // without a matching Person row still render a prominent chip. We read
  // from the local `assignee` state (not card.assignee directly) so the
  // chip updates instantly on save, even before the parent re-renders.
  const ownerName = (assignee ?? "").trim();
  const ownerInitials = ownerName ? initialsOf(ownerName) : null;

  const cardClass = [
    "ws-card",
    `ws-card--${card.health ?? "unset"}`,
    isLateToStart ? "ws-card--late" : "",
    hasSlippingIssue ? "ws-card--slipping" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={cardClass}>
      <header className="ws-card-head">
        <div className="ws-card-title">
          <div className="ws-card-title-row">
            <h3>
              {card.hasChildren ? (
                <Link href={`/tasks/${card.id}`}>{card.title}</Link>
              ) : (
                card.title
              )}
            </h3>
            <span className="ws-owner-wrap">
              <button
                type="button"
                className={
                  "ws-owner-chip" +
                  (ownerInitials ? "" : " ws-owner-chip--empty")
                }
                onClick={() => setOwnerOpen((v) => !v)}
                disabled={ownerSaving}
                title={
                  ownerInitials
                    ? `Owner: ${ownerName} — click to reassign`
                    : "Assign an owner"
                }
              >
                <span className="ws-owner-chip__avatar" aria-hidden>
                  {ownerInitials ?? "?"}
                </span>
                <span className="ws-owner-chip__name">
                  {ownerSaving
                    ? "Saving…"
                    : ownerInitials
                      ? ownerName
                      : "Unassigned"}
                </span>
                <span className="ws-owner-chip__chev" aria-hidden>
                  ▾
                </span>
              </button>
              {ownerOpen && (
                <OwnerPicker
                  people={people}
                  currentAssignee={assignee}
                  onSelect={(name) => void saveOwner(name)}
                  onClose={() => setOwnerOpen(false)}
                />
              )}
            </span>
          </div>
          <div className="ws-card-submeta">
            <span>
              {fmtDate(card.startDate)} → {fmtDate(card.endDate)}
            </span>
            {card.hasChildren && (
              <>
                <span>·</span>
                <span>{card.childCount} subtasks</span>
              </>
            )}
            {activeIssues.length > 0 && (
              <>
                <span>·</span>
                <span className="ws-card-issue-count">
                  {activeIssues.length} open issue
                  {activeIssues.length === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
        </div>
        <HealthPill health={card.health} compact />
      </header>

      {(isLateToStart || hasSlippingIssue) && (
        <LateStartBanner
          card={card}
          daysLate={daysLate}
          hasSlippingIssue={hasSlippingIssue}
          onRescheduled={onRescheduled}
          onIssueFiled={onIssueFiled}
        />
      )}

      <div
        className={
          "ws-card-body" + (card.hasChildren ? " ws-card-body--rollup" : "")
        }
      >
        <div className="ws-card-chart">
          {miniSeries ? (
            <BurndownChart series={miniSeries} compact />
          ) : (
            <p className="workstream-muted">No chart yet.</p>
          )}
        </div>

        {card.hasChildren ? (
          // Parent rows don't accept standalone updates — everything here
          // is a rollup of the subtasks, so editing at this level would
          // get overwritten by the next child save. Nudge the user down
          // into the subtask where the actual work is tracked.
          <aside className="ws-rollup-note">
            <div className="ws-rollup-note__icon" aria-hidden>
              ↯
            </div>
            <div className="ws-rollup-note__body">
              <p className="ws-rollup-note__head">
                Updates roll up from subtasks
              </p>
              <p className="ws-rollup-note__sub">
                This row summarizes {card.childCount}{" "}
                {card.childCount === 1 ? "subtask" : "subtasks"}. Push
                comments and progress on a subtask — progress %, remaining
                hours, and health all flow up here automatically.
              </p>
              <Link
                href={`/tasks/${card.id}`}
                className="ws-rollup-note__cta"
              >
                Open subtasks →
              </Link>
            </div>
          </aside>
        ) : (
        <form
          className="ws-card-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="ws-field">
            <span className="ws-field-label">Comment</span>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="What happened since last standup?"
              rows={2}
            />
          </label>

          <div className="ws-field-row">
            <label className="ws-field">
              <span className="ws-field-label">
                Progress <strong>{progress}%</strong>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={progress}
                onChange={(e) => setProgress(Number(e.target.value))}
              />
            </label>
            <label className="ws-field ws-field--small">
              <span className="ws-field-label">
                Estimate (h)
                {card.hasChildren && (
                  <span className="ws-field-hint"> · rollup</span>
                )}
              </span>
              <input
                type="number"
                min={0}
                step={1}
                value={estimate}
                onChange={(e) => {
                  const v = e.target.value;
                  setEstimate(v === "" ? "" : Number(v));
                }}
                placeholder="—"
                disabled={card.hasChildren}
                title={
                  card.hasChildren
                    ? "Parent tasks roll up effort from their children automatically."
                    : "Estimated hours to complete. Remaining auto-updates from this and the progress %."
                }
              />
            </label>
            <label className="ws-field ws-field--small">
              <span className="ws-field-label">
                Remaining (h)
                {!remainingDirty && derivedRemaining != null && (
                  <span className="ws-field-hint"> · auto</span>
                )}
                {remainingDirty && (
                  <button
                    type="button"
                    className="ws-field-reset"
                    onClick={() => setRemainingDirty(false)}
                    title="Reset to estimated × (1 − progress)"
                  >
                    reset
                  </button>
                )}
              </span>
              <input
                type="number"
                min={0}
                step={1}
                value={effectiveRemaining}
                onChange={(e) => {
                  const v = e.target.value;
                  setRemainingDirty(true);
                  setRemaining(v === "" ? "" : Number(v));
                }}
                placeholder={derivedRemaining != null ? String(derivedRemaining) : "—"}
              />
            </label>
          </div>
          {derivedRemaining != null && (
            <p className="ws-field-formula">
              {Number(estimate)}h × (1 − {progress}%) ={" "}
              <strong>{derivedRemaining}h remaining</strong>
              {remainingDirty && effectiveRemaining !== "" && (
                <>
                  {" "}· using override <strong>{effectiveRemaining}h</strong>
                </>
              )}
            </p>
          )}

          <div className="ws-field-row">
            <label className="ws-field ws-field--small">
              <span className="ws-field-label">Status</span>
              <select
                value={statusValue}
                onChange={(e) => setStatusValue(e.target.value)}
              >
                <option value="TODO">To do</option>
                <option value="IN_PROGRESS">In progress</option>
                <option value="BLOCKED">Blocked</option>
                <option value="DONE">Done</option>
              </select>
            </label>
            <label className="ws-field ws-field--check">
              <input
                type="checkbox"
                checked={blocked}
                onChange={(e) => setBlocked(e.target.checked)}
              />
              <span>Blocked</span>
            </label>
            <button
              type="submit"
              className="ws-save"
              disabled={saving}
            >
              {saving ? "Saving…" : "Push update"}
            </button>
          </div>

          {error && <p className="ws-error">{error}</p>}
        </form>
        )}
      </div>

      {card.issues.length > 0 && (
        <LinkedIssuesList
          cardId={card.id}
          issues={card.issues}
          onResolved={onIssueResolved}
        />
      )}

      <footer className="ws-card-foot">
        <button
          type="button"
          className="ws-history-toggle"
          onClick={() => setHistoryOpen((v) => !v)}
          aria-expanded={historyOpen}
        >
          <span>
            Comment history ({history.length})
          </span>
          <span className="ws-history-meta">
            Last update · {lastUpdatedLabel}
          </span>
          <span aria-hidden className="ws-history-caret">
            {historyOpen ? "▲" : "▼"}
          </span>
        </button>
        {historyOpen && (
          <ol className="ws-history-list">
            {history.length === 0 ? (
              <li className="workstream-muted">
                No updates yet. Push the first one above.
              </li>
            ) : (
              history.map((s) => (
                <WsHistoryRow
                  key={s.id}
                  snap={s}
                  cardId={card.id}
                  onSnapshotDeleted={onSnapshotDeleted}
                />
              ))
            )}
          </ol>
        )}
      </footer>
    </article>
  );
}

// ---------- History row with inline delete ----------

function WsHistoryRow({
  snap,
  cardId,
  onSnapshotDeleted,
}: {
  snap: WorkstreamSnapshot;
  cardId: string;
  onSnapshotDeleted: (
    cardId: string,
    deletedId: string,
    nextState: {
      progress: number;
      status: string;
      health: "green" | "yellow" | "red" | null;
      blocked: boolean;
      remainingEffort: number | null;
    } | null,
  ) => void;
}) {
  const router = useRouter();
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
      const res = await fetch(`/api/tasks/${cardId}/updates/${snap.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => ({}))) as {
        nextTaskState?: {
          progress: number;
          status: string;
          health: "green" | "yellow" | "red" | null;
          blocked: boolean;
          remainingEffort: number | null;
        } | null;
      };
      onSnapshotDeleted(cardId, snap.id, body.nextTaskState ?? null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  return (
    <li
      className={"ws-history-item" + (busy ? " ws-history-item--busy" : "")}
    >
      <div className="ws-history-meta-line">
        <time>{fmtDateTime(new Date(snap.createdAt))}</time>
        <span className="ws-history-numbers">
          {snap.progress}%
          {snap.remainingEffort != null
            ? ` · ${snap.remainingEffort}h left`
            : ""}
          {snap.blocked ? " · blocked" : ""}
        </span>
        <HealthPill health={snap.health} compact />
        <button
          type="button"
          className="ws-history-delete"
          onClick={remove}
          disabled={busy}
          aria-label="Delete this update"
          title="Delete this update"
        >
          {busy ? "…" : "✕"}
        </button>
      </div>
      {snap.comment && <p>{snap.comment}</p>}
      {error && <p className="ws-history-error">{error}</p>}
    </li>
  );
}

// ---------- Late start banner + actions ----------

function LateStartBanner({
  card,
  daysLate,
  hasSlippingIssue,
  onRescheduled,
  onIssueFiled,
}: {
  card: ChildCard;
  daysLate: number;
  hasSlippingIssue: boolean;
  onRescheduled: (
    cardId: string,
    affected: Array<{
      id: string;
      startDate?: string;
      endDate?: string;
      progress?: number;
      status?: string;
    }>,
  ) => void;
  onIssueFiled: (cardId: string, issue: LinkedIssue) => void;
}) {
  // One of "none" | "reschedule" | "issue" — only one inline form is
  // open at a time so the card stays scannable.
  const [mode, setMode] = useState<"none" | "reschedule" | "issue">("none");

  const headline = hasSlippingIssue
    ? "Issue is slipping the schedule"
    : daysLate === 0
      ? "Should start today"
      : `Should have started ${daysLate} day${daysLate === 1 ? "" : "s"} ago`;

  const subline = hasSlippingIssue
    ? "Work started late and an open issue is flagging project impact."
    : "Nothing has been reported on this task — reschedule the start or file an issue so the slip is visible on the Gantt.";

  return (
    <div className="ws-card-banner">
      <div className="ws-card-banner-head">
        <span className="ws-card-banner-icon" aria-hidden>
          !
        </span>
        <div className="ws-card-banner-text">
          <strong>{headline}</strong>
          <span>{subline}</span>
        </div>
        <div className="ws-card-banner-actions">
          <button
            type="button"
            className="ws-banner-btn"
            onClick={() =>
              setMode((m) => (m === "reschedule" ? "none" : "reschedule"))
            }
          >
            Reschedule
          </button>
          <button
            type="button"
            className="ws-banner-btn ws-banner-btn--primary"
            onClick={() =>
              setMode((m) => (m === "issue" ? "none" : "issue"))
            }
          >
            File issue
          </button>
        </div>
      </div>

      {mode === "reschedule" && (
        <RescheduleForm
          card={card}
          onCancel={() => setMode("none")}
          onDone={(affected) => {
            onRescheduled(card.id, affected);
            setMode("none");
          }}
        />
      )}
      {mode === "issue" && (
        <FileIssueForm
          card={card}
          defaultScheduleImpact={daysLate >= 3 ? "Task Slip" : "At Risk"}
          onCancel={() => setMode("none")}
          onCreated={(issue) => {
            onIssueFiled(card.id, issue);
            setMode("none");
          }}
        />
      )}
    </div>
  );
}

function RescheduleForm({
  card,
  onCancel,
  onDone,
}: {
  card: ChildCard;
  onCancel: () => void;
  onDone: (
    affected: Array<{
      id: string;
      startDate?: string;
      endDate?: string;
      progress?: number;
      status?: string;
    }>,
  ) => void;
}) {
  const [start, setStart] = useState<string>(toInputDate(card.startDate));
  const [end, setEnd] = useState<string>(toInputDate(card.endDate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const startISO = new Date(start).toISOString();
      const endISO = new Date(end).toISOString();
      if (new Date(startISO) > new Date(endISO)) {
        throw new Error("Start must be on or before end.");
      }
      const res = await fetch(`/api/tasks/${card.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: startISO,
          endDate: endISO,
          updateComment: `Rescheduled: ${fmtDate(startISO)} → ${fmtDate(endISO)}`,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        affected: Array<{
          id: string;
          startDate?: string;
          endDate?: string;
          progress?: number;
          status?: string;
        }>;
      };
      onDone(data.affected ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reschedule failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="ws-banner-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="ws-banner-form-row">
        <label className="ws-banner-field">
          <span className="ws-banner-field-label">New start</span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
          />
        </label>
        <label className="ws-banner-field">
          <span className="ws-banner-field-label">New end</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            required
          />
        </label>
        <button
          type="button"
          className="ws-banner-field-quick"
          onClick={() => {
            const today = new Date();
            const todayStr = toInputDate(today.toISOString());
            setStart(todayStr);
            // Preserve duration; keep end ≥ start.
            const durMs =
              new Date(card.endDate).getTime() -
              new Date(card.startDate).getTime();
            const shifted = new Date(today.getTime() + Math.max(durMs, 0));
            setEnd(toInputDate(shifted.toISOString()));
          }}
        >
          Start today
        </button>
      </div>
      {error && <p className="ws-error">{error}</p>}
      <div className="ws-banner-form-actions">
        <button
          type="button"
          className="ws-banner-btn"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="ws-banner-btn ws-banner-btn--primary"
          disabled={saving}
        >
          {saving ? "Saving…" : "Save dates"}
        </button>
      </div>
    </form>
  );
}

function FileIssueForm({
  card,
  defaultScheduleImpact,
  onCancel,
  onCreated,
}: {
  card: ChildCard;
  defaultScheduleImpact: ScheduleImpact;
  onCancel: () => void;
  onCreated: (issue: LinkedIssue) => void;
}) {
  const [title, setTitle] = useState<string>(
    `Late start: ${card.title}`,
  );
  const [urgency, setUrgency] = useState<IssueUrgency>("high");
  const [issueType, setIssueType] = useState<IssueType>("Risk");
  const [scheduleImpact, setScheduleImpact] = useState<ScheduleImpact>(
    defaultScheduleImpact,
  );
  const [due, setDue] = useState<string>(
    toInputDate(
      new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ),
  );
  const [notes, setNotes] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const tags = serializeIssueMeta({
        urgency,
        issueType,
        scheduleImpact,
      });
      const todayISO = new Date().toISOString();
      const dueISO = new Date(due).toISOString();
      const res = await fetch(`/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || `Late start: ${card.title}`,
          description: notes ? notes : undefined,
          type: "ISSUE",
          status: "TODO",
          startDate: todayISO,
          endDate: dueISO,
          parentId: card.id,
          assignee: card.assignee ?? undefined,
          tags,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const created = (await res.json()) as {
        id: string;
        title: string;
        endDate: string;
        createdAt: string;
        status: string;
        assignee?: string | null;
      };
      onCreated({
        id: created.id,
        title: created.title,
        status: (created.status ?? "TODO") as LinkedIssue["status"],
        urgency,
        issueType,
        scheduleImpact,
        owner: created.assignee ?? card.assignee ?? null,
        dueDate: created.endDate,
        createdAt: created.createdAt,
        linkedTaskId: card.id,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not file issue");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="ws-banner-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="ws-banner-field ws-banner-field--full">
        <span className="ws-banner-field-label">Issue title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </label>
      <div className="ws-banner-form-row">
        <label className="ws-banner-field">
          <span className="ws-banner-field-label">Urgency</span>
          <select
            value={urgency}
            onChange={(e) => setUrgency(e.target.value as IssueUrgency)}
          >
            {URGENCIES.map((u) => (
              <option key={u} value={u}>
                {u === "high" ? "High" : u.charAt(0).toUpperCase() + u.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="ws-banner-field">
          <span className="ws-banner-field-label">Type</span>
          <select
            value={issueType}
            onChange={(e) => setIssueType(e.target.value as IssueType)}
          >
            {ISSUE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="ws-banner-field">
          <span className="ws-banner-field-label">Schedule impact</span>
          <select
            value={scheduleImpact}
            onChange={(e) =>
              setScheduleImpact(e.target.value as ScheduleImpact)
            }
          >
            {SCHEDULE_IMPACTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="ws-banner-field">
          <span className="ws-banner-field-label">Due</span>
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            required
          />
        </label>
      </div>
      <label className="ws-banner-field ws-banner-field--full">
        <span className="ws-banner-field-label">
          Next step (optional)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="What's the mitigation plan?"
        />
      </label>
      {(scheduleImpact === "Task Slip" ||
        scheduleImpact === "Workstream Slip") && (
        <p className="ws-banner-hint">
          Saving will mark this task red on the Gantt chart and roll the
          open-issue count up to its parent workstream.
        </p>
      )}
      {error && <p className="ws-error">{error}</p>}
      <div className="ws-banner-form-actions">
        <button
          type="button"
          className="ws-banner-btn"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="ws-banner-btn ws-banner-btn--primary"
          disabled={saving}
        >
          {saving ? "Filing…" : "File issue"}
        </button>
      </div>
    </form>
  );
}

// ---------- Linked issues list on a card ----------

function LinkedIssuesList({
  cardId,
  issues,
  onResolved,
}: {
  cardId: string;
  issues: LinkedIssue[];
  onResolved: (cardId: string, issueId: string) => void;
}) {
  const active = issues.filter((i) => i.status !== "DONE");
  const resolved = issues.filter((i) => i.status === "DONE");
  if (active.length === 0 && resolved.length === 0) return null;

  return (
    <section className="ws-card-issues">
      <header className="ws-card-issues-head">
        <span>
          Linked issues{" "}
          {active.length > 0 && (
            <span className="ws-card-issues-count">{active.length} active</span>
          )}
        </span>
      </header>
      <ul className="ws-card-issues-list">
        {[...active, ...resolved].map((i) => (
          <LinkedIssueRow
            key={i.id}
            issue={i}
            onResolved={() => onResolved(cardId, i.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function LinkedIssueRow({
  issue,
  onResolved,
}: {
  issue: LinkedIssue;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slipping =
    issue.scheduleImpact === "Task Slip" ||
    issue.scheduleImpact === "Workstream Slip";
  const resolved = issue.status === "DONE";

  async function resolve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${issue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "DONE",
          progress: 100,
          updateComment: "Issue resolved from standup view",
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resolve");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={`ws-issue-row ws-issue-row--${issue.urgency}${slipping ? " ws-issue-row--slipping" : ""}${resolved ? " ws-issue-row--resolved" : ""}`}
    >
      <div className="ws-issue-row-main">
        <div className="ws-issue-row-title">{issue.title}</div>
        <div className="ws-issue-row-meta">
          <span className={`ws-issue-chip ws-issue-chip--${issue.urgency}`}>
            {issue.urgency === "high"
              ? "High"
              : issue.urgency.charAt(0).toUpperCase() +
                issue.urgency.slice(1)}
          </span>
          <span className="ws-issue-chip ws-issue-chip--type">
            {issue.issueType}
          </span>
          {issue.scheduleImpact !== "None" && (
            <span
              className={`ws-issue-chip ws-issue-chip--impact${slipping ? " ws-issue-chip--slip" : ""}`}
            >
              {issue.scheduleImpact}
            </span>
          )}
          <span className="ws-issue-chip ws-issue-chip--ghost">
            Due {fmtDate(issue.dueDate)}
          </span>
          {issue.owner && (
            <span className="ws-issue-chip ws-issue-chip--ghost">
              {issue.owner}
            </span>
          )}
        </div>
        {error && <p className="ws-error">{error}</p>}
      </div>
      {!resolved ? (
        <button
          type="button"
          className="ws-issue-resolve"
          onClick={resolve}
          disabled={busy}
          title="Mark issue as resolved"
        >
          {busy ? "…" : "Resolve"}
        </button>
      ) : (
        <span className="ws-issue-resolved-label">Resolved</span>
      )}
    </li>
  );
}

// ---------- small UI bits ----------

function toInputDate(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="ws-pill">
      <span className="ws-pill-label">{label}</span>
      <span className="ws-pill-value">{value}</span>
    </span>
  );
}

function StatusPill({
  status,
  blocked,
}: {
  status: string;
  blocked: boolean;
}) {
  if (blocked && status !== "DONE")
    return <span className="ws-status ws-status--blocked">Blocked</span>;
  const map: Record<string, string> = {
    TODO: "To do",
    IN_PROGRESS: "In progress",
    BLOCKED: "Blocked",
    DONE: "Done",
  };
  return (
    <span
      className={`ws-status ws-status--${status.toLowerCase().replace("_", "-")}`}
    >
      {map[status] ?? status}
    </span>
  );
}

function HealthPill({
  health,
  compact = false,
}: {
  health: "green" | "yellow" | "red" | null;
  compact?: boolean;
}) {
  if (!health) return null;
  const label = health === "red" ? "Red" : health === "yellow" ? "Yellow" : "Green";
  return (
    <span
      className={`ws-health ws-health--${health}${compact ? " ws-health--compact" : ""}`}
    >
      <span className="ws-health-dot" />
      {label}
    </span>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDateTime(d: Date) {
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtRelative(d: Date) {
  const ms = Date.now() - d.getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return d.toLocaleDateString();
}
