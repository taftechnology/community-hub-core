import { GroupsError } from "./error.js";

export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, " ").normalize("NFC").toLowerCase();
}

export function parseGroupName(name: string): { name: string; nameKey: string } {
  if (typeof name !== "string") {
    throw new GroupsError("invalid_input");
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    throw new GroupsError("invalid_input");
  }
  return {
    name: trimmed,
    nameKey: normaliseName(trimmed),
  };
}
