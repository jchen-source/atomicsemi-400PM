import { prisma } from "@/lib/db";

// Best-effort bootstrap so local SQLite installs work without running
// `prisma db push` (which requires swapping the schema provider). In
// production Postgres the `Person` table is already created by Render's
// build-time `prisma db push`, so the CREATE TABLE IF NOT EXISTS is a
// no-op there. Errors are swallowed because we're intentionally loose.
let ensured: Promise<void> | null = null;

export function ensurePersonTable(): Promise<void> {
  if (ensured) return ensured;
  ensured = (async () => {
    const url = process.env.DATABASE_URL ?? "";
    const isSqlite = url.startsWith("file:");
    try {
      if (isSqlite) {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS "Person" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "name" TEXT NOT NULL UNIQUE,
            "role" TEXT,
            "active" INTEGER NOT NULL DEFAULT 1,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS "Person_active_idx" ON "Person"("active")`,
        );
      } else {
        await prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS "Person" (
            "id" TEXT NOT NULL,
            "name" TEXT NOT NULL,
            "role" TEXT,
            "active" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
          )
        `);
        await prisma.$executeRawUnsafe(
          `CREATE UNIQUE INDEX IF NOT EXISTS "Person_name_key" ON "Person"("name")`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS "Person_active_idx" ON "Person"("active")`,
        );
      }
    } catch {
      // If CREATE TABLE fails we can't do anything meaningful; let the
      // caller's query surface the real error.
    }
  })();
  return ensured;
}
