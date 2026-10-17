import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const image = "community-hub-api:local";

const runEnv = [
  "PORT=8080",
  "AWS_REGION=ap-southeast-2",
  "NODE_ENV=production",
  "COMMUNITY_HUB_ENVIRONMENT=staging",
  "API_HOSTNAME=au.api.example.test",
  "AUTH_HOSTNAME=auth.au.example.test",
  "WEBHOOKS_HOSTNAME=webhooks.au.example.test",
  "OPS_HOSTNAME=ops.au.example.test",
  "PGHOST=db.example.test",
  "PGPORT=5432",
  "PGDATABASE=communityhub",
  "PGUSER_APP=synthetic",
  "PGUSER_IDENTITY=synthetic",
  "PGUSER_PLATFORM=synthetic",
  "PGPASSWORD_APP=synthetic",
  "PGPASSWORD_IDENTITY=synthetic",
  "PGPASSWORD_PLATFORM=synthetic",
  "APP_SECRET_ARN=arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:synthetic",
  "IDENTITY_SECRET_ARN=arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:synthetic",
  "PLATFORM_SECRET_ARN=arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:synthetic",
  "ENVELOPE_KEY_ARN=arn:aws:kms:ap-southeast-2:123456789012:key/mrk-0123456789abcdef0123456789abcdef",
];

function docker(args: string[], allowFailure = false): string {
  const result = spawnSync("docker", args, { encoding: "utf8", cwd: root });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `docker ${args[0]} failed`);
  }
  return result.stdout;
}

function ensureImage(): void {
  const inspect = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" });
  if (inspect.status === 0) {
    return;
  }
  execFileSync(
    "docker",
    ["build", "--platform", "linux/arm64", "-f", "apps/api/Dockerfile", "-t", image, "."],
    { cwd: root, stdio: "inherit" },
  );
}

function startContainer(): { id: string; port: number } {
  const id = docker([
    "run",
    "-d",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--user",
    "node",
    "-p",
    "127.0.0.1::8080",
    ...runEnv.flatMap((entry) => ["-e", entry]),
    image,
  ]).trim();
  const mapped = docker(["port", id, "8080"]).trim();
  const port = Number(mapped.split(":").at(-1));
  return { id, port };
}

async function waitForHealth(id: string): Promise<void> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 20_000) {
    const result = spawnSync(
      "docker",
      [
        "exec",
        id,
        "node",
        "-e",
        "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      { encoding: "utf8" },
    );
    if (result.status === 0) {
      return;
    }
    last = result.stderr || `exit ${result.status}`;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`health did not become ready: ${last}`);
}

function loopbackBody(id: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    "docker",
    [
      "exec",
      id,
      "node",
      "--input-type=module",
      "-e",
      "const response = await fetch('http://127.0.0.1:8080/health'); const text = await response.text(); process.stdout.write(String(response.status) + '\\n' + text);",
    ],
    { encoding: "utf8" },
  );
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe("service image build", () => {
  it("builds policy, tenancy, people, and access before the service", () => {
    const dockerfile = readFileSync(path.join(root, "apps/api/Dockerfile"), "utf8");
    const build = dockerfile
      .split("\n")
      .find((line) => line.includes("pnpm --filter") && line.trimEnd().endsWith(" build"));
    expect(build).toBeDefined();
    const filters = [...(build?.matchAll(/--filter\s+(\S+)/g) ?? [])].map((match) => match[1]);
    for (const name of [
      "@community-hub/policy",
      "@community-hub/tenancy",
      "@community-hub/people",
      "@community-hub/access",
      "@community-hub/entitlements-eval",
      "@community-hub/entitlements",
      "@community-hub/billing",
    ]) {
      expect(filters, name).toContain(name);
    }
  });
});

describe.skipIf(process.env.RUN_IMAGE_TESTS !== "1")("regional service image", () => {
  it("ships exactly the distroless package set", () => {
    ensureImage();
    const listed = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        image,
        "node",
        "--input-type=module",
        "-e",
        [
          'import { readdirSync } from "node:fs";',
          'const names = readdirSync("/var/lib/dpkg/status.d")',
          '.filter((name) => !name.endsWith(".md5sums"))',
          ".sort();",
          "process.stdout.write(JSON.stringify(names));",
        ].join(" "),
      ],
      { encoding: "utf8" },
    );
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      "base-files",
      "ca-certificates",
      "gcc-14-base",
      "libc6",
      "libgcc-s1",
      "libgomp1",
      "libssl3t64",
      "libstdc++6",
      "libzstd1",
      "media-types",
      "netbase",
      "tzdata",
      "tzdata-legacy",
      "zlib1g",
    ]);
  }, 600_000);

  it("lets node write /tmp and records its owner and mode", () => {
    ensureImage();
    const write = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "node",
        image,
        "node",
        "--input-type=module",
        "-e",
        'import { writeFileSync } from "node:fs"; writeFileSync("/tmp/write-probe", "ok");',
      ],
      { encoding: "utf8" },
    );
    expect(write.status, `${write.stdout}${write.stderr}`).toBe(0);
    const stat = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "node",
        image,
        "node",
        "--input-type=module",
        "-e",
        'import { statSync } from "node:fs"; const s = statSync("/tmp"); process.stdout.write(JSON.stringify({ uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 }));',
      ],
      { encoding: "utf8" },
    );
    expect(stat.status, stat.stderr).toBe(0);
    expect(JSON.parse(stat.stdout)).toEqual({ uid: 1000, gid: 1000, mode: 0o1777 });
  }, 600_000);

  it("matches the ingress contract and drains an unfinished header on SIGTERM", async () => {
    ensureImage();
    const inspected = JSON.parse(docker(["inspect", image])) as Array<{
      Config: {
        User: string;
        Entrypoint: string[] | null;
        Cmd: string[] | null;
        Env: string[] | null;
        Volumes: Record<string, unknown> | null;
        Healthcheck?: { Test: string[] };
      };
    }>;
    const config = inspected[0]?.Config;
    expect(config?.User).toBe("node");
    expect(config?.Entrypoint ?? []).toEqual([]);
    expect(config?.Cmd).toEqual(["node", "/app/index.js"]);
    expect(config?.Volumes).toHaveProperty("/tmp");
    const health = config?.Healthcheck?.Test ?? [];
    expect(health[0]).toBe("CMD");
    expect(health[1]).toBe("node");
    expect(health.join(" ")).not.toContain("sh");
    const listed = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        [
          'import { readdirSync, statSync } from "node:fs";',
          'import { join } from "node:path";',
          "const files = [];",
          "const dirs = [];",
          "function walk(dir) {",
          "  for (const name of readdirSync(dir)) {",
          "    const path = join(dir, name);",
          '    const rel = path.slice("/app".length);',
          '    if (rel === "/node_modules" || rel.startsWith("/node_modules/")) continue;',
          "    if (statSync(path).isDirectory()) { dirs.push(rel); walk(path); }",
          "    else files.push(rel);",
          "  }",
          "}",
          'walk("/app");',
          "process.stdout.write(JSON.stringify({ files, dirs }));",
        ].join(" "),
      ],
      { encoding: "utf8" },
    );
    expect(listed.status, listed.stderr).toBe(0);
    const app = JSON.parse(listed.stdout) as { files: string[]; dirs: string[] };
    expect(app.files.filter((file) => file.endsWith(".ts"))).toEqual([]);
    expect([...app.files, ...app.dirs].some((entry) => entry.includes(".turbo"))).toBe(false);
    expect(app.files).not.toContain("/Dockerfile");
    expect(
      app.files.filter((file) => file.includes("tsconfig") || file.includes("vitest.config")),
    ).toEqual([]);
    expect(app.dirs).not.toContain("/dist");
    expect(app.files.filter((file) => file.endsWith(".pem"))).toEqual([
      "/certs/rds-ap-southeast-2-bundle.pem",
    ]);
    const packages = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        [
          'import { readdirSync, realpathSync, statSync } from "node:fs";',
          'import { join } from "node:path";',
          "const files = [];",
          "const dirs = [];",
          "const seen = new Set();",
          "function walk(dir) {",
          "  let real;",
          "  try { real = realpathSync(dir); } catch { return; }",
          "  if (seen.has(real)) return;",
          "  seen.add(real);",
          "  for (const name of readdirSync(real)) {",
          '    if (name === "node_modules" || name === ".pnpm") continue;',
          "    const path = join(real, name);",
          "    let st;",
          "    try { st = statSync(path); } catch { continue; }",
          "    if (st.isDirectory()) { dirs.push(path); walk(path); }",
          "    else files.push(path);",
          "  }",
          "}",
          'const root = "/app/node_modules/@community-hub";',
          "for (const name of readdirSync(root)) walk(join(root, name));",
          "process.stdout.write(JSON.stringify({ files, dirs }));",
        ].join(" "),
      ],
      { encoding: "utf8" },
    );
    expect(packages.status, packages.stderr).toBe(0);
    const workspace = JSON.parse(packages.stdout) as { files: string[]; dirs: string[] };
    expect(
      workspace.files.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts")),
    ).toEqual([]);
    expect(workspace.files.filter((file) => file.includes(".test."))).toEqual([]);
    expect(
      workspace.files.filter((file) => {
        const base = file.split("/").pop() ?? "";
        return base.startsWith("tsconfig") || base.startsWith("vitest.config");
      }),
    ).toEqual([]);
    expect(workspace.dirs.filter((dir) => dir.endsWith("/test"))).toEqual([]);
    expect(workspace.files.some((file) => file.endsWith("/sql/bootstrap.sql"))).toBe(true);
    expect(health.join(" ")).not.toContain("bash");
    const names = (config?.Env ?? []).map((entry) => entry.split("=")[0]);
    for (const forbidden of [
      "PGHOST",
      "PGPASSWORD_APP",
      "ENVELOPE_KEY_ARN",
      "API_HOSTNAME",
      "TURNSTILE_SECRET",
      "NODE_ENV",
    ]) {
      expect(names).not.toContain(forbidden);
    }

    const first = startContainer();
    try {
      await waitForHealth(first.id);
      const body = loopbackBody(first.id);
      expect(body.status, body.stderr).toBe(0);
      expect(body.stdout).toBe('200\n{"ok":true}');
      const traced = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(first.port, "127.0.0.1");
        let received = "";
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("TRACE produced no response"));
        }, 5_000);
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString();
          if (received.includes("\r\n\r\n")) {
            clearTimeout(timer);
            socket.end();
            resolve(received);
          }
        });
        socket.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.write("TRACE /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      });
      expect(traced.startsWith("HTTP/1.1 ")).toBe(true);
      expect(traced.split("\r\n\r\n")[1] ?? "").toBe("");
      const afterTrace = loopbackBody(first.id);
      expect(afterTrace.status, afterTrace.stderr).toBe(0);
      expect(afterTrace.stdout).toBe('200\n{"ok":true}');
      const healthExec = spawnSync(
        "docker",
        [
          "exec",
          first.id,
          "node",
          "-e",
          "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        { encoding: "utf8" },
      );
      expect(healthExec.status).toBe(0);
      const limits = spawnSync(
        "docker",
        [
          "exec",
          first.id,
          "node",
          "--input-type=module",
          "-e",
          'import { KEEP_ALIVE_TIMEOUT_MS, HEADERS_TIMEOUT_MS } from "/app/server.js"; process.exit(KEEP_ALIVE_TIMEOUT_MS === 65000 && HEADERS_TIMEOUT_MS === 30000 ? 0 : 1);',
        ],
        { encoding: "utf8" },
      );
      expect(limits.status, limits.stderr).toBe(0);
    } finally {
      spawnSync("docker", ["rm", "-f", first.id]);
    }

    const idle = startContainer();
    try {
      await waitForHealth(idle.id);
      const started = Date.now();
      docker(["kill", "--signal=TERM", idle.id]);
      const waited = spawnSync("docker", ["wait", idle.id], { encoding: "utf8" });
      expect(waited.stdout.trim()).toBe("0");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      spawnSync("docker", ["rm", "-f", idle.id]);
    }

    const second = startContainer();
    try {
      await waitForHealth(second.id);
      const held = await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect(second.port, "127.0.0.1");
        socket.once("error", reject);
        socket.once("connect", () => resolve(socket));
      });
      held.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      const finished = loopbackBody(second.id);
      expect(finished.status, finished.stderr).toBe(0);
      expect(finished.stdout).toBe('200\n{"ok":true}');

      const started = Date.now();
      docker(["kill", "--signal=TERM", second.id]);
      const waited = spawnSync("docker", ["wait", second.id], { encoding: "utf8" });
      const elapsed = Date.now() - started;
      expect(waited.stdout.trim()).toBe("0");
      expect(elapsed).toBeGreaterThan(20_000);
      expect(elapsed).toBeLessThan(30_000);
      held.destroy();
    } finally {
      spawnSync("docker", ["rm", "-f", second.id]);
    }

    const probe = spawnSync("docker", ["run", "--rm", image, "node", "/app/probe.js"], {
      encoding: "utf8",
    });
    expect(probe.status).toBe(1);
    expect(probe.stdout).toBe("fail\n");
    expect(probe.stderr).toBe("env\n");

    const shipped = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        image,
        "node",
        "--input-type=module",
        "-e",
        'import { existsSync } from "node:fs"; process.exit(existsSync("/app/db-bootstrap.js") && existsSync("/app/node_modules/@community-hub/db/sql/bootstrap.sql") ? 0 : 1);',
      ],
      { encoding: "utf8" },
    );
    expect(shipped.status, shipped.stderr).toBe(0);
  }, 600_000);

  it("ships provision-owner", () => {
    ensureImage();
    const shipped = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        image,
        "node",
        "--input-type=module",
        "-e",
        'import { existsSync } from "node:fs"; process.exit(existsSync("/app/provision-owner.js") ? 0 : 1);',
      ],
      { encoding: "utf8" },
    );
    expect(shipped.status, shipped.stderr).toBe(0);
  }, 600_000);

  it("ships db-migrate and the product migrations", () => {
    ensureImage();
    const listed = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        image,
        "node",
        "--input-type=module",
        "-e",
        [
          'import { existsSync, readFileSync } from "node:fs";',
          'const drizzle = "/app/node_modules/@community-hub/db/drizzle";',
          'const journal = JSON.parse(readFileSync(drizzle + "/meta/_journal.json", "utf8"));',
          "const tags = journal.entries.map((entry) => entry.tag);",
          'const missing = tags.filter((tag) => !existsSync(drizzle + "/" + tag + ".sql"));',
          'if (!existsSync("/app/db-migrate.js") || missing.length > 0) process.exit(1);',
          "process.stdout.write(JSON.stringify(tags));",
        ].join(" "),
      ],
      { encoding: "utf8" },
    );
    expect(listed.status, listed.stderr).toBe(0);
    const expected = (
      JSON.parse(
        readFileSync(path.join(root, "packages/db/drizzle/meta/_journal.json"), "utf8"),
      ) as { entries: { tag: string }[] }
    ).entries.map((entry) => entry.tag);
    expect(JSON.parse(listed.stdout)).toEqual(expected);
  }, 600_000);

  it("runs db-migrate with no environment", () => {
    ensureImage();
    const result = spawnSync("docker", ["run", "--rm", image, "node", "/app/db-migrate.js"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("env\n");
  }, 600_000);
});
