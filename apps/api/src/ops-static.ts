import fs from "node:fs";
import path from "node:path";

import type { GateRoute } from "./gate.js";

export class StaticRejected extends Error {
  readonly code = "static" as const;

  constructor() {
    super("static");
    this.name = "StaticRejected";
  }
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(STATIC_CONTENT_TYPES));

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const MAX_STATIC_BYTES = 5 * 1024 * 1024;

function createStaticRoute(
  pattern: string,
  bytes: Buffer,
  contentType: string,
  cacheControl: string,
): GateRoute {
  return {
    method: "GET",
    pattern,
    surface: "ops",
    billing: "exempt",
    static: true,
    handle: () =>
      new Response(bytes, {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(bytes.byteLength),
          "content-security-policy": CSP,
          "cross-origin-opener-policy": "same-origin",
          "cache-control": cacheControl,
        },
      }),
  };
}

export function loadOpsStatic(dir: string): GateRoute[] {
  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(dir);
  } catch {
    throw new StaticRejected();
  }

  if (!dirStat.isDirectory()) {
    throw new StaticRejected();
  }

  let topEntries: string[];
  try {
    topEntries = fs.readdirSync(dir);
  } catch {
    throw new StaticRejected();
  }

  let hasIndexHtml = false;
  let totalBytes = 0;
  const routes: GateRoute[] = [];

  for (const entry of topEntries) {
    if (entry.startsWith(".")) {
      continue;
    }
    if (entry === "assets") {
      continue;
    }

    const fullPath = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      throw new StaticRejected();
    }

    if (stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }

    const ext = path.extname(entry);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      continue;
    }

    if (entry === "index.html") {
      hasIndexHtml = true;
      const bytes = fs.readFileSync(fullPath);
      totalBytes += bytes.byteLength;
      routes.push(createStaticRoute("/", bytes, STATIC_CONTENT_TYPES[ext]!, "no-cache"));
      continue;
    }

    const bytes = fs.readFileSync(fullPath);
    totalBytes += bytes.byteLength;
    routes.push(
      createStaticRoute(
        `/${entry}`,
        bytes,
        STATIC_CONTENT_TYPES[ext]!,
        "public, max-age=31536000, immutable",
      ),
    );
  }

  if (!hasIndexHtml) {
    throw new StaticRejected();
  }

  const assetsPath = path.join(dir, "assets");
  let assetsStat: fs.Stats | undefined;
  try {
    assetsStat = fs.lstatSync(assetsPath);
  } catch (error: unknown) {
    if ((error as { code?: string })?.code !== "ENOENT") {
      throw new StaticRejected();
    }
  }

  if (assetsStat !== undefined && !assetsStat.isSymbolicLink() && assetsStat.isDirectory()) {
    let assetEntries: string[];
    try {
      assetEntries = fs.readdirSync(assetsPath);
    } catch {
      throw new StaticRejected();
    }

    for (const entry of assetEntries) {
      if (entry.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(assetsPath, entry);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        throw new StaticRejected();
      }

      if (stat.isSymbolicLink() || !stat.isFile()) {
        continue;
      }

      const ext = path.extname(entry);
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        continue;
      }

      const bytes = fs.readFileSync(fullPath);
      totalBytes += bytes.byteLength;
      routes.push(
        createStaticRoute(
          `/assets/${entry}`,
          bytes,
          STATIC_CONTENT_TYPES[ext]!,
          "public, max-age=31536000, immutable",
        ),
      );
    }
  }

  if (totalBytes > MAX_STATIC_BYTES) {
    throw new StaticRejected();
  }

  return routes;
}
