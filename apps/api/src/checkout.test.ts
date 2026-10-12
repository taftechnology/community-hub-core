import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";

import { createCheckout, type Role } from "./checkout.js";
import { secretsManagerReader } from "./secrets.js";

const MARKER = "marker-secret-value";

type FakeSql = { end: ReturnType<typeof vi.fn> };

function denied(code: string): Error {
  return Object.assign(new Error("denied"), { code });
}

function harness(input?: {
  current?: string;
  previous?: string;
  currentError?: Error;
  previousError?: Error;
}) {
  const opened: Array<{ role: Role; password: string; sql: FakeSql }> = [];
  const logs: unknown[] = [];
  const readSecret = vi.fn(async (_arn: string, stage: "AWSCURRENT" | "AWSPREVIOUS") => {
    if (stage === "AWSCURRENT") {
      if (input?.currentError !== undefined) {
        throw input.currentError;
      }
      return input?.current ?? "current-secret";
    }
    if (input?.previousError !== undefined) {
      throw input.previousError;
    }
    return input?.previous ?? "previous-secret";
  });
  function open(role: Role) {
    return (password: string) => {
      const sql: FakeSql = { end: vi.fn(async () => undefined) };
      opened.push({ role, password, sql });
      return sql;
    };
  }
  const checkout = createCheckout({
    passwords: { app: "pw-app", identity: "pw-identity", platform: "pw-platform" },
    arns: { app: "arn-app", identity: "arn-identity", platform: "arn-platform" },
    open: { app: open("app"), identity: open("identity"), platform: open("platform") },
    readSecret,
    log: (message, fields) => {
      logs.push({ message, fields });
    },
  });
  return { checkout, opened, readSecret, logs };
}

describe("checkout", () => {
  it("opens one pool with the env password and runs the query", async () => {
    const { checkout, opened } = harness();
    const result = await checkout("identity", async (sql) => {
      expect(sql).toBe(opened[0]?.sql);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(opened.map((pool) => pool.password)).toEqual(["pw-identity"]);
  });

  it("re-reads both stages and retries once on a new pool when the current secret differs", async () => {
    const { checkout, opened, readSecret } = harness({
      current: "rotated-secret",
      previous: "older-secret",
    });
    let attempts = 0;
    const result = await checkout("app", async () => {
      attempts += 1;
      if (attempts === 1) {
        throw denied("28P01");
      }
      return "retried";
    });
    expect(result).toBe("retried");
    expect(attempts).toBe(2);
    expect(readSecret.mock.calls).toEqual([
      ["arn-app", "AWSCURRENT"],
      ["arn-app", "AWSPREVIOUS"],
    ]);
    expect(opened.map((pool) => pool.password)).toEqual(["pw-app", "rotated-secret"]);
    expect(opened[0]?.sql.end).not.toHaveBeenCalled();
    await checkout("app", async (sql) => {
      expect(sql).toBe(opened[1]?.sql);
    });
    expect(opened).toHaveLength(2);
  });

  it("uses the previous secret when only that stage differs", async () => {
    const { checkout, opened } = harness({ current: "pw-app", previous: "previous-secret" });
    let attempts = 0;
    await checkout("app", async () => {
      attempts += 1;
      if (attempts === 1) {
        throw denied("28P01");
      }
    });
    expect(opened.map((pool) => pool.password)).toEqual(["pw-app", "previous-secret"]);
  });

  it("rejects without a second pool when neither stage differs", async () => {
    const { checkout, opened, readSecret } = harness({
      current: "pw-identity",
      previous: "pw-identity",
    });
    await expect(
      checkout("identity", async () => {
        throw denied("28P01");
      }),
    ).rejects.toMatchObject({ code: "28P01" });
    expect(readSecret).toHaveBeenCalledTimes(2);
    expect(opened).toHaveLength(1);
  });

  it("surfaces the database error when the secret has no previous version", async () => {
    const original = denied("28P01");
    const missing = Object.assign(new Error("no previous version"), {
      name: "ResourceNotFoundException",
    });
    const { checkout, opened, readSecret } = harness({
      current: "pw-identity",
      previousError: missing,
    });
    let caught: unknown;
    try {
      await checkout("identity", async () => {
        throw original;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(readSecret.mock.calls).toEqual([
      ["arn-identity", "AWSCURRENT"],
      ["arn-identity", "AWSPREVIOUS"],
    ]);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.sql.end).not.toHaveBeenCalled();
    await checkout("identity", async (sql) => {
      expect(sql).toBe(opened[0]?.sql);
    });
    expect(opened).toHaveLength(1);
  });

  it("still throws the secrets error when the previous read fails but the current secret differs", async () => {
    const missing = Object.assign(new Error("no previous version"), {
      name: "ResourceNotFoundException",
    });
    const { checkout, opened } = harness({ current: "rotated-secret", previousError: missing });
    await expect(
      checkout("identity", async () => {
        throw denied("28P01");
      }),
    ).rejects.toBe(missing);
    expect(opened).toHaveLength(1);
  });

  it("throws the secrets error when the current read fails and does not read the previous", async () => {
    const refused = Object.assign(new Error("access refused"), { name: "AccessDeniedException" });
    const { checkout, opened, readSecret } = harness({ currentError: refused });
    await expect(
      checkout("identity", async () => {
        throw denied("28P01");
      }),
    ).rejects.toBe(refused);
    expect(readSecret.mock.calls).toEqual([["arn-identity", "AWSCURRENT"]]);
    expect(opened).toHaveLength(1);
  });

  it("keeps the replacement pool when the retry fails with an ordinary error", async () => {
    const { checkout, opened, readSecret } = harness({ current: "rotated-secret" });
    let attempts = 0;
    await expect(
      checkout("identity", async () => {
        attempts += 1;
        if (attempts === 1) {
          throw denied("28P01");
        }
        throw new Error("ordinary");
      }),
    ).rejects.toThrow("ordinary");
    expect(opened).toHaveLength(2);
    expect(opened[1]?.sql.end).not.toHaveBeenCalled();
    const reads = readSecret.mock.calls.length;
    await checkout("identity", async (sql) => {
      expect(sql).toBe(opened[1]?.sql);
    });
    expect(readSecret).toHaveBeenCalledTimes(reads);
    expect(opened[1]?.sql.end).not.toHaveBeenCalled();
    expect(opened).toHaveLength(2);
  });

  it("rejects a second auth failure without opening a third pool", async () => {
    const { checkout, opened } = harness({ current: "rotated-secret" });
    await expect(
      checkout("platform", async () => {
        throw denied("28P01");
      }),
    ).rejects.toMatchObject({ code: "28P01" });
    expect(opened).toHaveLength(2);
    expect(opened[0]?.sql.end).not.toHaveBeenCalled();
    await checkout("platform", async (sql) => {
      expect(sql).toBe(opened[0]?.sql);
    });
    expect(opened).toHaveLength(2);
  });

  it("does not read secrets for any other SQLSTATE", async () => {
    const { checkout, opened, readSecret } = harness();
    await expect(
      checkout("identity", async () => {
        throw denied("08006");
      }),
    ).rejects.toMatchObject({ code: "08006" });
    expect(readSecret).not.toHaveBeenCalled();
    expect(opened).toHaveLength(1);
  });

  it("re-reads one role once when twenty requests fail auth together", async () => {
    const { checkout, opened, readSecret } = harness({ current: "rotated-secret" });
    let attempts = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        checkout("identity", async () => {
          attempts += 1;
          if (attempts <= 20) {
            throw denied("28P01");
          }
          return "ok";
        }),
      ),
    );
    expect(results).toEqual(Array.from({ length: 20 }, () => "ok"));
    expect(readSecret).toHaveBeenCalledTimes(2);
    const replacements = opened.filter((pool) => pool.password === "rotated-secret");
    const kept = replacements.filter((pool) => pool.sql.end.mock.calls.length === 0);
    expect(kept).toHaveLength(1);
    for (const pool of replacements) {
      if (pool.sql !== kept[0]?.sql) {
        expect(pool.sql.end).toHaveBeenCalled();
      }
    }
    expect(opened[0]?.sql.end).not.toHaveBeenCalled();
    expect(opened.filter((pool) => pool.sql.end.mock.calls.length === 0)).toHaveLength(2);
  });

  it("keeps the marker password out of the error and the log", async () => {
    const { checkout, logs } = harness({ current: MARKER, previous: "older-secret" });
    let caught: unknown;
    try {
      await checkout("identity", async () => {
        throw denied("28P01");
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(MARKER);
    expect(JSON.stringify(logs)).not.toContain(MARKER);
  });
});

describe("secretsManagerReader", () => {
  it("requests the secret string for one stage", async () => {
    const send = vi.fn<(command: GetSecretValueCommand) => Promise<{ SecretString: string }>>(
      async () => ({ SecretString: MARKER }),
    );
    const read = secretsManagerReader({ send });
    await expect(
      read("arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity", "AWSPREVIOUS"),
    ).resolves.toBe(MARKER);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    expect(command?.input).toMatchObject({
      SecretId: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
      VersionStage: "AWSPREVIOUS",
    });
  });
});
