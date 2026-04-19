import { NextResponse } from "next/server";
import { readSyncConfig, redactConfig, writeSyncConfig } from "@/lib/settings";
import { z } from "zod";

const propsSchema = z
  .object({
    title: z.string().optional(),
    status: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    progress: z.string().optional(),
    assignee: z.string().optional(),
    tags: z.string().optional(),
    parentRelation: z.string().optional(),
  })
  .passthrough();

const patchSchema = z.object({
  notionToken: z.string().optional(),
  roadmapDbId: z.string().optional(),
  issuesDbId: z.string().optional(),
  roadmapProps: propsSchema.optional(),
  issueProps: propsSchema.optional(),
});

export async function GET() {
  const cfg = await readSyncConfig();
  return NextResponse.json(redactConfig(cfg));
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  // Ignore the redacted placeholder so existing tokens aren't overwritten.
  const data = { ...parsed.data };
  if (data.notionToken && data.notionToken.startsWith("••••")) {
    delete data.notionToken;
  }
  // Cast to SyncConfig-compatible partial (props sub-objects match).
  const next = await writeSyncConfig(data as Parameters<typeof writeSyncConfig>[0]);
  return NextResponse.json(redactConfig(next));
}
