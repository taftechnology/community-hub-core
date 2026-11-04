import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommunitySwitcher } from "./community-switcher";

describe("CommunitySwitcher", () => {
  it("renders nothing when communities list is empty", () => {
    const { container } = render(
      <CommunitySwitcher communities={[]} currentId="" onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there is only one community", () => {
    const { container } = render(
      <CommunitySwitcher
        communities={[{ id: "comm-1", label: "St Mary" }]}
        currentId="comm-1"
        onChange={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders trigger with current label when there are two communities", () => {
    const communities = [
      { id: "comm-1", label: "St Mary" },
      { id: "comm-2", label: "St Patrick" },
    ];

    render(<CommunitySwitcher communities={communities} currentId="comm-1" onChange={() => {}} />);

    expect(screen.getByText("St Mary")).not.toBeNull();
  });

  it("choosing the other community calls onChange with its id exactly once", async () => {
    const onChange = vi.fn();
    const communities = [
      { id: "comm-1", label: "St Mary" },
      { id: "comm-2", label: "St Patrick" },
    ];

    render(<CommunitySwitcher communities={communities} currentId="comm-1" onChange={onChange} />);

    const trigger = screen.getByText("St Mary");
    fireEvent.click(trigger);

    const option = await screen.findByText("St Patrick");
    expect(option).not.toBeNull();

    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("comm-2");
  });

  it("carries touch:min-h-(--ch-size-touch) on each menu item for touch screens", async () => {
    const communities = [
      { id: "comm-1", label: "St Mary" },
      { id: "comm-2", label: "St Patrick" },
    ];

    render(<CommunitySwitcher communities={communities} currentId="comm-1" onChange={() => {}} />);

    const trigger = screen.getByText("St Mary");
    fireEvent.click(trigger);

    const items = await screen.findAllByRole("menuitem");
    expect(items.length).toBe(2);
    for (const item of items) {
      expect(item.className).toContain("touch:min-h-(--ch-size-touch)");
    }
  });
});
