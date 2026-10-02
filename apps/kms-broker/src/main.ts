import { KMSClient } from "@aws-sdk/client-kms";

import { createAwsBrokerKms } from "./aws-kms-adapter.js";
import { assertEnvelopeKeyArn, createServer } from "./server.js";

function readEnvelopeKeyArn(): string {
  try {
    return assertEnvelopeKeyArn(process.env.ENVELOPE_KEY_ARN ?? "");
  } catch {
    process.exit(1);
  }
}

const envelopeKeyArn = readEnvelopeKeyArn();

const client = new KMSClient({
  region: "ap-southeast-2",
  maxAttempts: 1,
});

const kms = createAwsBrokerKms(client);

const { start } = createServer({ kms, envelopeKeyArn });

start((err) => {
  if (err) {
    process.exit(1);
  }
});
