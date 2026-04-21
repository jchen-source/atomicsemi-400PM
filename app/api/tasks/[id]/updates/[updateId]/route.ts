import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { rollupAncestorsForIds } from "@/lib/schedule";

/**
 * Delete a single TaskUpdate (history entry / burndown dot).
 *
 * Semantics:
 *   - Always removes the row so it disappears from the drawer history and
 *     stops drawing a dot on the burndown chart.
 *   - If the deleted row was the *most recent* PROGRESS snapshot for its
 *     task, we roll the task's cached progress/remaining/status/health/
 *     lastProgressAt back to the snapshot that came before it — or to the
 *     "no updates yet" defaults if the deleted row was the only one. This
 *     keeps the burn line, the task drawer, and parent rollups in sync so
 *     a deleted update actually "un-does" itself end-to-end.
 *   - Non-latest snapshots (or pure OPEN_ISSUE notes, which never touch
 *     task state) are deleted quietly without touching Task fields.
 *   - Ancestors always get re-rolled so parent progress/effort/health/
 *     dates stay accurate after whatever the leaf looks like now.
 */

type RouteCtx = { params: Promise<{ id: string; updateId: string }> };

export async function DELETE(_req: Request, ctx: RouteCtx) {
  const { id, updateId } = await ctx.params;

  const existing = await prisma.taskUpdate.findUnique({
    where: { id: updateId },
    select: {
      id: true,
      taskId: true,
      commentType: true,
      createdAt: true,
    },
  });
  if (!existing || existing.taskId !== id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const nextTaskState = await prisma.$transaction(async (tx) => {
    // Is this the most recent PROGRESS snapshot for the task? If so,
    // deleting it needs to restore the prior state; otherwise we can
    // just drop the row.
    let isLatestProgress = false;
    if (existing.commentType === "PROGRESS") {
      const latest = await tx.taskUpdate.findFirst({
        where: { taskId: id, commentType: "PROGRESS" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      isLatestProgress = latest?.id === updateId;
    }

    await tx.taskUpdate.delete({ where: { id: updateId } });

    let restored: {
      progress: number;
      remainingEffort: number | null;
      status: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
      health: "green" | "yellow" | "red" | null;
      blocked: boolean;
    } | null = null;

    if (isLatestProgress) {
      // Next-most-recent PROGRESS snapshot — this becomes the task's
      // current state. `null` means we just deleted the only snapshot.
      const prev = await tx.taskUpdate.findFirst({
        where: { taskId: id, commentType: "PROGRESS" },
        orderBy: { createdAt: "desc" },
        select: {
          progress: true,
          remainingEffort: true,
          status: true,
          health: true,
          blocked: true,
          createdAt: true,
        },
      });

      if (prev) {
        restored = {
          progress: prev.progress ?? 0,
          remainingEffort: prev.remainingEffort,
          status:
            ((prev.status as
              | "TODO"
              | "IN_PROGRESS"
              | "BLOCKED"
              | "DONE"
              | null) ?? "TODO"),
          health: prev.health as "green" | "yellow" | "red" | null,
          blocked: prev.blocked ?? false,
        };
        await tx.task.update({
          where: { id },
          data: {
            progress: restored.progress,
            remainingEffort: restored.remainingEffort,
            status: restored.status,
            health: restored.health,
            blocked: restored.blocked,
            lastProgressAt: prev.createdAt,
          },
        });
      } else {
        restored = {
          progress: 0,
          remainingEffort: null,
          status: "TODO",
          health: null,
          blocked: false,
        };
        await tx.task.update({
          where: { id },
          data: {
            progress: 0,
            remainingEffort: null,
            status: "TODO",
            health: null,
            blocked: false,
            lastProgressAt: null,
          },
        });
      }
    }

    // Ancestors always re-roll — even an OPEN_ISSUE removal can flip the
    // parent's health banner if the child used to flag an issue, and a
    // PROGRESS rewind clearly needs the parent's progress recomputed.
    await rollupAncestorsForIds(tx, [id]);

    return restored;
  });

  revalidatePath("/tasks");
  revalidatePath(`/tasks/${id}`);
  revalidatePath("/");

  return NextResponse.json({ ok: true, nextTaskState });
}
