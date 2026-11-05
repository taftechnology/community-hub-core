import "./test-support/prosemirror-dom";

import { render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { RichTextEditor, type RichTextEditorToolbarLabels } from "./rich-text-editor";

const defaultToolbarLabels: RichTextEditorToolbarLabels = {
  heading2: "Heading 2",
  heading3: "Heading 3",
  bold: "Bold",
  italic: "Italic",
  bulletList: "Bullet list",
  orderedList: "Numbered list",
};

describe("RichTextEditor a11y", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  for (const theme of ["light", "dark"] as const) {
    it(`passes axe in default state in ${theme} mode`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <RichTextEditor
          label="Service schedule"
          toolbarLabel="Formatting controls"
          toolbar={defaultToolbarLabels}
          initialValue="<p>Sunday Mass at 9:00 AM</p>"
        />,
      );

      const results = await axe.run(container, {
        rules: {
          // Opaque token pairs are validated by @community-hub/check-tokens contrast rules.
          "color-contrast": { enabled: false },
        },
      });

      expect(results.violations).toEqual([]);
    });

    it(`passes axe in invalid state in ${theme} mode`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <RichTextEditor
          label="Service schedule"
          toolbarLabel="Formatting controls"
          toolbar={defaultToolbarLabels}
          invalid
        />,
      );

      const results = await axe.run(container, {
        rules: {
          "color-contrast": { enabled: false },
        },
      });

      expect(results.violations).toEqual([]);
    });

    it(`passes axe in disabled state in ${theme} mode`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <RichTextEditor
          label="Service schedule"
          toolbarLabel="Formatting controls"
          toolbar={defaultToolbarLabels}
          disabled
        />,
      );

      const results = await axe.run(container, {
        rules: {
          "color-contrast": { enabled: false },
        },
      });

      expect(results.violations).toEqual([]);
    });

    it(`passes axe in over-limit state in ${theme} mode`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <RichTextEditor
          label="Service schedule"
          toolbarLabel="Formatting controls"
          toolbar={defaultToolbarLabels}
          maxLength={10}
          initialValue="<p>Content that is definitely over the ten character limit</p>"
          counterLabel={(used, max) => `${used} / ${max}`}
        />,
      );

      const results = await axe.run(container, {
        rules: {
          "color-contrast": { enabled: false },
        },
      });

      expect(results.violations).toEqual([]);
    });
  }
});
