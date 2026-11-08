import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EmptyState } from "./empty-state.js";

describe("EmptyState", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders message in a paragraph as the only text, with no role and no aria-live", () => {
    const { container } = render(<EmptyState message="No contacts yet" />);

    const root = container.querySelector('[data-slot="empty-state"]');
    expect(root).not.toBeNull();

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.textContent).toBe("No contacts yet");
    expect(container.textContent?.trim()).toBe("No contacts yet");

    expect(container.querySelector("[role]")).toBeNull();
    expect(container.querySelector("[aria-live]")).toBeNull();
  });
});
