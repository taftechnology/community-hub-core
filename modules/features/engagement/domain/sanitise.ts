import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = ["p", "br", "h1", "h2", "h3", "h4", "strong", "em", "ul", "ol", "li"];

const CONTAINER_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "template",
  "noscript",
  "textarea",
  "option",
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {},
  disallowedTagsMode: "discard",
  transformTags: {
    b: "strong",
    i: "em",
  },
  nonTextTags: CONTAINER_TAGS,
};

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function normaliseEmpty(cleaned: string): string {
  // A result with no non-whitespace text becomes ""
  // (e.g. <p></p>, <p><br></p>, <h1> </h1>, <ul><li><p></p></li></ul>).
  const textContent = cleaned.replace(/<[^>]+>/g, "").replace(/[ \t\n\r]/g, "");
  if (textContent.length === 0) {
    return "";
  }
  return cleaned;
}

export function sanitiseServiceTimesHtml(input: string): string {
  const prepared = input.replaceAll("\u0000", "").replace(LONE_SURROGATE_RE, "\uFFFD");
  const cleaned = sanitizeHtml(prepared, SANITIZE_OPTIONS);
  return normaliseEmpty(cleaned);
}
