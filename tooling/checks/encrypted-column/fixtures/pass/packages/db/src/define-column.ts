import type { Ciphertext } from "@community-hub/crypto";
import { customType } from "drizzle-orm/pg-core";

function byteaColumn<T extends Uint8Array, TConfig extends Record<string, unknown>>() {
  return customType<{ data: T; driverData: Uint8Array; config: TConfig }>({
    dataType() {
      return "bytea";
    },
    toDriver(value) {
      return value;
    },
    fromDriver(value) {
      return value as T;
    },
  });
}

export function encryptedColumn(name: string, config: { label: string }) {
  return byteaColumn<Ciphertext, { label: string }>()(name, { label: config.label });
}
