import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { rollupAncestorsForIds } from "@/lib/schedule";

/**
 * One-shot repair: every leaf whose status is out of sync with its
 * progress gets nudged to the correct state, then ancestors roll up so
 * programs/workstreams pick up the new status too.
 *
 *   leaf.progress >= 100 && status !== DONE        → DONE
 *   leaf.progress  >  0  && status === TODO        → IN_PROGRESS
 *
 * This is the backfill companion to the auto-promotion rules in the
 * progress endpoint + schedule rollup. Existing rows that predate those
 * rules (e.g. a task the team marked 100% from the Gantt without
 * touching the status cell) never self-correct until someone pushes
 * another update — this endpoint fixes them in a single pass.
 *
 * POST only, no body. Returns counts so the caller can sanity-check.
 */
export async function POST() {
  const leaves = await prisma.task.findMany({
    where: {
      type: { notIn: ["ISSUE", "MILESTONE"] },
      children: { none: { type: { notIn: ["ISSUE", "MILESTONE"] } } },
    },
    select: { id: true, status: true, progress: true, blocked: true },
  });

  const touched: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const l of leaves) {
      let next: string | null = null;
      if (l.progress >= 100 && l.status !== "DONE") next = "DONE";
      else if (
        l.progress > 0 &&
        l.status === "TODO" &&
        // A TODO row that's explicitly blocked should go BLOCKED, not
        // IN_PROGRESS — match the live endpoint's semantics.
        !l.blocked
      ) {
        next = "IN_PROGRESS";
      } else if (l.progress > 0 && l.status === "TODO" && l.blocked) {
        next = "BLOCKED";
      }
      if (next) {
        await tx.task.update({ where: { id: l.id }, data: { status: next } });
        touched.push(l.id);
      }
    }
    if (touched.length) {
      await rollupAncestorsForIds(tx, touched);
    }
  });

  try {
    revalidatePath("/");
    revalidatePath("/tasks");
  } catch {
    // no-op outside request lifecycle
  }

  return NextResponse.json({
    ok: true,
    leavesChecked: leaves.length,
    leavesUpdated: touched.length,
    ids: touched,
  });
}
