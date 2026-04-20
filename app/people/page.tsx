import { prisma } from "@/lib/db";
import { DEFAULT_PEOPLE } from "../api/people/route";
import { ensurePersonTable } from "@/lib/person-bootstrap";
import { buildResourceMatrix } from "@/lib/resource-matrix";
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

  const matrix = buildResourceMatrix({
    tasks,
    roster: people.map((p) => p.name),
    windowStart,
    weeks: 12,
  });

  return (
    <PeopleClient
      people={people.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        active: p.active,
      }))}
      matrix={matrix}
    />
  );
}
