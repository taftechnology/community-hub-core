import noCryptoTestingImport from "./rules/no-crypto-testing-import.js";
import noDbPlaintextImport from "./rules/no-db-plaintext-import.js";
import noEncryptedColumnQuery from "./rules/no-encrypted-column-query.js";
import noEventPayload from "./rules/no-event-payload.js";
import noKmsPortOutsideCrypto from "./rules/no-kms-port-outside-crypto.js";
import noRestrictedDisable from "./rules/no-restricted-disable.js";
import noTsIgnore from "./rules/no-ts-ignore.js";

const plugin = {
  meta: {
    name: "@community-hub/eslint-plugin",
    version: "0.0.0",
  },
  rules: {
    "no-encrypted-column-query": noEncryptedColumnQuery,
    "no-event-payload": noEventPayload,
    "no-kms-port-outside-crypto": noKmsPortOutsideCrypto,
    "no-restricted-disable": noRestrictedDisable,
    "no-ts-ignore": noTsIgnore,
    "no-crypto-testing-import": noCryptoTestingImport,
    "no-db-plaintext-import": noDbPlaintextImport,
  },
};

export default plugin;
