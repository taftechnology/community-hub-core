// @vitest-environment node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

it("resolves the stylesheets the first app imports", () => {
  expect(require.resolve("@community-hub/tokens/tokens.css")).toMatch(/tokens\.css$/);
  expect(require.resolve("@community-hub/ui/theme.css")).toMatch(/theme\.css$/);
});

it("exports the shell frame components", async () => {
  const ui = await import("./index.js");
  expect(typeof ui.AppShell).toBe("function");
  expect(typeof ui.AppSidebar).toBe("function");
  expect(typeof ui.TopBar).toBe("function");
  expect(typeof ui.Drawer).toBe("function");
  expect(typeof ui.Logo).toBe("function");
});
