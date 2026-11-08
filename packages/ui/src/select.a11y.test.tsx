import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { Select } from "./select";

describe("Select a11y", () => {
  it("passes axe when labeled", async () => {
    const { container } = render(
      <label>
        Role
        <Select defaultValue="user">
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </Select>
      </label>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("flags a select without an accessible name", async () => {
    const { container } = render(
      <Select defaultValue="user">
        <option value="user">User</option>
      </Select>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations.map((v) => v.id)).toContain("select-name");
  });
});
