import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CreateDependencySchema } from "@/lib/validation";
import {
  rescheduleDownstream,
  rollupAncestorsForIds,
} from "@/lib/schedule";

export async function GET() {
  const deps = await prisma.dependency.findMany();
  return NextResponse.json(deps);
}

async function wouldCreateCycle(
  predecessorId: string,
  dependentId: string,
): Promise<boolean> {
  // Walk successors of `dependentId`; if we reach `predecessorId`, adding
  // pred -> dep would form a cycle.
  const queue = [dependentId];
  const seen = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (cur === predecessorId) return true;
    const outs = await prisma.dependency.findMany({
      where: { predecessorId: cur },
      select: { dependentId: true },
    });
    for (const e of outs) queue.push(e.dependentId);
  }
  return false;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = CreateDependencySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // Idempotent behavior: if this dependency already exists, return success.
  const existing = await prisma.dependency.findFirst({
    where: {
      predecessorId: data.predecessorId,
      dependentId: data.dependentId,
    },
  });
  if (existing) {
    return NextResponse.json(
      { dependency: existing, affected: [], existed: true },
      { status: 200 },
    );
  }

  if (await wouldCreateCycle(data.predecessorId, data.dependentId)) {
    return NextResponse.json(
      { error: "would create a dependency cycle" },
      { status: 400 },
    );
  }

  try {
    const { dep, affected } = await prisma.$transaction(async (tx) => {
      const dep = await tx.dependency.create({ data });
      const touched = await rescheduleDownstream(tx, data.predecessorId);
      // After downstream shifts, every affected task's Workstream/Program
      // parent needs to recompute span + progress. Seed with the predecessor
      // too, in case the dependency anchors a still-unshifted task whose
      // ancestor chain hasn't been touched yet.
      const rolled = await rollupAncestorsForIds(tx, [
        data.predecessorId,
        data.dependentId,
        ...touched,
      ]);
      const allTouched = new Set<string>([...touched, ...rolled]);
      const affected = await tx.task.findMany({
        where: { id: { in: [...allTouched] } },
      });
      return { dep, affected };
    });
    return NextResponse.json({ dependency: dep, affected, existed: false }, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
