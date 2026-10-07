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
  const uses = [...job.matchAll(/^\s*- uses:\s*(\S+)/gm)].map((match) => match[1] ?? "");
  if (uses.length === 0) {
    return false;
  }
  return uses.every((value) => /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(value));
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
  const preview = jobBlock(text, "build-preview");
  const top = header(text);
  const idTokenCount = count(text, "id-token: write");

  if (
    top.includes("id-token: write") ||
    idTokenCount !== 1 ||
    count(publish, "id-token: write") !== 1
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
  if (!publish.includes(PUBLISH_IF)) {
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

  return { ok: violations.length === 0, violations };
}
