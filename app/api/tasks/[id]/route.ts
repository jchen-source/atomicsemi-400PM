import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  UpdateTaskSchema,
  assigneeStringFromAllocations,
  normalizeAllocations,
} from "@/lib/validation";
import {
  rescheduleDownstream,
  rollupAncestorsForIds,
  rollupFromParentId,
  rollupProgress,
} from "@/lib/schedule";
import { parseTags, serializeTags } from "@/lib/utils";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      children: true,
      dependsOn: true,
      dependedBy: true,
      updates: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
    },
  });
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(task);
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = UpdateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const data = parsed.data;
  const { updateComment, progressComment, openIssueComment, ...taskPatch } = data;
  const nextStart = taskPatch.startDate ?? existing.startDate;
  const nextEnd = taskPatch.endDate ?? existing.endDate;
  if (nextStart > nextEnd) {
    return NextResponse.json(
      { error: "startDate must be <= endDate" },
      { status: 400 },
    );
  }

  const dbData: Record<string, unknown> = { ...taskPatch };
  if (taskPatch.tags !== undefined) dbData.tags = serializeTags(taskPatch.tags);
  if (taskPatch.parentId !== undefined || taskPatch.linkedTaskId !== undefined) {
    const nextParent = taskPatch.linkedTaskId ?? taskPatch.parentId;
    dbData.parent = nextParent
      ? { connect: { id: nextParent } }
      : { disconnect: true };
    delete dbData.parentId;
  }
  delete dbData.linkedTaskId;

  // Allocations come in as [{ name, percent }]. We persist them as a JSON
  // string (SQLite-friendly) and keep `assignee` in sync as a comma-joined
  // name list so existing filters/chips that read it keep working. When
  // the client sends `allocations: null` or `[]`, we clear the column and
  // fall back to legacy single-owner behavior; in that case we DON'T
  // overwrite whatever `assignee` the client also sent.
  if ("allocations" in taskPatch) {
    const normalized = normalizeAllocations(taskPatch.allocations ?? null);
    dbData.allocations = normalized ? JSON.stringify(normalized) : null;
    if (normalized) {
      dbData.assignee = assigneeStringFromAllocations(normalized);
    }
  }

  const { updatedTask, updatedIds } = await prisma.$transaction(async (tx) => {
    // Effort hours on a parent are always a rollup sum of their children.
    // Strip any manual edit to the parent's own value before writing so the
    // canonical rollup (triggered below) isn't clobbered by the user's stale
    // manual entry, and so the client sees its edit get reverted cleanly.
    const childCount = await tx.task.count({ where: { parentId: id } });
    if (childCount > 0 && "effortHours" in dbData) {
      delete dbData.effortHours;
    }

    const updatedTask =
      Object.keys(dbData).length > 0
        ? await tx.task.update({ where: { id }, data: dbData })
        : existing;

    const rescheduled =
      taskPatch.startDate || taskPatch.endDate
        ? await rescheduleDownstream(tx, id)
        : new Set<string>();

    const shouldRollup =
      taskPatch.progress !== undefined ||
      taskPatch.startDate !== undefined ||
      taskPatch.endDate !== undefined ||
      taskPatch.parentId !== undefined ||
      taskPatch.effortHours !== undefined;
    // Roll up ancestors for the edited task AND for every task that got
    // pushed downstream. This is what propagates a bar drag inside a
    // Subtask all the way up to its Task / Workstream / Program bars.
    const rolled = shouldRollup
      ? await rollupAncestorsForIds(tx, [id, ...rescheduled])
      : new Set<string>();

    const comments: Array<{ type: "PROGRESS" | "OPEN_ISSUE"; text: string }> = [];
    if (progressComment && progressComment.trim()) {
      comments.push({ type: "PROGRESS", text: progressComment.trim() });
    }
    if (openIssueComment && openIssueComment.trim()) {
      comments.push({ type: "OPEN_ISSUE", text: openIssueComment.trim() });
    }
    if (updateComment && updateComment.trim()) {
      comments.push({ type: "PROGRESS", text: updateComment.trim() });
    }

    for (const c of comments) {
      const updateId = `upd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      await tx.$executeRaw`
        INSERT INTO "TaskUpdate" (
          "id",
          "taskId",
          "commentType",
          "comment",
          "progress",
          "endDate",
          "effortHours",
          "assignee",
          "resourceAllocated",
          "createdAt"
        ) VALUES (
          ${updateId},
          ${id},
          ${c.type},
          ${c.text},
          ${updatedTask.progress},
          ${updatedTask.endDate},
          ${updatedTask.effortHours},
          ${updatedTask.assignee},
          ${updatedTask.resourceAllocated},
          ${new Date()}
        )
      `;
    }

    const touched = new Set<string>([...rescheduled, ...rolled, id]);
    return { updatedTask, updatedIds: [...touched] };
  });

  const affected = await prisma.task.findMany({
    where: { id: { in: updatedIds } },
  });

  try {
    revalidatePath("/");
    revalidatePath("/tasks");
    revalidatePath(`/tasks/${id}`);
    if (updatedTask.parentId) {
      revalidatePath(`/tasks/${updatedTask.parentId}`);
    }
    revalidatePath("/open-issues");
  } catch {
    // no-op outside request lifecycle
  }

  return NextResponse.json({
    task: { ...updatedTask, tags: parseTags(updatedTask.tags) },
    affected: affected.map((a) => ({ ...a, tags: parseTags(a.tags) })),
  });
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  // mode:
  //   "cascade"     -> delete task and all descendants (default)
  //   "parent-only" -> detach direct children (promote to top level), then delete this task only
  const mode = (url.searchParams.get("mode") ?? "cascade") as
    | "cascade"
    | "parent-only";

  try {
    const victim = await prisma.task.findUnique({
      where: { id },
      select: { parentId: true },
    });

    if (mode === "parent-only") {
      const result = await prisma.$transaction(async (tx) => {
        // Promote direct children to top-level.
        await tx.task.updateMany({
          where: { parentId: id },
          data: { parentId: null },
        });
        await tx.dependency.deleteMany({
          where: {
            OR: [{ predecessorId: id }, { dependentId: id }],
          },
        });
        await tx.task.delete({ where: { id } });
        const rolled = await rollupFromParentId(tx, victim?.parentId);
        return { deletedTasks: 1, rolled: [...rolled] };
      });
      return NextResponse.json({
        ok: true,
        mode,
        deletedTasks: result.deletedTasks,
        affected: result.rolled,
      });
    }

    // Default cascade: gather descendants and delete all.
    const allIds = new Set<string>([id]);
    const queue = [id];
    while (queue.length) {
      const parentId = queue.shift()!;
      const kids = await prisma.task.findMany({
        where: { parentId },
        select: { id: true },
      });
      for (const k of kids) {
        if (allIds.has(k.id)) continue;
        allIds.add(k.id);
        queue.push(k.id);
      }
    }

    const ids = [...allIds];
    const result = await prisma.$transaction(async (tx) => {
      await tx.dependency.deleteMany({
        where: {
          OR: [{ predecessorId: { in: ids } }, { dependentId: { in: ids } }],
        },
      });
      const deleted = await tx.task.deleteMany({ where: { id: { in: ids } } });
      const rolled = await rollupFromParentId(tx, victim?.parentId);
      return { deleted: deleted.count, rolled: [...rolled] };
    });
    return NextResponse.json({
      ok: true,
      mode,
      deletedTasks: result.deleted,
      affected: result.rolled,
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
