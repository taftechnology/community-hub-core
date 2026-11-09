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

  it("leaves Enter to the browser with form-associated input and a single Search submit button", () => {
    const onSubmit = vi.fn((e) => e.preventDefault());

    const { container } = render(
      <FilterBar
        label="Search contacts"
        value="Owen"
        onValueChange={() => {}}
        onSubmit={onSubmit}
      />,
    );

    const form = container.querySelector("form");
    expect(form).not.toBeNull();

    const input = screen.getByRole("textbox", { name: "Search contacts" }) as HTMLInputElement;
    expect(input.form).toBe(form);

    const buttons = form?.querySelectorAll("button");
    expect(buttons).toHaveLength(1);

    const searchButton = screen.getByRole("button", { name: "Search" }) as HTMLButtonElement;
    expect(searchButton.type).toBe("submit");

    fireEvent.submit(form!);
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
