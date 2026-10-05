import * as ts from "typescript";

export function getCalleeName(node) {
  if (!node || node.type !== "CallExpression") {
    return null;
  }
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return callee.name;
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

export function containsNode(root, target) {
  let current = target;
  while (current) {
    if (current === root) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function innermostCallOrTag(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (parent.type === "CallExpression" || parent.type === "NewExpression") {
      const inArgs = parent.arguments.some((arg) => arg === current || containsNode(arg, current));
      if (inArgs) {
        return parent;
      }
    }
    if (parent.type === "TaggedTemplateExpression") {
      const inQuasi = parent.quasi.expressions.some(
        (expr) => expr === current || containsNode(expr, current),
      );
      if (inQuasi) {
        return parent;
      }
    }
    current = parent;
  }
  return null;
}

export function isSqlTag(tag) {
  if (!tag) {
    return false;
  }
  if (tag.type === "Identifier") {
    return tag.name === "sql";
  }
  if (tag.type === "MemberExpression" && !tag.computed && tag.property.type === "Identifier") {
    return tag.property.name === "sql";
  }
  return false;
}

function followAlias(checker, symbol) {
  if (!symbol) {
    return symbol;
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }
  return symbol;
}

export function isDrizzleSqlObject(node, services, checker) {
  if (!node) {
    return false;
  }
  if (node.type === "Identifier") {
    if (node.name === "sql") {
      return true;
    }
    if (!services || !checker) {
      return false;
    }
    const tsNode = services.esTreeNodeToTSNodeMap.get(node);
    if (!tsNode) {
      return false;
    }
    const symbol = followAlias(checker, checker.getSymbolAtLocation(tsNode));
    return Boolean(symbol && symbol.getName() === "sql");
  }
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return node.property.name === "sql";
  }
  return false;
}

export function isSqlRawCall(node, services, checker) {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") {
    return false;
  }
  const callee = node.callee;
  if (callee.computed || callee.property.type !== "Identifier" || callee.property.name !== "raw") {
    return false;
  }
  return isDrizzleSqlObject(callee.object, services, checker);
}

export function isStringish(node) {
  if (!node) {
    return false;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return true;
  }
  if (node.type === "TemplateLiteral") {
    return true;
  }
  return false;
}

export function ancestorPropertyNames(node) {
  const names = [];
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (parent.type === "Property") {
      if (parent.key.type === "Identifier") {
        names.push(parent.key.name);
      } else if (parent.key.type === "Literal") {
        names.push(String(parent.key.value));
      }
    }
    current = parent;
  }
  return names;
}

export function isIndexOnCall(node) {
  if (getCalleeName(node) !== "on" || node.callee.type !== "MemberExpression") {
    return false;
  }
  const object = node.callee.object;
  if (object.type !== "CallExpression") {
    return false;
  }
  const inner = getCalleeName(object);
  return inner === "index" || inner === "uniqueIndex";
}

export function isCryptoSource(filename) {
  const normalized = filename.replaceAll("\\", "/");
  return normalized.includes("/packages/crypto/src/");
}

export function isTestFile(filename) {
  const normalized = filename.replaceAll("\\", "/");
  return (
    /\.test\.ts$/.test(normalized) ||
    /\/tests?\//.test(normalized) ||
    /\/src\/testing\.ts$/.test(normalized)
  );
}

export const QUERY_RULE_IDS = [
  "@community-hub/no-encrypted-column-query",
  "@community-hub/no-event-payload",
  "@community-hub/no-kms-port-outside-crypto",
  "@community-hub/no-restricted-disable",
  "@community-hub/no-ts-ignore",
  "@community-hub/no-crypto-testing-import",
  "@community-hub/no-db-plaintext-import",
];
