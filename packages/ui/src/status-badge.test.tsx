import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { StatusBadge, type StatusBadgeTone } from "./status-badge.js";

describe("StatusBadge", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a span element with data-slot and word as text", () => {
    render(<StatusBadge tone="success">Active</StatusBadge>);
    const badge = screen.getByText("Active");
    expect(badge.tagName).toBe("SPAN");
    expect(badge.getAttribute("data-slot")).toBe("status-badge");
    expect(badge.getAttribute("data-tone")).toBe("success");
  });

  it("renders each tone with its data-tone and exact three token classes", () => {
    const toneSpecs: Array<{
      tone: StatusBadgeTone;
      textClass: string;
      bgClass: string;
      borderClass: string;
    }> = [
      {
        tone: "success",
        textClass: "text-primary-ink",
        bgClass: "bg-tint",
        borderClass: "border-tint-border",
      },
      {
        tone: "warning",
        textClass: "text-warning-ink",
        bgClass: "bg-warning-tint",
        borderClass: "border-warning-border",
      },
      {
        tone: "danger",
        textClass: "text-destructive-ink",
        bgClass: "bg-destructive-tint",
        borderClass: "border-destructive-border",
      },
      {
        tone: "neutral",
        textClass: "text-muted-foreground",
        bgClass: "bg-muted",
        borderClass: "border-border",
      },
    ];

    for (const spec of toneSpecs) {
      const { container, unmount } = render(
        <StatusBadge tone={spec.tone}>{spec.tone} badge</StatusBadge>,
      );
      const span = container.querySelector("span");
      expect(span).not.toBeNull();
      expect(span?.getAttribute("data-tone")).toBe(spec.tone);
      expect(span?.className).toContain(spec.textClass);
      expect(span?.className).toContain(spec.bgClass);
      expect(span?.className).toContain(spec.borderClass);
      unmount();
    }
  });

  it("renders with badge shape classes and merges optional className", () => {
    const { container } = render(
      <StatusBadge tone="neutral" className="custom-badge">
        Neutral
      </StatusBadge>,
    );
    const span = container.querySelector("span");
    expect(span?.className).toContain("custom-badge");
    expect(span?.className).toContain("rounded-full");
    expect(span?.className).toContain("text-[13px]");
    expect(span?.className).toContain("leading-[20px]");
    expect(span?.className).toContain("font-semibold");
    expect(span?.className).toContain("whitespace-nowrap");
  });
});
