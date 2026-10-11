import { ImplicitOrganisationError } from "./error.js";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MIN_LENGTH = 3;

const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "assets",
  "au",
  "auth",
  "billing",
  "cdn",
  "docs",
  "help",
  "login",
  "mail",
  "ops",
  "portal",
  "staging",
  "static",
  "status",
  "support",
  "www",
]);

export function isSlug(slug: unknown): slug is string {
  return (
    typeof slug === "string" && slug.length >= MIN_LENGTH && SLUG.test(slug) && !RESERVED.has(slug)
  );
}

export function implicitPair(input: { organisationSlug: string; communitySlug: string }): {
  organisationSlug: string;
  communitySlug: string;
  region: "au";
  kind: "implicit";
} {
  if (!isSlug(input.organisationSlug) || !isSlug(input.communitySlug)) {
    throw new ImplicitOrganisationError("invalid_slug");
  }
  return {
    organisationSlug: input.organisationSlug,
    communitySlug: input.communitySlug,
    region: "au",
    kind: "implicit",
  };
}
