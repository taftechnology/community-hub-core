// @vitest-environment node
import { readFileSync } from "node:fs";

import {
  cliPinMismatch,
  copiedHeaderCliVersionsInSrc,
  shadcnVersionFromReadme,
  shadcnVersionFromScript,
} from "./cli-pin";

const packageRoot = new URL("../", import.meta.url);

it("detects a script vs copied-header CLI mismatch", () => {
  expect(cliPinMismatch("4.21.0", "4.21.0", ["4.0.0"])).toBe(true);
});

it("keeps shadcn@4.21.0 aligned across script, README, and copied headers", () => {
  const script = readFileSync(new URL("scripts/run-shadcn.mjs", packageRoot), "utf8");
  const readme = readFileSync(new URL("README.md", packageRoot), "utf8");
  const scriptVersion = shadcnVersionFromScript(script);
  const readmeVersion = shadcnVersionFromReadme(readme);
  const headerVersions = copiedHeaderCliVersionsInSrc(new URL(".", import.meta.url));

  expect(scriptVersion).toBe("4.21.0");
  expect(readmeVersion).toBe("4.21.0");
  expect(headerVersions).toEqual(["4.21.0", "4.21.0"]);
  expect(cliPinMismatch(scriptVersion!, readmeVersion!, headerVersions)).toBe(false);
});
