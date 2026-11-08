import { render } from "@testing-library/react";
import axe from "axe-core";

import { StatusBadge, type StatusBadgeTone } from "./status-badge.js";

describe("StatusBadge accessibility", () => {
  it("passes axe on all four tones", async () => {
    const tones: StatusBadgeTone[] = ["success", "warning", "danger", "neutral"];
    const { container } = render(
      <div>
        {tones.map((tone) => (
          <StatusBadge key={tone} tone={tone}>
            {tone}
          </StatusBadge>
        ))}
      </div>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
