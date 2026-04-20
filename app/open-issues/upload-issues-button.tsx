"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";

/**
 * Flexible column aliases so the uploader doesn't care whether the
 * header says "Task", "Issue", "Title", etc. Match is case-
 * insensitive; first hit wins.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  program: ["program", "workstream", "project"],
  task: ["task", "title", "issue", "summary", "name"],
  owner: ["owner", "assignee", "assigned to", "dri", "responsible"],
  priority: ["priority", "urgency", "severity"],
  status: ["status", "state"],
  comments: [
    "comments",
    "comment",
    "notes",
    "note",
    "description",
    "details",
    "context",
  ],
  dueDate: ["due date", "due", "duedate", "target", "target date", "deadline"],
};

type ImportRow = {
  program: string;
  task: string;
  owner: string;
  priority: string;
  status: string;
  comments: string;
  dueDate: string;
};

type ImportResult = {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors?: Array<{ row: number; error: string }>;
};

export default function UploadIssuesButton() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setRows(null);
    setFileName("");
    setError("");
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFile(file: File) {
    setError("");
    setResult(null);
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) {
        setError("No sheets found in this file.");
        return;
      }
      const json: Array<Record<string, unknown>> = XLSX.utils.sheet_to_json(
        sheet,
        { defval: "", raw: false },
      );
      if (json.length === 0) {
        setError("Sheet is empty.");
        return;
      }
      const headerMap = buildHeaderMap(Object.keys(json[0] ?? {}));
      if (!headerMap.task) {
        setError(
          "Couldn't find a Task/Title/Issue column. Make sure the first row is headers.",
        );
        return;
      }
      const mapped: ImportRow[] = json
        .map((r) => ({
          program: pickString(r, headerMap.program),
          task: pickString(r, headerMap.task),
          owner: pickString(r, headerMap.owner),
          priority: pickString(r, headerMap.priority),
          status: pickString(r, headerMap.status),
          comments: pickString(r, headerMap.comments),
          dueDate: pickString(r, headerMap.dueDate),
        }))
        .filter((r) => r.task.trim().length > 0);
      if (mapped.length === 0) {
        setError("No rows with a Task/Title value found.");
        return;
      }
      setRows(mapped);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse file.");
    }
  }

  async function runImport() {
    if (!rows) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/open-issues/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Import failed (${res.status})`);
      }
      const body = (await res.json()) as ImportResult;
      setResult(body);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        title="Upload an Excel or CSV export of open issues"
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M17 8l-5-5-5 5" />
          <path d="M12 3v12" />
        </svg>
        Upload spreadsheet
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />

      {(rows || error || result) && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) reset();
          }}
        >
          <div className="w-full max-w-3xl overflow-hidden rounded-lg bg-white shadow-xl">
            <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Import Open Issues
                </h2>
                <p className="text-[11px] text-slate-500">
                  {fileName || "Preview and confirm before importing."}
                </p>
              </div>
              <button
                type="button"
                onClick={reset}
                disabled={busy}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                Close
              </button>
            </header>

            <div className="max-h-[60vh] overflow-auto">
              {error && (
                <p className="m-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {error}
                </p>
              )}
              {result && (
                <div className="m-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                  Imported <strong>{result.created}</strong> new issue
                  {result.created === 1 ? "" : "s"}
                  {result.updated > 0 && (
                    <>
                      {" "}· updated <strong>{result.updated}</strong> existing
                    </>
                  )}
                  {result.skipped > 0 && (
                    <> · skipped <strong>{result.skipped}</strong></>
                  )}
                  {result.failed > 0 && (
                    <>
                      {" "}·{" "}
                      <span className="text-red-700">
                        failed <strong>{result.failed}</strong>
                      </span>
                    </>
                  )}
                  .
                  {result.errors && result.errors.length > 0 && (
                    <ul className="mt-1 list-inside list-disc">
                      {result.errors.map((e) => (
                        <li key={e.row}>
                          Row {e.row}: {e.error}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {rows && !result && (
                <table className="w-full border-collapse text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 text-left font-semibold text-slate-600">
                    <tr>
                      <th className="border-b border-slate-200 px-3 py-1.5">
                        #
                      </th>
                      <th className="border-b border-slate-200 px-3 py-1.5">
                        Task
                      </th>
                      <th className="border-b border-slate-200 px-3 py-1.5">
                        Owner
                      </th>
                      <th className="border-b border-slate-200 px-3 py-1.5">
                        Priority
                      </th>
                      <th className="border-b border-slate-200 px-3 py-1.5">
                        Status
                      </th>
                      <th className="border-b border-slate-200 px-3 py-1.5">
                        Due
                      </th>
                      <th className="border-b border-slate-200 px-3 py-1.5">
                        Comments
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="odd:bg-white even:bg-slate-50/60">
                        <td className="border-b border-slate-100 px-3 py-1.5 text-slate-400">
                          {i + 1}
                        </td>
                        <td className="border-b border-slate-100 px-3 py-1.5 text-slate-800">
                          {r.task}
                        </td>
                        <td className="border-b border-slate-100 px-3 py-1.5 text-slate-600">
                          {r.owner || "—"}
                        </td>
                        <td className="border-b border-slate-100 px-3 py-1.5 text-slate-600">
                          {r.priority || "—"}
                        </td>
                        <td className="border-b border-slate-100 px-3 py-1.5 text-slate-600">
                          {r.status || "—"}
                        </td>
                        <td className="border-b border-slate-100 px-3 py-1.5 text-slate-600">
                          {r.dueDate || "—"}
                        </td>
                        <td className="border-b border-slate-100 px-3 py-1.5 text-slate-600">
                          <span className="line-clamp-2 whitespace-pre-wrap">
                            {r.comments || "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] text-slate-500">
                {rows && !result
                  ? `${rows.length} rows ready. Linked tasks can be assigned after import.`
                  : result
                    ? "Changes are live on the Open Issues page."
                    : ""}
              </p>
              <div className="flex items-center gap-2">
                {result ? (
                  <button
                    type="button"
                    onClick={reset}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    Done
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={reset}
                      disabled={busy}
                      className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={runImport}
                      disabled={busy || !rows || rows.length === 0}
                      className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
                    >
                      {busy ? "Importing…" : `Import ${rows?.length ?? 0} rows`}
                    </button>
                  </>
                )}
              </div>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

type HeaderMap = {
  program: string | null;
  task: string | null;
  owner: string | null;
  priority: string | null;
  status: string | null;
  comments: string | null;
  dueDate: string | null;
};

function buildHeaderMap(keys: string[]): HeaderMap {
  const out: HeaderMap = {
    program: null,
    task: null,
    owner: null,
    priority: null,
    status: null,
    comments: null,
    dueDate: null,
  };
  const normKeys = keys.map((k) => ({ raw: k, norm: normaliseHeader(k) }));
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as Array<
    [keyof HeaderMap, string[]]
  >) {
    const hit = normKeys.find((k) =>
      aliases.some((a) => normaliseHeader(a) === k.norm),
    );
    if (hit) out[field] = hit.raw;
  }
  return out;
}

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_\-\.]+/g, "").trim();
}

function pickString(row: Record<string, unknown>, key: string | null): string {
  if (!key) return "";
  const v = row[key];
  if (v === null || v === undefined) return "";
  return String(v).trim();
}
