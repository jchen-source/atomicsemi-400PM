import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { UpdateTaskSchema } from "@/lib/validation";
import {
  rescheduleDownstream,
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

  const { updatedTask, updatedIds } = await prisma.$transaction(async (tx) => {
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
      taskPatch.parentId !== undefined;
    const rolled = shouldRollup ? await rollupProgress(tx, id) : new Set<string>();

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

  return NextResponse.json({
    task: { ...updatedTask, tags: parseTags(updatedTask.tags) },
    affected: affected.map((a) => ({ ...a, tags: parseTags(a.tags) })),
  });
}

export async function DELETE(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  try {
    const victim = await prisma.task.findUnique({
      where: { id },
      select: { parentId: true },
    });

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
      deletedTasks: result.deleted,
      affected: result.rolled,
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
