import { isTestFile } from "../lib/ast.js";

function isPlaintextSource(value) {
  return (
    typeof value === "string" &&
    (value === "@community-hub/db/plaintext" ||
      value === "./plaintext" ||
      value.endsWith("/plaintext") ||
      value.endsWith("/plaintext.ts") ||
      value.endsWith("/plaintext.js"))
  );
}

function sourceText(node) {
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

function checkSource(node, context) {
  if (isPlaintextSource(sourceText(node))) {
    context.report({ node, messageId: "plaintext" });
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Ban plaintext database constructors from non-test source",
    },
    schema: [],
    messages: {
      plaintext: "Plaintext database constructors are test-only and cannot be imported from src.",
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
      ExportAllDeclaration(node) {
        checkSource(node.source, context);
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          checkSource(node.source, context);
        }
      },
    };
  },
};
