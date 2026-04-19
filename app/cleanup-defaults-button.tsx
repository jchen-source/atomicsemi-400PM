"use client";

import { useState } from "react";

export default function CleanupDefaultsButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function onDeleteDemoOnly() {
    const ok = window.confirm(
      'Delete demo seed backlog "Launch PM App v1"? Imported Notion backlog will be kept.',
    );
    if (!ok) return;

    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/tasks/cleanup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ includeImported: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Cleanup failed");
      setMsg(
        `Deleted ${data.deletedTasks ?? 0} tasks and ${data.deletedDependencies ?? 0} dependencies.`,
      );
      window.location.reload();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Cleanup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onDeleteDemoOnly}
        disabled={busy}
        className="inline-flex items-center rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300"
      >
        {busy ? "Deleting..." : "Delete Demo Seed"}
      </button>
      {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
    </div>
  );
}

