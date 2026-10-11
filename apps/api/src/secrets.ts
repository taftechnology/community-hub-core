import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

import type { SecretReader } from "./checkout.js";

export function secretsManagerReader(client: {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}): SecretReader {
  return async (arn, stage) => {
    const result = await client.send(
      new GetSecretValueCommand({
        SecretId: arn,
        VersionStage: stage,
      }),
    );
    if (typeof result.SecretString !== "string") {
      throw new Error("secret_unavailable");
    }
    return result.SecretString;
  };
}
