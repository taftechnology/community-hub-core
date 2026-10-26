import { describe, expect, it } from "vitest";

import { classify, PROVISION_SECRET_ARN } from "./one-off-failure.js";

describe("classify", () => {
  it("returns kms\\n for new Error('kms_failed')", () => {
    expect(classify(new Error("kms_failed"))).toBe("kms\n");
  });

  it("returns connect 08006\\n for an error carrying SQLSTATE 08006", () => {
    const error = Object.assign(new Error("connection failed"), {
      name: "PostgresError",
      severity: "ERROR",
      code: "08006",
    });
    expect(classify(error)).toBe("connect 08006\n");
  });

  it("returns connect\\n for an error with code: 'ECONNREFUSED'", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(classify(error)).toBe("connect\n");
  });

  it("returns connect\\n for an error whose cause has code: 'ECONNREFUSED'", () => {
    const cause = Object.assign(new Error("inner"), { code: "ECONNREFUSED" });
    const error = new Error("outer", { cause });
    expect(classify(error)).toBe("connect\n");
  });

  it("returns fail\\n for a plain Error", () => {
    expect(classify(new Error("plain error"))).toBe("fail\n");
  });
});

describe("PROVISION_SECRET_ARN", () => {
  const validArn =
    "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-ab12CD";

  it("accepts the valid provision-owner ARN", () => {
    expect(PROVISION_SECRET_ARN.test(validArn)).toBe(true);
  });

  it("rejects an ARN with -identity- instead of -provision-owner-", () => {
    const arn =
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-ab12CD";
    expect(PROVISION_SECRET_ARN.test(arn)).toBe(false);
  });

  it("rejects an ARN with a 5-character suffix", () => {
    const arn =
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-ab12C";
    expect(PROVISION_SECRET_ARN.test(arn)).toBe(false);
  });

  it("rejects an ARN with secretsmanagerx as the service", () => {
    const arn =
      "arn:aws:secretsmanagerx:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-ab12CD";
    expect(PROVISION_SECRET_ARN.test(arn)).toBe(false);
  });

  it("rejects an ARN with a trailing space", () => {
    const arn = `${validArn} `;
    expect(PROVISION_SECRET_ARN.test(arn)).toBe(false);
  });
});
