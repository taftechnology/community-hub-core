import type { ChildView } from "@community-hub/people";

// Every groups function that can touch a child takes a view, with no default. "admin" is passed only
// by code that has just asked isCommunityAdmin; everyone else passes "presence". An invalid or
// missing view is refused before anything else, so a caller that forgets it fails instead of
// guessing (architecture §12.1, ADR 0017).
export function isChildView(value: unknown): value is ChildView {
  return value === "admin" || value === "presence";
}
