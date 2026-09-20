import { ESLintUtils } from "@typescript-eslint/utils";
import * as ts from "typescript";

import { getCalleeName } from "../lib/ast.js";
import { typeNames, typeOfSymbol, unwrapTypes } from "../lib/types.js";

// Must match the spec / packages/kernel EVENT_NAME_RE (do not import kernel from the plugin).
const EVENT_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.v[1-9][0-9]*$/;

// Same list as docs/specs/2026-09-19-kernel-runtime.md (second line; a UUID field named email still fails).
const BANNED_KEYS = new Set([
  "name",
  "email",
  "emailAddress",
  "e_mail",
  "full_name",
  "fullName",
  "dob",
  "dateOfBirth",
  "address",
  "phone",
  "notes",
  "note",
  "comment",
  "label",
  "amount",
]);

const ALLOWED_LEAVES = new Set([
  "ZodUUID",
  "$ZodUUID",
  "ZodEnum",
  "$ZodEnum",
  "ZodBoolean",
  "$ZodBoolean",
  "ZodInt",
  "$ZodInt",
  "ZodInt32",
  "$ZodInt32",
  "ZodISODateTime",
  "$ZodISODateTime",
  "ZodDate",
  "$ZodDate",
]);

const OBJECT_NAMES = new Set(["ZodObject", "$ZodObject"]);
const RECORD_NAMES = new Set(["ZodRecord", "$ZodRecord"]);
const WRAPPER_NAMES = new Set([
  "ZodOptional",
  "$ZodOptional",
  "ZodNullable",
  "$ZodNullable",
  "ZodDefault",
  "$ZodDefault",
]);
const LOOSE_CONFIG = new Set(["$loose", "$catchall"]);
const BANNED_CALLEES = new Set(["record", "passthrough", "catchall", "loose", "looseObject"]);
const EXTEND_CALLEES = new Set(["extend", "safeExtend", "merge"]);

function namesOf(type) {
  return typeNames(type);
}

function hasAnyName(type, set) {
  const names = namesOf(type);
  for (const name of set) {
    if (names.has(name)) {
      return true;
    }
  }
  return false;
}

function typeOfNode(node, services, checker) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return tsNode ? checker.getTypeAtLocation(tsNode) : undefined;
}

function stringLiteralValue(node, services, checker) {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? null;
  }
  const type = typeOfNode(node, services, checker);
  if (!type) {
    return null;
  }
  if (typeof type.isStringLiteral === "function" && type.isStringLiteral()) {
    return type.value;
  }
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return type.value;
  }
  return null;
}

function propertyValue(object, name) {
  if (!object || object.type !== "ObjectExpression") {
    return { spread: false, value: undefined };
  }
  let spread = false;
  let value;
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      spread = true;
      continue;
    }
    if (property.type !== "Property" || property.computed) {
      continue;
    }
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal"
          ? String(property.key.value)
          : null;
    if (key === name) {
      value = property.value;
    }
  }
  return { spread, value };
}

function isStaticObject(node) {
  return Boolean(
    node &&
    node.type === "ObjectExpression" &&
    node.properties.every((property) => property.type !== "SpreadElement"),
  );
}

function payloadAstViolation(node, depth = 0) {
  if (!node || depth > 24) {
    return true;
  }
  switch (node.type) {
    case "SpreadElement":
      return true;
    case "ObjectExpression":
      return node.properties.some((property) =>
        payloadAstViolation(
          property.type === "SpreadElement" ? property : property.value,
          depth + 1,
        ),
      );
    case "ArrayExpression":
      return node.elements.some((element) => payloadAstViolation(element, depth + 1));
    case "CallExpression": {
      const name = getCalleeName(node);
      if (BANNED_CALLEES.has(name)) {
        return true;
      }
      if (EXTEND_CALLEES.has(name) && !isStaticObject(node.arguments[0])) {
        return true;
      }
      if (
        node.callee.type === "MemberExpression" &&
        payloadAstViolation(node.callee.object, depth + 1)
      ) {
        return true;
      }
      return node.arguments.some((argument) => payloadAstViolation(argument, depth + 1));
    }
    case "MemberExpression":
      return payloadAstViolation(node.object, depth + 1);
    case "TSAsExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "ChainExpression":
      return payloadAstViolation(node.expression, depth + 1);
    default:
      return false;
  }
}

function hasOpenStringIndex(type, checker) {
  if (!type || typeof checker.getIndexInfoOfType !== "function") {
    return false;
  }
  const info = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  if (!info) {
    return false;
  }
  return !(info.type.flags & ts.TypeFlags.Never);
}

function internalsOf(type, checker) {
  return typeOfSymbol(checker, type.getProperty("_zod"));
}

function objectIsUnreadable(type, checker) {
  const internals = internalsOf(type, checker);
  const config = typeOfSymbol(checker, internals?.getProperty("config"));
  if (config && hasAnyName(config, LOOSE_CONFIG)) {
    return true;
  }
  const output = typeOfSymbol(checker, internals?.getProperty("output"));
  if (output && hasOpenStringIndex(output, checker)) {
    return true;
  }
  const configOut = typeOfSymbol(checker, config?.getProperty("out"));
  return Boolean(configOut && hasOpenStringIndex(configOut, checker));
}

function shapeOf(type, checker) {
  return typeOfSymbol(checker, type.getProperty("shape"));
}

function unwrapSchema(type, checker, seen) {
  if (!type || seen.has(type)) {
    return [];
  }
  const out = [];
  for (const current of unwrapTypes(type)) {
    if (!current || seen.has(current)) {
      continue;
    }
    if (hasAnyName(current, WRAPPER_NAMES)) {
      const inner = typeOfSymbol(checker, current.getProperty("unwrap"));
      const def = typeOfSymbol(checker, internalsOf(current, checker)?.getProperty("def"));
      const innerType = typeOfSymbol(checker, def?.getProperty("innerType")) ?? inner;
      if (innerType) {
        out.push(...unwrapSchema(innerType, checker, seen));
        continue;
      }
    }
    out.push(current);
  }
  return out;
}

function schemaViolation(type, checker, seen = new WeakSet()) {
  if (!type) {
    return true;
  }
  if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) {
    return true;
  }
  const parts = unwrapSchema(type, checker, seen);
  if (parts.length === 0) {
    return true;
  }
  for (const current of parts) {
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (hasAnyName(current, RECORD_NAMES)) {
      return true;
    }
    if (hasAnyName(current, ALLOWED_LEAVES)) {
      continue;
    }
    if (hasAnyName(current, OBJECT_NAMES)) {
      if (objectIsUnreadable(current, checker)) {
        return true;
      }
      const shape = shapeOf(current, checker);
      if (!shape) {
        return true;
      }
      if (hasOpenStringIndex(shape, checker)) {
        return true;
      }
      const props = typeof shape.getProperties === "function" ? shape.getProperties() : [];
      for (const prop of props) {
        const key =
          typeof prop.getName === "function" ? prop.getName() : String(prop.escapedName ?? "");
        if (BANNED_KEYS.has(key)) {
          return true;
        }
        const propType = typeOfSymbol(checker, prop);
        if (schemaViolation(propType, checker, seen)) {
          return true;
        }
      }
      continue;
    }
    return true;
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Restrict defineEvent payloads to UUID, enum, boolean, integer, and timestamp fields",
    },
    schema: [],
    messages: {
      payload:
        "Event payload must use allow-listed value types (UUID, enum, boolean, integer, timestamp); banned keys and unreadable Zod shapes fail closed.",
      name: "Event name must match <module>.<entity>.<verb>.v<n>.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      CallExpression(node) {
        if (getCalleeName(node) !== "defineEvent") {
          return;
        }
        const spec = node.arguments[0];
        if (!spec) {
          context.report({ node, messageId: "payload" });
          return;
        }
        const { spread, value: nameNode } = propertyValue(spec, "name");
        const payloadNode = propertyValue(spec, "payload").value;
        if (spec.type !== "ObjectExpression" || spread || !payloadNode) {
          context.report({ node: spec, messageId: "payload" });
          if (spec.type === "ObjectExpression" && nameNode) {
            const name = stringLiteralValue(nameNode, services, checker);
            if (name === null || !EVENT_NAME_RE.test(name)) {
              context.report({ node: nameNode, messageId: "name" });
            }
          }
          return;
        }
        if (!nameNode) {
          context.report({ node: spec, messageId: "name" });
        } else {
          const name = stringLiteralValue(nameNode, services, checker);
          if (name === null || !EVENT_NAME_RE.test(name)) {
            context.report({ node: nameNode, messageId: "name" });
          }
        }
        if (
          payloadAstViolation(payloadNode) ||
          schemaViolation(typeOfNode(payloadNode, services, checker), checker)
        ) {
          context.report({ node: payloadNode, messageId: "payload" });
        }
      },
    };
  },
};
