import { prisma } from "@/lib/db";
import { readSyncConfig, type SyncConfig } from "@/lib/settings";
import { notionClient, queryAllDbPages } from "./client";
import {
  mapStatus,
  readDateRange,
  readMultiSelect,
  readNumber,
  readPersonNames,
  readRelationIds,
  readSelectName,
  readTitle,
  type NotionPage,
} from "./mapping";
import { addDaysUTC, serializeTags } from "@/lib/utils";

type ImportResult = {
  imported: number;
  skipped: number;
  failed: number;
  errors: string[];
};

function todayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Build task data from a Notion page + a property map. Returns null when
 * fields are missing in an unrecoverable way.
 */
function toTaskData(
  page: NotionPage,
  map: SyncConfig["roadmapProps"] | SyncConfig["issueProps"],
) {
  const title = readTitle(page, map.title);
  const range = readDateRange(page, map.end);
  const startRange = readDateRange(page, map.start);
  const today = todayUTC();

  // Prefer the (start, end) date range if start prop holds a range.
  const start = startRange.start ?? range.start ?? today;
  const end =
    startRange.end ?? range.end ?? range.start ?? addDaysUTC(start, 1);

  const status = mapStatus(readSelectName(page, map.status));
  const progress = readNumber(page, map.progress);
  const assignee = readPersonNames(page, map.assignee);
  const tags = readMultiSelect(page, map.tags);

  return {
    title,
    status,
    startDate: start < end ? start : today,
    endDate: start < end ? end : addDaysUTC(today, 1),
    progress:
      progress == null ? 0 : Math.max(0, Math.min(100, Math.round(progress))),
    assignee: assignee ?? null,
    tags: serializeTags(tags),
  };
}

export async function runNotionImport(): Promise<ImportResult> {
  const cfg = await readSyncConfig();
  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  if (!cfg.notionToken) {
    result.errors.push("Notion token is not configured");
    return result;
  }
  if (!cfg.roadmapDbId && !cfg.issuesDbId) {
    result.errors.push("No Notion database IDs configured");
    return result;
  }

  const client = notionClient(cfg.notionToken);

  // ---- Pass 1: roadmap (EPICs) ----
  const roadmapByNotionId = new Map<string, string>(); // notion page id -> local task id

  if (cfg.roadmapDbId) {
    try {
      const pages = (await queryAllDbPages(
        client,
        cfg.roadmapDbId,
      )) as NotionPage[];

      for (const page of pages) {
        try {
          const existing = await prisma.task.findUnique({
            where: { notionId: page.id },
          });
          if (existing) {
            roadmapByNotionId.set(page.id, existing.id);
            result.skipped++;
            continue;
          }
          const data = toTaskData(page, cfg.roadmapProps);
          const created = await prisma.task.create({
            data: { ...data, type: "EPIC", notionId: page.id },
          });
          roadmapByNotionId.set(page.id, created.id);
          result.imported++;
        } catch (err) {
          result.failed++;
          result.errors.push(
            `roadmap page ${page.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `roadmap DB: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Ensure existing EPICs in DB (from prior imports) are reachable so new
  // issues can still link to them.
  const previousEpics = await prisma.task.findMany({
    where: { notionId: { not: null }, type: "EPIC" },
    select: { id: true, notionId: true },
  });
  for (const e of previousEpics) {
    if (e.notionId) roadmapByNotionId.set(e.notionId, e.id);
  }

  // ---- Pass 2: issues (ISSUE, linked to parent) ----
  if (cfg.issuesDbId) {
    try {
      const pages = (await queryAllDbPages(
        client,
        cfg.issuesDbId,
      )) as NotionPage[];

      for (const page of pages) {
        try {
          const existing = await prisma.task.findUnique({
            where: { notionId: page.id },
          });
          if (existing) {
            result.skipped++;
            continue;
          }
          const data = toTaskData(page, cfg.issueProps);
          const parentIds = readRelationIds(
            page,
            cfg.issueProps.parentRelation,
          );
          const parentId =
            parentIds
              .map((nid) => roadmapByNotionId.get(nid))
              .find((v): v is string => !!v) ?? null;

          await prisma.task.create({
            data: {
              ...data,
              type: "ISSUE",
              notionId: page.id,
              parentId,
            },
          });
          result.imported++;
        } catch (err) {
          result.failed++;
          result.errors.push(
            `issue page ${page.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `issues DB: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await prisma.syncLog.create({
    data: {
      source: "notion",
      imported: result.imported,
      skipped: result.skipped,
      failed: result.failed,
      errors: result.errors.length ? result.errors.slice(0, 20).join("\n") : null,
      message:
        result.errors.length && result.imported + result.skipped === 0
          ? "sync failed"
          : `imported ${result.imported}, skipped ${result.skipped}, failed ${result.failed}`,
    },
  });

  return result;
}
