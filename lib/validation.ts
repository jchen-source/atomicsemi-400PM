import { z } from "zod";

export const TaskTypeEnum = z.enum(["EPIC", "TASK", "ISSUE", "MILESTONE"]);
export const StatusEnum = z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]);
export const DepTypeEnum = z.enum(["FS", "SS", "FF", "SF"]);

const dateLike = z
  .union([z.string(), z.date()])
  .transform((v) => new Date(v))
  .refine((d) => !Number.isNaN(d.getTime()), { message: "invalid date" });

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
