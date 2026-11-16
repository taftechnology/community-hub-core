import { isTestFile } from "../lib/ast.js";

const BANNED = new Set(["@community-hub/crypto/testing", "@community-hub/access/testing"]);

function checkSource(node, context) {
  if (node.type === "Literal" && BANNED.has(node.value)) {
    context.report({
      node,
      messageId: "testing",
      data: { module: node.value },
    });
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban @community-hub/crypto/testing and @community-hub/access/testing imports from non-test source",
    },
    schema: [],
    messages: {
      testing: "{{module}} is test-only and cannot be imported from src.",
    },
  },
  create(context) {
    if (isTestFile(context.filename)) {
      return {};
    }
    return {
      ImportDeclaration(node) {
        checkSource(node.source, context);
      },
      ImportExpression(node) {
        checkSource(node.source, context);
      },
    };
  },
};
