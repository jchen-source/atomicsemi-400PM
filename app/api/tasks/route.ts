import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { CreateTaskSchema } from "@/lib/validation";
import { parseTags, serializeTags } from "@/lib/utils";
import { rollupFromParentId } from "@/lib/schedule";

export async function GET() {
  // Stable ordering — no startDate tiebreaker — so repeated calls return
  // rows in the same order even as users edit dates.
  const tasks = await prisma.task.findMany({
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
  });
  return NextResponse.json(
    tasks.map((t) => ({ ...t, tags: parseTags(t.tags) })),
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const data = parsed.data;
  if (data.startDate > data.endDate) {
    return NextResponse.json(
      { error: "startDate must be <= endDate" },
      { status: 400 },
    );
  }

  const { parentId, linkedTaskId, ...rest } = data;
  const relationParentId = linkedTaskId ?? parentId;
  const createData: Prisma.TaskCreateInput = {
    ...rest,
    tags: serializeTags(data.tags),
    parent: relationParentId ? { connect: { id: relationParentId } } : undefined,
  };

  const result = await prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: createData,
    });
    const rolled = await rollupFromParentId(tx, task.parentId);
    return { task, rolled: [...rolled] };
  });

  try {
    revalidatePath("/");
    revalidatePath("/tasks");
    revalidatePath("/open-issues");
    if (result.task.parentId) {
      revalidatePath(`/tasks/${result.task.parentId}`);
    }
  } catch {
    // no-op outside request lifecycle
  }

  return NextResponse.json(
    { ...result.task, tags: parseTags(result.task.tags), affected: result.rolled },
    { status: 201 },
  );
}
