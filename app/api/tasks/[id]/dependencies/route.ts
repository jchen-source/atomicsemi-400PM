import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod";
import {
  rescheduleDownstream,
  rollupAncestorsForIds,
} from "@/lib/schedule";

type RouteCtx = { params: Promise<{ id: string }> };

const BodySchema = z.object({
  predecessorIds: z.array(z.string()),
});

export async function GET(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const links = await prisma.dependency.findMany({
    where: { dependentId: id },
    select: { predecessorId: true },
  });
  return NextResponse.json({
    predecessorIds: links.map((l) => l.predecessorId),
  });
}

export async function PUT(req: Request, ctx: RouteCtx) {
  const { id: dependentId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const dependent = await prisma.task.findUnique({
    where: { id: dependentId },
    select: { id: true },
  });
  if (!dependent) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }

  const nextSet = new Set(
    parsed.data.predecessorIds.filter((pid) => pid && pid !== dependentId),
  );

  const existing = await prisma.dependency.findMany({
    where: { dependentId },
    select: { id: true, predecessorId: true },
  });
  const existingSet = new Set(existing.map((e) => e.predecessorId));

  const toDelete = existing
    .filter((e) => !nextSet.has(e.predecessorId))
    .map((e) => e.id);
  const toAdd = [...nextSet].filter((pid) => !existingSet.has(pid));

  await prisma.$transaction(async (tx) => {
    if (toDelete.length) {
      await tx.dependency.deleteMany({ where: { id: { in: toDelete } } });
    }
    for (const predecessorId of toAdd) {
      await tx.dependency.create({
        data: { predecessorId, dependentId, type: "FS", lagDays: 0 },
      });
    }

    // Re-run scheduling from every touched predecessor so the dependent and
    // any further downstream tasks get pushed forward as needed, then roll
    // up ancestor Workstream/Program dates for the dependent and anyone
    // shifted along the way.
    const touched = new Set<string>();
    for (const pid of [...nextSet]) {
      const shifted = await rescheduleDownstream(tx, pid);
      for (const s of shifted) touched.add(s);
    }
    await rollupAncestorsForIds(tx, [dependentId, ...touched]);
  });

  const final = await prisma.dependency.findMany({
    where: { dependentId },
    select: { predecessorId: true },
  });

  return NextResponse.json({
    predecessorIds: final.map((d) => d.predecessorId),
  });
}

