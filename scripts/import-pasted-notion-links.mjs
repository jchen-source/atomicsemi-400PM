import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();

function extractLinkRows(markdown) {
  const re = /\[([^\]]+)\]\((https:\/\/www\.notion\.so\/[^\s)]+)\)/g;
  const rows = [];
  let m;
  while ((m = re.exec(markdown))) {
    const title = m[1].trim();
    const url = m[2].trim();
    if (!title) continue;
    rows.push({ title, url });
  }
  return rows;
}

function extractNotionId(url) {
  // Works for URLs like .../slug-345947bdfd4480b89f6ff947fbf6e7a8?pvs=21
  const m = url.match(/([0-9a-f]{32})(?:\?|$)/i);
  return m ? m[1].toLowerCase() : null;
}

function isTopLevel(title) {
  return /^(Tool Delivery:|Cube Delivery:)/i.test(title);
}

function toTags(title) {
  const tags = [];
  if (/^Tool Delivery:/i.test(title)) tags.push("tool-delivery");
  if (/^Cube Delivery:/i.test(title)) tags.push("cube-delivery");
  if (/procurement/i.test(title)) tags.push("procurement");
  if (/wiring/i.test(title)) tags.push("wiring");
  if (/assembly/i.test(title)) tags.push("assembly");
  if (/installation/i.test(title)) tags.push("installation");
  return JSON.stringify(tags);
}

async function main() {
  const markdown = readFileSync("data/notion-links.md", "utf8");
  const rows = extractLinkRows(markdown);
  if (!rows.length) {
    console.log("No Notion links found.");
    return;
  }

  let parentId = null;
  let sort = 0;

  const existing = await prisma.task.findFirst({
    where: { title: "Imported Notion Backlog" },
  });
  const root =
    existing ??
    (await prisma.task.create({
      data: {
        title: "Imported Notion Backlog",
        type: "EPIC",
        status: "TODO",
        startDate: new Date(),
        endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 90),
        progress: 0,
        tags: JSON.stringify(["notion-import"]),
      },
    }));

  for (const row of rows) {
    sort += 1;
    const notionId = extractNotionId(row.url);
    if (!notionId) continue;

    if (isTopLevel(row.title)) {
      const top = await prisma.task.upsert({
        where: { notionId },
        create: {
          notionId,
          title: row.title,
          type: "TASK",
          status: "TODO",
          startDate: new Date(),
          endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
          progress: 0,
          parentId: root.id,
          sortOrder: sort,
          tags: toTags(row.title),
        },
        update: {
          title: row.title,
          parentId: root.id,
          sortOrder: sort,
          tags: toTags(row.title),
        },
      });
      parentId = top.id;
      continue;
    }

    await prisma.task.upsert({
      where: { notionId },
      create: {
        notionId,
        title: row.title,
        type: "ISSUE",
        status: /done/i.test(row.title) ? "DONE" : "TODO",
        startDate: new Date(),
        endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
        progress: /done/i.test(row.title) ? 100 : 0,
        parentId: parentId ?? root.id,
        sortOrder: sort,
        tags: toTags(row.title),
      },
      update: {
        title: row.title,
        parentId: parentId ?? root.id,
        sortOrder: sort,
        tags: toTags(row.title),
      },
    });
  }

  const importedCount = await prisma.task.count({
    where: { parentId: root.id },
  });
  console.log(`Imported backlog under "${root.title}" with ${importedCount} top-level children.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

