import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { Field } from "./field.js";
import { Input } from "./input.js";

describe("Field a11y", () => {
  it("passes axe with label and input", async () => {
    const { container } = render(
      <Field label="Email">
        <Input type="email" />
      </Field>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("passes axe with help and error", async () => {
    const { container } = render(
      <Field label="Verification code" help="6-digit code" error="Invalid code entered">
        <Input />
      </Field>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
