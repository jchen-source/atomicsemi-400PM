import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const DEMO_ROOT_TITLE = "Launch PM App v1";
const IMPORTED_ROOT_TITLE = "Imported Notion Backlog";

async function collectDescendants(rootIds: string[]) {
  const all = new Set<string>(rootIds);
  const queue = [...rootIds];

  while (queue.length) {
    const parentId = queue.shift()!;
    const children = await prisma.task.findMany({
      where: { parentId },
      select: { id: true },
    });
    for (const c of children) {
      if (all.has(c.id)) continue;
      all.add(c.id);
      queue.push(c.id);
    }
  }

  return [...all];
}

export async function POST(req: Request) {
  let includeImported = false;
  try {
    const body = await req.json();
    includeImported = Boolean(body?.includeImported);
  } catch {
    includeImported = false;
  }

  const targetTitles = includeImported
    ? [DEMO_ROOT_TITLE, IMPORTED_ROOT_TITLE]
    : [DEMO_ROOT_TITLE];

  const roots = await prisma.task.findMany({
    where: { title: { in: targetTitles } },
    select: { id: true, title: true },
  });

  if (!roots.length) {
    return NextResponse.json({
      deletedTasks: 0,
      deletedDependencies: 0,
      message: "No default roots found",
    });
  }

  const ids = await collectDescendants(roots.map((r) => r.id));

  const depDelete = await prisma.dependency.deleteMany({
    where: {
      OR: [{ predecessorId: { in: ids } }, { dependentId: { in: ids } }],
    },
  });

  const taskDelete = await prisma.task.deleteMany({
    where: { id: { in: ids } },
  });

  return NextResponse.json({
    deletedTasks: taskDelete.count,
    deletedDependencies: depDelete.count,
    roots: roots.map((r) => r.title),
  });
}

