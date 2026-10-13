import { describe, expect, it } from "vitest";

import { loadImageCa, readOpsEnv } from "./db-ops-env.js";
import { IMAGE_CERT_PATH } from "./env.js";

const NAMES = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD_MASTER",
  "PGPASSWORD_APP",
  "PGPASSWORD_IDENTITY",
  "PGPASSWORD_PLATFORM",
] as const;

function complete(): NodeJS.ProcessEnv {
  return {
    PGHOST: "db.example.test",
    PGPORT: "5432",
    PGDATABASE: "communityhub",
    PGUSER: "postgres",
    PGPASSWORD_MASTER: "master-synthetic",
    PGPASSWORD_APP: "app-synthetic",
    PGPASSWORD_IDENTITY: "identity-synthetic",
    PGPASSWORD_PLATFORM: "platform-synthetic",
  };
}

describe("readOpsEnv", () => {
  it("reads the eight variables and parses the port", () => {
    expect(readOpsEnv(complete())).toEqual({
      host: "db.example.test",
      port: 5432,
      database: "communityhub",
      user: "postgres",
      master: "master-synthetic",
      app: "app-synthetic",
      identity: "identity-synthetic",
      platform: "platform-synthetic",
    });
  });

  it.each(NAMES)("returns undefined when %s is missing", (name) => {
    const source = complete();
    delete source[name];
    expect(readOpsEnv(source)).toBeUndefined();
  });

  it.each(NAMES)("returns undefined when %s is empty", (name) => {
    expect(readOpsEnv({ ...complete(), [name]: "" })).toBeUndefined();
  });

  it.each(["0", "65536", "abc", "8e3", " 5432"])("returns undefined for the port %j", (port) => {
    expect(readOpsEnv({ ...complete(), PGPORT: port })).toBeUndefined();
  });
});

describe("loadImageCa", () => {
  it("returns the bundle text the reader returns", () => {
    const files: string[] = [];
    const pem = loadImageCa((file) => {
      files.push(file);
      return "-----BEGIN CERTIFICATE-----";
    });
    expect(pem).toBe("-----BEGIN CERTIFICATE-----");
    expect(files).toEqual([IMAGE_CERT_PATH]);
  });

  it("returns undefined when the reader throws", () => {
    const pem = loadImageCa(() => {
      throw new Error("planted-password-marker");
    });
    expect(pem).toBeUndefined();
  });
});
