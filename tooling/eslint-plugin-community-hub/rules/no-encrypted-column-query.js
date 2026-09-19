import { ESLintUtils } from "@typescript-eslint/utils";

import {
  ancestorPropertyNames,
  getCalleeName,
  innermostCallOrTag,
  isCryptoSource,
  isIndexOnCall,
  isSqlRawCall,
  isSqlTag,
  isStringish,
} from "../lib/ast.js";
import {
  classifyType,
  isBranded,
  isBrandedColumn,
  isBrandedValue,
  isSqlType,
} from "../lib/types.js";

const SELECT_LIKE = new Set(["select", "returning", "values", "set"]);
const CONFLICT = new Set(["onConflictDoNothing", "onConflictDoUpdate"]);
const CRYPTO_VALUE_CALLEES = new Set(["decrypt", "encrypt", "blindIndex", "insertEncrypted"]);

function isBannedExecuteArg(node, services, checker) {
  if (!node) {
    return false;
  }
  if (isStringish(node)) {
    return true;
  }
  if (node.type !== "Identifier") {
    return false;
  }
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  if (!tsNode) {
    return true;
  }
  return !isSqlType(checker.getTypeAtLocation(tsNode), checker);
}

function classifyNode(node, services, checker) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  if (!tsNode) {
    return {
      ciphertext: false,
      blindIndex: false,
      ownCiphertext: false,
      ownBlindIndex: false,
      isArray: false,
    };
  }
  return classifyType(checker.getTypeAtLocation(tsNode), checker);
}

function isAllowedBlindLookup(call, services, checker) {
  const name = getCalleeName(call);
  if ((name !== "eq" && name !== "inArray") || call.arguments.length < 2) {
    return false;
  }
  const left = classifyNode(call.arguments[0], services, checker);
  const right = classifyNode(call.arguments[1], services, checker);
  if (!left.blindIndex || left.ciphertext || !right.blindIndex || right.ciphertext) {
    return false;
  }
  if (!isBrandedColumn(left) || isBrandedColumn(right)) {
    return false;
  }
  if (name === "eq") {
    return isBrandedValue(right) && !right.isArray;
  }
  return right.isArray || isBrandedValue(right);
}

function isAllowed(node, classification, services, checker, filename) {
  if (isCryptoSource(filename)) {
    return true;
  }
  const enclosing = innermostCallOrTag(node);
  if (!enclosing) {
    return false;
  }
  if (enclosing.type === "TaggedTemplateExpression" && isSqlTag(enclosing.tag)) {
    return false;
  }
  if (enclosing.type !== "CallExpression") {
    return false;
  }
  const name = getCalleeName(enclosing);
  if (CRYPTO_VALUE_CALLEES.has(name)) {
    return true;
  }
  if (SELECT_LIKE.has(name)) {
    return true;
  }
  if (name === "eq" || name === "inArray") {
    return isAllowedBlindLookup(enclosing, services, checker);
  }
  if (name === "on" && isIndexOnCall(enclosing)) {
    return (
      classification.blindIndex && !classification.ciphertext && isBrandedColumn(classification)
    );
  }
  if (CONFLICT.has(name)) {
    const props = ancestorPropertyNames(node);
    if (props.includes("set")) {
      return true;
    }
    if (props.includes("target")) {
      return (
        classification.blindIndex && !classification.ciphertext && isBrandedColumn(classification)
      );
    }
  }
  return false;
}

function inspect(node, context, services, checker, reported, extra = {}) {
  if (!node || reported.has(node)) {
    return;
  }
  switch (node.type) {
    case "ArrayExpression":
      for (const element of node.elements) {
        inspect(element, context, services, checker, reported, extra);
      }
      return;
    case "ObjectExpression":
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          inspect(property.argument, context, services, checker, reported, extra);
        } else {
          inspect(property.value, context, services, checker, reported, extra);
        }
      }
      return;
    case "SpreadElement":
      inspect(node.argument, context, services, checker, reported, extra);
      return;
    case "ConditionalExpression":
      inspect(node.consequent, context, services, checker, reported, extra);
      inspect(node.alternate, context, services, checker, reported, extra);
      return;
    case "LogicalExpression":
    case "BinaryExpression":
      inspect(node.left, context, services, checker, reported, extra);
      inspect(node.right, context, services, checker, reported, extra);
      return;
    case "ChainExpression":
      inspect(node.expression, context, services, checker, reported, extra);
      return;
    case "TSNonNullExpression":
      inspect(node.expression, context, services, checker, reported, extra);
      return;
    case "TSAsExpression":
    case "TSTypeAssertion":
    case "TSSatisfiesExpression":
      return;
    case "CallExpression":
    case "TaggedTemplateExpression":
    case "NewExpression":
      return;
    default: {
      const classification = classifyNode(node, services, checker);
      if (!isBranded(classification)) {
        return;
      }
      if (
        !extra.forceDisallow &&
        isAllowed(node, classification, services, checker, context.filename)
      ) {
        return;
      }
      reported.add(node);
      context.report({ node, messageId: "query" });
    }
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow querying Ciphertext/BlindIndex values except the documented allow-list",
    },
    schema: [],
    messages: {
      query: "Ciphertext and blind-index values cannot be used in this query position.",
      sqlRaw: "sql.raw is banned; it bypasses encrypted-column typing.",
      executeString: "db.execute with a string is banned; it bypasses encrypted-column typing.",
      cast: "Casting to or from Ciphertext/BlindIndex is banned outside @community-hub/crypto.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const reported = new WeakSet();

    function checkCast(node) {
      if (isCryptoSource(context.filename)) {
        return;
      }
      const result = classifyNode(node, services, checker);
      const operand = classifyNode(node.expression, services, checker);
      if (!isBranded(result) && !isBranded(operand)) {
        return;
      }
      reported.add(node);
      context.report({ node, messageId: "cast" });
    }

    return {
      CallExpression(node) {
        if (isSqlRawCall(node, services, checker)) {
          context.report({ node: node.arguments[0] ?? node, messageId: "sqlRaw" });
        }
        if (getCalleeName(node) === "execute") {
          const arg = node.arguments[0];
          if (arg && isBannedExecuteArg(arg, services, checker)) {
            context.report({ node: arg, messageId: "executeString" });
          }
        }
        for (const argument of node.arguments) {
          inspect(argument, context, services, checker, reported);
        }
        if (getCalleeName(node) === "as" && node.callee.type === "MemberExpression") {
          inspect(node.callee.object, context, services, checker, reported, {
            forceDisallow: true,
          });
        }
      },
      TaggedTemplateExpression(node) {
        if (!isSqlTag(node.tag)) {
          return;
        }
        for (const expression of node.quasi.expressions) {
          inspect(expression, context, services, checker, reported, {
            forceDisallow: true,
          });
        }
      },
      TSAsExpression: checkCast,
      TSTypeAssertion: checkCast,
    };
  },
};
