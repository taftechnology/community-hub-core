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

it("exports the theme, user menu, and community switcher components and utilities", async () => {
  const ui = await import("./index.js");
  expect(typeof ui.ThemeToggle).toBe("function");
  expect(typeof ui.UserMenu).toBe("function");
  expect(typeof ui.CommunitySwitcher).toBe("function");
  expect(typeof ui.THEME_STORAGE_KEY).toBe("string");
  expect(typeof ui.readStoredTheme).toBe("function");
  expect(typeof ui.systemTheme).toBe("function");
  expect(typeof ui.applyTheme).toBe("function");
  expect(typeof ui.initialTheme).toBe("function");
});
