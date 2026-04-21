import { z } from "zod";

export const TaskTypeEnum = z.enum(["EPIC", "TASK", "ISSUE"]);
export const StatusEnum = z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]);
export const DepTypeEnum = z.enum(["FS", "SS", "FF", "SF"]);

const dateLike = z
  .union([z.string(), z.date()])
  .transform((v) => new Date(v))
  .refine((d) => !Number.isNaN(d.getTime()), { message: "invalid date" });

/**
 * One row of a task's percent-split. `percent` is a number in `(0, 100]`;
 * the full list must sum to ~100 (we allow 0.1 slack to tolerate floating
 * point). `name` is matched case-insensitively against the roster and
 * stored as provided.
 */
export const AllocationSchema = z.object({
  name: z.string().min(1).max(200),
  percent: z.number().min(0.01).max(100),
});

/**
 * Client may send `allocations: null` to *clear* a split (revert to the
 * single-assignee / even-split legacy path). An explicit empty array is
 * treated the same as null so the callers don't have to distinguish.
 */
export const AllocationsSchema = z
  .array(AllocationSchema)
  .max(50)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    for (const r of rows) {
      const key = r.name.trim().toLowerCase();
      if (!key) {
        ctx.addIssue({ code: "custom", message: "allocation name is empty" });
        return;
      }
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate allocation for "${r.name}"`,
        });
        return;
      }
      seen.add(key);
    }
    if (rows.length === 0) return; // empty array = clear split, handled above
    const sum = rows.reduce((acc, r) => acc + r.percent, 0);
    if (Math.abs(sum - 100) > 0.1) {
      ctx.addIssue({
        code: "custom",
        message: `allocation percents must sum to 100 (got ${sum.toFixed(2)})`,
      });
    }
  });

export type AllocationInput = z.infer<typeof AllocationSchema>;

/**
 * Normalize allocations for persistence: trim names, round percents to 2
 * decimals, and drop empty rows. Returns `null` when there's nothing to
 * store (caller clears the column and falls back to legacy behavior).
 */
export function normalizeAllocations(
  rows: AllocationInput[] | null | undefined,
): AllocationInput[] | null {
  if (!rows || rows.length === 0) return null;
  const cleaned = rows
    .map((r) => ({
      name: r.name.trim(),
      percent: Math.round(r.percent * 100) / 100,
    }))
    .filter((r) => r.name && r.percent > 0);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Derive the comma-joined `assignee` string from a normalized allocation
 * list. Kept in sync on every write so existing filters, chips, and
 * displays that read `Task.assignee` keep working without a schema churn.
 */
export function assigneeStringFromAllocations(
  rows: AllocationInput[] | null,
): string | null {
  if (!rows || rows.length === 0) return null;
  return rows.map((r) => r.name).join(", ");
}

export const CreateTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).optional().nullable(),
  type: TaskTypeEnum.default("TASK"),
  status: StatusEnum.default("TODO"),
  startDate: dateLike,
  endDate: dateLike,
  progress: z.number().int().min(0).max(100).default(0),
  parentId: z.string().optional().nullable(),
  linkedTaskId: z.string().optional().nullable(),
  assignee: z.string().optional().nullable(),
  resourceAllocated: z.string().max(200).optional().nullable(),
  allocations: AllocationsSchema.optional().nullable(),
  effortHours: z.number().int().min(0).max(100_000).optional().nullable(),
  tags: z.array(z.string()).default([]),
  sortOrder: z.number().int().default(0),
});

export const UpdateTaskSchema = CreateTaskSchema.partial().extend({
  progressComment: z.string().max(2_000).optional().nullable(),
  openIssueComment: z.string().max(20_000).optional().nullable(),
  updateComment: z.string().max(5_000).optional().nullable(),
});

export const CreateDependencySchema = z
  .object({
    predecessorId: z.string(),
    dependentId: z.string(),
    type: DepTypeEnum.default("FS"),
    lagDays: z.number().int().default(0),
  })
  .refine((v) => v.predecessorId !== v.dependentId, {
    message: "A task cannot depend on itself",
  });

export const UpdateDependencySchema = z.object({
  type: DepTypeEnum.optional(),
  lagDays: z.number().int().optional(),
});
