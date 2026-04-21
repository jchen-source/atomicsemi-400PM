import { prisma } from "@/lib/db";
import { DEFAULT_PEOPLE } from "@/lib/default-people";
import { ensurePersonTable } from "@/lib/person-bootstrap";
import {
  buildResourceMatrix,
  type MatrixTask,
} from "@/lib/resource-matrix";
import PeopleClient from "./people-client";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  // Seed roster on first visit — mirrors the GET /api/people behavior so
  // the page doesn't render empty on a fresh deploy.
  await ensurePersonTable();
  const count = await prisma.person.count();
  if (count === 0) {
    for (const name of DEFAULT_PEOPLE) {
      try {
        await prisma.person.create({ data: { name } });
      } catch {
        /* unique collision or concurrent seed */
      }
    }
  }

  const [people, tasks] = await Promise.all([
    prisma.person.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
    }),
    prisma.task.findMany({
      where: { type: { in: ["EPIC", "TASK"] } },
    }),
  ]);

  // Default window: 12 weeks starting from this week's Monday. Users can
  // pick a different window on the client.
  const now = new Date();
  const windowStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  const roster = people.map((p) => p.name);
  const matrix = buildResourceMatrix({
    tasks,
    roster,
    windowStart,
    weeks: 12,
  });

  // Slim serialized shape for the client — only the fields the matrix
  // actually reads, so we're not shipping the full Task payload over the
  // wire when all the client needs to do is re-scope to a chosen program.
  const clientTasks: MatrixTask[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    parentId: t.parentId,
    startDate: t.startDate.toISOString(),
    endDate: t.endDate.toISOString(),
    effortHours: t.effortHours,
    assignee: t.assignee,
    resourceAllocated: t.resourceAllocated,
    allocations:
      (t as typeof t & { allocations?: string | null }).allocations ?? null,
    type: t.type,
  }));

  // Programs = depth-0 tasks. Cheap pass: everyone whose parentId is null
  // (or missing from the fetched set). The Task[] fetch above filters to
  // EPIC/TASK, which is exactly what the matrix consumes, so the list
  // stays honest: only programs that actually contribute capacity get
  // surfaced in the dropdown.
  const parentIds = new Set(tasks.map((t) => t.id));
  const programs = tasks
    .filter((t) => !t.parentId || !parentIds.has(t.parentId))
    .map((t) => ({ id: t.id, title: t.title }))
    .sort((a, b) => a.title.localeCompare(b.title));

  return (
    <PeopleClient
      people={people.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        active: p.active,
      }))}
      matrix={matrix}
      tasks={clientTasks}
      programs={programs}
      roster={roster}
      windowStartISO={windowStart.toISOString()}
      weeks={12}
    />
  );
}
