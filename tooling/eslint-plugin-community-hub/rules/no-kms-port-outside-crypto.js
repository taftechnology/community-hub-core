import { ESLintUtils } from "@typescript-eslint/utils";

import { getCalleeName, isCryptoSource } from "../lib/ast.js";
import { identifierIsKmsPortMethod, typeNames } from "../lib/types.js";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow KmsPort.generateDataKey/decrypt outside packages/crypto/src",
    },
    schema: [],
    messages: {
      kmsPort:
        "KmsPort.generateDataKey/decrypt is only allowed in packages/crypto/src. Use generateKmsRoot/unwrapKmsRoot.",
    },
  },
  create(context) {
    if (isCryptoSource(context.filename)) {
      return {};
    }
    const normalized = context.filename.replaceAll("\\", "/");
    if (normalized.endsWith("/apps/api/src/probe.ts")) {
      return {};
    }
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      CallExpression(node) {
        const name = getCalleeName(node);
        if (name !== "generateDataKey" && name !== "decrypt") {
          return;
        }
        if (node.callee.type === "MemberExpression") {
          const tsNode = services.esTreeNodeToTSNodeMap.get(node.callee.object);
          if (!tsNode) {
            return;
          }
          const type = checker.getTypeAtLocation(tsNode);
          if (typeNames(type).has("KmsPort")) {
            context.report({ node, messageId: "kmsPort" });
          }
          return;
        }
        if (node.callee.type !== "Identifier") {
          return;
        }
        const tsNode = services.esTreeNodeToTSNodeMap.get(node.callee);
        if (!tsNode) {
          return;
        }
        if (identifierIsKmsPortMethod(tsNode, checker)) {
          context.report({ node, messageId: "kmsPort" });
        }
      },
    };
  },
};
