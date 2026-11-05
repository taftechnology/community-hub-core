import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_TAGS_FIXTURES,
  DROPPED_CONTAINER_FIXTURES,
  EDGE_CASE_FIXTURES,
  EMPTY_NORMALISATION_FIXTURES,
  FIXTURE_CORPUS,
  HOSTILE_INPUT_SUITE,
  UNWRAPPED_TAGS_FIXTURES,
} from "./fixtures.js";
import { sanitiseServiceTimesHtml } from "./sanitise.js";

const ALLOWED_TAGS = new Set(["p", "br", "h1", "h2", "h3", "h4", "strong", "em", "ul", "ol", "li"]);

function assertDomSafety(fragment: DocumentFragment): void {
  function walk(node: Node): void {
    if (node.nodeType === 8) {
      // COMMENT_NODE
      throw new Error(`Unexpected comment node survived: "${node.nodeValue}"`);
    }
    if (node.nodeType === 4) {
      // CDATA_SECTION_NODE
      throw new Error(`Unexpected CDATA section node survived: "${node.nodeValue}"`);
    }
    if (node.nodeType === 7) {
      // PROCESSING_INSTRUCTION_NODE
      throw new Error(`Unexpected processing instruction survived: "${node.nodeName}"`);
    }
    if (node.nodeType === 1) {
      // ELEMENT_NODE
      const el = node as Element;
      const tagName = el.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tagName)) {
        throw new Error(`Disallowed tag found in output: <${tagName}>`);
      }
      if (el.attributes.length > 0) {
        const names = Array.from(el.attributes)
          .map((a: Attr) => a.name)
          .join(", ");
        throw new Error(`Element <${tagName}> has unexpected attributes: ${names}`);
      }
    }
    for (const child of Array.from(node.childNodes)) {
      walk(child);
    }
  }

  for (const child of Array.from(fragment.childNodes)) {
    walk(child);
  }
}

describe("sanitiseServiceTimesHtml", () => {
  describe("allowed tags and transforms", () => {
    it.each(ALLOWED_TAGS_FIXTURES)("$name", ({ input, expected }) => {
      expect(sanitiseServiceTimesHtml(input)).toBe(expected);
    });

    it("transforms <b> to <strong> and <i> to <em>", () => {
      expect(sanitiseServiceTimesHtml("<b>bold</b><i>italic</i>")).toBe(
        "<strong>bold</strong><em>italic</em>",
      );
    });
  });

  describe("unwrapping disallowed non-container tags", () => {
    it.each(UNWRAPPED_TAGS_FIXTURES)("$name", ({ input, expected }) => {
      expect(sanitiseServiceTimesHtml(input)).toBe(expected);
    });
  });

  describe("container tags dropped with content (including nested allowed tags)", () => {
    it.each(DROPPED_CONTAINER_FIXTURES)("$name", ({ input, expected }) => {
      expect(sanitiseServiceTimesHtml(input)).toBe(expected);
    });

    // Pin 3
    it("<script>b</script> leaves no b", () => {
      expect(sanitiseServiceTimesHtml("<script>b</script>")).toBe("");
    });

    // Pin 4
    it('<svg><p>x</p></svg> becomes ""', () => {
      expect(sanitiseServiceTimesHtml("<svg><p>x</p></svg>")).toBe("");
      expect(sanitiseServiceTimesHtml("<p>keep</p><svg><p>x</p></svg>")).toBe("<p>keep</p>");
    });
  });

  describe("attribute stripping", () => {
    // Pin 2
    it("an input with onclick, style, class, data-x, start keeps none", () => {
      const input =
        '<ol start="5"><li class="item" id="first" style="color:red" data-x="test" onclick="alert(1)"><p>Text</p></li></ol>';
      const output = sanitiseServiceTimesHtml(input);
      expect(output).toBe("<ol><li><p>Text</p></li></ol>");
      expect(output).not.toContain("start");
      expect(output).not.toContain("class");
      expect(output).not.toContain("id");
      expect(output).not.toContain("style");
      expect(output).not.toContain("data-x");
      expect(output).not.toContain("onclick");
    });

    it("strips href, src, and all other attributes from allowed and unwrapped tags", () => {
      const input =
        '<p class="intro" style="font-size:16px"><a href="https://example.com" target="_blank" rel="noopener">link</a><img src="pic.jpg" alt="pic" /></p>';
      expect(sanitiseServiceTimesHtml(input)).toBe("<p>link</p>");
    });
  });

  describe("edge-case fixtures", () => {
    it.each(EDGE_CASE_FIXTURES)("$name", ({ input, expected }) => {
      expect(sanitiseServiceTimesHtml(input)).toBe(expected);
    });
  });

  describe("empty normalisation", () => {
    it.each(EMPTY_NORMALISATION_FIXTURES)("$name", ({ input, expected }) => {
      expect(sanitiseServiceTimesHtml(input)).toBe(expected);
    });

    // Pin 5
    it('<p></p>, <p><br></p>, <h1> </h1>, <ul><li><p></p></li></ul> become ""', () => {
      expect(sanitiseServiceTimesHtml("<p></p>")).toBe("");
      expect(sanitiseServiceTimesHtml("<p><br></p>")).toBe("");
      expect(sanitiseServiceTimesHtml("<h1> </h1>")).toBe("");
      expect(sanitiseServiceTimesHtml("<ul><li><p></p></li></ul>")).toBe("");
    });

    it("does not normalise text containing an empty paragraph to empty", () => {
      expect(sanitiseServiceTimesHtml("<p>Real text</p><p></p>")).toBe("<p>Real text</p><p></p>");
    });
  });

  describe("idempotence over the whole fixture corpus", () => {
    it("sanitise(sanitise(x)) === sanitise(x) for every fixture", () => {
      for (const fixture of FIXTURE_CORPUS) {
        const once = sanitiseServiceTimesHtml(fixture);
        const twice = sanitiseServiceTimesHtml(once);
        expect(twice).toBe(once);
      }
    });
  });

  describe("structural hostile suite", () => {
    // Pin 1
    it("structural hostile suite: every element in the allow-list, zero attributes", () => {
      for (const hostile of HOSTILE_INPUT_SUITE) {
        const output = sanitiseServiceTimesHtml(hostile);

        // Substring checks
        expect(output).not.toMatch(/<script/i);
        expect(output).not.toMatch(/on\w+\s*=/i);

        if (output.length > 0) {
          const fragment = JSDOM.fragment(output);
          assertDomSafety(fragment);
        }
      }
    });
  });
});
