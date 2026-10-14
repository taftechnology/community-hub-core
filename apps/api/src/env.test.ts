import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readServiceEnv } from "./env.js";

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

const mrk = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

function complete(): NodeJS.ProcessEnv {
  return {
    PORT: "8080",
    PGPORT: "5432",
    AWS_REGION: "ap-southeast-2",
    NODE_ENV: "test",
    COMMUNITY_HUB_ENVIRONMENT: "staging",
    API_HOSTNAME: "au.api.example.test",
    AUTH_HOSTNAME: "auth.au.example.test",
    WEBHOOKS_HOSTNAME: "webhooks.au.example.test",
    OPS_HOSTNAME: "ops.au.example.test",
    PGHOST: "db.internal",
    PGDATABASE: "communityhub",
    PGUSER_APP: "app",
    PGUSER_IDENTITY: "identity",
    PGUSER_PLATFORM: "platform",
    PGPASSWORD_APP: "pw-app",
    PGPASSWORD_IDENTITY: "pw-identity",
    PGPASSWORD_PLATFORM: "pw-platform",
    ENVELOPE_KEY_ARN: mrk,
    APP_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app",
    IDENTITY_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
    PLATFORM_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform",
  };
}

describe("readServiceEnv", () => {
  it("accepts a synthetic mrk envelope key and the pinned bundle", () => {
    const read = readServiceEnv(complete(), pem);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.env.PORT).toBe(8080);
      expect(read.env.ENVELOPE_KEY_ARN).toBe(mrk);
    }
  });

  it("rejects a missing host, an alias ARN, an uppercase key id, a changed bundle, and duplicate hostnames", () => {
    const missing = complete();
    delete missing.PGHOST;
    expect(readServiceEnv(missing, pem)).toEqual({ ok: false });

    expect(
      readServiceEnv(
        {
          ...complete(),
          ENVELOPE_KEY_ARN: "arn:aws:kms:ap-southeast-2:123456789012:alias/envelope",
        },
        pem,
      ),
    ).toEqual({ ok: false });

    expect(
      readServiceEnv(
        {
          ...complete(),
          ENVELOPE_KEY_ARN:
            "arn:aws:kms:ap-southeast-2:123456789012:key/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        },
        pem,
      ),
    ).toEqual({ ok: false });

    expect(readServiceEnv(complete(), `${pem}x`)).toEqual({ ok: false });

    const shared = complete();
    shared.OPS_HOSTNAME = shared.API_HOSTNAME;
    expect(readServiceEnv(shared, pem)).toEqual({ ok: false });
  });

  describe("mail variables (MAIL_FROM_ADDRESS and SES_CONFIGURATION_SET)", () => {
    it("accepts when neither mail variable is set, returning env without the keys", () => {
      const read = readServiceEnv(complete(), pem);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect("MAIL_FROM_ADDRESS" in read.env).toBe(false);
        expect("SES_CONFIGURATION_SET" in read.env).toBe(false);
      }
    });

    it("accepts when both mail variables are valid, returning env with both keys", () => {
      const source = {
        ...complete(),
        MAIL_FROM_ADDRESS: "no-reply@mail.example.test",
        SES_CONFIGURATION_SET: "community-hub-otp",
      };
      const read = readServiceEnv(source, pem);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.env.MAIL_FROM_ADDRESS).toBe("no-reply@mail.example.test");
        expect(read.env.SES_CONFIGURATION_SET).toBe("community-hub-otp");
      }
    });

    it.each([
      ["only MAIL_FROM_ADDRESS", { MAIL_FROM_ADDRESS: "no-reply@mail.example.test" }],
      ["only SES_CONFIGURATION_SET", { SES_CONFIGURATION_SET: "community-hub-otp" }],
      [
        "address with a space",
        {
          MAIL_FROM_ADDRESS: "no reply@mail.example.test",
          SES_CONFIGURATION_SET: "valid-set",
        },
      ],
      [
        "address with <",
        {
          MAIL_FROM_ADDRESS: "<no-reply@mail.example.test",
          SES_CONFIGURATION_SET: "valid-set",
        },
      ],
      [
        "address with >",
        {
          MAIL_FROM_ADDRESS: "no-reply@mail.example.test>",
          SES_CONFIGURATION_SET: "valid-set",
        },
      ],
      [
        "address with two @",
        {
          MAIL_FROM_ADDRESS: "no@reply@mail.example.test",
          SES_CONFIGURATION_SET: "valid-set",
        },
      ],
      [
        "address with empty local part",
        {
          MAIL_FROM_ADDRESS: "@mail.example.test",
          SES_CONFIGURATION_SET: "valid-set",
        },
      ],
      [
        "address with empty domain",
        {
          MAIL_FROM_ADDRESS: "no-reply@",
          SES_CONFIGURATION_SET: "valid-set",
        },
      ],
      [
        "address empty string",
        {
          MAIL_FROM_ADDRESS: "",
          SES_CONFIGURATION_SET: "valid-set",
        },
      ],
      [
        "set name of 65 characters",
        {
          MAIL_FROM_ADDRESS: "no-reply@mail.example.test",
          SES_CONFIGURATION_SET: "a".repeat(65),
        },
      ],
      [
        "set name with a dot",
        {
          MAIL_FROM_ADDRESS: "no-reply@mail.example.test",
          SES_CONFIGURATION_SET: "set.name",
        },
      ],
    ])("rejects invalid configuration: %s", (_label, overrides) => {
      const source = {
        ...complete(),
        ...overrides,
      };
      expect(readServiceEnv(source, pem)).toEqual({ ok: false });
    });
  });
});
