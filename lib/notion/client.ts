import { Client } from "@notionhq/client";

export function notionClient(token: string) {
  if (!token) throw new Error("Notion token is not configured");
  return new Client({ auth: token });
}

/**
 * Paginate through all pages of a database.
 */
export async function queryAllDbPages(
  client: Client,
  database_id: string,
): Promise<unknown[]> {
  const results: unknown[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const res = await client.databases.query({
      database_id,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...res.results);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return results;
}
