# PM Gantt — Notion-integrated project management

A solo-use project management app with a SVAR Gantt chart (dependencies that
auto-adjust, editable progress bars), a one-time Notion importer with a manual
re-sync that never overwrites your local edits, and a one-click Render deploy
behind HTTP basic auth.

## Features

- Gantt chart with **drag-to-reschedule**, **drag-to-link**, and **inline
  progress editing** (SVAR `@svar-ui/react-gantt`, MIT).
- **Finish-to-Start, Start-to-Start, Finish-to-Finish, Start-to-Finish**
  dependencies with **lag days**. Moving a predecessor auto-pushes successors
  forward.
- **Progress roll-up**: parent epic/task progress is the duration-weighted
  average of its children — updates as you tick off issues.
- Three task types: **EPIC → TASK → ISSUE**. Issues are tied to a parent via a
  `parentId` chain, so deep work lives under the right roadmap item.
- **Notion import**: pulls a roadmap DB and an issues DB, wires parent
  relations into the hierarchy. Re-sync is additive — it only inserts new
  Notion pages, it never touches rows you already have.
- **Issues list view** grouped by parent, with inline status/progress editing,
  full-text filter, parent filter, and sort.
- **Basic-auth** gate for deployments (off locally, on in prod via
  `APP_PASSWORD`).

---

## Prerequisites

Install these once on your Mac:

```bash
# Homebrew (skip if you have it): https://brew.sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install node                # Node 20+
brew install --cask docker       # Docker Desktop (for local Postgres)
open /Applications/Docker.app    # start Docker Desktop once
```

## Local development

```bash
cd ~/notion-gantt-pm

# 1. Install dependencies
npm install

# 2. Start local Postgres (Docker)
npm run db:up

# 3. Run the initial migration + seed sample data
npm run db:migrate           # accept the suggested name, e.g. "init"
npm run db:seed

# 4. Start the dev server
npm run dev
```

Open <http://localhost:3000>. You should see three sample epics/tasks with
dependencies already wired up. Drag a bar around — successors should move too,
and the parent epic's progress should reflect its children.

Useful scripts:

- `npm run db:studio` — open Prisma Studio to inspect the DB.
- `npm run db:down` — stop the Postgres container.

---

## Connect to Notion

Your Notion workspace should contain:

1. A **roadmap database** (one row per epic/major initiative).
2. An **issues database** with a **relation property** pointing at the roadmap
   DB, so each issue knows its parent.

### Step 1 — create an integration

1. Go to <https://www.notion.so/my-integrations> and create a new **internal
   integration**. Copy the **Internal Integration Secret** (starts with
   `ntn_`).
2. Open each database in Notion → top-right `···` menu → **Connections** →
   add your integration. Do this for **both** the roadmap DB and the issues
   DB, otherwise the API returns 404.
3. Grab each database ID from its URL. In
   `https://www.notion.so/<workspace>/<name>-32hexchars?...`, the 32-hex chunk
   is the ID.

### Step 2 — configure the app

Open <http://localhost:3000/settings> and fill in:

- **Integration token**, **roadmap DB ID**, **issues DB ID**.
- **Property mappings**: the names of the properties in each Notion DB. The
  defaults assume `Name / Status / Start / End / Progress / Assignee / Tags`
  and a `Roadmap` relation on the issues DB; change them to match yours.

Click **Save settings**, then **Run sync from Notion**. The Sync history
table will show how many rows were imported, skipped (already present), or
failed.

### Re-sync behavior

Re-running the sync is **additive only** — if a row already exists in the
local DB (matched by Notion page ID), it's skipped and your local edits are
preserved. New Notion pages get inserted and, for issues, linked to their
parent epic via the relation property.

---

## Deploy to Render

The repository includes a `render.yaml` blueprint that provisions both a web
service and a managed Postgres in one step.

1. Push the repo to GitHub.
2. In the Render dashboard, **New → Blueprint**, point at your repo.
3. Render will:
   - create a Postgres database (`pm-gantt-db`),
   - set `DATABASE_URL` on the web service automatically,
   - generate a random `APP_PASSWORD` (view it in the service's Environment
     tab),
   - leave `NOTION_TOKEN`, `NOTION_ROADMAP_DB_ID`, `NOTION_ISSUES_DB_ID`
     blank. You can either set them as env vars (useful for CI-style syncs)
     or just configure them later via the `/settings` page, which stores them
     in the DB.
4. The build command is `npm ci && npm run build` which also runs
   `prisma migrate deploy`, so migrations are applied on every deploy.

Once live, hit your Render URL. The browser will prompt for basic auth:
username `admin`, password from `APP_PASSWORD`. Go to `/settings`, paste your
Notion credentials, and run the sync.

---

## Project structure

```
app/
  api/
    tasks/           - CRUD for tasks, runs scheduler on date/progress changes
    dependencies/    - CRUD for dependency edges, runs scheduler on insert/update
    sync/notion/     - POST to run import, GET for sync history
    settings/        - GET/PATCH for Notion config (token is redacted on GET)
  page.tsx           - Gantt chart
  issues/            - Grouped issue list with inline editing
  settings/          - Notion config + "Run sync" button
lib/
  db.ts              - Prisma singleton
  schedule.ts        - rescheduleDownstream + rollupProgress (pure-ish)
  settings.ts        - read/write Notion sync config (DB-backed)
  notion/            - Notion client, property mapping, import runner
  utils.ts           - cn(), date helpers
prisma/
  schema.prisma      - Task, Dependency, SyncLog, Setting + enums
  seed.ts            - tiny sample dataset
middleware.ts        - basic-auth gate when APP_PASSWORD is set
docker-compose.yml   - local Postgres 16
render.yaml          - Render blueprint (web service + managed Postgres)
```

## Extending

- **More task properties**: add columns to `Task` in `prisma/schema.prisma`,
  migrate, then surface them in `lib/validation.ts` and the UI.
- **More dependency types**: already modeled (`FS/SS/FF/SF` + lag). The Gantt
  lets users pick the type via the link's context menu.
- **Richer Notion sync**: `lib/notion/mapping.ts` contains the per-property
  readers. Add a reader for any Notion property type and wire it through
  `toTaskData` in `lib/notion/import.ts`.
- **Multi-user / auth**: swap `middleware.ts` for NextAuth/Auth.js; the data
  model already has `assignee` and can easily grow a `User` table.

## Licenses

- `@svar-ui/react-gantt` — MIT.
- `@notionhq/client` — MIT.
- `@prisma/client` — Apache 2.0.
