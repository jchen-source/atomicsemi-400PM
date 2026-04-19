"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ImportBacklogButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("");

  async function run() {
    if (loading) return;
    const ok = window.confirm(
      "Import the committed Notion backlog into this workspace? This is safe to re-run — it upserts by Notion ID.",
    );
    if (!ok) return;
    setLoading(true);
    setStatus("Importing…");
    try {
      const res = await fetch("/api/import/pasted-links", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Import failed");
      setStatus(`Imported ${data.imported} items.`);
      router.refresh();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
      >
        {loading ? "Importing…" : "Import backlog"}
      </button>
      {status && (
        <span className="text-xs text-muted-foreground">{status}</span>
      )}
    </div>
  );
}
