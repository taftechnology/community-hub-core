import type { KmsPort } from "@community-hub/crypto";
import type { InvitationAddresses } from "@community-hub/access";
import {
  closeInvitationEmail,
  createInvitationEmail,
  invitationAddressMatches,
  openInvitationEmails,
  refreshInvitationEmail,
  sweepInvitationEmails,
} from "@community-hub/identity";
import type { Checkout } from "./checkout.js";

type IdentitySql = Parameters<typeof sweepInvitationEmails>[0];

export type IdentityInvitationAddressesDeps = {
  checkout: Checkout<IdentitySql>;
  kms: KmsPort;
  keyArn: string;
};

export function identityInvitationAddresses(
  deps: IdentityInvitationAddressesDeps,
): InvitationAddresses {
  return {
    async sweep(now: Date): Promise<{ erased: number; deleted: number }> {
      return deps.checkout("identity", (sql) => sweepInvitationEmails(sql, now));
    },

    async create(input: {
      invitationId: string;
      communityId: string;
      address: string;
      expiresAt: Date;
    }): Promise<{ ok: true } | { ok: false; reason: "already_invited" }> {
      return deps.checkout("identity", (sql) =>
        createInvitationEmail(sql, deps.kms, deps.keyArn, input),
      );
    },

    async refresh(input: { invitationId: string; expiresAt: Date }): Promise<boolean> {
      return deps.checkout("identity", (sql) => refreshInvitationEmail(sql, input));
    },

    async close(invitationId: string): Promise<void> {
      return deps.checkout("identity", (sql) => closeInvitationEmail(sql, invitationId));
    },

    async open(invitationIds: readonly string[]): Promise<Map<string, string>> {
      return deps.checkout("identity", (sql) =>
        openInvitationEmails(sql, deps.kms, deps.keyArn, invitationIds),
      );
    },

    async matches(input: { invitationId: string; userId: string }): Promise<boolean> {
      return deps.checkout("identity", (sql) => invitationAddressMatches(sql, input));
    },
  };
}
