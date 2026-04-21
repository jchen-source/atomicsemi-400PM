import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "PM Gantt",
  description: "Notion-integrated PM app with Gantt chart",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        <div className="app-shell">
          <aside className="app-sidebar">
            <div className="app-sidebar-card p-3">
              <p className="text-sm font-semibold">PM Gantt</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Notion-integrated planning workspace
              </p>
            </div>

            <div className="mt-4">
              <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Main Menu
              </p>
              <nav className="space-y-1 text-sm">
                <SideLink href="/" label="Gantt Chart" />
                <SideLink href="/tasks" label="Tasks" />
                <SideLink href="/people" label="Resource Matrix" />
                <SideLink href="/settings" label="Settings" />
                <SideLink href="/settings#notion" label="Notion Sync" />
              </nav>
            </div>

            <div className="mt-5">
              <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Incoming Deadline
              </p>
              <div className="app-sidebar-card space-y-2 p-3 text-xs text-muted-foreground">
                <p>Daily standup items</p>
                <p>Procurement blockers</p>
                <p>Upcoming workstream kickoffs</p>
              </div>
            </div>
          </aside>

          <div className="app-main">
            <header className="app-topbar">
              <div className="text-sm text-muted-foreground">
                My Pages / PM Gantt Workspace
              </div>
              <Link
                href="/settings#notion"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                <span aria-hidden>{"\u2B22"}</span>
                Connect Notion
              </Link>
            </header>
            <main className="app-page-frame">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}

function SideLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="block rounded-md px-2 py-1.5 text-muted-foreground hover:bg-white hover:text-foreground"
    >
      {label}
    </Link>
  );
}
