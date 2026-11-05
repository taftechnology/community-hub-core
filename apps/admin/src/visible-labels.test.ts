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

it("includes Family Records when mapped to people.households and entitled", () => {
  const map = {
    "Contacts & Members": "people.directory",
    "Family Records": "people.households",
  };
  expect(visibleLabels(labels, ["people.households"], map)).toEqual([
    "Dashboard",
    "Family Records",
    "Settings",
  ]);
});

it("includes Engagement when mapped to module.engagement and entitled", () => {
  const map = {
    Engagement: "module.engagement",
    "Contacts & Members": "people.directory",
    "Family Records": "people.households",
  };
  expect(visibleLabels(labels, ["module.engagement"], map)).toEqual([
    "Dashboard",
    "Engagement",
    "Settings",
  ]);
  expect(
    visibleLabels(labels, ["module.engagement", "people.directory", "people.households"], map),
  ).toEqual(["Dashboard", "Engagement", "Contacts & Members", "Family Records", "Settings"]);
});
