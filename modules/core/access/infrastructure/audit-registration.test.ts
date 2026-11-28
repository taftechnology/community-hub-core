import { describe, expect, it } from "vitest";
import { isAuditAction, isAuditPurpose } from "@community-hub/kernel/module";

import type { AccessErrorCode } from "../domain/error.js";
import { AccessError } from "../public/index.js";

describe("audit registration", () => {
  it("registers users listed action and purpose and users view purpose", () => {
    expect(isAuditAction("access.users.listed")).toBe(true);
    expect(isAuditPurpose("access.users.listed")).toBe(true);
    expect(isAuditPurpose("access.users.view")).toBe(true);
  });

  it("includes too_many in AccessErrorCode", () => {
    const code: AccessErrorCode = "too_many";
    const error = new AccessError(code);
    expect(error.code).toBe("too_many");
  });

  it("registers invitation audit actions and purposes", () => {
    const invitationActions = [
      "access.invitation.created",
      "access.invitation.resent",
      "access.invitation.revoked",
      "access.invitation.accepted",
      "access.invitation.voided",
      "access.invitations.listed",
    ];

    for (const action of invitationActions) {
      expect(isAuditAction(action)).toBe(true);
      expect(isAuditPurpose(action)).toBe(true);
    }

    expect(isAuditPurpose("access.user.not_member")).toBe(true);
  });

  it("registers the View action and its eight purposes, three segments each", () => {
    expect(isAuditAction("people.minor.field_viewed")).toBe(true);
    const purposes = [
      "people.minor_view.name",
      "people.minor_view.date_of_birth",
      "people.minor_view.email",
      "people.minor_view.phone",
      "people.minor_view.life_event_type",
      "people.minor_view.life_event_date",
      "people.minor_view.life_event_place",
      "people.minor_view.life_event_notes",
    ];
    for (const purpose of purposes) {
      expect(isAuditPurpose(purpose), purpose).toBe(true);
      // The audit table's check allows exactly three segments.
      expect(purpose.split(".")).toHaveLength(3);
    }
  });

  it("includes new error codes in AccessErrorCode", () => {
    const newCodes: AccessErrorCode[] = [
      "not_member",
      "already_invited",
      "invitation_invalid",
      "wrong_address",
      "invitation_void",
      "invitation_not_found",
      "person_linked",
      "person_minor",
      "person_not_found",
      "role_not_found",
    ];

    for (const code of newCodes) {
      const error = new AccessError(code);
      expect(error.code).toBe(code);
    }
  });
});
