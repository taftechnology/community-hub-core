import { ImplicitOrganisationError } from "./error.js";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "au",
  "auth",
  "mail",
  "ops",
  "static",
  "status",
  "www",
]);

export function implicitPair(input: { organisationSlug: string; communitySlug: string }): {
  organisationSlug: string;
  communitySlug: string;
  region: "au";
  kind: "implicit";
} {
  if (
    !SLUG.test(input.organisationSlug) ||
    !SLUG.test(input.communitySlug) ||
    RESERVED.has(input.organisationSlug) ||
    RESERVED.has(input.communitySlug)
  ) {
    throw new ImplicitOrganisationError("invalid_slug");
  }
  return {
    organisationSlug: input.organisationSlug,
    communitySlug: input.communitySlug,
    region: "au",
    kind: "implicit",
  };
}
