import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ensurePersonTable } from "@/lib/person-bootstrap";
import { z } from "zod";

type RouteCtx = { params: Promise<{ id: string }> };

const UpdatePersonSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: z.string().trim().max(80).nullable().optional(),
  active: z.boolean().optional(),
});

export async function PATCH(req: Request, ctx: RouteCtx) {
  await ensurePersonTable();
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = UpdatePersonSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const person = await prisma.person.update({
      where: { id },
      data: parsed.data,
    });
    return NextResponse.json(person);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export async function DELETE(_req: Request, ctx: RouteCtx) {
  await ensurePersonTable();
  const { id } = await ctx.params;
  try {
    await prisma.person.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
