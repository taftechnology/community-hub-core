export type WorkflowCheck = {
  ok: boolean;
  violations: string[];
};

const WORKFLOW_CANCEL = "cancel-in-progress: ${{ github.event_name == 'pull_request' }}";
const PUBLISH_IF = "if: github.event_name == 'push' && github.ref == 'refs/heads/main'";
const PUBLISH_NEEDS = "needs: [static, test]";
const SCAN_COMMAND = "node tooling/checks/image-publish/scan-decision-cli.js";

function header(text: string): string {
  const index = text.search(/^jobs:\n/m);
  return index === -1 ? text : text.slice(0, index);
}

function jobBlock(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) {
    return "";
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[a-z0-9-]+:$/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function usesArePinned(job: string): boolean {
  const uses = [...job.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1] ?? "");
  if (uses.length === 0) {
    return false;
  }
  return uses.every((value) => /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(value));
}

function publishIfIsExact(publish: string): boolean {
  return publish.split("\n").some((line) => line.trim() === PUBLISH_IF);
}

function jobSteps(job: string): string[] {
  const lines = job.split("\n");
  const blocks: string[][] = [];
  for (const line of lines) {
    if (/^ {6}- /.test(line)) {
      blocks.push([line]);
      continue;
    }
    const current = blocks.at(-1);
    if (current) {
      current.push(line);
    }
  }
  return blocks.map((block) => block.join("\n"));
}

function joinContinuations(text: string): string {
  return text.replace(/\\\n[ \t]*/g, " ");
}

function awsCommands(job: string): string[] {
  const commands: string[] = [];
  for (const line of joinContinuations(job).split("\n")) {
    const segments = line.split(/&&|\|\||;|\$\(|\bthen\b|\bdo\b|\|/);
    for (const segment of segments) {
      const match = /^\s*(aws\b.*)$/.exec(segment);
      const command = match?.[1]?.trim();
      if (command !== undefined && command.length > 0) {
        commands.push(command);
      }
    }
  }
  return commands;
}

function isAssetSyncOrIndexCopy(command: string): boolean {
  return command.startsWith("aws s3 sync") || command.startsWith("aws s3 cp");
}

function adminPublishSyncFails(job: string): boolean {
  const lines = joinContinuations(job).split("\n");
  const syncIndex = lines.findIndex((line) => line.includes("aws s3 sync"));
  const copyIndex = lines.findIndex((line) => line.includes("aws s3 cp"));
  if (syncIndex === -1 || copyIndex === -1 || syncIndex > copyIndex) {
    return true;
  }
  const sync = lines[syncIndex] ?? "";
  const copy = lines[copyIndex] ?? "";
  const syncOk =
    sync.includes("dist/assets") &&
    sync.includes("--delete") &&
    sync.includes("--only-show-errors") &&
    sync.includes("public, max-age=31536000, immutable");
  const copyOk =
    copy.includes("index.html") &&
    copy.includes("--only-show-errors") &&
    copy.includes("no-cache") &&
    !copy.includes("--delete");
  return !syncOk || !copyOk;
}

function adminPublishQueryFails(job: string): boolean {
  return awsCommands(job).some(
    (command) => !isAssetSyncOrIndexCopy(command) && !command.includes("--query"),
  );
}

function publishHasSeparateImageTest(publish: string): boolean {
  return jobSteps(publish).some(
    (step) => step.includes("src/image.test.ts") && !step.includes(SCAN_COMMAND),
  );
}

function buildsAreAttested(text: string): boolean {
  const builds = text.split("\n").filter((line) => line.includes("docker build"));
  return (
    builds.length > 0 &&
    builds.every((line) => line.includes("--provenance=false") && line.includes("--sbom=false"))
  );
}

export function checkWorkflow(text: string): WorkflowCheck {
  const violations: string[] = [];
  const publish = jobBlock(text, "publish");
  const adminPublish = jobBlock(text, "admin-publish");
  const preview = jobBlock(text, "build-preview");
  const top = header(text);
  const idTokenCount = count(text, "id-token: write");

  if (
    top.includes("id-token: write") ||
    idTokenCount !== 2 ||
    count(publish, "id-token: write") !== 1 ||
    count(adminPublish, "id-token: write") !== 1
  ) {
    violations.push("workflow-id-token");
  }
  if (/^[ \t]*cancel-in-progress:\s*true\s*$/m.test(text)) {
    violations.push("cancel-true");
  }
  if (!top.includes(WORKFLOW_CANCEL) || !top.includes("github.sha")) {
    violations.push("workflow-cancel");
  }
  if (preview.includes("docker push")) {
    violations.push("preview-push");
  }
  if (!buildsAreAttested(text)) {
    violations.push("missing-attestation");
  }
  if (/(?<!\d)\d{12}(?!\d)/.test(text)) {
    violations.push("account-id");
  }
  if (!publishIfIsExact(publish)) {
    violations.push("publish-without-main");
  }
  if (!usesArePinned(publish)) {
    violations.push("publish-floating-uses");
  }
  if (!publish.includes(PUBLISH_NEEDS)) {
    violations.push("publish-without-needs");
  }
  if (!publish.includes("group: image-publish") || !publish.includes("cancel-in-progress: false")) {
    violations.push("publish-concurrency");
  }
  if (
    !publish.includes(SCAN_COMMAND) ||
    !publish.includes("--stdout") ||
    !publish.includes("--stderr") ||
    !publish.includes("--aws-exit") ||
    !publish.includes("--media-type") ||
    !publish.includes("imageScanStatus.status") ||
    !publish.includes("imageScanFindings.findingSeverityCounts")
  ) {
    violations.push("publish-scan");
  }
  if (preview.includes("id-token")) {
    violations.push("preview-id-token");
  }
  if (!preview.includes("RUN_IMAGE_TESTS") || !preview.includes("src/image.test.ts")) {
    violations.push("preview-image-tests");
  }
  if (publishHasSeparateImageTest(publish)) {
    violations.push("publish-image-test");
  }
  if (!adminPublish.includes(PUBLISH_NEEDS)) {
    violations.push("admin-publish-without-needs");
  }
  if (!publishIfIsExact(adminPublish)) {
    violations.push("admin-publish-without-main");
  }
  if (!usesArePinned(adminPublish)) {
    violations.push("admin-publish-floating-uses");
  }
  if (
    !adminPublish.includes("group: admin-publish") ||
    !adminPublish.includes("cancel-in-progress: false")
  ) {
    violations.push("admin-publish-concurrency");
  }
  if (adminPublishSyncFails(adminPublish)) {
    violations.push("admin-publish-sync");
  }
  if (adminPublishQueryFails(adminPublish)) {
    violations.push("admin-publish-query");
  }

  return { ok: violations.length === 0, violations };
}
