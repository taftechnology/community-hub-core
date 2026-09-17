import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRANCH_PATTERN = /^(feat|fix|chore|docs)\/(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

const DOC_LINK_PATTERN = /docs\/(specs|plans)\/(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md/g;

export type TraceabilityViolation = {
  message: string;
};

export type CheckResult = {
  ok: boolean;
  violations: TraceabilityViolation[];
};

export type TraceabilityInput = {
  branch: string;
  prBody: string;
  root?: string;
};

type ParsedBranch = {
  type: string;
  date: string;
  slug: string;
};

type DocRef = {
  kind: "specs" | "plans";
  date: string;
  slug: string;
  path: string;
};

function parseBranch(branch: string): ParsedBranch | null {
  const match = branch.trim().match(BRANCH_PATTERN);
  if (!match) {
    return null;
  }
  return { type: match[1]!, date: match[2]!, slug: match[3]! };
}

function extractDocRefs(prBody: string): DocRef[] {
  const refs: DocRef[] = [];
  for (const match of prBody.matchAll(DOC_LINK_PATTERN)) {
    refs.push({
      kind: match[1] as "specs" | "plans",
      date: match[2]!,
      slug: match[3]!,
      path: `docs/${match[1]}/${match[2]}-${match[3]}.md`,
    });
  }
  return refs;
}

function isNoSpecLane(branch: ParsedBranch, prBody: string): boolean {
  return (branch.type === "chore" || branch.type === "fix") && prBody.includes("No spec:");
}

function statusIsApproved(content: string): boolean {
  for (const line of content.split("\n")) {
    if (!line.startsWith("Status:")) {
      continue;
    }
    const value = line.slice("Status:".length).trim();
    if (/^draft\b/i.test(value) && !/\bapproved\b/i.test(value)) {
      return false;
    }
    return /\bapproved\b/i.test(value);
  }
  return false;
}

export function check(input: TraceabilityInput): CheckResult {
  const root = input.root ?? process.cwd();
  const violations: TraceabilityViolation[] = [];

  const branch = parseBranch(input.branch);
  if (!branch) {
    violations.push({
      message: `branch must match <type>/<YYYY-MM-DD>-<slug> (feat|fix|chore|docs); got "${input.branch}"`,
    });
    return { ok: false, violations };
  }

  if (isNoSpecLane(branch, input.prBody)) {
    return { ok: true, violations: [] };
  }

  const refs = extractDocRefs(input.prBody);
  const specs = refs.filter((r) => r.kind === "specs");
  const plans = refs.filter((r) => r.kind === "plans");

  if (specs.length !== 1) {
    violations.push({
      message: `PR body must link exactly one spec (docs/specs/YYYY-MM-DD-slug.md); found ${specs.length}`,
    });
  }
  if (plans.length !== 1) {
    violations.push({
      message: `PR body must link exactly one plan (docs/plans/YYYY-MM-DD-slug.md); found ${plans.length}`,
    });
  }

  if (specs.length === 1 && plans.length === 1) {
    const spec = specs[0]!;
    const plan = plans[0]!;
    if (spec.slug !== plan.slug) {
      violations.push({
        message: `spec slug "${spec.slug}" must match plan slug "${plan.slug}"`,
      });
    }
    if (spec.slug !== branch.slug) {
      violations.push({
        message: `branch slug "${branch.slug}" must match spec/plan slug "${spec.slug}"`,
      });
    }

    for (const doc of [spec, plan]) {
      const abs = path.join(root, doc.path);
      if (!fs.existsSync(abs)) {
        violations.push({ message: `${doc.path} is linked but does not exist` });
        continue;
      }
      const content = fs.readFileSync(abs, "utf8");
      if (!statusIsApproved(content)) {
        violations.push({
          message: `${doc.path} must have Status containing approved`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

function runCli(): void {
  const branch = process.env.TRACEABILITY_BRANCH?.trim();
  const prBody = process.env.TRACEABILITY_PR_BODY ?? "";

  if (!branch) {
    console.error("TRACEABILITY_BRANCH is required");
    process.exit(1);
  }

  const result = check({ branch, prBody });
  if (!result.ok) {
    for (const v of result.violations) {
      console.error(v.message);
    }
    process.exit(1);
  }
  console.log("traceability: ok");
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runCli();
}
