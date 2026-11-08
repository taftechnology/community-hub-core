import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Avatar } from "./avatar.js";

const INVENTED_NAMES = [
  "Mira Tolland",
  "Owen Barrah",
  "Lila Vance",
  "Caleb Thorne",
  "Nadia Mercer",
  "Julian Hayes",
  "Elena Ward",
  "Silas Drake",
  "Tessa Brooks",
  "Callum Reid",
];

describe("Avatar", () => {
  afterEach(() => {
    cleanup();
  });

  it("sets aria-hidden to true, carries no title attribute, and never writes the name to any attribute", () => {
    const { container } = render(<Avatar name="Mira Tolland" />);

    const avatar = container.querySelector('[data-slot="avatar"]');
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");

    expect(container.querySelector("[title]")).toBeNull();

    const elements = container.querySelectorAll("*");
    for (const el of elements) {
      for (const attr of el.attributes) {
        expect(attr.name).not.toBe("title");
        expect(attr.value).not.toContain("Mira Tolland");
        expect(attr.value).not.toContain("Mira");
        expect(attr.value).not.toContain("Tolland");
      }
    }
  });

  it("extracts uppercase initials for two-word, three-word, one-word, and empty names", () => {
    const twoWord = render(<Avatar name="Mira Tolland" />);
    expect(twoWord.container.querySelector('[data-slot="avatar"]')?.textContent).toBe("MT");
    twoWord.unmount();

    const threeWord = render(<Avatar name="Mira Jane Tolland" />);
    expect(threeWord.container.querySelector('[data-slot="avatar"]')?.textContent).toBe("MT");
    threeWord.unmount();

    const oneWord = render(<Avatar name="Tolland" />);
    expect(oneWord.container.querySelector('[data-slot="avatar"]')?.textContent).toBe("T");
    oneWord.unmount();

    const empty = render(<Avatar name="" />);
    expect(empty.container.querySelector('[data-slot="avatar"]')?.textContent).toBe("");
    empty.unmount();

    const whitespace = render(<Avatar name="   " />);
    expect(whitespace.container.querySelector('[data-slot="avatar"]')?.textContent).toBe("");
    whitespace.unmount();
  });

  it("consistently computes the same data-tone for the same name across renders", () => {
    const render1 = render(<Avatar name="Owen Barrah" />);
    const tone1 = render1.container
      .querySelector('[data-slot="avatar"]')
      ?.getAttribute("data-tone");
    render1.unmount();

    const render2 = render(<Avatar name="Owen Barrah" />);
    const tone2 = render2.container
      .querySelector('[data-slot="avatar"]')
      ?.getAttribute("data-tone");
    render2.unmount();

    expect(tone1).toBeTruthy();
    expect(tone1).toBe(tone2);
  });

  it("produces at least two different tones across ten invented names", () => {
    const tones = INVENTED_NAMES.map((name) => {
      const { container, unmount } = render(<Avatar name={name} />);
      const tone = container.querySelector('[data-slot="avatar"]')?.getAttribute("data-tone");
      unmount();
      return tone;
    });

    const uniqueTones = new Set(tones.filter(Boolean));
    expect(uniqueTones.size).toBeGreaterThanOrEqual(2);
  });

  it("applies the literal bg-tone-*-tint and text-tone-*-ink class pair matching data-tone", () => {
    const { container } = render(<Avatar name="Mira Tolland" />);
    const avatar = container.querySelector('[data-slot="avatar"]')!;

    const tone = avatar.getAttribute("data-tone");
    expect(tone).toBeTruthy();
    expect(avatar.className).toContain(`bg-tone-${tone}-tint`);
    expect(avatar.className).toContain(`text-tone-${tone}-ink`);
  });
});
