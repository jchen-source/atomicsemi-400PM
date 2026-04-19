// SVAR @svar-ui/react-gantt v2.6.x ships a package.json whose "exports" map
// points the CJS entry at ./dist/index.cjs.js, but only ./dist/index.cjs
// actually exists. Next.js's webpack resolves via the CJS condition and
// fails with "Module not found". This script creates the missing alias file
// so the package resolves cleanly.
//
// Remove this shim when SVAR ships a fixed package.
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const base = join(
  here,
  "..",
  "node_modules",
  "@svar-ui",
  "react-gantt",
  "dist",
);

const src = join(base, "index.cjs");
const dest = join(base, "index.cjs.js");

if (existsSync(src) && !existsSync(dest)) {
  copyFileSync(src, dest);
  console.log("[fix-svar-gantt] created alias", dest);
}
