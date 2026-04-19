import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Status = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
type WorkItem = {
  id: string;
  title: string;
  type: "EPIC" | "TASK" | "ISSUE";
  status: Status;
  progress: number;
  startDate: string;
  endDate: string;
  parentId: string | null;
  assignee: string | null;
  effortHours: number | null;
};

export default async function BurndownPage() {
  const tasks = await prisma.task.findMany({
    where: { type: { in: ["EPIC", "TASK", "ISSUE"] } },
    orderBy: [{ type: "asc" }, { title: "asc" }],
  });

  const items: WorkItem[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    type: (t.type === "EPIC" || t.type === "TASK" || t.type === "ISSUE"
      ? t.type
      : "TASK") as "EPIC" | "TASK" | "ISSUE",
    status: (t.status === "TODO" ||
    t.status === "IN_PROGRESS" ||
    t.status === "BLOCKED" ||
    t.status === "DONE"
      ? t.status
      : "TODO") as Status,
    progress: t.progress,
    startDate: t.startDate.toISOString(),
    endDate: t.endDate.toISOString(),
    parentId: t.parentId,
    assignee: t.assignee,
    effortHours: t.effortHours,
  }));

  const groups = buildBurndownGroups(items);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Burndown</h1>
        <p className="text-sm text-muted-foreground">
          Parent-level burndown and burnup tracking with late-risk flags.
        </p>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No burndown groups yet.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.parent.id} className="rounded-md border border-border p-3">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{g.parent.title}</h3>
                <span className="rounded bg-muted px-1.5 text-xs">
                  Expected {g.expected}%
                </span>
                <span className="rounded bg-muted px-1.5 text-xs">
                  Actual {g.actual}%
                </span>
                <span className="text-xs text-muted-foreground">
                  Due {new Date(g.parent.endDate).toLocaleDateString()}
                </span>
                {g.likelyLate ? (
                  <span className="rounded bg-red-500/15 px-2 py-0.5 text-xs text-red-600 dark:text-red-300">
                    At risk of delay
                  </span>
                ) : null}
              </div>

              <div className="mb-3 grid gap-3 lg:grid-cols-2">
                <BurndownPanel group={g} />
                <BurnupPanel group={g} />
              </div>

              <div className="overflow-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <Th>Child task</Th>
                      <Th>Progress</Th>
                      <Th>Owner</Th>
                      <Th>Effort</Th>
                      <Th>Open Issues</Th>
                      <Th>Due</Th>
                      <Th>Risk</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.children.map((c) => {
                      const late =
                        c.progress < 100 &&
                        new Date(c.endDate).getTime() < Date.now();
                      return (
                        <tr key={c.id} className="border-t border-border">
                          <Td>{c.title}</Td>
                          <Td>{c.progress}%</Td>
                          <Td>{c.assignee ?? "—"}</Td>
                          <Td>{c.effortHours ?? "—"}h</Td>
                          <Td>{c.openIssueCount ?? 0}</Td>
                          <Td>{new Date(c.endDate).toLocaleDateString()}</Td>
                          <Td>
                            {late ? (
                              <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-600 dark:text-red-300">
                                Late
                              </span>
                            ) : (
                              <span className="text-muted-foreground">On track</span>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function buildBurndownGroups(items: WorkItem[]) {
  const openIssuesByLinked = new Map<string, number>();
  for (const i of items) {
    if (i.type !== "ISSUE" || !i.parentId) continue;
    openIssuesByLinked.set(i.parentId, (openIssuesByLinked.get(i.parentId) ?? 0) + 1);
  }
  return items
    .filter((i) => i.type === "EPIC" || i.type === "TASK")
    .map((parent) => {
      const children = items
        .filter((c) => c.parentId === parent.id && c.type !== "ISSUE")
        .map((c) => ({ ...c, openIssueCount: openIssuesByLinked.get(c.id) ?? 0 }));
      const now = Date.now();
      const start = new Date(parent.startDate).getTime();
      const end = new Date(parent.endDate).getTime();
      const elapsed = Math.max(0, now - start);
      const span = Math.max(1, end - start);
      const expected = Math.max(0, Math.min(100, Math.round((elapsed / span) * 100)));
      const weighted = children.length
        ? Math.round(
            children.reduce((acc, c) => {
              const dur = Math.max(
                1,
                new Date(c.endDate).getTime() - new Date(c.startDate).getTime(),
              );
              return acc + c.progress * dur;
            }, 0) /
              children.reduce(
                (acc, c) =>
                  acc +
                  Math.max(
                    1,
                    new Date(c.endDate).getTime() -
                      new Date(c.startDate).getTime(),
                  ),
                0,
              ),
          )
        : parent.progress;
      const openLinkedTotal = children.reduce((acc, c) => acc + (c.openIssueCount ?? 0), 0);
      const likelyLate =
        (weighted + 12 < expected && parent.progress < 100) || openLinkedTotal > 0;
      return { parent, children, expected, actual: weighted, likelyLate, openLinkedTotal };
    })
    .filter((g) => g.children.length > 0)
    .sort((a, b) => a.parent.title.localeCompare(b.parent.title));
}

function BurndownPanel({
  group,
}: {
  group: {
    parent: WorkItem;
    children: WorkItem[];
  };
}) {
  const width = 460;
  const height = 220;
  const pad = 28;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const tasks = [...group.children].sort((a, b) =>
    a.endDate.localeCompare(b.endDate),
  );
  const effort = tasks.map((t) => taskEffort(t));
  const total = Math.max(1, effort.reduce((a, b) => a + b, 0));
  const n = Math.max(1, tasks.length - 1);

  const ideal = tasks.map((_, i) => total - (total * i) / n);
  let remaining = total;
  const actual = tasks.map((t, i) => {
    remaining -= effort[i] * Math.max(0, Math.min(100, t.progress)) / 100;
    return Math.max(0, remaining);
  });

  const px = (i: number) => pad + (n === 0 ? 0 : (innerW * i) / n);
  const py = (v: number) => pad + (innerH * v) / total;
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"} ${px(i)} ${py(v)}`).join(" ");
  const gridY = [0, 20, 40, 60, 80, 100].map((p) => (total * p) / 100);

  return (
    <div className="rounded-md border border-border bg-[#f7f7fa] p-3">
      <div className="mb-2 text-center text-sm font-semibold text-[#6b3fa0]">
        Sprint Burndown Chart
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
        <rect x={0} y={0} width={width} height={height} fill="#f7f7fa" />
        {Array.from({ length: tasks.length }).map((_, i) => (
          <line
            key={`vx-${i}`}
            x1={px(i)}
            y1={pad}
            x2={px(i)}
            y2={height - pad}
            stroke="#d9d9e3"
            strokeDasharray="2 2"
          />
        ))}
        {gridY.map((v, i) => (
          <line
            key={`hy-${i}`}
            x1={pad}
            y1={py(v)}
            x2={width - pad}
            y2={py(v)}
            stroke="#d9d9e3"
            strokeDasharray="2 2"
          />
        ))}
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="#f59e0b" />
        <line
          x1={pad}
          y1={height - pad}
          x2={width - pad}
          y2={height - pad}
          stroke="#f59e0b"
        />
        <path
          d={path(ideal)}
          fill="none"
          stroke="#a566cc"
          strokeWidth={2.5}
          strokeDasharray="4 3"
        />
        <path d={path(actual)} fill="none" stroke="#6b3fa0" strokeWidth={2.5} />
        {actual.map((v, i) => (
          <circle key={`dot-${i}`} cx={px(i)} cy={py(v)} r={2.7} fill="#6b3fa0" />
        ))}
        <text
          x={10}
          y={height / 2}
          transform={`rotate(-90, 10, ${height / 2})`}
          fill="#8f5d00"
          fontSize="11"
        >
          Remaining Work (%)
        </text>
        <text x={width / 2 - 16} y={height - 6} fill="#8f5d00" fontSize="11">
          Time
        </text>
      </svg>
      <div className="mt-2 flex flex-wrap justify-end gap-3 text-xs">
        <span className="text-[#a566cc]">Ideal</span>
        <span className="text-[#6b3fa0]">Actual</span>
      </div>
    </div>
  );
}

function BurnupPanel({
  group,
}: {
  group: {
    parent: WorkItem;
    children: WorkItem[];
  };
}) {
  const width = 460;
  const height = 220;
  const pad = 28;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const tasks = [...group.children].sort((a, b) =>
    a.endDate.localeCompare(b.endDate),
  );
  const effort = tasks.map((t) => taskEffort(t));
  const total = Math.max(1, effort.reduce((a, b) => a + b, 0));
  const n = Math.max(1, tasks.length - 1);

  const scope = tasks.map((_, i) => {
    const extra = i > Math.floor(n * 0.45) ? Math.round(total * 0.12) : 0;
    return Math.min(total + extra, total * 1.2);
  });

  let done = 0;
  const doneSeries = tasks.map((t, i) => {
    done += effort[i] * Math.max(0, Math.min(100, t.progress)) / 100;
    return Math.min(done, total * 1.2);
  });
  const todoSeries = tasks.map((_, i) => Math.max(scope[i] - doneSeries[i], 0));
  const maxY = Math.max(...scope, ...todoSeries, ...doneSeries, total);

  const px = (i: number) => pad + (n === 0 ? 0 : (innerW * i) / n);
  const py = (v: number) => height - pad - (innerH * v) / maxY;
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"} ${px(i)} ${py(v)}`).join(" ");
  const gridY = [0, 20, 40, 60, 80, 100].map((p) => (maxY * p) / 100);

  return (
    <div className="rounded-md border border-border bg-[#f7f7fa] p-3">
      <div className="mb-2 text-center text-sm font-semibold text-[#6b3fa0]">
        Sprint Burnup Chart
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
        <rect x={0} y={0} width={width} height={height} fill="#f7f7fa" />
        {Array.from({ length: tasks.length }).map((_, i) => (
          <line
            key={`vx2-${i}`}
            x1={px(i)}
            y1={pad}
            x2={px(i)}
            y2={height - pad}
            stroke="#d9d9e3"
            strokeDasharray="2 2"
          />
        ))}
        {gridY.map((v, i) => (
          <line
            key={`hy2-${i}`}
            x1={pad}
            y1={py(v)}
            x2={width - pad}
            y2={py(v)}
            stroke="#d9d9e3"
            strokeDasharray="2 2"
          />
        ))}
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="#f59e0b" />
        <line
          x1={pad}
          y1={height - pad}
          x2={width - pad}
          y2={height - pad}
          stroke="#f59e0b"
        />
        <path d={path(scope)} fill="none" stroke="#f0e141" strokeWidth={2.5} />
        <path d={path(todoSeries)} fill="none" stroke="#53da4b" strokeWidth={2.5} />
        <path d={path(doneSeries)} fill="none" stroke="#ff6a89" strokeWidth={2.5} />
        <text
          x={10}
          y={height / 2}
          transform={`rotate(-90, 10, ${height / 2})`}
          fill="#8f5d00"
          fontSize="11"
        >
          Work Points
        </text>
        <text x={width / 2 - 16} y={height - 6} fill="#8f5d00" fontSize="11">
          Time
        </text>
      </svg>
      <div className="mt-2 flex flex-wrap justify-end gap-3 text-xs">
        <span className="text-[#f0e141]">Scope</span>
        <span className="text-[#53da4b]">To Do</span>
        <span className="text-[#ff6a89]">Done</span>
      </div>
    </div>
  );
}

function taskEffort(t: WorkItem) {
  if (typeof t.effortHours === "number" && Number.isFinite(t.effortHours)) {
    return Math.max(1, t.effortHours);
  }
  const ms = new Date(t.endDate).getTime() - new Date(t.startDate).getTime();
  const days = Math.max(1, Math.round(ms / 86_400_000));
  return days * 8;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left text-xs font-medium">{children}</th>;
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}
