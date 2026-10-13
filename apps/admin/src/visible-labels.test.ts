import { labels } from "./labels";
import { visibleLabels } from "./visible-labels";

it("returns Dashboard and Settings when the map is empty", () => {
  const shown = visibleLabels(labels, [], {});
  expect(shown).toEqual(["Dashboard", "Settings"]);
  expect(shown).not.toContain("Contacts & Members");
});

it("includes a mapped label only when its key is entitled", () => {
  const map = { "Contacts & Members": "people.directory" };
  expect(visibleLabels(labels, [], map)).toEqual(["Dashboard", "Settings"]);
  expect(visibleLabels(labels, ["people.directory"], map)).toEqual([
    "Dashboard",
    "Contacts & Members",
    "Settings",
  ]);
});
