// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

it("resolves the stylesheets the first app imports", () => {
  expect(require.resolve("@community-hub/tokens/tokens.css")).toMatch(/tokens\.css$/);
  expect(require.resolve("@community-hub/ui/theme.css")).toMatch(/theme\.css$/);
});

it("resolves the rich-text-editor subpath and stylesheet", () => {
  expect(require.resolve("@community-hub/ui/rich-text-editor")).toMatch(/rich-text-editor\.tsx$/);
  expect(require.resolve("@community-hub/ui/rich-text-editor.css")).toMatch(
    /rich-text-editor\.css$/,
  );
});

it("does not export RichTextEditor or Tiptap from the root barrel", async () => {
  const ui = await import("./index.js");
  expect("RichTextEditor" in ui).toBe(false);
  for (const key of Object.keys(ui)) {
    expect(key.toLowerCase()).not.toContain("tiptap");
  }
});

it("ensures apps/ops does not import @community-hub/ui/rich-text-editor or @tiptap", () => {
  const root = path.resolve(fileURLToPath(import.meta.url), "../../../../");
  const opsPkgJsonPath = path.join(root, "apps/ops/package.json");
  const opsPkgJson = fs.readFileSync(opsPkgJsonPath, "utf8");
  expect(opsPkgJson).not.toContain("@tiptap");
  expect(opsPkgJson).not.toContain("rich-text-editor");

  const opsSrcDir = path.join(root, "apps/ops/src");
  function scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (/\.(tsx?|jsx?|css)$/.test(entry.name)) {
        const content = fs.readFileSync(full, "utf8");
        expect(content).not.toContain("@community-hub/ui/rich-text-editor");
        expect(content).not.toContain("@tiptap");
      }
    }
  }
  scanDir(opsSrcDir);
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
  expect(typeof ui.UserMenuCheckboxItem).toBe("function");
  expect(typeof ui.CommunitySwitcher).toBe("function");
  expect(typeof ui.THEME_STORAGE_KEY).toBe("string");
  expect(typeof ui.readStoredTheme).toBe("function");
  expect(typeof ui.systemTheme).toBe("function");
  expect(typeof ui.applyTheme).toBe("function");
  expect(typeof ui.initialTheme).toBe("function");
});
