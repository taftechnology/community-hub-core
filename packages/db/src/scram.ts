import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

const DEFAULT_ITERATIONS = 4096;
const SALT_BYTES = 16;
const DK_LEN = 32;

export function scramSha256Verifier(
  password: string,
  options?: { salt?: Buffer; iterations?: number },
): string {
  const iterations = options?.iterations ?? DEFAULT_ITERATIONS;
  const salt = options?.salt ?? randomBytes(SALT_BYTES);
  const saltedPassword = pbkdf2Sync(password, salt, iterations, DK_LEN, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
