import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

it("resolves the stylesheets the first app imports", () => {
  expect(require.resolve("@community-hub/tokens/tokens.css")).toMatch(/tokens\.css$/);
  expect(require.resolve("@community-hub/ui/theme.css")).toMatch(/theme\.css$/);
});
