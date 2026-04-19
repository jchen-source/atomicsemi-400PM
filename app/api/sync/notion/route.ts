import { NextResponse } from "next/server";
import { runNotionImport } from "@/lib/notion/import";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  try {
    const result = await runNotionImport();
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  const logs = await prisma.syncLog.findMany({
    orderBy: { runAt: "desc" },
    take: 20,
  });
  return NextResponse.json(logs);
}
