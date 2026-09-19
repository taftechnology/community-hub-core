import type { BlindIndex, Ciphertext } from "@community-hub/crypto";
import { customType } from "drizzle-orm/pg-core";

function asUint8Array(value: Uint8Array): Uint8Array {
  if (Object.getPrototypeOf(value) === Uint8Array.prototype) {
    return value;
  }
  return new Uint8Array(value);
}

function byteaColumn<T extends Uint8Array>() {
  return customType<{ data: T; driverData: Uint8Array }>({
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

export function encryptedColumn<TName extends string>(name: TName, config: { label: string }) {
  return Object.assign(byteaColumn<Ciphertext>()(name), { label: config.label });
}

export function blindIndexColumn<TName extends string, P extends string>(
  name: TName,
  config: { purpose: P },
) {
  return Object.assign(byteaColumn<BlindIndex<P>>()(name), { purpose: config.purpose });
}
