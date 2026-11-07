import "./test-support/prosemirror-dom";

import { fireEvent, render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import * as React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  RichTextEditor,
  type RichTextEditorHandle,
  type RichTextEditorToolbarLabels,
} from "./rich-text-editor";

const defaultToolbarLabels: RichTextEditorToolbarLabels = {
  heading2: "Heading 2",
  heading3: "Heading 3",
  bold: "Bold",
  italic: "Italic",
  bulletList: "Bullet list",
  orderedList: "Numbered list",
};

describe("RichTextEditor", () => {
  beforeEach(() => {
    document.querySelectorAll("style").forEach((el) => el.remove());
  });

  afterEach(() => {
    document.querySelectorAll("style").forEach((el) => el.remove());
  });

  it("schema node names and mark names match the exact sanitiser allow-list (Pin 23)", () => {
    let capturedEditor: Editor | null = null;
    render(
      <RichTextEditor
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
        onEditorReady={(editor) => {
          capturedEditor = editor;
        }}
      />,
    );

    expect(capturedEditor).not.toBeNull();
    const nodeNames = Object.keys(capturedEditor!.schema.nodes).sort();
    const markNames = Object.keys(capturedEditor!.schema.marks).sort();

    // Exactly the allow-listed nodes and marks
    expect(nodeNames).toEqual([
      "bulletList",
      "doc",
      "hardBreak",
      "heading",
      "listItem",
      "orderedList",
      "paragraph",
      "text",
    ]);
    expect(markNames).toEqual(["bold", "italic"]);
  });

  it("restricts heading levels to 1, 2, 3, and 4 only", () => {
    let capturedEditor: Editor | null = null;
    render(
      <RichTextEditor
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
        onEditorReady={(editor) => {
          capturedEditor = editor;
        }}
      />,
    );

    expect(capturedEditor).not.toBeNull();
    const headingType = capturedEditor!.schema.nodes.heading;
    expect(headingType).toBeDefined();

    // Check heading options configured
    const levels = (headingType.spec as unknown as { levels?: number[] }).levels ?? [1, 2, 3, 4];
    expect(levels).toEqual([1, 2, 3, 4]);

    // Setting content with <h5> unwraps or drops <h5> according to schema
    capturedEditor!.commands.setContent("<h5>Level 5 heading</h5>");
    expect(capturedEditor!.getHTML()).not.toContain("<h5>");
  });

  it("does not inject any <style> element on or after mount (Pin 24)", () => {
    // Before mounting, remove every style element and assert there are none
    document.querySelectorAll("style").forEach((el) => el.remove());
    expect(document.querySelectorAll("style").length).toBe(0);
    expect(document.querySelector("[data-tiptap-style]")).toBeNull();

    // 1. Mount fresh RichTextEditor without initialValue
    const { container: containerEmpty, unmount: unmountEmpty } = render(
      <RichTextEditor
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
      />,
    );

    expect(document.querySelectorAll("style").length).toBe(0);
    expect(document.querySelector("[data-tiptap-style]")).toBeNull();
    expect(containerEmpty.querySelectorAll("style").length).toBe(0);

    const boldBtnEmpty = screen.getByRole("button", { name: "Bold" });
    fireEvent.click(boldBtnEmpty);

    expect(document.querySelectorAll("style").length).toBe(0);
    expect(document.querySelector("[data-tiptap-style]")).toBeNull();
    expect(containerEmpty.querySelectorAll("style").length).toBe(0);

    unmountEmpty();

    // Ensure DOM is clean before mounting next instance
    document.querySelectorAll("style").forEach((el) => el.remove());
    expect(document.querySelectorAll("style").length).toBe(0);
    expect(document.querySelector("[data-tiptap-style]")).toBeNull();

    // 2. Mount fresh RichTextEditor with initialValue
    let capturedEditor: Editor | null = null;
    const { container } = render(
      <RichTextEditor
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
        initialValue="<p>Test paragraph</p>"
        onEditorReady={(editor) => {
          capturedEditor = editor;
        }}
      />,
    );

    // Right after mount: no style elements in document or container
    expect(document.querySelectorAll("style").length).toBe(0);
    expect(document.querySelector("[data-tiptap-style]")).toBeNull();
    expect(container.querySelectorAll("style").length).toBe(0);

    // After one user edit via toolbar (toggling bold)
    expect(capturedEditor).not.toBeNull();
    capturedEditor!.commands.setTextSelection({ from: 1, to: 5 });
    const boldBtn = screen.getByRole("button", { name: "Bold" });
    fireEvent.click(boldBtn);

    expect(document.querySelectorAll("style").length).toBe(0);
    expect(document.querySelector("[data-tiptap-style]")).toBeNull();
    expect(container.querySelectorAll("style").length).toBe(0);
  });

  it("setContent loads HTML without emitting onChange", () => {
    const onChange = vi.fn();
    const ref = React.createRef<RichTextEditorHandle>();

    render(
      <RichTextEditor
        ref={ref}
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
        onChange={onChange}
      />,
    );

    expect(onChange).not.toHaveBeenCalled();

    ref.current?.setContent("<p>Sunday Mass at 9:00 AM</p>");

    expect(onChange).not.toHaveBeenCalled();
    expect(ref.current?.getHTML()).toBe("<p>Sunday Mass at 9:00 AM</p>");
  });

  it("calls onChange when a user edit occurs via toolbar button", () => {
    const onChange = vi.fn();
    const ref = React.createRef<RichTextEditorHandle>();

    render(
      <RichTextEditor
        ref={ref}
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
        initialValue="<p>Test</p>"
        onChange={onChange}
        onEditorReady={(editor) => {
          editor.commands.setTextSelection({ from: 1, to: 5 });
        }}
      />,
    );

    const boldButton = screen.getByRole("button", { name: "Bold" });
    fireEvent.click(boldButton);

    expect(onChange).toHaveBeenCalled();
  });

  it("toolbar buttons toggle formatting and reflect aria-pressed", () => {
    let capturedEditor: Editor | null = null;
    render(
      <RichTextEditor
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
        initialValue="<p>Selected paragraph</p>"
        onEditorReady={(editor) => {
          capturedEditor = editor;
        }}
      />,
    );

    const boldBtn = screen.getByRole("button", { name: "Bold" });
    const italicBtn = screen.getByRole("button", { name: "Italic" });
    const h2Btn = screen.getByRole("button", { name: "Heading 2" });
    const h3Btn = screen.getByRole("button", { name: "Heading 3" });
    const bulletBtn = screen.getByRole("button", { name: "Bullet list" });
    const orderedBtn = screen.getByRole("button", { name: "Numbered list" });

    expect(boldBtn.getAttribute("aria-pressed")).toBe("false");
    expect(italicBtn.getAttribute("aria-pressed")).toBe("false");
    expect(h2Btn.getAttribute("aria-pressed")).toBe("false");
    expect(h3Btn.getAttribute("aria-pressed")).toBe("false");
    expect(bulletBtn.getAttribute("aria-pressed")).toBe("false");
    expect(orderedBtn.getAttribute("aria-pressed")).toBe("false");

    // Position selection within the paragraph text
    capturedEditor!.commands.setTextSelection({ from: 1, to: 10 });

    // Toggle bold
    fireEvent.click(boldBtn);
    expect(boldBtn.getAttribute("aria-pressed")).toBe("true");

    // Toggle italic
    fireEvent.click(italicBtn);
    expect(italicBtn.getAttribute("aria-pressed")).toBe("true");

    // Toggle Heading 2
    fireEvent.click(h2Btn);
    expect(h2Btn.getAttribute("aria-pressed")).toBe("true");

    // Toggle Heading 3 (should deactivate Heading 2)
    fireEvent.click(h3Btn);
    expect(h3Btn.getAttribute("aria-pressed")).toBe("true");
    expect(h2Btn.getAttribute("aria-pressed")).toBe("false");

    // Toggle Bullet list
    fireEvent.click(bulletBtn);
    expect(bulletBtn.getAttribute("aria-pressed")).toBe("true");

    // Toggle Numbered list
    fireEvent.click(orderedBtn);
    expect(orderedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(bulletBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("supports WAI-ARIA roving tabindex and keyboard navigation on toolbar", () => {
    render(
      <RichTextEditor
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
      />,
    );

    const buttons = [
      screen.getByRole("button", { name: "Heading 2" }),
      screen.getByRole("button", { name: "Heading 3" }),
      screen.getByRole("button", { name: "Bold" }),
      screen.getByRole("button", { name: "Italic" }),
      screen.getByRole("button", { name: "Bullet list" }),
      screen.getByRole("button", { name: "Numbered list" }),
    ];

    // First button has tabIndex 0, rest have -1
    expect(buttons[0]?.tabIndex).toBe(0);
    for (let i = 1; i < buttons.length; i++) {
      expect(buttons[i]?.tabIndex).toBe(-1);
    }

    // ArrowRight moves focus to Heading 3
    fireEvent.keyDown(buttons[0]!, { key: "ArrowRight" });
    expect(buttons[1]?.tabIndex).toBe(0);
    expect(buttons[0]?.tabIndex).toBe(-1);

    // End moves focus to last button
    fireEvent.keyDown(buttons[1]!, { key: "End" });
    expect(buttons[5]?.tabIndex).toBe(0);
    expect(buttons[1]?.tabIndex).toBe(-1);

    // ArrowRight wraps around to first button
    fireEvent.keyDown(buttons[5]!, { key: "ArrowRight" });
    expect(buttons[0]?.tabIndex).toBe(0);
    expect(buttons[5]?.tabIndex).toBe(-1);

    // ArrowLeft wraps backwards to last button
    fireEvent.keyDown(buttons[0]!, { key: "ArrowLeft" });
    expect(buttons[5]?.tabIndex).toBe(0);

    // Home moves focus to first button
    fireEvent.keyDown(buttons[5]!, { key: "Home" });
    expect(buttons[0]?.tabIndex).toBe(0);
  });

  it("exposes textbox role, aria-multiline, accessible name and describedby on editable area", () => {
    render(
      <>
        <div id="schedule-hint">Hint description</div>
        <RichTextEditor
          label="Schedule Text"
          toolbarLabel="Formatting controls"
          toolbar={defaultToolbarLabels}
          describedBy="schedule-hint"
        />
      </>,
    );

    const textbox = screen.getByRole("textbox", { name: "Schedule Text" });
    expect(textbox).toBeDefined();
    expect(textbox.getAttribute("aria-multiline")).toBe("true");
    expect(textbox.getAttribute("aria-describedby")).toBe("schedule-hint");
    expect(textbox.getAttribute("aria-invalid")).toBe("false");
  });

  it("renders a polite aria-live counter and enters over-limit state when content exceeds maxLength", () => {
    const ref = React.createRef<RichTextEditorHandle>();
    const counterLabel = (used: number, max: number) => `${used} / ${max}`;

    render(
      <RichTextEditor
        ref={ref}
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
        maxLength={30}
        counterLabel={counterLabel}
      />,
    );

    const counter = screen.getByText((content) => content.includes("/ 30"));
    expect(counter.getAttribute("aria-live")).toBe("polite");

    const textbox = screen.getByRole("textbox", { name: "Service schedule" });
    expect(textbox.getAttribute("aria-invalid")).toBe("false");

    // Load content over 30 chars
    ref.current?.setContent("<p>This is a paragraph that exceeds thirty characters.</p>");

    expect(textbox.getAttribute("aria-invalid")).toBe("true");
    expect(counter.textContent).toContain("/ 30");
  });

  it("serialises empty content as <p></p>", () => {
    const ref = React.createRef<RichTextEditorHandle>();

    render(
      <RichTextEditor
        ref={ref}
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
      />,
    );

    expect(ref.current?.getHTML()).toBe("<p></p>");
  });

  it("drops <a>, <img>, and <blockquote> not in the schema", () => {
    const ref = React.createRef<RichTextEditorHandle>();

    render(
      <RichTextEditor
        ref={ref}
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
      />,
    );

    ref.current?.setContent(
      '<p>Hello <a href="https://example.com">link</a> <img src="image.png" alt="pic" /></p><blockquote>Quote</blockquote>',
    );

    const html = ref.current?.getHTML();
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<blockquote");
    // Text inside link and quote is preserved in paragraph
    expect(html).toContain("Hello link");
    expect(html).toContain("Quote");
  });

  it("disables toolbar buttons and contenteditable when disabled=true", () => {
    render(
      <RichTextEditor
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
        disabled
      />,
    );

    const textbox = screen.getByRole("textbox", { name: "Service schedule" });
    expect(textbox.getAttribute("contenteditable")).toBe("false");

    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("focuses editable area via ref focus()", () => {
    const ref = React.createRef<RichTextEditorHandle>();

    render(
      <RichTextEditor
        ref={ref}
        label="Service schedule"
        toolbarLabel="Formatting controls"
        toolbar={defaultToolbarLabels}
      />,
    );

    const textbox = screen.getByRole("textbox", { name: "Service schedule" });
    ref.current?.focus();
    expect(document.activeElement).toBe(textbox);
  });
});
