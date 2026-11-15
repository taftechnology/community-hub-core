export interface InvitationAddresses {
  sweep(now: Date): Promise<{ erased: number; deleted: number }>;
  create(input: {
    invitationId: string;
    communityId: string;
    address: string;
    expiresAt: Date;
  }): Promise<{ ok: true } | { ok: false; reason: "already_invited" }>;
  refresh(input: { invitationId: string; expiresAt: Date }): Promise<boolean>;
  close(invitationId: string): Promise<void>;
  open(invitationIds: readonly string[]): Promise<Map<string, string>>;
  matches(input: { invitationId: string; userId: string }): Promise<boolean>;
}
