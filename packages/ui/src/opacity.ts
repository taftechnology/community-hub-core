const HOVER_UTILITY = /(?:^|\s)(?:dark:)?hover:[^\s"'`,]+/g;

function stripHoverUtilities(source: string): string {
  return source.replace(HOVER_UTILITY, " ");
}

function extractClassTokens(source: string): string[] {
  const tokens: string[] = [];
  const pattern =
    /(?<![\w-])((?:[a-z][\w-]*:)*[\w[\]./%+-]+(?:\/[\d.]+)?)(?![\w-])/gi;
  for (const match of source.matchAll(pattern)) {
    const token = match[1];
    if (token !== undefined && token.includes("/")) {
      tokens.push(token);
    }
  }
  return tokens;
}

function isRingOpacityUtility(token: string): boolean {
  return /(^|:)ring-/.test(token);
}

function isFocusVisibleBorderOrOutlineOpacity(token: string): boolean {
  return /focus-visible:(border-|outline-)/.test(token);
}

function isDefaultBackgroundOpacity(token: string): boolean {
  const slash = token.lastIndexOf("/");
  if (slash === -1) {
    return false;
  }
  const withoutOpacity = token.slice(0, slash);
  const colon = withoutOpacity.lastIndexOf(":");
  const utility = colon === -1 ? withoutOpacity : withoutOpacity.slice(colon + 1);
  if (!utility.startsWith("bg-")) {
    return false;
  }
  if (colon === -1) {
    return true;
  }
  const variants = withoutOpacity.slice(0, colon).split(":");
  if (variants.some((variant) => variant === "aria-expanded" || variant === "active")) {
    return false;
  }
  return variants.every((variant) => variant === "dark");
}

export function opacityViolations(source: string): string[] {
  const scanned = stripHoverUtilities(source);
  const hits: string[] = [];
  for (const token of extractClassTokens(scanned)) {
    if (
      isRingOpacityUtility(token) ||
      isFocusVisibleBorderOrOutlineOpacity(token) ||
      isDefaultBackgroundOpacity(token)
    ) {
      hits.push(token);
    }
  }
  return hits;
}
