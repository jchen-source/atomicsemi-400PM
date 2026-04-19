import type { PrismaClient, Task, Dependency } from "@prisma/client";
import { addDaysUTC, diffDaysUTC } from "./utils";

type DepType = "FS" | "SS" | "FF" | "SF";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Given a predecessor's dates and a dependency edge, return the earliest
 * allowed [start, end] for the dependent task. Duration is preserved.
 */
function applyDependency(
  depType: DepType,
  lagDays: number,
  predStart: Date,
  predEnd: Date,
  depStart: Date,
  depEnd: Date,
): { start: Date; end: Date } {
  const duration = Math.max(0, diffDaysUTC(depStart, depEnd));
  let newStart: Date;

  switch (depType) {
    case "FS":
      newStart = addDaysUTC(predEnd, lagDays);
      break;
    case "SS":
      newStart = addDaysUTC(predStart, lagDays);
      break;
    case "FF": {
      const newEnd = addDaysUTC(predEnd, lagDays);
      return { start: addDaysUTC(newEnd, -duration), end: newEnd };
    }
    case "SF": {
      const newEnd = addDaysUTC(predStart, lagDays);
      return { start: addDaysUTC(newEnd, -duration), end: newEnd };
    }
  }

  return { start: newStart, end: addDaysUTC(newStart, duration) };
}

/**
 * Walk the dependency graph forward from `startTaskId`. If a successor is
 * violating its predecessor's constraint, push it forward (never earlier).
 * Writes updates via the given transaction. Returns the set of updated IDs.
 */
export async function rescheduleDownstream(
  tx: PrismaTx,
  startTaskId: string,
): Promise<Set<string>> {
  const updated = new Set<string>();
  const queue: string[] = [startTaskId];
  const seen = new Set<string>();

  while (queue.length) {
    const currentId = queue.shift()!;
    if (seen.has(currentId)) continue;
    seen.add(currentId);

    const outgoing = await tx.dependency.findMany({
      where: { predecessorId: currentId },
      include: { predecessor: true, dependent: true },
    });

    for (const edge of outgoing) {
      const pred = edge.predecessor;
      const dep = edge.dependent;
      const { start: minStart, end: minEnd } = applyDependency(
        edge.type as DepType,
        edge.lagDays,
        pred.startDate,
        pred.endDate,
        dep.startDate,
        dep.endDate,
      );

      const currentStart = dep.startDate.getTime();
      const currentEnd = dep.endDate.getTime();
      const needsShift =
        minStart.getTime() > currentStart || minEnd.getTime() > currentEnd;

      if (needsShift) {
        const newStart = new Date(Math.max(currentStart, minStart.getTime()));
        const newEnd = new Date(Math.max(currentEnd, minEnd.getTime()));
        await tx.task.update({
          where: { id: dep.id },
          data: { startDate: newStart, endDate: newEnd },
        });
        updated.add(dep.id);
        queue.push(dep.id);
      }
    }
  }

  return updated;
}

/**
 * Roll up progress to ancestors. Each parent's progress becomes the
 * duration-weighted mean of its direct children's progress.
 */
export async function rollupProgress(
  tx: PrismaTx,
  leafTaskId: string,
): Promise<Set<string>> {
  const updated = new Set<string>();
  let currentId: string | null = leafTaskId;

  while (currentId) {
    const node: Task | null = await tx.task.findUnique({
      where: { id: currentId },
    });
    if (!node || !node.parentId) break;

    const siblings: Task[] = await tx.task.findMany({
      where: { parentId: node.parentId },
    });

    // Only real work items (TASK / EPIC) define the parent's visible span.
    // Linked ISSUEs render as their own top-level rows in the Gantt, so they
    // must not inflate (or prevent shrinkage of) their anchor task's parent.
    const spanSiblings = siblings.filter((s) => s.type !== "ISSUE");

    let totalWeight = 0;
    let weightedSum = 0;
    let minStart = Number.POSITIVE_INFINITY;
    let maxEnd = Number.NEGATIVE_INFINITY;
    // Effort hours roll up as a straight sum of every non-ISSUE child.
    // `hasAnyEffort` lets us distinguish "all children blank" (leave the
    // parent's manually-entered effort alone) from "at least one child has
    // effort" (parent becomes the derived sum, even if some children are 0).
    let effortSum = 0;
    let hasAnyEffort = false;
    for (const s of spanSiblings) {
      const duration = Math.max(1, diffDaysUTC(s.startDate, s.endDate));
      totalWeight += duration;
      weightedSum += duration * s.progress;
      minStart = Math.min(minStart, s.startDate.getTime());
      maxEnd = Math.max(maxEnd, s.endDate.getTime());
      if (s.effortHours != null) {
        effortSum += s.effortHours;
        hasAnyEffort = true;
      }
    }
    const parentProgress =
      totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

    // When there are no non-issue children, don't clobber the parent's dates
    // with garbage — just leave the existing span.
    const hasSpan = Number.isFinite(minStart) && Number.isFinite(maxEnd);
    const nextStart = hasSpan ? new Date(minStart) : node.startDate;
    const nextEnd = hasSpan ? new Date(maxEnd) : node.endDate;
    const nextEffort = hasAnyEffort ? effortSum : node.effortHours;

    await tx.task.update({
      where: { id: node.parentId },
      data: {
        progress: parentProgress,
        startDate: nextStart,
        endDate: nextEnd,
        effortHours: nextEffort,
      },
    });
    updated.add(node.parentId);

    currentId = node.parentId;
  }

  return updated;
}

/**
 * Roll up ancestor dates/progress starting from a known parent id.
 * Useful after creating/deleting/moving children.
 */
export async function rollupFromParentId(
  tx: PrismaTx,
  parentId: string | null | undefined,
): Promise<Set<string>> {
  if (!parentId) return new Set<string>();
  const fakeLeaf = await tx.task.findFirst({
    where: { parentId },
    select: { id: true },
  });
  if (fakeLeaf?.id) return rollupProgress(tx, fakeLeaf.id);
  return new Set<string>();
}

/**
 * Roll up ancestors for every id in `ids`. Useful when a batch of tasks was
 * moved (e.g. downstream reschedule shifted 5 successors and each of their
 * workstream/program parents needs its dates/progress recomputed).
 */
export async function rollupAncestorsForIds(
  tx: PrismaTx,
  ids: Iterable<string>,
): Promise<Set<string>> {
  const updated = new Set<string>();
  const seenLeaves = new Set<string>();
  for (const id of ids) {
    if (seenLeaves.has(id)) continue;
    seenLeaves.add(id);
    const rolled = await rollupProgress(tx, id);
    for (const r of rolled) updated.add(r);
  }
  return updated;
}

export type { Task, Dependency };
