type Status = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";

type NotionProperty = { type: string; [k: string]: unknown };
type NotionPage = {
  id: string;
  properties: Record<string, NotionProperty>;
  created_time?: string;
  last_edited_time?: string;
};

function castProp<T>(prop: NotionProperty): T {
  return prop as unknown as T;
}

export function readTitle(page: NotionPage, propName: string): string {
  const prop = page.properties[propName];
  if (!prop) return "(untitled)";
  if (prop.type === "title") {
    const arr = castProp<{ title: Array<{ plain_text?: string }> }>(prop).title;
    return arr.map((t) => t.plain_text ?? "").join("") || "(untitled)";
  }
  if (prop.type === "rich_text") {
    const arr = castProp<{ rich_text: Array<{ plain_text?: string }> }>(
      prop,
    ).rich_text;
    return arr.map((t) => t.plain_text ?? "").join("") || "(untitled)";
  }
  return "(untitled)";
}

export function readSelectName(
  page: NotionPage,
  propName: string | undefined,
): string | null {
  if (!propName) return null;
  const prop = page.properties[propName];
  if (!prop) return null;
  if (prop.type === "select") {
    const sel = castProp<{ select: { name: string } | null }>(prop).select;
    return sel?.name ?? null;
  }
  if (prop.type === "status") {
    const s = castProp<{ status: { name: string } | null }>(prop).status;
    return s?.name ?? null;
  }
  return null;
}

export function readDateRange(
  page: NotionPage,
  propName: string | undefined,
): { start: Date | null; end: Date | null } {
  const empty = { start: null, end: null };
  if (!propName) return empty;
  const prop = page.properties[propName];
  if (!prop) return empty;
  if (prop.type === "date") {
    const d = castProp<{
      date: { start: string; end: string | null } | null;
    }>(prop).date;
    if (!d) return empty;
    return {
      start: d.start ? new Date(d.start) : null,
      end: d.end ? new Date(d.end) : null,
    };
  }
  return empty;
}

export function readNumber(
  page: NotionPage,
  propName: string | undefined,
): number | null {
  if (!propName) return null;
  const prop = page.properties[propName];
  if (!prop) return null;
  if (prop.type === "number") {
    return castProp<{ number: number | null }>(prop).number ?? null;
  }
  return null;
}

export function readPersonNames(
  page: NotionPage,
  propName: string | undefined,
): string | null {
  if (!propName) return null;
  const prop = page.properties[propName];
  if (!prop) return null;
  if (prop.type === "people") {
    const people = castProp<{ people: Array<{ name?: string }> }>(prop).people;
    const names = people.map((p) => p.name).filter((n): n is string => !!n);
    return names.join(", ") || null;
  }
  if (prop.type === "rich_text") {
    const arr = castProp<{ rich_text: Array<{ plain_text?: string }> }>(
      prop,
    ).rich_text;
    return arr.map((t) => t.plain_text ?? "").join("") || null;
  }
  return null;
}

export function readMultiSelect(
  page: NotionPage,
  propName: string | undefined,
): string[] {
  if (!propName) return [];
  const prop = page.properties[propName];
  if (!prop) return [];
  if (prop.type === "multi_select") {
    const arr = castProp<{ multi_select: Array<{ name: string }> }>(
      prop,
    ).multi_select;
    return arr.map((v) => v.name);
  }
  return [];
}

export function readRelationIds(
  page: NotionPage,
  propName: string | undefined,
): string[] {
  if (!propName) return [];
  const prop = page.properties[propName];
  if (!prop) return [];
  if (prop.type === "relation") {
    const arr = castProp<{ relation: Array<{ id: string }> }>(prop).relation;
    return arr.map((v) => v.id);
  }
  return [];
}

/**
 * Loose mapping from free-text Notion status label to our enum.
 */
export function mapStatus(raw: string | null): Status {
  if (!raw) return "TODO";
  const s = raw.toLowerCase();
  if (/(done|complete|closed|shipped|resolved)/.test(s)) return "DONE";
  if (/(block|hold|paused|waiting)/.test(s)) return "BLOCKED";
  if (/(progress|doing|active|review|qa|testing)/.test(s)) return "IN_PROGRESS";
  return "TODO";
}

export type { NotionPage };
