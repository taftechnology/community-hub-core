import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

it("builds index.html with external scripts and no inline style", () => {
  execFileSync("pnpm", ["exec", "vite", "build"], {
    cwd: appRoot,
    stdio: "pipe",
    env: {
      ...process.env,
      CI: "1",
      VITE_API_ORIGIN: "https://au.api.example.test",
      VITE_AUTH_ORIGIN: "https://auth.au.example.test",
    },
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

  expect(html).toContain('lang="en-AU"');

  const assetsDir = path.join(appRoot, "dist/assets");
  const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const woff2Files = assets.filter((file) => file.endsWith(".woff2"));
  expect(woff2Files.length).toBeGreaterThan(0);

  const cssFiles = assets.filter((file) => file.endsWith(".css"));
  const uiFontsCss = path.resolve(appRoot, "../../packages/ui/src/fonts.css");
  const adminIndexCss = path.join(appRoot, "src/index.css");

  const allHtmlAndCss = [
    html,
    ...cssFiles.map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8")),
    fs.readFileSync(adminIndexCss, "utf8"),
    ...(fs.existsSync(uiFontsCss) ? [fs.readFileSync(uiFontsCss, "utf8")] : []),
  ];

  for (const content of allHtmlAndCss) {
    expect(content).not.toContain("fonts.googleapis.com");
    expect(content).not.toContain("fonts.gstatic.com");
    expect(content).not.toContain("data:font");
  }
}, 60000);
