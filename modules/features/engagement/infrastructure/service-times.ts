import { appendAuditEvent, type AppTransaction } from "@community-hub/db";
import { recordSuccess } from "@community-hub/usage";

import { ServiceTimesError } from "../domain/error.js";
import { toPublicServiceTimes, type PublicServiceTimes } from "../domain/projection.js";
import { sanitiseServiceTimesHtml } from "../domain/sanitise.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireActorUserId(actorUserId: string | null): void {
  if (!(actorUserId === null || (typeof actorUserId === "string" && UUID_RE.test(actorUserId)))) {
    throw new ServiceTimesError("invalid_input");
  }
}

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

export interface ServiceTimesRecord {
  html: string;
  version: number;
}

export interface SaveServiceTimesInput {
  html: string;
  expectedVersion: number;
  now: Date;
  actorUserId: string | null;
}

export async function getServiceTimes(tx: AppTransaction): Promise<ServiceTimesRecord> {
  const rows = await tx<{ content_html: string; version: number }[]>`
    select content_html, version
    from app.service_times
  `;
  if (rows.length === 0) {
    return { html: "", version: 0 };
  }
  return {
    html: rows[0]!.content_html,
    version: rows[0]!.version,
  };
}

export async function getPublishedServiceTimes(tx: AppTransaction): Promise<PublicServiceTimes> {
  const rows = await tx<{ content_html: string }[]>`
    select content_html
    from app.service_times
  `;
  if (rows.length === 0) {
    return { html: "" };
  }
  return toPublicServiceTimes(rows[0]!);
}

export async function saveServiceTimes(
  tx: AppTransaction,
  input: SaveServiceTimesInput,
): Promise<ServiceTimesRecord> {
  requireActorUserId(input.actorUserId);

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    throw new ServiceTimesError("invalid_input");
  }

  if (typeof input.html !== "string" || input.html.length > 120_000) {
    throw new ServiceTimesError("invalid_input");
  }

  const cleaned = sanitiseServiceTimesHtml(input.html);

  if (cleaned.length > 20_000) {
    throw new ServiceTimesError("invalid_input");
  }

  let version: number;

  if (input.expectedVersion === 0) {
    const rows = await tx<{ version: number }[]>`
      insert into app.service_times (
        org_id,
        community_id,
        content_html,
        version,
        created_at,
        updated_at
      ) values (
        current_setting('app.org_id')::uuid,
        current_setting('app.community_id')::uuid,
        ${cleaned},
        1,
        ${input.now},
        ${input.now}
      )
      on conflict (org_id, community_id) do nothing
      returning version
    `;
    if (rows.length === 0) {
      throw new ServiceTimesError("version_conflict");
    }
    version = rows[0]!.version;
  } else {
    const rows = await tx<{ version: number }[]>`
      update app.service_times
      set content_html = ${cleaned},
          version = version + 1,
          updated_at = ${input.now}
      where org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
        and version = ${input.expectedVersion}
      returning version
    `;
    if (rows.length === 0) {
      throw new ServiceTimesError("version_conflict");
    }
    version = rows[0]!.version;
  }

  const settingRows = await tx<{ communityId: string }[]>`
    select current_setting('app.community_id') as "communityId"
  `;
  const communityId = settingRows[0]?.communityId;
  if (!communityId) {
    throw new Error("Missing app.community_id in session settings");
  }

  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: "engagement.service_times.saved",
    purpose: "engagement.service_times.saved",
    targetIds: [communityId],
  });

  await recordSuccess(tx, "module.engagement", input.now);

  return {
    html: cleaned,
    version,
  };
}
