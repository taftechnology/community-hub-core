import tokens from "./tokens.json" with { type: "json" };

export { tokens };
export type Tokens = typeof tokens;

export {
  BANNED_PREFIXES,
  contrastRatio,
  contrastViolations,
  decorativeViolations,
  generateTokens,
  missingPairViolations,
  namespaceViolations,
  selfReferenceViolations,
  validateTokens,
} from "./generate.js";
export type { Violation } from "./generate.js";
