import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

it("builds index.html with external scripts and no inline style", () => {
  execFileSync("pnpm", ["exec", "vite", "build"], {
    cwd: appRoot,
    stdio: "pipe",
    env: { ...process.env, CI: "1" },
  });
  const html = fs.readFileSync(path.join(appRoot, "dist/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  expect(scripts.length).toBeGreaterThan(0);
  for (const match of scripts) {
    const attrs = match[1] ?? "";
    const src = /(?:^|\s)src="([^"]*)"/.exec(attrs);
    expect(src?.[1], attrs).toBeTruthy();
    expect(src?.[1]).not.toContain("://");
  }
  expect(html).not.toMatch(/<style[\s>]/i);
  expect(html).not.toMatch(/\sstyle="/i);
}, 60000);
