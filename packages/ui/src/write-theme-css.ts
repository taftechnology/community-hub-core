import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";

import { generateTokens } from "@community-hub/tokens/generate";
import { tokens } from "@community-hub/tokens";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const themePath = path.join(packageRoot, "theme.css");

const { themeCss } = generateTokens(tokens);
const config = await prettier.resolveConfig(themePath);
const formatted = await prettier.format(themeCss, { ...config, filepath: themePath });
writeFileSync(themePath, formatted, "utf8");
