// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appRoot, "dist");

function listFiles(dir: string, base = ""): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...listFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      result.push(rel);
    }
  }
  return result;
}

describe("ops build", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["exec", "vite", "build"], {
      cwd: appRoot,
      stdio: "pipe",
      env: {
        ...process.env,
        CI: "1",
      },
    });
  }, 120000);

  it("builds exactly index.html, one hashed JS and one hashed CSS with no inline code", () => {
    const files = listFiles(dist);
    expect(files).toContain("index.html");
    expect(files).toHaveLength(3);

    const assetRegex = /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.(js|css)$/;
    const jsFiles = files.filter((f) => f.endsWith(".js") && assetRegex.test(f));
    const cssFiles = files.filter((f) => f.endsWith(".css") && assetRegex.test(f));

    expect(jsFiles).toHaveLength(1);
    expect(cssFiles).toHaveLength(1);

    let totalBytes = 0;
    for (const f of files) {
      const stat = fs.statSync(path.join(dist, f));
      totalBytes += stat.size;
    }
    expect(totalBytes).toBeLessThan(1024 * 1024);

    const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const match of scripts) {
      const attrs = match[1] ?? "";
      const srcMatch = /(?:^|\s)src="([^"]*)"/.exec(attrs);
      expect(srcMatch?.[1], attrs).toBeTruthy();
      expect(srcMatch?.[1]).not.toContain("://");
    }

    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle="/i);
    expect(html).not.toContain("data:");

    const cssContent = fs.readFileSync(path.join(dist, cssFiles[0]!), "utf8");
    expect(cssContent).not.toContain("url(");
    expect(cssContent).not.toContain("data:");
  });

  it("loadOpsStatic registers every built file", async () => {
    type StaticRoute = {
      pattern: string;
      billing?: string | undefined;
      handle: (
        req?: Request,
        ctx?: { billing?: string | undefined; pattern: string },
      ) => Response | Promise<Response>;
    };
    const opsStaticPath = path.resolve(appRoot, "../api/src/ops-static.ts");
    const { loadOpsStatic } = (await import(pathToFileURL(opsStaticPath).href)) as {
      loadOpsStatic: (dir: string) => StaticRoute[];
    };

    const files = listFiles(dist);
    const routes = loadOpsStatic(dist);

    const routePatterns = routes.map((r) => r.pattern).sort();
    const expectedPatterns = [
      "/",
      ...files.filter((f) => f !== "index.html").map((f) => "/" + f),
    ].sort();

    expect(routePatterns).toEqual(expectedPatterns);

    const expectedContentTypes: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
    };

    for (const route of routes) {
      const res = await route.handle(new Request("https://ops.example.test" + route.pattern), {
        billing: route.billing,
        pattern: route.pattern,
      });
      const ext = route.pattern === "/" ? ".html" : path.extname(route.pattern);
      expect(res.headers.get("content-type")).toBe(expectedContentTypes[ext]);
    }
  });
});
