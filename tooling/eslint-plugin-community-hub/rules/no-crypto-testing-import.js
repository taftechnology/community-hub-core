import { isTestFile } from "../lib/ast.js";

const TESTING = "@community-hub/crypto/testing";

function checkSource(node, context) {
  if (node.type === "Literal" && node.value === TESTING) {
    context.report({ node, messageId: "testing" });
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Ban @community-hub/crypto/testing imports from non-test source",
    },
    schema: [],
    messages: {
      testing: "@community-hub/crypto/testing is test-only and cannot be imported from src.",
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
