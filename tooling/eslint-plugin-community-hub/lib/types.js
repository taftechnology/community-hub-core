import * as ts from "typescript";

const CIPHERTEXT_BRAND = "__ciphertext";
const BLIND_INDEX_BRAND = "__blindIndex";

export function unwrapTypes(type) {
  const out = [];
  const seen = new Set();

  function visit(current) {
    if (!current || seen.has(current)) {
      return;
    }
    seen.add(current);
    if (typeof current.isUnion === "function" && current.isUnion()) {
      for (const inner of current.types) {
        visit(inner);
      }
      return;
    }
    if (typeof current.isIntersection === "function" && current.isIntersection()) {
      for (const inner of current.types) {
        visit(inner);
      }
    }
    const flags = current.flags;
    if (
      flags & ts.TypeFlags.Null ||
      flags & ts.TypeFlags.Undefined ||
      flags & ts.TypeFlags.Void ||
      flags & ts.TypeFlags.Never
    ) {
      return;
    }
    out.push(current);
  }

  visit(type);
  return out;
}

export function typeOfSymbol(checker, symbol) {
  if (!symbol) {
    return undefined;
  }
  if (typeof checker.getTypeOfSymbol === "function") {
    return checker.getTypeOfSymbol(symbol);
  }
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (decl) {
    return checker.getTypeOfSymbolAtLocation(symbol, decl);
  }
  return undefined;
}

function typeArgumentsOf(type, checker) {
  const args = [];
  if (Array.isArray(type.aliasTypeArguments)) {
    args.push(...type.aliasTypeArguments);
  }
  const objectFlags = type.objectFlags ?? 0;
  if (objectFlags & ts.ObjectFlags.Reference) {
    try {
      args.push(...checker.getTypeArguments(type));
    } catch {
      // not a type reference
    }
  }
  if (Array.isArray(type.typeArguments)) {
    args.push(...type.typeArguments);
  }
  return args;
}

function hasBrand(type, name) {
  return type.getProperty(name) != null;
}

function looksLikeColumnConfig(type) {
  return Boolean(
    type.getProperty("data") &&
    (type.getProperty("columnType") ||
      type.getProperty("dataType") ||
      type.getProperty("tableName")),
  );
}

/**
 * Classify a TypeScript type for Ciphertext / BlindIndex brands.
 * Own brands sit on the value type. Nested brands come from Drizzle columns
 * and SQL wrappers (`_.data`, `_.type`, type arguments).
 */
export function classifyType(type, checker, seen = new WeakSet()) {
  const result = {
    ciphertext: false,
    blindIndex: false,
    ownCiphertext: false,
    ownBlindIndex: false,
    isArray: false,
  };
  if (!type || seen.has(type)) {
    return result;
  }

  for (const current of unwrapTypes(type)) {
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (hasBrand(current, CIPHERTEXT_BRAND)) {
      result.ciphertext = true;
      result.ownCiphertext = true;
    }
    if (hasBrand(current, BLIND_INDEX_BRAND)) {
      result.blindIndex = true;
      result.ownBlindIndex = true;
    }

    if (
      (typeof checker.isArrayType === "function" && checker.isArrayType(current)) ||
      (typeof checker.isTupleType === "function" && checker.isTupleType(current))
    ) {
      result.isArray = true;
    }

    const underscore = current.getProperty("_");
    if (underscore) {
      const wrapper = typeOfSymbol(checker, underscore);
      if (wrapper) {
        for (const field of ["data", "type"]) {
          const prop = wrapper.getProperty(field);
          const inner = typeOfSymbol(checker, prop);
          if (!inner) {
            continue;
          }
          const nested = classifyType(inner, checker, seen);
          result.ciphertext ||= nested.ciphertext;
          result.blindIndex ||= nested.blindIndex;
        }
      }
    }

    if (looksLikeColumnConfig(current)) {
      const dataProp = current.getProperty("data");
      const inner = typeOfSymbol(checker, dataProp);
      if (inner) {
        const nested = classifyType(inner, checker, seen);
        result.ciphertext ||= nested.ciphertext;
        result.blindIndex ||= nested.blindIndex;
      }
    }

    for (const arg of typeArgumentsOf(current, checker)) {
      const nested = classifyType(arg, checker, seen);
      result.ciphertext ||= nested.ciphertext;
      result.blindIndex ||= nested.blindIndex;
      if (result.isArray) {
        result.ownCiphertext ||= nested.ownCiphertext;
        result.ownBlindIndex ||= nested.ownBlindIndex;
      }
    }
  }

  return result;
}

export function isBranded(classification) {
  return classification.ciphertext || classification.blindIndex;
}

export function isBrandedColumn(classification) {
  return (
    isBranded(classification) && !classification.ownCiphertext && !classification.ownBlindIndex
  );
}

export function isBrandedValue(classification) {
  return classification.ownCiphertext || classification.ownBlindIndex;
}

export function isSqlType(type, checker) {
  if (!type) {
    return false;
  }
  if (type.flags & ts.TypeFlags.StringLike) {
    return false;
  }
  for (const current of unwrapTypes(type)) {
    if (current.flags & ts.TypeFlags.StringLike) {
      return false;
    }
    if (typeNames(current).has("SQL")) {
      return true;
    }
  }
  if (typeof checker?.typeToString === "function" && checker.typeToString(type) === "SQL") {
    return true;
  }
  return typeNames(type).has("SQL");
}

export function isKmsPortMethodType(type) {
  if (!type || typeof type.getCallSignatures !== "function") {
    return false;
  }
  for (const sig of type.getCallSignatures()) {
    const decl = sig.declaration;
    if (!decl) {
      continue;
    }
    let current = decl.parent;
    while (current) {
      if (
        (current.kind === ts.SyntaxKind.InterfaceDeclaration ||
          current.kind === ts.SyntaxKind.TypeAliasDeclaration) &&
        current.name &&
        String(current.name.escapedText ?? current.name.text) === "KmsPort"
      ) {
        return true;
      }
      current = current.parent;
    }
  }
  return false;
}

function nodeText(node) {
  if (!node) {
    return "";
  }
  if (typeof node.getText === "function") {
    return node.getText();
  }
  return String(node.escapedText ?? node.text ?? "");
}

export function identifierIsKmsPortMethod(tsNode, checker) {
  if (!tsNode || !checker) {
    return false;
  }
  if (isKmsPortMethodType(checker.getTypeAtLocation(tsNode))) {
    return true;
  }
  const symbol = checker.getSymbolAtLocation(tsNode);
  if (!symbol) {
    return false;
  }
  for (const decl of symbol.declarations ?? []) {
    if (ts.isBindingElement(decl)) {
      const name = nodeText(decl.propertyName ?? decl.name);
      if (name !== "decrypt" && name !== "generateDataKey") {
        continue;
      }
      const pattern = decl.parent;
      if (!ts.isObjectBindingPattern(pattern)) {
        continue;
      }
      const variable = pattern.parent;
      if (!ts.isVariableDeclaration(variable) || !variable.initializer) {
        continue;
      }
      if (typeNames(checker.getTypeAtLocation(variable.initializer)).has("KmsPort")) {
        return true;
      }
    }
    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isPropertyAccessExpression(decl.initializer)
    ) {
      const prop = nodeText(decl.initializer.name);
      if (prop !== "decrypt" && prop !== "generateDataKey") {
        continue;
      }
      if (typeNames(checker.getTypeAtLocation(decl.initializer.expression)).has("KmsPort")) {
        return true;
      }
    }
  }
  return false;
}

export function typeNames(type) {
  const names = new Set();
  function add(symbol) {
    if (!symbol) {
      return;
    }
    if (typeof symbol.getName === "function") {
      names.add(symbol.getName());
    }
    if (symbol.escapedName) {
      names.add(String(symbol.escapedName));
    }
  }
  for (const current of unwrapTypes(type)) {
    add(current.aliasSymbol);
    add(typeof current.getSymbol === "function" ? current.getSymbol() : current.symbol);
  }
  return names;
}
