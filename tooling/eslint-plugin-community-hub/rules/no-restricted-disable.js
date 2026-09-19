import { QUERY_RULE_IDS } from "../lib/ast.js";

const DISABLE_RE = /^\s*eslint-disable(?:-next-line|-line)?(?:\s+(.+))?$/u;

function listedRuleIds(list) {
  if (!list) {
    return ["*"];
  }
  const withoutComment = list.split("--", 1)[0] ?? list;
  return withoutComment
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Ban eslint-disable for community-hub encrypted-column rules",
    },
    schema: [],
    messages: {
      disable: "eslint-disable for {{id}} is banned.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = DISABLE_RE.exec(comment.value);
          if (!match) {
            continue;
          }
          const ids = listedRuleIds(match[1]);
          if (ids.includes("*")) {
            context.report({ loc: comment.loc, messageId: "disable", data: { id: "*" } });
            continue;
          }
          for (const id of ids) {
            if (QUERY_RULE_IDS.includes(id)) {
              context.report({ loc: comment.loc, messageId: "disable", data: { id } });
            }
          }
        }
      },
    };
  },
};
