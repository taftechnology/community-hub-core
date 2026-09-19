import { isTestFile } from "../lib/ast.js";

const TS_IGNORE_RE = /@ts-(?:ignore|expect-error)\b/u;

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Ban @ts-ignore and @ts-expect-error in non-test source",
    },
    schema: [],
    messages: {
      tsIgnore: "{{directive}} is banned in non-test source.",
    },
  },
  create(context) {
    if (isTestFile(context.filename)) {
      return {};
    }
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = TS_IGNORE_RE.exec(comment.value);
          if (!match) {
            continue;
          }
          context.report({
            loc: comment.loc,
            messageId: "tsIgnore",
            data: { directive: match[0] },
          });
        }
      },
    };
  },
};
