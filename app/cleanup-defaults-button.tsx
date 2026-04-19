"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CleanupDefaultsButton() {
  const router = useRouter();
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
      router.refresh();
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
        title='Delete demo seed backlog "Launch PM App v1"'
        className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {busy ? "Removing…" : "Remove demo seed"}
      </button>
      {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
    </div>
  );
}

