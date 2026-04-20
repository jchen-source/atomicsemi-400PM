import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ensurePersonTable } from "@/lib/person-bootstrap";
import { DEFAULT_PEOPLE } from "@/lib/default-people";
import { z } from "zod";

const CreatePersonSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(80).nullable().optional(),
});

export async function GET() {
  // Transparent-bootstrap: the first time the People page (or anything
  // else) asks for the roster we seed the defaults. This means a fresh
  // deploy surfaces the real team immediately without the user having to
  // run any extra setup step.
  await ensurePersonTable();
  const count = await prisma.person.count();
  if (count === 0) {
    // Loop because SQLite's Prisma adapter doesn't support
    // `createMany({ skipDuplicates: true })`. A per-row try/catch keeps this
    // idempotent regardless of dialect.
    for (const name of DEFAULT_PEOPLE) {
      try {
        await prisma.person.create({ data: { name } });
      } catch {
        // Unique-name collision is fine; anything else we also swallow here
        // so seeding never blocks the page.
      }
    }
  }

  const people = await prisma.person.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return NextResponse.json(people);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = CreatePersonSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const name = parsed.data.name.trim();
  try {
    const person = await prisma.person.create({
      data: { name, role: parsed.data.role?.trim() || null },
    });
    return NextResponse.json(person, { status: 201 });
  } catch (e: unknown) {
    // Unique constraint on name
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in (e as Record<string, unknown>) &&
      (e as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "A contributor with that name already exists." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "failed to create" }, { status: 500 });
  }
}
