import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { serializeTags } from "@/lib/utils";
import {
  serializeIssueMeta,
  serializeNotes,
  type IssueStatus,
  type IssueUrgency,
} from "@/lib/open-issues";

/**
 * Bulk import endpoint for the Open Issues page. Accepts the exact
 * column shape from the user's spreadsheet (Program, Task, Owner,
 * Priority, Status, Comments, Due Date). Nothing is linked to a
 * planning task automatically — the user wires that up in the UI after
 * upload. Empty / blank rows are silently dropped.
 *
 * The endpoint is idempotent against re-upload only by title match:
 * if a row with the same title already exists, we update its core
 * fields in place instead of creating a duplicate. That keeps the
 * standup list tidy if someone re-exports the sheet.
 */

const RowSchema = z.object({
  program: z.string().optional().nullable(),
  task: z.string().min(1),
  owner: z.string().optional().nullable(),
  priority: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  comments: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
});

const BodySchema = z.object({
  rows: z.array(RowSchema).max(2000),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const now = new Date();
  const fallbackDue = new Date(now);
  fallbackDue.setDate(fallbackDue.getDate() + 14);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: Array<{ row: number; error: string }> = [];

  for (let i = 0; i < parsed.data.rows.length; i++) {
    const raw = parsed.data.rows[i];
    const title = (raw.task ?? "").trim();
    if (!title) {
      skipped++;
      continue;
    }

    const owner = (raw.owner ?? "").trim() || null;
    const priority = normalisePriority(raw.priority);
    const status = normaliseStatus(raw.status);
    const comment = (raw.comments ?? "").trim();
    const due = parseDateLoose(raw.dueDate) ?? fallbackDue;
    const program = (raw.program ?? "").trim();

    // Store "Program" as a pass-through tag so the user can later
    // filter / recognise provenance if they want.
    const programTags = program ? [`program:${program}`] : [];
    const tags = serializeIssueMeta(
      {
        urgency: priority,
        issueType: "Blocker",
        scheduleImpact: "None",
      },
      programTags,
    );
    // We move comments into the TaskUpdate thread (OPEN_ISSUE) so they
    // show up in the new Comments UI. Leave nextStep empty on import —
    // the description column is kept for the resolution note.
    const description = serializeNotes({
      nextStep: "",
      resolutionNote: "",
    });

    try {
      // Match by title within issues only. We also ensure we never
      // merge with a planning task (type != ISSUE).
      const existing = await prisma.task.findFirst({
        where: { type: "ISSUE", title },
        select: { id: true },
      });

      if (existing) {
        await prisma.task.update({
          where: { id: existing.id },
          data: {
            status,
            assignee: owner,
            startDate: due,
            endDate: due,
            tags: serializeTags(tags),
            description,
          },
        });
        updated++;
        if (comment) {
          await appendComment(existing.id, comment);
        }
      } else {
        const task = await prisma.task.create({
          data: {
            title,
            type: "ISSUE",
            status,
            startDate: due,
            endDate: due,
            progress: status === "DONE" ? 100 : 0,
            assignee: owner,
            tags: serializeTags(tags),
            description,
          },
          select: { id: true },
        });
        created++;
        if (comment) {
          await appendComment(task.id, comment);
        }
      }
    } catch (err) {
      errors.push({
        row: i + 1,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    created,
    updated,
    skipped,
    failed: errors.length,
    errors: errors.slice(0, 20),
  });
}

async function appendComment(taskId: string, text: string) {
  const id = `upd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await prisma.$executeRaw`
    INSERT INTO "TaskUpdate" (
      "id",
      "taskId",
      "commentType",
      "comment",
      "createdAt"
    ) VALUES (
      ${id},
      ${taskId},
      'OPEN_ISSUE',
      ${text},
      ${new Date()}
    )
  `;
}

function normalisePriority(raw: string | null | undefined): IssueUrgency {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "critical" || v === "urgent" || v === "p0") return "critical";
  if (v === "high" || v === "p1") return "high";
  if (v === "low" || v === "p3") return "low";
  if (v === "medium" || v === "p2" || v === "med") return "medium";
  return "medium";
}

function normaliseStatus(raw: string | null | undefined): IssueStatus {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || v.startsWith("not started") || v === "todo" || v === "to do") {
    return "TODO";
  }
  if (v.startsWith("in progress") || v === "doing" || v === "wip") {
    return "IN_PROGRESS";
  }
  if (v === "blocked" || v === "waiting" || v.startsWith("wait")) {
    return "BLOCKED";
  }
  if (v === "done" || v === "resolved" || v === "complete" || v === "closed") {
    return "DONE";
  }
  return "TODO";
}

/**
 * Lenient date parser. Accepts MM/DD/YYYY (the user's sheet format),
 * M/D/YYYY, YYYY-MM-DD, and ISO strings. Ignores timezone quirks by
 * anchoring to local noon so a date like "04/17/2026" always renders
 * as April 17 in every timezone.
 */
function parseDateLoose(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // US-style MM/DD/YYYY or M/D/YYYY(/YY)
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    let year = Number(us[3]);
    if (year < 100) year += 2000;
    const month = Number(us[1]) - 1;
    const day = Number(us[2]);
    const d = new Date(year, month, day, 12, 0, 0, 0);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // ISO YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      12,
      0,
      0,
      0,
    );
    if (!Number.isNaN(d.getTime())) return d;
  }
  // Excel serial date: number of days since 1899-12-30
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 25_000 && serial < 60_000) {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      return new Date(epoch.getTime() + serial * 86_400_000);
    }
  }
  // Fallback to Date parser (handles "April 17, 2026" etc.)
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
