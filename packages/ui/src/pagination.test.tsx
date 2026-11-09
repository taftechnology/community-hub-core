import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Pagination } from "./pagination.js";

describe("Pagination", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders an empty container when cursor is null", () => {
    const { container } = render(<Pagination cursor={null} onNext={() => {}} />);

    expect(container.innerHTML).toBe("");
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders exactly one button named Next page when cursor is present", () => {
    const onNext = vi.fn();
    const { container } = render(<Pagination cursor="cursor_abc123" onNext={onNext} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDefined();

    fireEvent.click(buttons[0]!);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledWith("cursor_abc123");

    expect(container.textContent?.trim()).toBe("Next page");
  });
});
