import { execFileSync, spawnSync } from "node:child_process";
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

describe.skipIf(process.env.RUN_IMAGE_TESTS !== "1")("regional service image", () => {
  it("matches the ingress contract and drains an unfinished header on SIGTERM", async () => {
    ensureImage();
    const inspected = JSON.parse(docker(["inspect", image])) as Array<{
      Config: {
        User: string;
        Entrypoint: string[];
        Env: string[] | null;
        Volumes: Record<string, unknown> | null;
        Healthcheck?: { Test: string[] };
      };
    }>;
    const config = inspected[0]?.Config;
    expect(config?.User).toBe("node");
    expect(config?.Entrypoint).toEqual(["node", "/app/index.js"]);
    expect(config?.Volumes).toHaveProperty("/tmp");
    const health = config?.Healthcheck?.Test ?? [];
    expect(health[0]).toBe("CMD");
    expect(health[1]).toBe("node");
    expect(health.join(" ")).not.toContain("sh");
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
          'import { KEEP_ALIVE_TIMEOUT_MS, HEADERS_TIMEOUT_MS } from "/app/server.js"; process.exit(KEEP_ALIVE_TIMEOUT_MS === 65000 && HEADERS_TIMEOUT_MS === 66000 ? 0 : 1);',
        ],
        { encoding: "utf8" },
      );
      expect(limits.status, limits.stderr).toBe(0);
    } finally {
      spawnSync("docker", ["rm", "-f", first.id]);
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

    const probe = spawnSync(
      "docker",
      ["run", "--rm", "--entrypoint", "node", image, "/app/probe.js"],
      { encoding: "utf8" },
    );
    expect(probe.status).toBe(1);
    expect(probe.stdout).toBe("fail\n");
    expect(probe.stderr).toBe("env\n");
  }, 600_000);
});
