import { beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapOwner, findOwner } from "@community-hub/access";
import type { KmsPort } from "@community-hub/crypto";
import { findOrCreateUserByEmail, findUserByEmail } from "@community-hub/identity";
import {
  createImplicitOrganisation,
  findCommunityBySlug,
  findOrganisationBySlug,
} from "@community-hub/tenancy";

import {
  runProvisionOwner,
  type ProvisionOwnerDeps,
  type ProvisionOwnerResult,
} from "./provision-owner.js";

vi.mock("@community-hub/tenancy", () => ({
  findOrganisationBySlug: vi.fn(),
  findCommunityBySlug: vi.fn(),
  createImplicitOrganisation: vi.fn(),
}));
vi.mock("@community-hub/access", () => ({
  findOwner: vi.fn(),
  bootstrapOwner: vi.fn(),
}));
vi.mock("@community-hub/identity", () => ({
  findUserByEmail: vi.fn(),
  findOrCreateUserByEmail: vi.fn(),
}));
vi.mock("@community-hub/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@community-hub/db")>();
  return {
    ...actual,
    // Run the body against a stand-in transaction; the access/identity calls are mocked.
    withAppTransaction: vi.fn(
      async (_sql: unknown, _scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ tx: "stand-in" }),
    ),
  };
});

const ARN =
  "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-ab12CD";

// Planted markers: none of these may ever appear on either stream.
const ORG_SLUG = "planted-org-slug";
const COMMUNITY_SLUG = "planted-community-slug";
const EMAIL = "planted-person@example.test";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const COMMUNITY_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";
const PLANTED = [ORG_SLUG, COMMUNITY_SLUG, EMAIL, ORG_ID, COMMUNITY_ID, OWNER_ID, OTHER_ID];

const SECRET = JSON.stringify({
  organisationSlug: ORG_SLUG,
  communitySlug: COMMUNITY_SLUG,
  email: EMAIL,
});

// Each stream, on every path, is empty or one of the fixed lines in the spec's Behaviour tables.
const ALLOWED =
  /^$|^created\n$|^already_bootstrapped\n$|^(env|secret|organisation|owner|kms|fail)\n$|^connect( [0-9A-Z]{5})?\n$/;

const mFindOrg = vi.mocked(findOrganisationBySlug);
const mFindCommunity = vi.mocked(findCommunityBySlug);
const mCreateImplicit = vi.mocked(createImplicitOrganisation);
const mFindOwner = vi.mocked(findOwner);
const mBootstrap = vi.mocked(bootstrapOwner);
const mFindUser = vi.mocked(findUserByEmail);
const mFindOrCreate = vi.mocked(findOrCreateUserByEmail);

const fakeSql = { tag: "fake" } as unknown as ProvisionOwnerDeps["platform"];
const fakeKms = { tag: "kms" } as unknown as KmsPort;
const KEY_ARN = "arn:aws:kms:ap-southeast-2:123456789012:key/mrk-00000000000000000000000000000000";

type Harness = {
  source: NodeJS.ProcessEnv;
  read: string[];
  readSecret: ReturnType<typeof vi.fn>;
  run: () => Promise<ProvisionOwnerResult>;
};

function harness(
  options: { arn?: string | null; readSecret?: () => Promise<string> } = {},
): Harness {
  const read: string[] = [];
  const base: NodeJS.ProcessEnv = {};
  if (options.arn !== null) {
    base.PROVISION_SECRET_ARN = options.arn ?? ARN;
  }
  const source = new Proxy(base, {
    get(target, prop) {
      if (typeof prop === "string") {
        read.push(prop);
      }
      return target[prop as string];
    },
  });
  const readSecret = vi.fn(options.readSecret ?? (async () => SECRET));
  return {
    source,
    read,
    readSecret,
    async run() {
      const result = await runProvisionOwner({
        source,
        readSecret,
        platform: fakeSql,
        app: fakeSql,
        identity: fakeSql,
        kms: fakeKms,
        keyArn: KEY_ARN,
        now: () => new Date("2026-10-13T00:00:00+11:00"),
      });
      const out = `${result.stdout}${result.stderr}`;
      for (const value of PLANTED) {
        expect(out).not.toContain(value);
      }
      expect(ALLOWED.test(result.stdout), `stdout ${JSON.stringify(result.stdout)}`).toBe(true);
      expect(ALLOWED.test(result.stderr), `stderr ${JSON.stringify(result.stderr)}`).toBe(true);
      expect(result.exitCode).toBe(result.stderr === "" ? 0 : 1);
      if (result.exitCode === 1) {
        expect(result.stdout).toBe("");
      } else {
        expect(result.stderr).toBe("");
      }
      return result;
    },
  };
}

function pgError(code: string): Error {
  const error = new Error("server error with PGHOST and a password in it");
  error.name = "PostgresError";
  return Object.assign(error, { severity: "ERROR", code });
}

const created = (): ProvisionOwnerResult => ({ exitCode: 0, stdout: "created\n", stderr: "" });
const bootstrapped = (): ProvisionOwnerResult => ({
  exitCode: 0,
  stdout: "already_bootstrapped\n",
  stderr: "",
});
const failure = (word: string): ProvisionOwnerResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `${word}\n`,
});

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh tenant with no owner is the default; individual cases override.
  mFindOrg.mockResolvedValue(null);
  mFindCommunity.mockResolvedValue(null);
  mCreateImplicit.mockResolvedValue({ organisationId: ORG_ID, communityId: COMMUNITY_ID });
  mFindOwner.mockResolvedValue(null);
  mFindOrCreate.mockResolvedValue({ userId: OWNER_ID });
  mBootstrap.mockResolvedValue({
    organisationGrantId: "55555555-5555-4555-8555-555555555555",
    communityGrantId: "66666666-6666-4666-8666-666666666666",
  });
  mFindUser.mockResolvedValue({ userId: OWNER_ID });
});

describe("runProvisionOwner env", () => {
  it("refuses when PROVISION_SECRET_ARN is missing", async () => {
    const h = harness({ arn: null });
    expect(await h.run()).toEqual(failure("env"));
    expect(h.readSecret).not.toHaveBeenCalled();
    expect(mFindOrg).not.toHaveBeenCalled();
  });

  it("refuses a malformed ARN", async () => {
    const h = harness({ arn: "not-an-arn" });
    expect(await h.run()).toEqual(failure("env"));
    expect(h.readSecret).not.toHaveBeenCalled();
  });

  it("refuses an ARN that does not name the one fixed provision-owner secret", async () => {
    const h = harness({
      arn: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-ab12CD",
    });
    expect(await h.run()).toEqual(failure("env"));
    expect(h.readSecret).not.toHaveBeenCalled();
  });

  it("reads only PROVISION_SECRET_ARN from the environment", async () => {
    const h = harness();
    await h.run();
    expect(h.read).toEqual(["PROVISION_SECRET_ARN"]);
  });
});

describe("runProvisionOwner secret", () => {
  it("fails when the secret cannot be read", async () => {
    const h = harness({
      readSecret: async () => {
        throw new Error("secret with an email planted-person@example.test in it");
      },
    });
    expect(await h.run()).toEqual(failure("secret"));
    expect(mFindOrg).not.toHaveBeenCalled();
  });

  it("fails when the secret is not JSON", async () => {
    const h = harness({ readSecret: async () => "not json at all" });
    expect(await h.run()).toEqual(failure("secret"));
  });

  it.each(["organisationSlug", "communitySlug", "email"])(
    "fails when the secret JSON is missing %s",
    async (missing) => {
      const full: Record<string, string> = {
        organisationSlug: ORG_SLUG,
        communitySlug: COMMUNITY_SLUG,
        email: EMAIL,
      };
      delete full[missing];
      const h = harness({ readSecret: async () => JSON.stringify(full) });
      expect(await h.run()).toEqual(failure("secret"));
      expect(mFindOrg).not.toHaveBeenCalled();
    },
  );
});

describe("runProvisionOwner organisation resolution", () => {
  it("refuses when the organisation exists but the community does not", async () => {
    mFindOrg.mockResolvedValue({ id: ORG_ID, slug: ORG_SLUG, region: "au", kind: "implicit" });
    mFindCommunity.mockResolvedValue(null);
    const h = harness();
    expect(await h.run()).toEqual(failure("organisation"));
    expect(mCreateImplicit).not.toHaveBeenCalled();
    expect(mBootstrap).not.toHaveBeenCalled();
  });

  it("refuses when the community exists but the organisation does not", async () => {
    mFindOrg.mockResolvedValue(null);
    mFindCommunity.mockResolvedValue({
      id: COMMUNITY_ID,
      organisationId: ORG_ID,
      slug: COMMUNITY_SLUG,
      region: "au",
    });
    const h = harness();
    expect(await h.run()).toEqual(failure("organisation"));
    expect(mCreateImplicit).not.toHaveBeenCalled();
  });

  it("refuses when the community belongs to a different organisation", async () => {
    mFindOrg.mockResolvedValue({ id: ORG_ID, slug: ORG_SLUG, region: "au", kind: "implicit" });
    mFindCommunity.mockResolvedValue({
      id: COMMUNITY_ID,
      organisationId: OTHER_ID,
      slug: COMMUNITY_SLUG,
      region: "au",
    });
    const h = harness();
    expect(await h.run()).toEqual(failure("organisation"));
    expect(mCreateImplicit).not.toHaveBeenCalled();
    expect(mBootstrap).not.toHaveBeenCalled();
  });

  it("creates the tenant when neither the organisation nor the community exists", async () => {
    const h = harness();
    expect(await h.run()).toEqual(created());
    expect(mCreateImplicit).toHaveBeenCalledWith(fakeSql, {
      organisationSlug: ORG_SLUG,
      communitySlug: COMMUNITY_SLUG,
    });
  });

  it("proceeds without creating when both already exist and match", async () => {
    mFindOrg.mockResolvedValue({ id: ORG_ID, slug: ORG_SLUG, region: "au", kind: "implicit" });
    mFindCommunity.mockResolvedValue({
      id: COMMUNITY_ID,
      organisationId: ORG_ID,
      slug: COMMUNITY_SLUG,
      region: "au",
    });
    const h = harness();
    expect(await h.run()).toEqual(created());
    expect(mCreateImplicit).not.toHaveBeenCalled();
  });
});

describe("runProvisionOwner owner step", () => {
  it("creates the identity user and owner grants when no owner exists", async () => {
    const h = harness();
    expect(await h.run()).toEqual(created());
    expect(mFindOrCreate).toHaveBeenCalledWith(fakeSql, fakeKms, KEY_ARN, { email: EMAIL });
    expect(mBootstrap).toHaveBeenCalledWith(expect.anything(), {
      now: expect.any(Date),
      userId: OWNER_ID,
      actorUserId: OWNER_ID,
    });
  });

  it("reports already_bootstrapped when the owner is the named email, creating nothing", async () => {
    mFindOwner.mockResolvedValue({ userId: OWNER_ID });
    mFindUser.mockResolvedValue({ userId: OWNER_ID });
    const h = harness();
    expect(await h.run()).toEqual(bootstrapped());
    expect(mFindUser).toHaveBeenCalledWith(fakeSql, fakeKms, KEY_ARN, { email: EMAIL });
    // The read-only lookup only — never the create path, and never a grant.
    expect(mFindOrCreate).not.toHaveBeenCalled();
    expect(mBootstrap).not.toHaveBeenCalled();
  });

  it("refuses with owner when an owner exists under a different email, creating nothing", async () => {
    mFindOwner.mockResolvedValue({ userId: OWNER_ID });
    mFindUser.mockResolvedValue({ userId: OTHER_ID });
    const h = harness();
    expect(await h.run()).toEqual(failure("owner"));
    // Regression guard: the different-email path must never reach the create path.
    expect(mFindOrCreate).not.toHaveBeenCalled();
    expect(mBootstrap).not.toHaveBeenCalled();
  });

  it("refuses with owner when an owner exists and the email has no identity user", async () => {
    mFindOwner.mockResolvedValue({ userId: OWNER_ID });
    mFindUser.mockResolvedValue(null);
    const h = harness();
    expect(await h.run()).toEqual(failure("owner"));
    expect(mFindOrCreate).not.toHaveBeenCalled();
    expect(mBootstrap).not.toHaveBeenCalled();
  });
});

describe("runProvisionOwner failure classes", () => {
  it("reports kms when an envelope-key operation fails", async () => {
    mFindOrCreate.mockRejectedValue(new Error("kms_failed"));
    const h = harness();
    expect(await h.run()).toEqual(failure("kms"));
  });

  it("reports connect with the SQLSTATE of a PostgresError", async () => {
    mFindOrg.mockRejectedValue(pgError("28P01"));
    const h = harness();
    expect(await h.run()).toEqual(failure("connect 28P01"));
  });

  it("reports a bare connect for a connection errno", async () => {
    mFindOrg.mockRejectedValue(Object.assign(new Error("socket"), { code: "ECONNREFUSED" }));
    const h = harness();
    expect(await h.run()).toEqual(failure("connect"));
  });

  it("reports fail for anything else", async () => {
    mFindOwner.mockRejectedValue(new Error("something unexpected"));
    const h = harness();
    expect(await h.run()).toEqual(failure("fail"));
  });
});
