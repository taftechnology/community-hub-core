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
const COLUMN_CONSTRUCTORS = new Set(["encryptedColumn", "blindIndexColumn"]);
const TABLE_DEFINITIONS = new Set(["table", "pgTable"]);

function isBannedExecuteArg(node, services, checker) {
  if (!node) {
    return false;
  }
  if (isStringish(node)) {
    return true;
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
  if (TABLE_DEFINITIONS.has(name) && COLUMN_CONSTRUCTORS.has(getCalleeName(node))) {
    return true;
  }
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

function isDirectBrandedArg(node, services, checker) {
  let current = node;
  while (
    current &&
    (current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "ChainExpression")
  ) {
    current = current.expression;
  }
  if (
    !current ||
    current.type === "CallExpression" ||
    current.type === "TaggedTemplateExpression" ||
    current.type === "NewExpression"
  ) {
    return false;
  }
  return isBranded(classifyNode(current, services, checker));
}

function isAllowlistedCallee(node) {
  const name = getCalleeName(node);
  if (CRYPTO_VALUE_CALLEES.has(name) || SELECT_LIKE.has(name)) {
    return true;
  }
  if (name === "eq" || name === "inArray" || name === "execute" || name === "as") {
    return true;
  }
  if (CONFLICT.has(name)) {
    return true;
  }
  return name === "on" && isIndexOnCall(node);
}

function walk(node, reported, onLeaf, calls = "skip") {
  if (!node || reported.has(node)) {
    return;
  }
  switch (node.type) {
    case "ArrayExpression":
      for (const element of node.elements) {
        walk(element, reported, onLeaf, calls);
      }
      return;
    case "ObjectExpression":
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          walk(property.argument, reported, onLeaf, calls);
        } else {
          walk(property.value, reported, onLeaf, calls);
        }
      }
      return;
    case "SpreadElement":
      walk(node.argument, reported, onLeaf, calls);
      return;
    case "ConditionalExpression":
      walk(node.consequent, reported, onLeaf, calls);
      walk(node.alternate, reported, onLeaf, calls);
      return;
    case "LogicalExpression":
    case "BinaryExpression":
      walk(node.left, reported, onLeaf, calls);
      walk(node.right, reported, onLeaf, calls);
      return;
    case "ChainExpression":
      walk(node.expression, reported, onLeaf, calls);
      return;
    case "AwaitExpression":
      walk(node.argument, reported, onLeaf, calls);
      return;
    case "TSNonNullExpression":
      walk(node.expression, reported, onLeaf, calls);
      return;
    case "TSSatisfiesExpression":
      walk(node.expression, reported, onLeaf, calls);
      return;
    case "TSAsExpression":
    case "TSTypeAssertion":
      return;
    case "CallExpression":
    case "TaggedTemplateExpression":
    case "NewExpression":
      if (calls === "leaf") {
        onLeaf(node);
      }
      return;
    default:
      onLeaf(node);
  }
}

function inspect(node, context, services, checker, reported, extra = {}) {
  walk(node, reported, (leaf) => {
    const classification = classifyNode(leaf, services, checker);
    if (!isBranded(classification)) {
      return;
    }
    if (
      !extra.forceDisallow &&
      isAllowed(leaf, classification, services, checker, context.filename)
    ) {
      return;
    }
    reported.add(leaf);
    context.report({ node: leaf, messageId: "query" });
  });
}

function typeOfEsNode(node, services, checker) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return tsNode ? checker.getTypeAtLocation(tsNode) : undefined;
}

function assignedType(node, services, checker) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  if (tsNode) {
    try {
      const contextual = checker.getContextualType(tsNode);
      if (contextual) {
        return contextual;
      }
    } catch {
      // not an expression TypeScript will contextualise
    }
  }
  const parent = node.parent;
  if (!parent) {
    return undefined;
  }
  if (parent.type === "AssignmentPattern") {
    return typeOfEsNode(parent.left, services, checker);
  }
  if (parent.type === "PropertyDefinition" || parent.type === "Property") {
    return typeOfEsNode(parent, services, checker);
  }
  if (parent.type === "VariableDeclarator") {
    return typeOfEsNode(parent.id, services, checker);
  }
  if (parent.type === "AssignmentExpression") {
    return typeOfEsNode(parent.left, services, checker);
  }
  if (parent.type === "TSSatisfiesExpression") {
    const annotation = parent.typeAnnotation;
    if (!annotation) {
      return undefined;
    }
    const tsAnn = services.esTreeNodeToTSNodeMap.get(annotation);
    return tsAnn && typeof checker.getTypeFromTypeNode === "function"
      ? checker.getTypeFromTypeNode(tsAnn)
      : undefined;
  }
  return undefined;
}

function inspectWiden(node, context, services, checker, reported) {
  if (isCryptoSource(context.filename)) {
    return;
  }
  walk(
    node,
    reported,
    (leaf) => {
      const classification = classifyNode(leaf, services, checker);
      if (!isBranded(classification) || isBrandedValue(classification)) {
        return;
      }
      if (leaf.type === "CallExpression" && isAllowlistedCallee(leaf)) {
        return;
      }
      if (isAllowed(leaf, classification, services, checker, context.filename)) {
        return;
      }
      const dest = assignedType(leaf, services, checker);
      if (!dest || isBranded(classifyType(dest, checker))) {
        return;
      }
      reported.add(leaf);
      context.report({ node: leaf, messageId: "query" });
    },
    "leaf",
  );
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
        if (isAllowlistedCallee(node)) {
          return;
        }
        if (!innermostCallOrTag(node)) {
          return;
        }
        if (reported.has(node)) {
          return;
        }
        if (node.arguments.some((argument) => isDirectBrandedArg(argument, services, checker))) {
          return;
        }
        const classification = classifyNode(node, services, checker);
        if (!isBranded(classification) || isBrandedValue(classification)) {
          return;
        }
        if (isAllowed(node, classification, services, checker, context.filename)) {
          return;
        }
        reported.add(node);
        context.report({ node, messageId: "query" });
      },
      NewExpression(node) {
        for (const argument of node.arguments) {
          inspect(argument, context, services, checker, reported);
        }
      },
      VariableDeclarator(node) {
        inspectWiden(node.init, context, services, checker, reported);
      },
      AssignmentExpression(node) {
        inspectWiden(node.right, context, services, checker, reported);
      },
      ReturnStatement(node) {
        inspectWiden(node.argument, context, services, checker, reported);
      },
      ArrowFunctionExpression(node) {
        if (node.body.type !== "BlockStatement") {
          inspectWiden(node.body, context, services, checker, reported);
        }
      },
      AssignmentPattern(node) {
        inspectWiden(node.right, context, services, checker, reported);
      },
      PropertyDefinition(node) {
        inspectWiden(node.value, context, services, checker, reported);
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
