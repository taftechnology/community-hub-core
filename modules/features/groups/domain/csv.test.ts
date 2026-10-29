import { describe, expect, it } from "vitest";

import { toCsv } from "./csv.js";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentCell += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i += 1;
          continue;
        }
      } else {
        currentCell += char;
        i += 1;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i += 1;
      } else if (char === ",") {
        currentRow.push(currentCell);
        currentCell = "";
        i += 1;
      } else if (char === "\n") {
        currentRow.push(currentCell);
        rows.push(currentRow);
        currentRow = [];
        currentCell = "";
        i += 1;
      } else if (char === "\r") {
        if (i + 1 < text.length && text[i + 1] === "\n") {
          i += 1;
        }
        currentRow.push(currentCell);
        rows.push(currentRow);
        currentRow = [];
        currentCell = "";
        i += 1;
      } else {
        currentCell += char;
        i += 1;
      }
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

describe("toCsv", () => {
  it("formats header-only output", () => {
    const header = [["given_name", "family_name", "role"]];
    expect(toCsv(header)).toBe('"given_name","family_name","role"\n');
  });

  it("handles empty rows", () => {
    expect(toCsv([])).toBe("");
  });

  it("guards against formula injection with leading =, +, -, @, tab, or carriage return (pin 22)", () => {
    expect(toCsv([["=1+1"]])).toBe('"\'=1+1"\n');
    expect(toCsv([["+441234"]])).toBe('"\'+441234"\n');
    expect(toCsv([["-100"]])).toBe('"\'-100"\n');
    expect(toCsv([["@mention"]])).toBe('"\'@mention"\n');
    expect(toCsv([["\ttabbed"]])).toBe('"\'\ttabbed"\n');
    expect(toCsv([["\rcarriage"]])).toBe('"\'\rcarriage"\n');
  });

  it("round-trips a cell with commas, quotes, and newlines through a parser", () => {
    const complexCell = 'Line 1, with "quotes"\nand newline';
    const input = [
      ["given_name", "family_name", "role"],
      [complexCell, "Doe", "member"],
    ];
    const csv = toCsv(input);
    const parsed = parseCsv(csv);
    expect(parsed).toEqual(input);
  });
});
