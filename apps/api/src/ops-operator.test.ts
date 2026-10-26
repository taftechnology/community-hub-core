import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KmsPort } from "@community-hub/crypto";
import {
  findOrCreateUserByEmail,
  findUserByEmail,
  grantOperator,
  IdentityError,
  recoverOperator,
  revokeOperator,
} from "@community-hub/identity";

import {
  opsRpIdFrom,
  runOpsOperator,
  runOpsOperatorMain,
  type OpsOperatorDeps,
} from "./ops-operator.js";

vi.mock("@community-hub/identity", async (importOriginal) => ({
  ...(await importOriginal()),
  findUserByEmail: vi.fn(),
  findOrCreateUserByEmail: vi.fn(),
  grantOperator: vi.fn(),
  revokeOperator: vi.fn(),
  recoverOperator: vi.fn(),
}));

const mFindUser = vi.mocked(findUserByEmail);
const mFindOrCreate = vi.mocked(findOrCreateUserByEmail);
const mGrant = vi.mocked(grantOperator);
const mRevoke = vi.mocked(revokeOperator);
const mRecover = vi.mocked(recoverOperator);

const ARN =
  "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-ab12CD";
const KEY_ARN = "arn:aws:kms:ap-southeast-2:123456789012:key/mrk-00000000000000000000000000000000";
const EMAIL = "operator@example.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-26T12:00:00.000Z");
const CODE = "A".repeat(32);
const OPS_RP_ID = "ops.example.test";
const fakeKms = { tag: "kms" } as unknown as KmsPort;

function makeDeps(overrides: Partial<OpsOperatorDeps> = {}): {
  deps: OpsOperatorDeps;
  connectionCalls: unknown[];
  readSecret: ReturnType<typeof vi.fn>;
} {
  const connectionCalls: unknown[] = [];
  const fakeIdentity = Object.assign(
    (...args: unknown[]) => {
      connectionCalls.push(args);
      return Promise.resolve([]);
    },
    {
      begin: vi.fn((...args: unknown[]) => {
        connectionCalls.push(["begin", ...args]);
        return Promise.resolve([]);
      }),
      end: vi.fn((...args: unknown[]) => {
        connectionCalls.push(["end", ...args]);
        return Promise.resolve(undefined);
      }),
    },
  ) as unknown as OpsOperatorDeps["identity"];

  const readSecret = vi.fn().mockResolvedValue(
    JSON.stringify({
      opsOperator: {
        action: "grant",
        email: EMAIL,
        roleKeys: ["platform_admin"],
        enrolmentCode: CODE,
      },
    }),
  );

  const deps: OpsOperatorDeps = {
    source: { PROVISION_SECRET_ARN: ARN },
    readSecret,
    identity: fakeIdentity,
    kms: fakeKms,
    keyArn: KEY_ARN,
    opsRpId: OPS_RP_ID,
    now: () => NOW,
    newId: () => REQUEST_ID,
    ...overrides,
  };

  return { deps, connectionCalls, readSecret };
}

describe("ops-operator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mFindOrCreate.mockResolvedValue({ userId: USER_ID });
    mFindUser.mockResolvedValue({ userId: USER_ID });
    mGrant.mockResolvedValue({ grantIds: ["grant-1"] });
    mRevoke.mockResolvedValue(undefined);
    mRecover.mockResolvedValue({ grantIds: ["grant-2"] });
  });

  describe("Security pin 1: shape refusal before any query", () => {
    it("refuses malformed payloads with shape before any query", async () => {
      const malformedPayloads = [
        // missing opsOperator
        {},
        // extra top-level key
        {
          opsOperator: {
            action: "grant",
            email: EMAIL,
            roleKeys: ["platform_admin"],
            enrolmentCode: CODE,
          },
          extra: "unexpected",
        },
        // unknown key inside opsOperator
        {
          opsOperator: {
            action: "grant",
            email: EMAIL,
            roleKeys: ["platform_admin"],
            enrolmentCode: CODE,
            unknownKey: "bad",
          },
        },
        // bad action
        {
          opsOperator: {
            action: "invalid_action",
            email: EMAIL,
            roleKeys: ["platform_admin"],
            enrolmentCode: CODE,
          },
        },
        // empty email
        {
          opsOperator: {
            action: "grant",
            email: "",
            roleKeys: ["platform_admin"],
            enrolmentCode: CODE,
          },
        },
        // roleKeys on revoke
        {
          opsOperator: {
            action: "revoke",
            email: EMAIL,
            roleKeys: ["platform_admin"],
          },
        },
        // enrolmentCode on revoke
        {
          opsOperator: {
            action: "revoke",
            email: EMAIL,
            enrolmentCode: CODE,
          },
        },
        // missing roleKeys on grant
        {
          opsOperator: {
            action: "grant",
            email: EMAIL,
            enrolmentCode: CODE,
          },
        },
        // missing enrolmentCode on grant
        {
          opsOperator: {
            action: "grant",
            email: EMAIL,
            roleKeys: ["platform_admin"],
          },
        },
        // missing roleKeys on recover
        {
          opsOperator: {
            action: "recover",
            email: EMAIL,
            enrolmentCode: CODE,
          },
        },
        // missing enrolmentCode on recover
        {
          opsOperator: {
            action: "recover",
            email: EMAIL,
            roleKeys: ["platform_admin"],
          },
        },
        // roleKeys not an array of strings
        {
          opsOperator: {
            action: "grant",
            email: EMAIL,
            roleKeys: "not-an-array",
            enrolmentCode: CODE,
          },
        },
        {
          opsOperator: {
            action: "grant",
            email: EMAIL,
            roleKeys: [123],
            enrolmentCode: CODE,
          },
        },
        {
          opsOperator: {
            action: "grant",
            email: EMAIL,
            roleKeys: [],
            enrolmentCode: CODE,
          },
        },
      ];

      for (const payload of malformedPayloads) {
        const { deps, connectionCalls, readSecret } = makeDeps();
        readSecret.mockResolvedValue(JSON.stringify(payload));

        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "shape\n" });
        expect(mFindOrCreate).not.toHaveBeenCalled();
        expect(mFindUser).not.toHaveBeenCalled();
        expect(mGrant).not.toHaveBeenCalled();
        expect(mRevoke).not.toHaveBeenCalled();
        expect(mRecover).not.toHaveBeenCalled();
        expect(connectionCalls).toHaveLength(0);
      }
    });

    it("refuses non-object opsOperator and invalid field types with shape", async () => {
      const extraMalformedPayloads = [
        { opsOperator: null },
        { opsOperator: [] },
        { opsOperator: "x" },
        // revoke with an unknown key beside the two valid ones
        { opsOperator: { action: "revoke", email: EMAIL, extraKey: "val" } },
        // non-string email
        {
          opsOperator: {
            action: "grant",
            email: 123,
            roleKeys: ["platform_admin"],
            enrolmentCode: CODE,
          },
        },
      ];

      for (const payload of extraMalformedPayloads) {
        const { deps, connectionCalls, readSecret } = makeDeps();
        readSecret.mockResolvedValue(JSON.stringify(payload));

        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "shape\n" });
        expect(mFindOrCreate).not.toHaveBeenCalled();
        expect(mFindUser).not.toHaveBeenCalled();
        expect(mGrant).not.toHaveBeenCalled();
        expect(mRevoke).not.toHaveBeenCalled();
        expect(mRecover).not.toHaveBeenCalled();
        expect(connectionCalls).toHaveLength(0);
      }
    });
  });

  describe("Security pin 3: only fixed words on every outcome", () => {
    it("prints only fixed words", async () => {
      // Injected IdentityError
      {
        const { deps } = makeDeps();
        mFindOrCreate.mockRejectedValueOnce(new IdentityError("invalid_grant"));
        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });
        expect(result.stdout).not.toContain(EMAIL);
        expect(result.stderr).not.toContain(EMAIL);
        expect(result.stdout).not.toContain(CODE);
        expect(result.stderr).not.toContain(CODE);
      }

      // Database error containing the test address
      {
        const { deps } = makeDeps();
        mFindOrCreate.mockRejectedValueOnce(new Error(`database error mentioning ${EMAIL}`));
        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "fail\n" });
        expect(result.stdout).not.toContain(EMAIL);
        expect(result.stderr).not.toContain(EMAIL);
      }

      // Thrown Error containing the test enrolment code caught by runOpsOperatorMain
      {
        const { deps } = makeDeps();
        const result = await runOpsOperatorMain({
          ...deps,
          run: () => {
            throw new Error(`fatal crash with secret code ${CODE}`);
          },
        });
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "fail\n" });
        expect(result.stdout).not.toContain(CODE);
        expect(result.stderr).not.toContain(CODE);
      }
    });
  });

  describe("Security pin 4: wrong ARN -> env, secret never read", () => {
    it("refuses a non-provision ARN without reading the secret", async () => {
      // ARN with -identity- instead of -provision-owner-
      {
        const { deps, readSecret } = makeDeps();
        deps.source = {
          PROVISION_SECRET_ARN:
            "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-ab12CD",
        };
        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "env\n" });
        expect(readSecret).not.toHaveBeenCalled();
      }

      // Missing PROVISION_SECRET_ARN
      {
        const { deps, readSecret } = makeDeps();
        deps.source = {};
        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "env\n" });
        expect(readSecret).not.toHaveBeenCalled();
      }
    });
  });

  describe("Security pin 7: any IdentityError -> refused", () => {
    it("maps every IdentityError code to refused", async () => {
      const errorCodes = [
        "invalid_email",
        "email_unavailable",
        "invalid_ceremony",
        "invalid_grant",
      ] as const;

      for (const code of errorCodes) {
        const { deps, readSecret } = makeDeps();
        readSecret.mockResolvedValue(
          JSON.stringify({
            opsOperator: {
              action: "revoke",
              email: EMAIL,
            },
          }),
        );
        mFindUser.mockRejectedValueOnce(new IdentityError(code));

        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });
      }
    });

    it("maps grantOperator rejection with IdentityError to refused", async () => {
      const { deps } = makeDeps();
      mGrant.mockRejectedValueOnce(new IdentityError("invalid_grant"));

      const result = await runOpsOperator(deps);
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });
    });

    it("maps recoverOperator rejection with IdentityError to refused", async () => {
      const { deps, readSecret } = makeDeps();
      readSecret.mockResolvedValue(
        JSON.stringify({
          opsOperator: {
            action: "recover",
            email: EMAIL,
            roleKeys: ["platform_admin"],
            enrolmentCode: CODE,
          },
        }),
      );
      mRecover.mockRejectedValueOnce(new IdentityError("invalid_grant"));

      const result = await runOpsOperator(deps);
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });
    });
  });

  describe("B3a pre-checks before any write", () => {
    it("refuses bad role keys and codes before any identity call", async () => {
      const refusals = [
        // unknown role key
        { roleKeys: ["unknown_role"], enrolmentCode: CODE },
        // duplicate role key
        { roleKeys: ["platform_admin", "platform_admin"], enrolmentCode: CODE },
        // 25-character code
        { roleKeys: ["platform_admin"], enrolmentCode: "A".repeat(25) },
        // code containing '='
        { roleKeys: ["platform_admin"], enrolmentCode: "A".repeat(31) + "=" },
        // code containing '0'
        { roleKeys: ["platform_admin"], enrolmentCode: "A".repeat(31) + "0" },
      ];

      for (const item of refusals) {
        const { deps, connectionCalls, readSecret } = makeDeps();
        readSecret.mockResolvedValue(
          JSON.stringify({
            opsOperator: {
              action: "grant",
              email: EMAIL,
              roleKeys: item.roleKeys,
              enrolmentCode: item.enrolmentCode,
            },
          }),
        );

        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });
        expect(mFindOrCreate).not.toHaveBeenCalled();
        expect(mFindUser).not.toHaveBeenCalled();
        expect(mGrant).not.toHaveBeenCalled();
        expect(mRevoke).not.toHaveBeenCalled();
        expect(mRecover).not.toHaveBeenCalled();
        expect(connectionCalls).toHaveLength(0);
      }
    });

    it("accepts lower-case codes and codes with spaces and hyphens", async () => {
      // Lower-case code
      {
        const { deps, readSecret } = makeDeps();
        readSecret.mockResolvedValue(
          JSON.stringify({
            opsOperator: {
              action: "grant",
              email: EMAIL,
              roleKeys: ["platform_admin"],
              enrolmentCode: "a".repeat(32),
            },
          }),
        );
        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 0, stdout: "granted\n", stderr: "" });
        expect(mGrant).toHaveBeenCalledOnce();
      }

      // Code with hyphens and spaces (32 A's spaced/hyphenated)
      {
        const { deps, readSecret } = makeDeps();
        readSecret.mockResolvedValue(
          JSON.stringify({
            opsOperator: {
              action: "grant",
              email: EMAIL,
              roleKeys: ["platform_admin"],
              enrolmentCode: "AAAA-AAAA AAAA-AAAA AAAA-AAAA AAAA-AAAA",
            },
          }),
        );
        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 0, stdout: "granted\n", stderr: "" });
        expect(mGrant).toHaveBeenCalledTimes(2);
      }
    });

    it("refuses recover with a 25-character code before any identity call", async () => {
      const { deps, connectionCalls, readSecret } = makeDeps();
      readSecret.mockResolvedValue(
        JSON.stringify({
          opsOperator: {
            action: "recover",
            email: EMAIL,
            roleKeys: ["platform_admin"],
            enrolmentCode: "A".repeat(25),
          },
        }),
      );

      const result = await runOpsOperator(deps);
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "refused\n" });
      expect(mFindOrCreate).not.toHaveBeenCalled();
      expect(mFindUser).not.toHaveBeenCalled();
      expect(mGrant).not.toHaveBeenCalled();
      expect(mRevoke).not.toHaveBeenCalled();
      expect(mRecover).not.toHaveBeenCalled();
      expect(connectionCalls).toHaveLength(0);
    });
  });

  describe("Actions and success outcomes", () => {
    it("grant: creates user if needed and calls grantOperator", async () => {
      const { deps } = makeDeps();
      const result = await runOpsOperator(deps);
      expect(result).toEqual({ exitCode: 0, stdout: "granted\n", stderr: "" });

      expect(mFindOrCreate).toHaveBeenCalledOnce();
      expect(mFindOrCreate).toHaveBeenCalledWith(deps.identity, deps.kms, deps.keyArn, {
        email: EMAIL,
      });

      expect(mGrant).toHaveBeenCalledOnce();
      expect(mGrant).toHaveBeenCalledWith(deps.identity, deps.kms, deps.keyArn, {
        userId: USER_ID,
        roleKeys: ["platform_admin"],
        enrolmentCode: CODE,
        opsRpId: OPS_RP_ID,
        now: NOW,
        requestId: REQUEST_ID,
      });
    });

    it("revoke: finds user and calls revokeOperator", async () => {
      const { deps, readSecret } = makeDeps();
      readSecret.mockResolvedValue(
        JSON.stringify({
          opsOperator: {
            action: "revoke",
            email: EMAIL,
          },
        }),
      );

      const result = await runOpsOperator(deps);
      expect(result).toEqual({ exitCode: 0, stdout: "revoked\n", stderr: "" });

      expect(mFindUser).toHaveBeenCalledOnce();
      expect(mFindUser).toHaveBeenCalledWith(deps.identity, deps.kms, deps.keyArn, {
        email: EMAIL,
      });
      expect(mFindOrCreate).not.toHaveBeenCalled();

      expect(mRevoke).toHaveBeenCalledOnce();
      expect(mRevoke).toHaveBeenCalledWith(deps.identity, {
        userId: USER_ID,
        opsRpId: OPS_RP_ID,
        now: NOW,
        requestId: REQUEST_ID,
      });
    });

    it("recover: finds user and calls recoverOperator", async () => {
      const { deps, readSecret } = makeDeps();
      readSecret.mockResolvedValue(
        JSON.stringify({
          opsOperator: {
            action: "recover",
            email: EMAIL,
            roleKeys: ["platform_security"],
            enrolmentCode: CODE,
          },
        }),
      );

      const result = await runOpsOperator(deps);
      expect(result).toEqual({ exitCode: 0, stdout: "recovered\n", stderr: "" });

      expect(mFindUser).toHaveBeenCalledOnce();
      expect(mFindUser).toHaveBeenCalledWith(deps.identity, deps.kms, deps.keyArn, {
        email: EMAIL,
      });
      expect(mFindOrCreate).not.toHaveBeenCalled();

      expect(mRecover).toHaveBeenCalledOnce();
      expect(mRecover).toHaveBeenCalledWith(deps.identity, deps.kms, deps.keyArn, {
        userId: USER_ID,
        roleKeys: ["platform_security"],
        enrolmentCode: CODE,
        opsRpId: OPS_RP_ID,
        now: NOW,
        requestId: REQUEST_ID,
      });
    });

    it("revoke and recover for unknown user print user", async () => {
      // revoke for unknown user
      {
        const { deps, readSecret } = makeDeps();
        readSecret.mockResolvedValue(
          JSON.stringify({
            opsOperator: {
              action: "revoke",
              email: EMAIL,
            },
          }),
        );
        mFindUser.mockResolvedValueOnce(null);

        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "user\n" });
        expect(mRevoke).not.toHaveBeenCalled();
      }

      // recover for unknown user
      {
        const { deps, readSecret } = makeDeps();
        readSecret.mockResolvedValue(
          JSON.stringify({
            opsOperator: {
              action: "recover",
              email: EMAIL,
              roleKeys: ["platform_support"],
              enrolmentCode: CODE,
            },
          }),
        );
        mFindUser.mockResolvedValueOnce(null);

        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "user\n" });
        expect(mRecover).not.toHaveBeenCalled();
      }
    });
  });

  describe("Secret failures", () => {
    it("returns secret for invalid JSON, null, and non-objects", async () => {
      for (const raw of ["not-json", "null", "[]", "123", '"a string"']) {
        const { deps, readSecret } = makeDeps();
        readSecret.mockResolvedValue(raw);

        const result = await runOpsOperator(deps);
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "secret\n" });
      }
    });

    it("returns secret when readSecret rejects", async () => {
      const { deps, readSecret } = makeDeps();
      readSecret.mockRejectedValue(new Error("Secrets Manager error"));

      const result = await runOpsOperator(deps);
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "secret\n" });
    });
  });

  describe("Other error classifications", () => {
    it("returns kms on envelope key failure", async () => {
      const { deps } = makeDeps();
      mFindOrCreate.mockRejectedValueOnce(new Error("kms_failed"));

      const result = await runOpsOperator(deps);
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "kms\n" });
    });

    it("returns connect on database connection failure", async () => {
      const { deps } = makeDeps();
      mFindOrCreate.mockRejectedValueOnce(
        Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
      );

      const result = await runOpsOperator(deps);
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "connect\n" });
    });
  });

  describe("runOpsOperatorMain and helpers", () => {
    it("runOpsOperatorMain catches any throw and returns fail", async () => {
      const { deps } = makeDeps();
      const result = await runOpsOperatorMain({
        ...deps,
        run: () => {
          throw new Error("unexpected error");
        },
      });
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "fail\n" });
    });

    it("opsRpIdFrom lower-cases OPS_HOSTNAME", () => {
      expect(opsRpIdFrom({ OPS_HOSTNAME: "OPS.Example.Test" })).toBe("ops.example.test");
    });
  });
});
