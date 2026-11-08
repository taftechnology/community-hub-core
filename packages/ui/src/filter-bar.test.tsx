import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilterBar } from "./filter-bar.js";

describe("FilterBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("provides the label as the input accessible name and connects custom inputId", () => {
    render(
      <FilterBar
        label="Search contacts"
        inputId="custom-search-input"
        value=""
        onValueChange={() => {}}
        onSubmit={(e) => e.preventDefault()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Search contacts" });
    expect(input).toBeDefined();
    expect(input.id).toBe("custom-search-input");
  });

  it("calls onValueChange when typing and never calls onSubmit", () => {
    const onValueChange = vi.fn();
    const onSubmit = vi.fn((e) => e.preventDefault());

    render(
      <FilterBar
        label="Search contacts"
        value=""
        onValueChange={onValueChange}
        onSubmit={onSubmit}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Search contacts" });
    fireEvent.change(input, { target: { value: "Mira" } });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("Mira");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit once when clicking the Search button", () => {
    const onSubmit = vi.fn((e) => e.preventDefault());

    render(
      <FilterBar
        label="Search contacts"
        value="Owen"
        onValueChange={() => {}}
        onSubmit={onSubmit}
      />,
    );

    const button = screen.getByRole("button", { name: "Search" });
    fireEvent.click(button);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("calls onSubmit once when pressing Enter in the input", () => {
    const onSubmit = vi.fn((e) => e.preventDefault());

    render(
      <FilterBar
        label="Search contacts"
        value="Owen"
        onValueChange={() => {}}
        onSubmit={onSubmit}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Search contacts" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables the Search button when submitDisabled is true", () => {
    render(
      <FilterBar
        label="Search contacts"
        value=""
        onValueChange={() => {}}
        onSubmit={(e) => e.preventDefault()}
        submitDisabled={true}
      />,
    );

    const button = screen.getByRole("button", { name: "Search" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
