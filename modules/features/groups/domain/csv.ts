const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];
const TRIMMED_FORMULA_PREFIXES = ["=", "+", "-", "@", "\uff1d", "\uff0b", "\uff0d", "\uff20"];

function isDangerousCell(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return true;
  }
  const trimmed = value.trimStart();
  return TRIMMED_FORMULA_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function formatCell(raw: string): string {
  let val = raw;
  if (isDangerousCell(val)) {
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
