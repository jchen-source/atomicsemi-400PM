import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { UpdateDependencySchema } from "@/lib/validation";
import { rescheduleDownstream } from "@/lib/schedule";

type RouteCtx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = UpdateDependencySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const existing = await prisma.dependency.findUnique({ where: { id } });
  if (!existing)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const { dep, affected } = await prisma.$transaction(async (tx) => {
    const dep = await tx.dependency.update({
      where: { id },
      data: parsed.data,
    });
    const touched = await rescheduleDownstream(tx, existing.predecessorId);
    const affected = await tx.task.findMany({
      where: { id: { in: [...touched] } },
    });
    return { dep, affected };
  });

  return NextResponse.json({ dependency: dep, affected });
}

export async function DELETE(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  try {
    await prisma.dependency.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
