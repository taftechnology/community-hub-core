import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertRoutes } from "./gate.js";
import { loadOpsStatic, StaticRejected } from "./ops-static.js";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

describe("loadOpsStatic", () => {
  let tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-static-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("serves allowed files from top-level and assets/ with exact spec headers", async () => {
    const dir = makeTempDir();
    const assetsDir = path.join(dir, "assets");
    fs.mkdirSync(assetsDir);

    const indexBytes = Buffer.from(
      "<!doctype html><html><head><title>Ops</title></head></html>",
      "utf8",
    );
    const faviconBytes = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
    const jsBytes = Buffer.from("console.log('ops-bundle');", "utf8");
    const cssBytes = Buffer.from("body { background: #000; }", "utf8");

    fs.writeFileSync(path.join(dir, "index.html"), indexBytes);
    fs.writeFileSync(path.join(dir, "favicon.ico"), faviconBytes);
    fs.writeFileSync(path.join(assetsDir, "app-1a2b.js"), jsBytes);
    fs.writeFileSync(path.join(assetsDir, "app-1a2b.css"), cssBytes);

    const routes = loadOpsStatic(dir);

    expect(routes).toHaveLength(4);
    const patterns = routes.map((r) => r.pattern);
    expect(patterns).toContain("/");
    expect(patterns).toContain("/favicon.ico");
    expect(patterns).toContain("/assets/app-1a2b.js");
    expect(patterns).toContain("/assets/app-1a2b.css");

    for (const route of routes) {
      expect(route.method).toBe("GET");
      expect(route.surface).toBe("ops");
      expect(route.billing).toBe("exempt");
      expect(route.static).toBe(true);
    }

    // Pass assertRoutes
    expect(() => assertRoutes(routes)).not.toThrow();

    // Verify index.html handler (mapped to pattern '/')
    const rootRoute = routes.find((r) => r.pattern === "/");
    expect(rootRoute).toBeDefined();
    const rootRes = await rootRoute!.handle(new Request("https://ops.example.test/"), {
      billing: "exempt",
      pattern: "/",
    });
    expect(rootRes.status).toBe(200);
    expect(Buffer.from(await rootRes.arrayBuffer())).toEqual(indexBytes);
    expect(rootRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(rootRes.headers.get("content-length")).toBe(String(indexBytes.byteLength));
    expect(rootRes.headers.get("content-security-policy")).toBe(CSP);
    expect(rootRes.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(rootRes.headers.get("cache-control")).toBe("no-cache");

    // Verify favicon.ico handler
    const faviconRoute = routes.find((r) => r.pattern === "/favicon.ico");
    expect(faviconRoute).toBeDefined();
    const faviconRes = await faviconRoute!.handle(
      new Request("https://ops.example.test/favicon.ico"),
      {
        billing: "exempt",
        pattern: "/favicon.ico",
      },
    );
    expect(faviconRes.status).toBe(200);
    expect(Buffer.from(await faviconRes.arrayBuffer())).toEqual(faviconBytes);
    expect(faviconRes.headers.get("content-type")).toBe("image/x-icon");
    expect(faviconRes.headers.get("content-length")).toBe(String(faviconBytes.byteLength));
    expect(faviconRes.headers.get("content-security-policy")).toBe(CSP);
    expect(faviconRes.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(faviconRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    // Verify assets/app-1a2b.js handler
    const jsRoute = routes.find((r) => r.pattern === "/assets/app-1a2b.js");
    expect(jsRoute).toBeDefined();
    const jsRes = await jsRoute!.handle(
      new Request("https://ops.example.test/assets/app-1a2b.js"),
      {
        billing: "exempt",
        pattern: "/assets/app-1a2b.js",
      },
    );
    expect(jsRes.status).toBe(200);
    expect(Buffer.from(await jsRes.arrayBuffer())).toEqual(jsBytes);
    expect(jsRes.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(jsRes.headers.get("content-length")).toBe(String(jsBytes.byteLength));
    expect(jsRes.headers.get("content-security-policy")).toBe(CSP);
    expect(jsRes.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(jsRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    // Verify assets/app-1a2b.css handler
    const cssRoute = routes.find((r) => r.pattern === "/assets/app-1a2b.css");
    expect(cssRoute).toBeDefined();
    const cssRes = await cssRoute!.handle(
      new Request("https://ops.example.test/assets/app-1a2b.css"),
      {
        billing: "exempt",
        pattern: "/assets/app-1a2b.css",
      },
    );
    expect(cssRes.status).toBe(200);
    expect(Buffer.from(await cssRes.arrayBuffer())).toEqual(cssBytes);
    expect(cssRes.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(cssRes.headers.get("content-length")).toBe(String(cssBytes.byteLength));
    expect(cssRes.headers.get("content-security-policy")).toBe(CSP);
    expect(cssRes.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(cssRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("does not register disallowed files, dotfiles, nested directories, or /index.html", () => {
    const dir = makeTempDir();
    const assetsDir = path.join(dir, "assets");
    fs.mkdirSync(assetsDir);
    const nestedDir = path.join(assetsDir, "nested");
    fs.mkdirSync(nestedDir);

    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
    fs.writeFileSync(path.join(dir, ".secret.js"), "const secret = 1;");
    fs.writeFileSync(path.join(assetsDir, ".secret.js"), "const secret = 2;");
    fs.writeFileSync(path.join(nestedDir, "x.js"), "const nested = 3;");
    fs.writeFileSync(path.join(dir, "notes.txt"), "some notes");
    fs.writeFileSync(path.join(dir, "APP.JS"), "upper case js");

    const routes = loadOpsStatic(dir);
    const patterns = routes.map((r) => r.pattern);

    expect(patterns).toContain("/");
    expect(patterns).not.toContain("/index.html");
    expect(patterns.some((p) => p.includes(".secret"))).toBe(false);
    expect(patterns.some((p) => p.includes("nested"))).toBe(false);
    expect(patterns.some((p) => p.includes("x.js"))).toBe(false);
    expect(patterns.some((p) => p.includes("notes.txt"))).toBe(false);
    expect(patterns.some((p) => p.includes("APP.JS"))).toBe(false);
    expect(routes).toHaveLength(1);
  });

  it("skips file symlinks when created", (ctx) => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
    const targetFile = path.join(dir, "target.js");
    fs.writeFileSync(targetFile, "console.log('target');");
    const symlinkFile = path.join(dir, "symlinked.js");

    try {
      fs.symlinkSync(targetFile, symlinkFile, "file");
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if (code === "EPERM" || code === "EACCES") {
        ctx.skip();
        return;
      }
      throw error;
    }

    const routes = loadOpsStatic(dir);
    const patterns = routes.map((r) => r.pattern);
    expect(patterns).toContain("/");
    expect(patterns).toContain("/target.js");
    expect(patterns).not.toContain("/symlinked.js");
  });

  it("does not serve an assets directory that is a junction", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");

    const externalAssetsDir = makeTempDir();
    fs.writeFileSync(path.join(externalAssetsDir, "external-bundle.js"), "console.log('ext');");

    const junctionLink = path.join(dir, "assets");
    fs.symlinkSync(externalAssetsDir, junctionLink, "junction");

    const routes = loadOpsStatic(dir);
    const patterns = routes.map((r) => r.pattern);
    expect(patterns).toContain("/");
    expect(patterns.some((p) => p.startsWith("/assets"))).toBe(false);
  });

  it("throws StaticRejected with code 'static' on missing directory", () => {
    const missing = path.join(os.tmpdir(), `missing-dir-${Date.now()}`);
    expect(() => loadOpsStatic(missing)).toThrow(StaticRejected);
    try {
      loadOpsStatic(missing);
    } catch (err) {
      expect(err).toBeInstanceOf(StaticRejected);
      expect((err as StaticRejected).code).toBe("static");
      expect((err as StaticRejected).name).toBe("StaticRejected");
    }
  });

  it("throws StaticRejected when index.html is missing", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "favicon.ico"), "icon");
    expect(() => loadOpsStatic(dir)).toThrow(StaticRejected);
  });

  it("throws StaticRejected when served files exceed 5 MiB (5 MiB + 1 byte), but allows 5 MiB exactly and ignores skipped files", () => {
    const dir = makeTempDir();
    const assetsDir = path.join(dir, "assets");
    fs.mkdirSync(assetsDir);

    // 5 MiB = 5 * 1024 * 1024 = 5242880 bytes
    const fiveMiB = 5 * 1024 * 1024;
    fs.writeFileSync(path.join(dir, "index.html"), Buffer.alloc(1));
    fs.writeFileSync(path.join(assetsDir, "app.js"), Buffer.alloc(fiveMiB - 1));

    // Exactly 5 MiB: 1 + 5242879 = 5242880 bytes -> must succeed
    expect(() => loadOpsStatic(dir)).not.toThrow();

    // Add a 6 MiB skipped file (.txt) -> still must succeed because skipped files do not count
    fs.writeFileSync(path.join(dir, "big-notes.txt"), Buffer.alloc(6 * 1024 * 1024));
    expect(() => loadOpsStatic(dir)).not.toThrow();

    // Now make served files 5 MiB + 1 byte
    fs.writeFileSync(path.join(assetsDir, "app.js"), Buffer.alloc(fiveMiB));
    // Total served = 1 + 5242880 = 5242881 bytes -> must throw
    expect(() => loadOpsStatic(dir)).toThrow(StaticRejected);
  });
});
