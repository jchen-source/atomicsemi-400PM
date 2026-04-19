import { prisma } from "./db";

export type SyncConfig = {
  notionToken: string;
  roadmapDbId: string;
  issuesDbId: string;
  // Property-name map for the roadmap database
  roadmapProps: {
    title: string;
    status?: string;
    start?: string;
    end?: string;
    progress?: string;
    assignee?: string;
    tags?: string;
  };
  // Property-name map for the issues database
  issueProps: {
    title: string;
    status?: string;
    start?: string;
    end?: string;
    progress?: string;
    assignee?: string;
    tags?: string;
    parentRelation: string; // relation pointing at roadmap DB
  };
};

const DEFAULTS: SyncConfig = {
  notionToken: "",
  roadmapDbId: "",
  issuesDbId: "",
  roadmapProps: {
    title: "Name",
    status: "Status",
    start: "Start",
    end: "End",
    progress: "Progress",
    assignee: "Assignee",
    tags: "Tags",
  },
  issueProps: {
    title: "Name",
    status: "Status",
    start: "Start",
    end: "Due",
    progress: "Progress",
    assignee: "Assignee",
    tags: "Tags",
    parentRelation: "Roadmap",
  },
};

const KEY = "syncConfig";

export async function readSyncConfig(): Promise<SyncConfig> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  let stored: Partial<SyncConfig> = {};
  if (row) {
    try {
      stored = JSON.parse(row.value) as Partial<SyncConfig>;
    } catch {
      stored = {};
    }
  }
  const merged: SyncConfig = {
    ...DEFAULTS,
    ...stored,
    roadmapProps: { ...DEFAULTS.roadmapProps, ...(stored.roadmapProps ?? {}) },
    issueProps: { ...DEFAULTS.issueProps, ...(stored.issueProps ?? {}) },
  };
  // Fall back to env vars if not set in DB
  if (!merged.notionToken && process.env.NOTION_TOKEN) {
    merged.notionToken = process.env.NOTION_TOKEN;
  }
  if (!merged.roadmapDbId && process.env.NOTION_ROADMAP_DB_ID) {
    merged.roadmapDbId = process.env.NOTION_ROADMAP_DB_ID;
  }
  if (!merged.issuesDbId && process.env.NOTION_ISSUES_DB_ID) {
    merged.issuesDbId = process.env.NOTION_ISSUES_DB_ID;
  }
  return merged;
}

export async function writeSyncConfig(patch: Partial<SyncConfig>) {
  const current = await readSyncConfig();
  const next: SyncConfig = {
    ...current,
    ...patch,
    roadmapProps: { ...current.roadmapProps, ...(patch.roadmapProps ?? {}) },
    issueProps: { ...current.issueProps, ...(patch.issueProps ?? {}) },
  };
  await prisma.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return next;
}

/**
 * Redact the token when sending config to the client.
 */
export function redactConfig(cfg: SyncConfig) {
  return {
    ...cfg,
    notionToken: cfg.notionToken ? "••••••••" + cfg.notionToken.slice(-4) : "",
  };
}
