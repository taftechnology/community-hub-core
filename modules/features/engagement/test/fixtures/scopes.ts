import { randomUUID } from "node:crypto";

export interface TenantScope {
  readonly orgId: string;
  readonly communityId: string;
}

export interface SyntheticScopes {
  readonly orgA: {
    readonly id: string;
    readonly community1: TenantScope;
    readonly community2: TenantScope;
  };
  readonly orgB: {
    readonly id: string;
    readonly community1: TenantScope;
  };
}

export function createSyntheticScopes(): SyntheticScopes {
  const orgAId = randomUUID();
  const orgBId = randomUUID();
  const comm1Id = randomUUID();
  const comm2Id = randomUUID();

  return {
    orgA: {
      id: orgAId,
      community1: { orgId: orgAId, communityId: comm1Id },
      community2: { orgId: orgAId, communityId: comm2Id },
    },
    orgB: {
      id: orgBId,
      community1: { orgId: orgBId, communityId: comm1Id },
    },
  };
}
