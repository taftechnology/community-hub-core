import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

// Ciphertext columns. SQL cannot compare, sort or group them meaningfully, and the
// encrypted-column lint does not see postgres.js tagged templates, so this test does.
const CIPHERTEXT = [
  "given_name_restricted",
  "family_name_restricted",
  "date_of_birth",
  "email",
  "phone",
  "wrapped",
];

// app.households.label is ciphertext. app.person_tags.label is clear text and is allowed.
const HOUSEHOLD_LABEL = "label";

const COMPARATORS =
  "(?:=|<>|!=|<=|>=|<|>|(?:not\\s+)?like\\b|(?:not\\s+)?ilike\\b|(?:not\\s+)?in\\b|(?:not\\s+)?between\\b)";

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

// The text inside every backtick-delimited template literal, with `${...}` replaced
// by a placeholder so interpolated code is never read as SQL.
function templatesOf(source: string): string[] {
  const out: string[] = [];
  for (const match of stripComments(source).matchAll(/`([^`]*)`/g)) {
    out.push((match[1] ?? "").replace(/\$\{[^}]*\}/g, "$p"));
  }
  return out;
}

function columnPattern(columns: string[]): string {
  const names = columns.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return `(?<![\\w$])(?:[a-z_]\\w*\\.)*(?:${names})(?![\\w$])`;
}

function ciphertextViolations(sqlText: string): string[] {
  const text = normalise(sqlText);
  const columns = [...CIPHERTEXT];
  if (/\bapp\.households\b/.test(text)) {
    columns.push(HOUSEHOLD_LABEL);
  }
  const column = columnPattern(columns);
  const found: string[] = [];

  const left = new RegExp(`(${column})\\s*${COMPARATORS}`, "g");
  for (const match of text.matchAll(left)) {
    found.push(`comparison: ${match[0]}`);
  }
  const right = new RegExp(`${COMPARATORS}\\s*(?:\\(\\s*)?(${column})`, "g");
  for (const match of text.matchAll(right)) {
    found.push(`comparison: ${match[0]}`);
  }

  const lists =
    /\b(?:order|group) by\b(.*?)(?=\blimit\b|\bhaving\b|\boffset\b|\bfor\b|\breturning\b|\bunion\b|\border by\b|;|\)|$)/g;
  for (const match of text.matchAll(lists)) {
    if (new RegExp(column).test(match[1] ?? "")) {
      found.push(`list: ${match[0]}`);
    }
  }
  return found;
}

function sourceViolations(source: string): string[] {
  return templatesOf(source).flatMap((template) => ciphertextViolations(template));
}

function sourceFiles(): string[] {
  return readdirSync(DIRECTORY, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

const BAD = [
  "select id from app.persons where phone = $1",
  "select id from app.persons where $1 = phone",
  "select id from app.persons order by family_name_restricted, email",
  "select id from app.persons where date_of_birth > $1",
  "select id from app.persons where date_of_birth <= $1",
  "select id from app.persons where email <> $1",
  "select id from app.persons where email != $1",
  "select id from app.persons where p.email ilike $1",
  "select id from app.persons where given_name_restricted like $1",
  "select id from app.persons where email in ($1, $2)",
  "select id from app.persons where $1 in (phone)",
  "select id from app.persons where email not in ($1)",
  "select id from app.persons group by phone having count(*) > 1",
  "select id from app.community_keys where wrapped = $1",
  "select id from app.persons\n  order\n  by email",
  "select id from app.persons\n  where\n    email\n      =\n      $1",
  "select id from app.households where label = $1",
  "select id from app.households order by label",
  "select id from app.households h where h.label like $1",
];

const GOOD = [
  "select id from app.persons where email_bidx = $1",
  "select id from app.persons where phone_bidx = $1 and email_bidx = $2",
  "insert into app.persons (id, email, phone) values ($1, $2, $3)",
  "select id, email from app.persons where id = $1",
  "select email, phone from app.persons\n where id = $1",
  "select id, date_of_birth, given_name_restricted from app.persons where id = $1",
  "select id from app.persons where email is null",
  "select id from app.persons where email is not null",
  "select id from app.person_activity where person_id = $1 order by occurred_at",
  "select id from app.person_tags where label = $1",
  "select id from app.person_tags order by label",
  "select label from app.households where id = $1",
  "insert into app.households (id, org_id, community_id, label) values ($1, $2, $3, $4)",
  "select id from app.household_keys where household_id = $1",
  "insert into app.organisation_keys (id, org_id, wrapped, key_version) values ($1, $2, $3, '1')",
];

describe("person source", () => {
  it("flags ciphertext used in a comparison, an order by or a group by", () => {
    for (const statement of BAD) {
      expect(ciphertextViolations(statement), statement).not.toEqual([]);
    }
  });

  it("leaves blind indexes, column lists, select lists and clear labels alone", () => {
    for (const statement of GOOD) {
      expect(ciphertextViolations(statement), statement).toEqual([]);
    }
  });

  it("reads SQL from tagged templates, ignoring comments and interpolated code", () => {
    const bad = "const rows = await tx`select id from app.persons where email = ${value}`;";
    expect(sourceViolations(bad)).not.toEqual([]);
    const commented = [
      "// a stray ` backtick in a comment",
      "const rows = await tx`select id from app.persons where phone = ${value}`;",
    ].join("\n");
    expect(sourceViolations(commented)).not.toEqual([]);
    const fine = [
      "/* where email = $1 order by email */",
      "const email = input.email;",
      "const rows = await tx`select id from app.persons where email_bidx = ${email}`;",
    ].join("\n");
    expect(sourceViolations(fine)).toEqual([]);
  });

  it("does not compare, sort or group ciphertext in the people SQL", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(0);
    const hits: Record<string, string[]> = {};
    for (const name of files) {
      const found = sourceViolations(readFileSync(path.join(DIRECTORY, name), "utf8"));
      if (found.length > 0) {
        hits[name] = found;
      }
    }
    expect(hits).toEqual({});
  });

  it("does not set tenant config", () => {
    const banned = "set_" + "config";
    const files = readdirSync(DIRECTORY).filter((name) => name.endsWith(".ts"));
    const hits = files.filter((name) =>
      readFileSync(path.join(DIRECTORY, name), "utf8").toLowerCase().includes(banned),
    );
    expect(hits).toEqual([]);
  });
});
