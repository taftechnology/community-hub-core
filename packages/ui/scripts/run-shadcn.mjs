import { existsSync, writeFileSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchCss = path.join(packageRoot, ".shadcn.css");

if (!existsSync(scratchCss)) {
  writeFileSync(scratchCss, '@import "tailwindcss";\n', "utf8");
}

const result = spawnSync(
  "pnpm",
  ["dlx", "shadcn@4.21.0", ...process.argv.slice(2)],
  { cwd: packageRoot, stdio: "inherit" },
);

process.exit(result.status ?? 1);
