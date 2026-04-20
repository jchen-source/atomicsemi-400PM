#!/usr/bin/env node
/**
 * Render builds against Postgres; local dev uses SQLite. The committed
 * `prisma/schema.prisma` defaults to sqlite so `npm run dev` works out of
 * the box. This script rewrites the provider to `postgresql` so Render's
 * `prisma db push` / `prisma generate` target the managed Postgres.
 *
 * Idempotent: safe to run repeatedly.
 */
import fs from "node:fs";
import path from "node:path";

const schemaPath = path.join(process.cwd(), "prisma", "schema.prisma");
const text = fs.readFileSync(schemaPath, "utf8");

if (text.includes('provider = "postgresql"')) {
  console.log("[prepare-postgres-schema] already postgresql, skipping.");
  process.exit(0);
}

const next = text.replace(
  /provider\s*=\s*"sqlite"/,
  'provider = "postgresql"',
);
if (next === text) {
  console.error(
    "[prepare-postgres-schema] could not find sqlite provider to replace.",
  );
  process.exit(1);
}

fs.writeFileSync(schemaPath, next);
console.log("[prepare-postgres-schema] rewrote provider to postgresql.");
