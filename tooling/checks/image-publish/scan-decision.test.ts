import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decide, errorNameFromStderr } from "./scan-decision.js";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "scan-decision.js");

const manifest = "application/vnd.oci.image.manifest.v1+json";

const scanNotFoundLine =
  "aws: [ERROR]: An error occurred (ScanNotFoundException) when calling the DescribeImageScanFindings operation: Image scan does not exist for the image with '{imageDigest:'sha256:0000', imageTag:'null'}' in the repository with name 'ch-staging/service' in the registry with id '123456789012'";

const run2 = {
  status: "COMPLETE" as string | null,
  counts: { HIGH: 8, MEDIUM: 2, LOW: 3 } as unknown,
  mediaType: manifest as string | null,
  errorName: null as string | null,
  timedOut: false,
};

function decision(overrides: Partial<typeof run2>) {
  return decide({ ...run2, ...overrides });
}

function spawnCli(options: {
  stdout: string;
  stderr: string;
  awsExit: string;
  mediaType?: string;
  timedOut?: boolean;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-publish-"));
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stdoutPath, options.stdout);
  fs.writeFileSync(stderrPath, options.stderr);
  const args = [
    script,
    "--stdout",
    stdoutPath,
    "--stderr",
    stderrPath,
    "--aws-exit",
    options.awsExit,
    "--media-type",
    options.mediaType ?? manifest,
  ];
  if (options.timedOut) {
    args.push("--timed-out");
  }
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

describe("decide", () => {
  it("passes the run2 shape with no CRITICAL key", () => {
    expect(decision({})).toEqual({ pass: true, retry: false });
  });

  it("passes COMPLETE with CRITICAL 0", () => {
    expect(decision({ counts: { CRITICAL: 0, HIGH: 8 } })).toEqual({ pass: true, retry: false });
  });

  it("passes COMPLETE when counts are null", () => {
    expect(decision({ counts: null })).toEqual({ pass: true, retry: false });
  });

  it("fails COMPLETE when CRITICAL is greater than 0", () => {
    expect(decision({ counts: { CRITICAL: 1 } })).toEqual({ pass: false, retry: false });
  });

  it.each(["FAILED", "UNSUPPORTED_IMAGE", "SCAN_ELIGIBILITY_EXPIRED", "FINDINGS_UNAVAILABLE"])(
    "fails status %s at once",
    (status) => {
      expect(decision({ status })).toEqual({ pass: false, retry: false });
    },
  );

  it("fails an in-progress scan at the timeout", () => {
    expect(decision({ status: "IN_PROGRESS", timedOut: true })).toEqual({
      pass: false,
      retry: false,
    });
  });

  it("retries an in-progress scan before the timeout", () => {
    expect(decision({ status: "IN_PROGRESS" })).toEqual({ pass: false, retry: true });
  });

  it("fails ScanNotFoundException at the timeout", () => {
    expect(decision({ status: null, errorName: "ScanNotFoundException", timedOut: true })).toEqual({
      pass: false,
      retry: false,
    });
  });

  it("retries ScanNotFoundException before the timeout", () => {
    expect(decision({ status: null, errorName: "ScanNotFoundException" })).toEqual({
      pass: false,
      retry: true,
    });
  });

  it.each([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
  ])("fails index media type %s", (mediaType) => {
    expect(decision({ mediaType })).toEqual({ pass: false, retry: false });
  });

  it("fails an API error other than ScanNotFoundException", () => {
    expect(decision({ status: null, errorName: "AccessDeniedException" })).toEqual({
      pass: false,
      retry: false,
    });
  });

  it.each([
    ["array", ["HIGH"]],
    ["string", "HIGH"],
    ["number", 8],
  ])("fails when counts is a %s", (_label, counts) => {
    expect(decision({ counts })).toEqual({ pass: false, retry: false });
  });

  it.each([
    ["string zero", "0"],
    ["negative", -1],
    ["fraction", 1.5],
    ["boolean", true],
  ])("fails when CRITICAL is a %s", (_label, critical) => {
    expect(decision({ counts: { CRITICAL: critical } })).toEqual({ pass: false, retry: false });
  });
});

describe("errorNameFromStderr", () => {
  it("returns null for empty stderr", () => {
    expect(errorNameFromStderr("")).toBeNull();
  });

  it("reads the name in parentheses after An error occurred", () => {
    expect(errorNameFromStderr(scanNotFoundLine)).toBe("ScanNotFoundException");
  });

  it("returns Unknown when the line does not parse", () => {
    expect(errorNameFromStderr("warning: scan still starting")).toBe("Unknown");
  });
});

describe("scan-decision CLI", () => {
  it("exits 0 for the run2 shape when stderr holds a warning", () => {
    const result = spawnCli({
      stdout: JSON.stringify({ status: "COMPLETE", counts: { HIGH: 8, MEDIUM: 2, LOW: 3 } }),
      stderr: "warning: scan still starting",
      awsExit: "0",
    });
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("exits 1 when aws-exit is 0 and stdout is not JSON", () => {
    const result = spawnCli({
      stdout: "not-json",
      stderr: "",
      awsExit: "0",
    });
    expect(result.status).toBe(1);
  });

  it("exits 1 when CRITICAL is greater than 0", () => {
    const result = spawnCli({
      stdout: JSON.stringify({ status: "COMPLETE", counts: { CRITICAL: 2 } }),
      stderr: "",
      awsExit: "0",
    });
    expect(result.status).toBe(1);
  });

  it("exits 2 for the real ScanNotFoundException line", () => {
    const result = spawnCli({
      stdout: "",
      stderr: scanNotFoundLine,
      awsExit: "254",
    });
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(2);
  });

  it("exits 1 when stderr does not parse", () => {
    const result = spawnCli({
      stdout: "",
      stderr: "warning: scan still starting",
      awsExit: "254",
    });
    expect(result.status).toBe(1);
  });
});
