import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function toISODate(d: Date | string) {
  return new Date(d).toISOString();
}

export function addDaysUTC(d: Date | string, n: number) {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

export function diffDaysUTC(a: Date | string, b: Date | string) {
  const ms =
    new Date(b).setUTCHours(0, 0, 0, 0) - new Date(a).setUTCHours(0, 0, 0, 0);
  return Math.round(ms / 86_400_000);
}

/**
 * SQLite doesn't support native array columns, so `Task.tags` is stored as a
 * JSON-serialized string. These helpers isolate that quirk.
 */
export function serializeTags(tags: string[] | undefined | null): string {
  if (!tags || tags.length === 0) return "[]";
  return JSON.stringify(tags);
}

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
