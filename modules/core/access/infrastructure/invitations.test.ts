import { describe, expectTypeOf, it } from "vitest";

import type { InvitationAddresses } from "../domain/invitation-addresses.js";
import {
  createInvitation,
  deleteInvitationAfterMailFailure,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  voidInvitationAfterMailFailure,
} from "./invitations.js";

describe("invitations dependency types", () => {
  it("createInvitation dependency parameter is exactly Pick<InvitationAddresses, 'sweep' | 'create'>", () => {
    expectTypeOf<Parameters<typeof createInvitation>[1]>().toEqualTypeOf<
      Pick<InvitationAddresses, "sweep" | "create">
    >();
  });

  it("listInvitations dependency parameter is exactly Pick<InvitationAddresses, 'sweep' | 'open'>", () => {
    expectTypeOf<Parameters<typeof listInvitations>[1]>().toEqualTypeOf<
      Pick<InvitationAddresses, "sweep" | "open">
    >();
  });

  it("resendInvitation dependency parameter is exactly Pick<InvitationAddresses, 'sweep' | 'refresh'>", () => {
    expectTypeOf<Parameters<typeof resendInvitation>[1]>().toEqualTypeOf<
      Pick<InvitationAddresses, "sweep" | "refresh">
    >();
  });

  it("revokeInvitation dependency parameter is exactly Pick<InvitationAddresses, 'sweep' | 'close'>", () => {
    expectTypeOf<Parameters<typeof revokeInvitation>[1]>().toEqualTypeOf<
      Pick<InvitationAddresses, "sweep" | "close">
    >();
  });

  it("deleteInvitationAfterMailFailure dependency parameter is exactly Pick<InvitationAddresses, 'sweep' | 'close'>", () => {
    expectTypeOf<Parameters<typeof deleteInvitationAfterMailFailure>[1]>().toEqualTypeOf<
      Pick<InvitationAddresses, "sweep" | "close">
    >();
  });

  it("voidInvitationAfterMailFailure dependency parameter is exactly Pick<InvitationAddresses, 'sweep' | 'close'>", () => {
    expectTypeOf<Parameters<typeof voidInvitationAfterMailFailure>[1]>().toEqualTypeOf<
      Pick<InvitationAddresses, "sweep" | "close">
    >();
  });
});
