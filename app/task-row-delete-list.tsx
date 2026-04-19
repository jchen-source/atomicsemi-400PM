"use client";

import { useState } from "react";

type Row = {
  id: string;
  title: string;
  type: string;
};

export default function TaskRowDeleteList({ rows }: { rows: Row[] }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const visible = rows
    .filter((r) => r.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 40);

  async function deleteOne(row: Row) {
    const ok = window.confirm(`Delete "${row.title}" and its descendants?`);
    if (!ok) return;
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/tasks/${row.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      window.location.reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Delete line-by-line</p>
        <input
          className="w-64 rounded-md border border-border bg-background px-2 py-1 text-xs"
          placeholder="Filter tasks..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="max-h-44 overflow-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-2 py-1 text-left">Task</th>
              <th className="px-2 py-1 text-left">Type</th>
              <th className="px-2 py-1 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-2 py-1">{r.title}</td>
                <td className="px-2 py-1 text-muted-foreground">{r.type}</td>
                <td className="px-2 py-1 text-right">
                  <button
                    onClick={() => deleteOne(r)}
                    disabled={busyId === r.id}
                    className="rounded border border-red-300 bg-red-50 px-2 py-0.5 text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
                  >
                    {busyId === r.id ? "Deleting..." : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td
                  className="px-2 py-2 text-center text-muted-foreground"
                  colSpan={3}
                >
                  No matching tasks
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

