// @vitest-environment node
import { aliasViolations, aliasViolationsInSrc } from "./alias";

it("rejects an @/ import the package paths would resolve", () => {
  expect(aliasViolations('import { cn } from "@/lib/utils"')).toEqual([
    'import { cn } from "@/lib/utils"',
  ]);
});

it("rejects a single-quoted @/ import", () => {
  expect(aliasViolations("import { cn } from '@/lib/utils'")).toEqual([
    "import { cn } from '@/lib/utils'",
  ]);
});

it("rejects a side-effect @/ import", () => {
  expect(aliasViolations('import "@/styles.css"')).toEqual(['import "@/styles.css"']);
  expect(aliasViolations("import '@/styles.css'")).toEqual(["import '@/styles.css'"]);
});

it("accepts a relative utils import", () => {
  expect(aliasViolations('import { cn } from "./lib/utils"')).toEqual([]);
});

it("finds no @/ import under src", () => {
  expect(aliasViolationsInSrc(new URL(".", import.meta.url))).toEqual([]);
});
