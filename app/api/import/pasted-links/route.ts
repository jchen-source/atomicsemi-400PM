import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";

function extractLinkRows(markdown: string) {
  const re = /\[([^\]]+)\]\((https:\/\/www\.notion\.so\/[^\s)]+)\)/g;
  const rows: { title: string; url: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const title = m[1].trim();
    const url = m[2].trim();
    if (!title) continue;
    rows.push({ title, url });
  }
  return rows;
}

function extractNotionId(url: string) {
  const m = url.match(/([0-9a-f]{32})(?:\?|$)/i);
  return m ? m[1].toLowerCase() : null;
}

function isTopLevel(title: string) {
  return /^(Tool Delivery:|Cube Delivery:)/i.test(title);
}

function toTags(title: string) {
  const tags: string[] = [];
  if (/^Tool Delivery:/i.test(title)) tags.push("tool-delivery");
  if (/^Cube Delivery:/i.test(title)) tags.push("cube-delivery");
  if (/procurement/i.test(title)) tags.push("procurement");
  if (/wiring/i.test(title)) tags.push("wiring");
  if (/assembly/i.test(title)) tags.push("assembly");
  if (/installation/i.test(title)) tags.push("installation");
  return JSON.stringify(tags);
}

export async function POST(req: Request) {
  let markdown: string | undefined;
  try {
    const body = (await req.json().catch(() => null)) as
      | { markdown?: string }
      | null;
    if (body?.markdown && typeof body.markdown === "string") {
      markdown = body.markdown;
    }
  } catch {
    // ignore
  }

  if (!markdown) {
    try {
      const p = path.join(process.cwd(), "data", "notion-links.md");
      markdown = await readFile(p, "utf8");
    } catch {
      return NextResponse.json(
        { error: "No markdown provided and data/notion-links.md not found." },
        { status: 400 },
      );
    }
  }

  const rows = extractLinkRows(markdown);
  if (!rows.length) {
    return NextResponse.json(
      { error: "No Notion links found in markdown." },
      { status: 400 },
    );
  }

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

  let parentId: string | null = null;
  let sort = 0;
  let imported = 0;

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
      imported += 1;
      continue;
    }

    await prisma.task.upsert({
      where: { notionId },
      create: {
        notionId,
        title: row.title,
        type: "TASK",
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
    imported += 1;
  }

  const total = await prisma.task.count({ where: { parentId: root.id } });
  return NextResponse.json({
    ok: true,
    rootId: root.id,
    rowsSeen: rows.length,
    imported,
    total,
  });
}
