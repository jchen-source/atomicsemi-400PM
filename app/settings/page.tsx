"use client";

import { useEffect, useState } from "react";

type Props = {
  title: string;
  status?: string;
  start?: string;
  end?: string;
  progress?: string;
  assignee?: string;
  tags?: string;
  parentRelation?: string;
};

type Config = {
  notionToken: string;
  roadmapDbId: string;
  issuesDbId: string;
  roadmapProps: Props;
  issueProps: Props;
};

type SyncLogRow = {
  id: string;
  runAt: string;
  imported: number;
  skipped: number;
  failed: number;
  errors: string | null;
  message: string | null;
};

export default function SettingsPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<SyncLogRow[]>([]);

  async function loadAll() {
    const [c, l] = await Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/sync/notion").then((r) => r.json()),
    ]);
    setCfg(c);
    setLogs(l);
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function save() {
    if (!cfg) return;
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
      });
      if (!res.ok) throw new Error(await res.text());
      const next = await res.json();
      setCfg(next);
      setStatus("Saved.");
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function runSync() {
    setSyncing(true);
    setStatus("Running sync…");
    try {
      const res = await fetch("/api/sync/notion", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Sync failed");
      setStatus(
        `Imported ${data.imported}, skipped ${data.skipped}, failed ${data.failed}.`,
      );
      await loadAll();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  if (!cfg) return <div className="text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Notion integration. After filling this in, click <b>Run sync</b> to
          import your roadmap and issues. Re-running only pulls new items; it
          never overwrites local edits.
        </p>
      </div>

      <div id="notion" />
      <Section title="Notion credentials">
        <Field
          label="Integration token"
          hint="Create an internal integration at notion.so/my-integrations, share both DBs with it, then paste the secret here."
        >
          <input
            type="password"
            className={inputCls}
            value={cfg.notionToken}
            onChange={(e) => setCfg({ ...cfg, notionToken: e.target.value })}
            placeholder="ntn_..."
          />
        </Field>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Roadmap database ID">
            <input
              className={inputCls}
              value={cfg.roadmapDbId}
              onChange={(e) => setCfg({ ...cfg, roadmapDbId: e.target.value })}
              placeholder="32 hex characters or UUID"
            />
          </Field>
          <Field label="Issues database ID">
            <input
              className={inputCls}
              value={cfg.issuesDbId}
              onChange={(e) => setCfg({ ...cfg, issuesDbId: e.target.value })}
              placeholder="32 hex characters or UUID"
            />
          </Field>
        </div>
      </Section>

      <Section title="Roadmap property mapping">
        <PropGrid
          value={cfg.roadmapProps}
          onChange={(p) => setCfg({ ...cfg, roadmapProps: p })}
        />
      </Section>

      <Section title="Issues property mapping">
        <PropGrid
          includeParent
          value={cfg.issueProps}
          onChange={(p) => setCfg({ ...cfg, issueProps: p })}
        />
      </Section>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className={btnCls("primary")}
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        <button
          onClick={runSync}
          disabled={syncing}
          className={btnCls("default")}
        >
          {syncing ? "Syncing…" : "Run sync from Notion"}
        </button>
        {status && (
          <span className="text-sm text-muted-foreground">{status}</span>
        )}
      </div>

      <Section title="Sync history">
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sync runs yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="min-w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <Th>Run</Th>
                  <Th>Imported</Th>
                  <Th>Skipped</Th>
                  <Th>Failed</Th>
                  <Th>Details</Th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <Td>{new Date(l.runAt).toLocaleString()}</Td>
                    <Td>{l.imported}</Td>
                    <Td>{l.skipped}</Td>
                    <Td>{l.failed}</Td>
                    <Td className="max-w-[420px] truncate" title={l.errors ?? l.message ?? ""}>
                      {l.errors ?? l.message ?? ""}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-background p-4">
      <h2 className="text-lg font-medium">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function PropGrid({
  value,
  onChange,
  includeParent = false,
}: {
  value: Props;
  onChange: (p: Props) => void;
  includeParent?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {(
        [
          ["title", "Title property"],
          ["status", "Status property"],
          ["start", "Start date property"],
          ["end", "End/Due date property"],
          ["progress", "Progress property (0-100)"],
          ["assignee", "Assignee property"],
          ["tags", "Tags property (multi-select)"],
          ...(includeParent
            ? ([["parentRelation", "Parent relation (to roadmap)"]] as const)
            : ([] as const)),
        ] as const
      ).map(([key, label]) => (
        <Field key={key} label={label}>
          <input
            className={inputCls}
            value={(value as Record<string, string | undefined>)[key] ?? ""}
            onChange={(e) =>
              onChange({ ...value, [key]: e.target.value } as Props)
            }
          />
        </Field>
      ))}
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30";

function btnCls(variant: "primary" | "default") {
  const base =
    "inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 transition-colors";
  if (variant === "primary") {
    return `${base} bg-primary text-primary-foreground hover:opacity-90`;
  }
  return `${base} border border-border hover:bg-accent`;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-medium">{children}</th>;
}
function Td({
  children,
  className = "",
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-3 py-2 ${className}`} title={title}>
      {children}
    </td>
  );
}
