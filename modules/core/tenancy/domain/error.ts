export type ImplicitOrganisationCode =
  "duplicate_organisation_slug" | "duplicate_community_slug" | "invalid_slug";

export class ImplicitOrganisationError extends Error {
  readonly code: ImplicitOrganisationCode;

  constructor(code: ImplicitOrganisationCode) {
    super(code);
    this.name = "ImplicitOrganisationError";
    this.code = code;
  }
}
