// How much of a child a reader may show. Every reader that can return a minor takes one, with no
// default. "admin" is passed only by code that has just asked isCommunityAdmin; "presence" is
// everyone else. Neither view returns a child's field: they differ only in whether a child is
// listed at all, and in the label that names it (architecture §12.1, ADR 0017).
export type ChildView = "admin" | "presence";

export function isChildView(value: unknown): value is ChildView {
  return value === "admin" || value === "presence";
}
