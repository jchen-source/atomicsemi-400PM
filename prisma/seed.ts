import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function addDays(d: Date, n: number) {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

async function main() {
  await prisma.dependency.deleteMany();
  await prisma.task.deleteMany();
  await prisma.syncLog.deleteMany();

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const epic = await prisma.task.create({
    data: {
      title: "Launch PM App v1",
      type: "EPIC",
      status: "IN_PROGRESS",
      startDate: today,
      endDate: addDays(today, 42),
      progress: 10,
      sortOrder: 0,
    },
  });

  const task1 = await prisma.task.create({
    data: {
      title: "Data model & Notion import",
      type: "TASK",
      status: "IN_PROGRESS",
      startDate: today,
      endDate: addDays(today, 7),
      progress: 40,
      parentId: epic.id,
      sortOrder: 1,
    },
  });

  const task2 = await prisma.task.create({
    data: {
      title: "Gantt UI with dependencies",
      type: "TASK",
      status: "TODO",
      startDate: addDays(today, 7),
      endDate: addDays(today, 21),
      progress: 0,
      parentId: epic.id,
      sortOrder: 2,
    },
  });

  const task3 = await prisma.task.create({
    data: {
      title: "Deploy to Render",
      type: "TASK",
      status: "TODO",
      startDate: addDays(today, 35),
      endDate: addDays(today, 42),
      progress: 0,
      parentId: epic.id,
      sortOrder: 3,
    },
  });

  await prisma.task.create({
    data: {
      title: "Map Notion relation -> parentId",
      type: "ISSUE",
      status: "TODO",
      startDate: today,
      endDate: addDays(today, 3),
      progress: 0,
      parentId: task1.id,
      sortOrder: 1,
    },
  });

  await prisma.task.create({
    data: {
      title: "Wire inline progress editing",
      type: "ISSUE",
      status: "TODO",
      startDate: addDays(today, 10),
      endDate: addDays(today, 14),
      progress: 0,
      parentId: task2.id,
      sortOrder: 1,
    },
  });

  await prisma.dependency.create({
    data: {
      predecessorId: task1.id,
      dependentId: task2.id,
      type: "FS",
      lagDays: 0,
    },
  });

  await prisma.dependency.create({
    data: {
      predecessorId: task2.id,
      dependentId: task3.id,
      type: "FS",
      lagDays: 7,
    },
  });

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
