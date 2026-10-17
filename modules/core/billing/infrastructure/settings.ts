import { newId } from "@community-hub/db";
import type { Sql, TransactionSql } from "postgres";

export interface BillingSettings {
  readonly id: string;
  readonly gstRateBps: number;
  readonly pricesIncludeGst: boolean;
  readonly trialDays: number;
  readonly graceDays: number;
  readonly stripeTaxRateId: string | null;
  readonly note: string;
  readonly createdAt: Date;
}

export interface InsertSettingsInput {
  readonly id?: string;
  readonly gstRateBps: number;
  readonly pricesIncludeGst: boolean;
  readonly trialDays: number;
  readonly graceDays: number;
  readonly stripeTaxRateId: string;
  readonly note: string;
  readonly createdAt?: Date;
}

type BillingSettingsRow = {
  id: string;
  gst_rate_bps: number;
  prices_include_gst: boolean;
  trial_days: number;
  grace_days: number;
  stripe_tax_rate_id: string | null;
  note: string;
  created_at: Date;
};

function toBillingSettings(row: BillingSettingsRow): BillingSettings {
  return {
    id: row.id,
    gstRateBps: row.gst_rate_bps,
    pricesIncludeGst: row.prices_include_gst,
    trialDays: row.trial_days,
    graceDays: row.grace_days,
    stripeTaxRateId: row.stripe_tax_rate_id,
    note: row.note,
    createdAt: row.created_at,
  };
}

export async function currentSettings(sql: Sql | TransactionSql): Promise<BillingSettings | null> {
  const rows = await sql<BillingSettingsRow[]>`
    select
      id,
      gst_rate_bps,
      prices_include_gst,
      trial_days,
      grace_days,
      stripe_tax_rate_id,
      note,
      created_at
    from platform.billing_settings
    order by created_at desc, id desc
    limit 1
  `;
  if (rows.length === 0 || !rows[0]) {
    return null;
  }
  return toBillingSettings(rows[0]);
}

export async function insertSettings(
  sql: Sql | TransactionSql,
  input: InsertSettingsInput,
): Promise<BillingSettings> {
  if (input.stripeTaxRateId == null || input.stripeTaxRateId.trim() === "") {
    throw new Error("stripeTaxRateId is required and cannot be null or empty");
  }

  const id = input.id ?? newId();
  const createdAt = input.createdAt ?? new Date();

  const rows = await sql<BillingSettingsRow[]>`
    insert into platform.billing_settings (
      id,
      gst_rate_bps,
      prices_include_gst,
      trial_days,
      grace_days,
      stripe_tax_rate_id,
      note,
      created_at
    ) values (
      ${id}::uuid,
      ${input.gstRateBps},
      ${input.pricesIncludeGst},
      ${input.trialDays},
      ${input.graceDays},
      ${input.stripeTaxRateId},
      ${input.note},
      ${createdAt}
    )
    returning
      id,
      gst_rate_bps,
      prices_include_gst,
      trial_days,
      grace_days,
      stripe_tax_rate_id,
      note,
      created_at
  `;

  return toBillingSettings(rows[0]!);
}
