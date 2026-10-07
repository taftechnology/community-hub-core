import fs from "node:fs";

const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

const IMMEDIATE_STATUSES = new Set([
  "FAILED",
  "UNSUPPORTED_IMAGE",
  "SCAN_ELIGIBILITY_EXPIRED",
  "FINDINGS_UNAVAILABLE",
]);

/**
 * @param {string} stderr
 * @returns {string | null}
 */
export function errorNameFromStderr(stderr) {
  if (stderr.trim() === "") {
    return null;
  }
  const match = stderr.match(/An error occurred \(([^)]+)\)/);
  const name = match?.[1];
  if (name == null || name === "") {
    return "Unknown";
  }
  return name;
}

/**
 * @param {{
 *   status: string | null,
 *   counts: unknown,
 *   mediaType: string | null,
 *   errorName: string | null,
 *   timedOut: boolean,
 * }} input
 * @returns {{ pass: boolean, retry: boolean }}
 */
export function decide(input) {
  if (input.timedOut) {
    return { pass: false, retry: false };
  }

  if (input.mediaType != null && INDEX_MEDIA_TYPES.has(input.mediaType)) {
    return { pass: false, retry: false };
  }

  if (input.counts !== null && (typeof input.counts !== "object" || Array.isArray(input.counts))) {
    return { pass: false, retry: false };
  }

  const counts =
    input.counts !== null && typeof input.counts === "object" && !Array.isArray(input.counts)
      ? input.counts
      : null;

  if (counts !== null && Object.hasOwn(counts, "CRITICAL")) {
    const critical = /** @type {Record<string, unknown>} */ (counts).CRITICAL;
    if (typeof critical !== "number" || !Number.isInteger(critical) || critical < 0) {
      return { pass: false, retry: false };
    }
    if (critical > 0) {
      return { pass: false, retry: false };
    }
  }

  if (input.errorName != null && input.errorName !== "ScanNotFoundException") {
    return { pass: false, retry: false };
  }

  if (input.status != null && IMMEDIATE_STATUSES.has(input.status)) {
    return { pass: false, retry: false };
  }

  if (input.errorName === "ScanNotFoundException") {
    return { pass: false, retry: true };
  }

  if (
    input.status === "COMPLETE" &&
    input.errorName == null &&
    (counts === null ||
      !Object.hasOwn(/** @type {Record<string, unknown>} */ (counts), "CRITICAL") ||
      /** @type {Record<string, unknown>} */ (counts).CRITICAL === 0)
  ) {
    return { pass: true, retry: false };
  }

  if (input.status !== "COMPLETE") {
    return { pass: false, retry: true };
  }

  return { pass: false, retry: false };
}

/**
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | null}
 */
function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    return null;
  }
  return value;
}

export function main() {
  const argv = globalThis.process.argv.slice(2);
  const stdoutPath = readArg(argv, "--stdout");
  const stderrPath = readArg(argv, "--stderr");
  const awsExitText = readArg(argv, "--aws-exit");
  const mediaType = readArg(argv, "--media-type");
  const timedOut = argv.includes("--timed-out");

  if (stdoutPath == null || stderrPath == null || awsExitText == null || mediaType == null) {
    globalThis.process.exit(1);
  }

  if (!/^\d+$/.test(awsExitText)) {
    globalThis.process.exit(1);
  }
  const awsExit = Number(awsExitText);

  /** @type {string | null} */
  let status = null;
  /** @type {unknown} */
  let counts = null;
  /** @type {string | null} */
  let errorName = null;

  if (awsExit === 0) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(stdoutPath, "utf8"));
    } catch {
      globalThis.process.exit(1);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      globalThis.process.exit(1);
    }
    const record = /** @type {Record<string, unknown>} */ (parsed);
    status = typeof record.status === "string" ? record.status : null;
    counts = Object.hasOwn(record, "counts") ? record.counts : null;
  } else {
    errorName = errorNameFromStderr(fs.readFileSync(stderrPath, "utf8"));
  }

  const decision = decide({ status, counts, mediaType, errorName, timedOut });
  if (decision.pass) {
    globalThis.process.exit(0);
  }
  globalThis.process.exit(decision.retry ? 2 : 1);
}
