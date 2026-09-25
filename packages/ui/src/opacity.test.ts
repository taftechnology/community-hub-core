import { readFileSync } from "node:fs";
import { opacityViolations } from "./opacity";

it("rejects a focus ring opacity modifier", () => {
  expect(opacityViolations("focus-visible:ring-ring/50")).toEqual(["focus-visible:ring-ring/50"]);
});

it("allows hover opacity", () => {
  expect(opacityViolations("hover:bg-primary/80")).toEqual([]);
});

it("accepts the copied Button", () => {
  const source = readFileSync(new URL("./button.tsx", import.meta.url), "utf8");
  expect(opacityViolations(source)).toEqual([]);
});
