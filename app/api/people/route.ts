import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ensurePersonTable } from "@/lib/person-bootstrap";
import { z } from "zod";

// Deduped starter roster captured from the project team list. Keeping this
// constant in code (rather than a migration) means Render can redeploy onto
// a fresh DB and still bootstrap the People sidebar + resource matrix with
// a sensible default without overwriting anything a user has customized.
export const DEFAULT_PEOPLE: string[] = [
  "Kirit Joshi",
  "William Christensen",
  "Prajwal Tumkur Mahesh",
  "Steven Szczeszynski",
  "Logan Alexander",
  "Rachael Ortega",
  "Jasmine Milan",
  "Jacky Chen",
];

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
    await prisma.person.createMany({
      data: DEFAULT_PEOPLE.map((name) => ({ name })),
      skipDuplicates: true,
    });
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
