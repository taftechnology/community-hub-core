import type { BlindIndex, Ciphertext } from "@community-hub/crypto";
import { customType } from "drizzle-orm/pg-core";

function asUint8Array(value: Uint8Array): Uint8Array {
  if (Object.getPrototypeOf(value) === Uint8Array.prototype) {
    return value;
  }
  return new Uint8Array(value);
}

function byteaColumn<T extends Uint8Array, TConfig extends Record<string, unknown>>() {
  return customType<{ data: T; driverData: Uint8Array; config: TConfig }>({
    dataType() {
      return "bytea";
    },
    toDriver(value) {
      return value;
    },
    fromDriver(value) {
      return asUint8Array(value) as T;
    },
  });
}

export function labelOf(column: unknown): string {
  if (column === null || typeof column !== "object") {
    throw new Error("encrypted column label is missing");
  }
  const rec = column as Record<string, unknown>;
  if (typeof rec.label === "string") {
    return rec.label;
  }
  const config = rec.config;
  if (config !== null && typeof config === "object") {
    const cfg = config as Record<string, unknown>;
    if (typeof cfg.label === "string") {
      return cfg.label;
    }
    const fieldConfig = cfg.fieldConfig;
    if (fieldConfig !== null && typeof fieldConfig === "object") {
      const fields = fieldConfig as Record<string, unknown>;
      if (typeof fields.label === "string") {
        return fields.label;
      }
    }
  }
  throw new Error("encrypted column label is missing");
}

export function encryptedColumn<TName extends string, TLabel extends string>(
  name: TName,
  config: { label: TLabel },
) {
  return byteaColumn<Ciphertext, { label: TLabel }>()(name, { label: config.label });
}

export function blindIndexColumn<TName extends string, P extends string>(
  name: TName,
  config: { purpose: P },
) {
  return byteaColumn<BlindIndex<P>, { purpose: P }>()(name, { purpose: config.purpose });
}
