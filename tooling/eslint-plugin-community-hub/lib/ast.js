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
    if (parent.type === "CallExpression") {
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

export function isSqlRawCall(node) {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") {
    return false;
  }
  const callee = node.callee;
  return (
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "raw" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "sql"
  );
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
  "@community-hub/no-kms-port-outside-crypto",
  "@community-hub/no-restricted-disable",
  "@community-hub/no-ts-ignore",
  "@community-hub/no-crypto-testing-import",
];
