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
  "xmp",
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
  exclusiveFilter(frame) {
    return CONTAINER_TAGS.includes(frame.tag);
  },
  allowVulnerableTags: false,
};

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
  const cleaned = sanitizeHtml(input, SANITIZE_OPTIONS);
  return normaliseEmpty(cleaned);
}
