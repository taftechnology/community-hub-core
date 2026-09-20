import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

import plugin from "../../eslint-plugin-community-hub/index.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(dir, "fixtures");

const QUERY = "@community-hub/no-encrypted-column-query";
const KMS = "@community-hub/no-kms-port-outside-crypto";
const DISABLE = "@community-hub/no-restricted-disable";
const TS_IGNORE = "@community-hub/no-ts-ignore";
const TESTING = "@community-hub/no-crypto-testing-import";
const PAYLOAD = "@community-hub/no-event-payload";

type Hit = { ruleId: string | null; message: string; line: number; fatal?: boolean | undefined };

const mustFail: { file: string; ruleId: string; count: number }[] = [
  { file: "fail/order-by.ts", ruleId: QUERY, count: 2 },
  { file: "fail/group-by.ts", ruleId: QUERY, count: 2 },
  { file: "fail/asc-desc.ts", ruleId: QUERY, count: 2 },
  { file: "fail/aggregates.ts", ruleId: QUERY, count: 3 },
  { file: "fail/eq-ciphertext.ts", ruleId: QUERY, count: 2 },
  { file: "fail/inarray-ciphertext.ts", ruleId: QUERY, count: 2 },
  { file: "fail/like.ts", ruleId: QUERY, count: 1 },
  { file: "fail/gt.ts", ruleId: QUERY, count: 2 },
  { file: "fail/sql-interpolation.ts", ruleId: QUERY, count: 1 },
  { file: "fail/sql-raw.ts", ruleId: QUERY, count: 1 },
  { file: "fail/sql-raw-var.ts", ruleId: QUERY, count: 1 },
  { file: "fail/sql-raw-renamed.ts", ruleId: QUERY, count: 1 },
  { file: "fail/execute-string.ts", ruleId: QUERY, count: 1 },
  { file: "fail/execute-var.ts", ruleId: QUERY, count: 1 },
  { file: "fail/execute-prop.ts", ruleId: QUERY, count: 1 },
  { file: "fail/widen-var.ts", ruleId: QUERY, count: 1 },
  { file: "fail/widen-array.ts", ruleId: QUERY, count: 1 },
  { file: "fail/widen-return.ts", ruleId: QUERY, count: 1 },
  { file: "fail/widen-object.ts", ruleId: QUERY, count: 1 },
  { file: "fail/widen-default.ts", ruleId: QUERY, count: 1 },
  { file: "fail/widen-field.ts", ruleId: QUERY, count: 1 },
  { file: "fail/call-result.ts", ruleId: QUERY, count: 1 },
  { file: "fail/widen-call.ts", ruleId: QUERY, count: 1 },
  { file: "fail/satisfies.ts", ruleId: QUERY, count: 1 },
  { file: "fail/new-expression.ts", ruleId: QUERY, count: 1 },
  { file: "fail/eq-bidx-bidx.ts", ruleId: QUERY, count: 2 },
  { file: "fail/ciphertext-index.ts", ruleId: QUERY, count: 1 },
  { file: "fail/subquery-alias.ts", ruleId: QUERY, count: 1 },
  { file: "fail/cte.ts", ruleId: QUERY, count: 1 },
  { file: "fail/as-alias.ts", ruleId: QUERY, count: 1 },
  { file: "fail/spread-columns.ts", ruleId: QUERY, count: 1 },
  { file: "fail/nullable.ts", ruleId: QUERY, count: 1 },
  { file: "fail/cast.ts", ruleId: QUERY, count: 2 },
  {
    file: "fail/modules/features/giving/infrastructure/order-by.ts",
    ruleId: QUERY,
    count: 1,
  },
  { file: "fail/packages/db/src/kms-decrypt.ts", ruleId: KMS, count: 1 },
  { file: "fail/packages/db/src/kms-destructure.ts", ruleId: KMS, count: 1 },
  { file: "fail/packages/db/src/testing-import.ts", ruleId: TESTING, count: 1 },
  { file: "fail/packages/db/src/disable-comment.ts", ruleId: DISABLE, count: 1 },
  { file: "fail/packages/db/src/inline-config.ts", ruleId: DISABLE, count: 1 },
  { file: "fail/packages/db/src/ts-ignore.ts", ruleId: TS_IGNORE, count: 1 },
  { file: "fail/packages/db/src/ts-expect-error.ts", ruleId: TS_IGNORE, count: 1 },
  { file: "fail/event-free-string.ts", ruleId: PAYLOAD, count: 1 },
  { file: "fail/event-banned-key.ts", ruleId: PAYLOAD, count: 1 },
  { file: "fail/event-record.ts", ruleId: PAYLOAD, count: 1 },
  { file: "fail/event-passthrough.ts", ruleId: PAYLOAD, count: 1 },
  { file: "fail/event-extend.ts", ruleId: PAYLOAD, count: 1 },
  { file: "fail/event-nested-string.ts", ruleId: PAYLOAD, count: 1 },
  { file: "fail/event-invalid-name.ts", ruleId: PAYLOAD, count: 1 },
];

const mustPass = [
  "pass/select.ts",
  "pass/returning.ts",
  "pass/insert-values.ts",
  "pass/eq-bidx.ts",
  "pass/inarray-bidx.ts",
  "pass/index-bidx.ts",
  "pass/on-conflict-bidx.ts",
  "pass/execute-sql.ts",
  "pass/hold-ciphertext.ts",
  "pass/packages/crypto/src/hold-ciphertext.ts",
  "pass/packages/db/src/decrypt-insert.ts",
  "pass/packages/db/src/define-column.ts",
  "pass/event-allowed.ts",
] as const;

let eslint: ESLint;

/** One type-aware pass per fixture. Relinting the same file on a shared ESLint
 *  instance drops parser services in CI (0 reports for fail/order-by.ts). */
const lintByFile = new Map<string, Promise<Hit[]>>();

beforeAll(() => {
  lintByFile.clear();
  eslint = new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: {
            project: path.join(fixturesDir, "tsconfig.json"),
            tsconfigRootDir: fixturesDir,
          },
        },
        plugins: { "@community-hub": plugin },
        rules: {
          [QUERY]: "error",
          [KMS]: "error",
          [DISABLE]: "error",
          [TS_IGNORE]: "error",
          [TESTING]: "error",
          [PAYLOAD]: "error",
        },
      },
    ],
  });
});

async function lint(file: string): Promise<Hit[]> {
  const cached = lintByFile.get(file);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    const results = await eslint.lintFiles([file]);
    const hits: Hit[] = [];
    for (const result of results) {
      for (const message of result.messages) {
        hits.push({
          ruleId: message.ruleId,
          message: message.message,
          line: message.line,
          fatal: message.fatal,
        });
      }
    }
    return hits;
  })();
  lintByFile.set(file, pending);
  return pending;
}

describe("encrypted-column ESLint fixtures", () => {
  it("loads the community-hub plugin", () => {
    expect(plugin.rules?.["no-encrypted-column-query"]).toBeDefined();
    expect(plugin.rules?.["no-kms-port-outside-crypto"]).toBeDefined();
    expect(plugin.rules?.["no-event-payload"]).toBeDefined();
  });

  for (const { file, ruleId, count } of mustFail) {
    it(`fails ${file} with ${ruleId} × ${count}`, async () => {
      const hits = await lint(file);
      const fatals = hits.filter((hit) => hit.fatal);
      expect(fatals, JSON.stringify(hits)).toEqual([]);
      const matched = hits.filter((hit) => hit.ruleId === ruleId);
      expect(matched.length, JSON.stringify(hits)).toBe(count);
    });
  }

  for (const file of mustPass) {
    it(`passes ${file} with zero reports from these rules`, async () => {
      const hits = await lint(file);
      const fatals = hits.filter((hit) => hit.fatal);
      expect(fatals, JSON.stringify(hits)).toEqual([]);
      const ours = hits.filter(
        (hit) =>
          hit.ruleId === QUERY ||
          hit.ruleId === KMS ||
          hit.ruleId === DISABLE ||
          hit.ruleId === TS_IGNORE ||
          hit.ruleId === TESTING ||
          hit.ruleId === PAYLOAD,
      );
      expect(ours, JSON.stringify(hits)).toEqual([]);
    });
  }

  it("flags .orderBy(encryptedCol) as no-encrypted-column-query, not some other rule", async () => {
    const hits = await lint("fail/order-by.ts");
    const queryHits = hits.filter((hit) => hit.ruleId === QUERY);
    expect(queryHits.length, JSON.stringify(hits)).toBe(2);
    expect(queryHits.every((hit) => hit.ruleId === QUERY)).toBe(true);
    expect(hits.some((hit) => hit.ruleId === "no-restricted-imports")).toBe(false);
  });
});
