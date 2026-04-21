import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { computeHealth } from "@/lib/health";
import { rollupAncestorsForIds } from "@/lib/schedule";
import { parseTags } from "@/lib/utils";

/**
 * Snapshot-driven progress endpoint for the master task list.
 *
 * One transaction:
 *   1. Load the task.
 *   2. Apply the patch + recompute cached `health`.
 *   3. Stamp `lastProgressAt` so the "Needs Update" filter resets.
 *   4. Write an immutable `TaskUpdate` row (progress + health + status +
 *      blocked + remainingEffort + comment) — this is what /burndown charts
 *      off of.
 *   5. Roll up ancestor dates/progress/effort via the existing helper.
 */

const ProgressSchema = z.object({
  progress: z.number().int().min(0).max(100).optional(),
  remainingEffort: z.number().int().min(0).nullable().optional(),
  // Estimated hours ("effort to complete"). Writable from the standup
  // form so the user can size a task at the same time they push progress
  // and the burndown Y-axis scales to reality. Parent tasks ignore this
  // — their effortHours is always a rollup of their leaves (see below).
  effortHours: z.number().int().min(0).max(100_000).nullable().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]).optional(),
  blocked: z.boolean().optional(),
  nextStep: z.string().max(4000).nullable().optional(),
  comment: z.string().max(4000).optional(),
  priority: z.enum(["high", "medium", "low"]).nullable().optional(),
});

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = ProgressSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Leaf-only rule: progress/comment/estimate updates belong to the row
  // that actually owns the work. Parent rows derive their numbers via
  // rollup — letting the user push a standalone update onto them would
  // immediately get overwritten the next time a child saves, and it'd
  // hide whose work moved the needle. 409 Conflict is the right signal
  // here: the resource state (has children) is incompatible with the
  // operation the client tried.
  //
  // IMPORTANT: open issues + legacy milestones are stored as child rows
  // (`type: "ISSUE"` / `"MILESTONE"`) so every task that has an open
  // issue linked to it looks like it has "subtasks" if we count rows
  // naively. The rest of the app (/tasks, workstream view, Gantt,
  // burndown) already excludes those types from hierarchy logic — this
  // endpoint has to match or users can't push progress on leaf tasks
  // that just happen to have an issue attached.
  const childCountPre = await prisma.task.count({
    where: {
      parentId: id,
      type: { notIn: ["ISSUE", "MILESTONE"] },
    },
  });
  if (childCountPre > 0) {
    return NextResponse.json(
      {
        error:
          "This task has subtasks — push updates on a subtask instead. Parent progress rolls up automatically.",
        code: "HAS_CHILDREN",
        childCount: childCountPre,
      },
      { status: 409 },
    );
  }

  // Merge patch → effective task for health calc.
  const nextStatus =
    input.status ??
    // Blocking through the toggle should promote status if the user left
    // status alone. This keeps the filter chips and the drawer in sync.
    (input.blocked === true && existing.status !== "BLOCKED"
      ? "BLOCKED"
      : existing.status);
  const nextBlocked = input.blocked ?? existing.blocked;
  const nextProgress =
    input.progress ??
    (nextStatus === "DONE" ? 100 : existing.progress);

  const nextHealth = computeHealth({
    startDate: existing.startDate,
    endDate: existing.endDate,
    progress: nextProgress,
    blocked: nextBlocked,
    status: nextStatus,
  });

  const { updatedTask, snapshot, affectedIds } = await prisma.$transaction(
    async (tx) => {
      const now = new Date();
      // Effort hours on a parent are a rollup of children — never accept a
      // manual value for those. Leaves honor the user's input (or null
      // clears the estimate). Undefined = leave whatever's already on the row.
      const childCount = await tx.task.count({ where: { parentId: id } });
      const canSetEffort =
        childCount === 0 && input.effortHours !== undefined;
      const updatedTask = await tx.task.update({
        where: { id },
        data: {
          progress: nextProgress,
          status: nextStatus,
          blocked: nextBlocked,
          remainingEffort:
            input.remainingEffort === undefined
              ? existing.remainingEffort
              : input.remainingEffort,
          effortHours: canSetEffort ? input.effortHours : existing.effortHours,
          nextStep:
            input.nextStep === undefined ? existing.nextStep : input.nextStep,
          priority:
            input.priority === undefined ? existing.priority : input.priority,
          health: nextHealth,
          lastProgressAt: now,
        },
      });

      const snapshot = await tx.taskUpdate.create({
        data: {
          taskId: id,
          commentType: "PROGRESS",
          comment: input.comment?.trim() || "",
          progress: updatedTask.progress,
          endDate: updatedTask.endDate,
          effortHours: updatedTask.effortHours,
          assignee: updatedTask.assignee,
          resourceAllocated: updatedTask.resourceAllocated,
          remainingEffort: updatedTask.remainingEffort,
          status: updatedTask.status,
          blocked: updatedTask.blocked,
          health: updatedTask.health,
          createdAt: now,
        },
      });

      // Progress changed → parent bars need their rollup refreshed so the
      // Gantt + master list reflect the new numbers everywhere.
      const rolled = await rollupAncestorsForIds(tx, [id]);

      // Ancestor rollup can flip health too — recompute for each touched
      // ancestor against the just-updated dates/progress.
      const ancestorIds = [...rolled];
      if (ancestorIds.length) {
        const ancestors = await tx.task.findMany({
          where: { id: { in: ancestorIds } },
        });
        for (const a of ancestors) {
          const h = computeHealth({
            startDate: a.startDate,
            endDate: a.endDate,
            progress: a.progress,
            blocked: a.blocked,
            status: a.status,
          });
          if (h !== a.health) {
            await tx.task.update({
              where: { id: a.id },
              data: { health: h },
            });
          }
        }
      }

      return {
        updatedTask,
        snapshot,
        affectedIds: [...new Set([id, ...ancestorIds])],
      };
    },
  );

  const affected = await prisma.task.findMany({
    where: { id: { in: affectedIds } },
  });

  // Any page that reads Task.progress or derived rollups needs to re-render
  // on next visit. The /tasks client already patches optimistically, but the
  // Gantt at / renders from a server fetch, so invalidate its cache here.
  try {
    revalidatePath("/");
    revalidatePath("/tasks");
    revalidatePath(`/tasks/${id}`);
    revalidatePath("/open-issues");
  } catch {
    // revalidatePath is a no-op outside of a request lifecycle; swallow so
    // tests / background jobs don't trip on it.
  }

  return NextResponse.json({
    task: { ...updatedTask, tags: parseTags(updatedTask.tags) },
    snapshot,
    affected: affected.map((a) => ({ ...a, tags: parseTags(a.tags) })),
  });
}
