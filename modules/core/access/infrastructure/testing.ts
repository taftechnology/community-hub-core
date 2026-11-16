import type { AppTransaction } from "@community-hub/db";

import type { InvitationAddresses } from "../domain/invitation-addresses.js";
import { insertMembership } from "./membership.js";

export async function addMember(tx: AppTransaction, userId: string): Promise<void> {
  await insertMembership(tx, {
    userId,
    source: "provision",
  });
}

export type RecordedAddressCall =
  | { method: "sweep"; now: Date }
  | {
      method: "create";
      input: {
        invitationId: string;
        communityId: string;
        address: string;
        expiresAt: Date;
      };
    }
  | {
      method: "refresh";
      input: { invitationId: string; expiresAt: Date };
    }
  | { method: "close"; invitationId: string }
  | { method: "open"; invitationIds: readonly string[] }
  | { method: "matches"; input: { invitationId: string; userId: string } };

export class MemoryInvitationAddresses implements InvitationAddresses {
  readonly entries = new Map<
    string,
    {
      invitationId: string;
      communityId: string;
      address: string;
      expiresAt: Date;
      closed: boolean;
    }
  >();

  readonly userAddresses = new Map<string, string>();
  readonly calls: RecordedAddressCall[] = [];

  createAnswer?: { ok: true } | { ok: false; reason: "already_invited" };
  refreshAnswer?: boolean;
  matchesAnswer?: boolean;

  async sweep(now: Date): Promise<{ erased: number; deleted: number }> {
    this.calls.push({ method: "sweep", now });
    let erased = 0;
    for (const entry of this.entries.values()) {
      if (!entry.closed && entry.expiresAt <= now) {
        entry.closed = true;
        erased++;
      }
    }
    return { erased, deleted: 0 };
  }

  async create(input: {
    invitationId: string;
    communityId: string;
    address: string;
    expiresAt: Date;
  }): Promise<{ ok: true } | { ok: false; reason: "already_invited" }> {
    this.calls.push({ method: "create", input });
    if (this.createAnswer !== undefined) {
      return this.createAnswer;
    }
    for (const entry of this.entries.values()) {
      if (
        entry.communityId === input.communityId &&
        entry.address.toLowerCase() === input.address.toLowerCase() &&
        !entry.closed &&
        entry.expiresAt > new Date()
      ) {
        return { ok: false, reason: "already_invited" };
      }
    }
    this.entries.set(input.invitationId, {
      invitationId: input.invitationId,
      communityId: input.communityId,
      address: input.address,
      expiresAt: input.expiresAt,
      closed: false,
    });
    return { ok: true };
  }

  async refresh(input: { invitationId: string; expiresAt: Date }): Promise<boolean> {
    this.calls.push({ method: "refresh", input });
    if (this.refreshAnswer !== undefined) {
      return this.refreshAnswer;
    }
    const entry = this.entries.get(input.invitationId);
    if (entry) {
      if (entry.closed) {
        return false;
      }
      entry.expiresAt = input.expiresAt;
      return true;
    }
    return true;
  }

  async close(invitationId: string): Promise<void> {
    this.calls.push({ method: "close", invitationId });
    const entry = this.entries.get(invitationId);
    if (entry) {
      entry.closed = true;
    }
  }

  async open(invitationIds: readonly string[]): Promise<Map<string, string>> {
    this.calls.push({ method: "open", invitationIds });
    const result = new Map<string, string>();
    const now = new Date();
    for (const id of invitationIds) {
      const entry = this.entries.get(id);
      if (entry && !entry.closed && entry.expiresAt > now) {
        result.set(id, entry.address);
      }
    }
    return result;
  }

  async matches(input: { invitationId: string; userId: string }): Promise<boolean> {
    this.calls.push({ method: "matches", input });
    if (this.matchesAnswer !== undefined) {
      return this.matchesAnswer;
    }
    const entry = this.entries.get(input.invitationId);
    if (!entry || entry.closed || entry.expiresAt <= new Date()) {
      return false;
    }
    const userAddress = this.userAddresses.get(input.userId);
    if (!userAddress) {
      return false;
    }
    return entry.address.toLowerCase() === userAddress.toLowerCase();
  }
}
