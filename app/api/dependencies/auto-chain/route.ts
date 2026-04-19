import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

type TaskRow = {
  id: string;
  parentId: string | null;
  sortOrder: number;
  startDate: Date;
};

function groupByParent(rows: TaskRow[]) {
  const map = new Map<string | null, TaskRow[]>();
  for (const r of rows) {
    const arr = map.get(r.parentId) ?? [];
    arr.push(r);
    map.set(r.parentId, arr);
  }
  for (const [, arr] of map) {
    arr.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.startDate.getTime() - b.startDate.getTime(),
    );
  }
  return map;
}

export async function POST() {
  const rows = await prisma.task.findMany({
    select: { id: true, parentId: true, sortOrder: true, startDate: true },
  });

  const byParent = groupByParent(rows);
  const created: Array<{
    id: string;
    source: string;
    target: string;
    type: "e2s";
  }> = [];

  for (const [, siblings] of byParent) {
    if (siblings.length < 2) continue;
    for (let i = 0; i < siblings.length - 1; i++) {
      const source = siblings[i].id;
      const target = siblings[i + 1].id;
      const exists = await prisma.dependency.findFirst({
        where: { predecessorId: source, dependentId: target },
        select: { id: true },
      });
      if (exists) continue;
      const dep = await prisma.dependency.create({
        data: {
          predecessorId: source,
          dependentId: target,
          type: "FS",
          lagDays: 0,
        },
      });
      created.push({ id: dep.id, source, target, type: "e2s" });
    }
  }

  return NextResponse.json({ created });
}

