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
        edge.type,
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

    let totalWeight = 0;
    let weightedSum = 0;
    let minStart = Number.POSITIVE_INFINITY;
    let maxEnd = Number.NEGATIVE_INFINITY;
    for (const s of siblings) {
      const duration = Math.max(1, diffDaysUTC(s.startDate, s.endDate));
      totalWeight += duration;
      weightedSum += duration * s.progress;
      minStart = Math.min(minStart, s.startDate.getTime());
      maxEnd = Math.max(maxEnd, s.endDate.getTime());
    }
    const parentProgress =
      totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

    const nextStart =
      Number.isFinite(minStart) ? new Date(minStart) : node.startDate;
    const nextEnd = Number.isFinite(maxEnd) ? new Date(maxEnd) : node.endDate;

    await tx.task.update({
      where: { id: node.parentId },
      data: {
        progress: parentProgress,
        startDate: nextStart,
        endDate: nextEnd,
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

export type { Task, Dependency };
