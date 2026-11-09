import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Field } from "./field.js";

describe("Field", () => {
  afterEach(() => {
    cleanup();
  });

  it("joins label to control using a generated id", () => {
    render(
      <Field label="Email address">
        <input type="email" />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Email address" });
    expect(input).toBeDefined();
    expect(input.id).toBeTruthy();
    const label = screen.getByText("Email address");
    expect(label.getAttribute("for")).toBe(input.id);
  });

  it("preserves a control's own id and joins label to it", () => {
    render(
      <Field label="Username">
        <input id="custom-username-id" type="text" />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Username" });
    expect(input.id).toBe("custom-username-id");
    const label = screen.getByText("Username");
    expect(label.getAttribute("for")).toBe("custom-username-id");
  });

  it("joins help text via aria-describedby", () => {
    render(
      <Field label="Password" help="Must be at least 8 characters">
        <input type="password" />
      </Field>,
    );
    const label = screen.getByText("Password");
    const input = document.getElementById(label.getAttribute("for")!);
    expect(input).not.toBeNull();
    const help = screen.getByText("Must be at least 8 characters");
    expect(help.id).toBeTruthy();
    expect(input?.getAttribute("aria-describedby")).toBe(help.id);
  });

  it("joins error text via aria-describedby and marks control aria-invalid", () => {
    render(
      <Field label="Email" error="Invalid email address">
        <input type="email" />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Email" });
    const error = screen.getByText("Invalid email address");
    expect(error.id).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("merges existing aria-describedby with help and error ids", () => {
    render(
      <Field label="Code" help="Check SMS" error="Invalid code">
        <input type="text" aria-describedby="existing-hint" />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Code" });
    const help = screen.getByText("Check SMS");
    const error = screen.getByText("Invalid code");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBe(`existing-hint ${help.id} ${error.id}`);
  });

  it("does not set aria-describedby when there is no help or error", () => {
    render(
      <Field label="Search">
        <input type="text" />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Search" });
    expect(input.hasAttribute("aria-describedby")).toBe(false);
  });

  it("leaves control's own aria-invalid alone when no error is provided", () => {
    render(
      <Field label="Pre-invalid">
        <input type="text" aria-invalid="true" />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Pre-invalid" });
    expect(input.getAttribute("aria-invalid")).toBe("true");

    cleanup();

    render(
      <Field label="Pre-valid">
        <input type="text" />
      </Field>,
    );
    const inputValid = screen.getByRole("textbox", { name: "Pre-valid" });
    expect(inputValid.hasAttribute("aria-invalid")).toBe(false);
  });
});
