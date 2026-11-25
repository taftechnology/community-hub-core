function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A refusal answers 409 with { code }; older answers have an empty body.
export async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const data: unknown = await response.json();
    return isRecord(data) && typeof data.code === "string" ? data.code : null;
  } catch {
    return null;
  }
}

export function duplicateDeletedMessage(canRestore: boolean): string {
  return canRestore
    ? "A deleted contact has this email (or phone). Restore it from the Deleted filter."
    : "A deleted contact has this email (or phone).";
}
