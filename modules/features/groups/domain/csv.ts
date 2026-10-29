const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

function formatCell(raw: string): string {
  let val = raw;
  if (val.length > 0 && FORMULA_PREFIXES.some((prefix) => val.startsWith(prefix))) {
    val = "'" + val;
  }
  const escaped = val.replaceAll('"', '""');
  return `"${escaped}"`;
}

export function toCsv(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }
  return rows.map((row) => row.map(formatCell).join(",") + "\n").join("");
}
