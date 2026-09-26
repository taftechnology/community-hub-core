import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateTokens } from "./generate.js";
import tokens from "./tokens.json" with { type: "json" };

const directory = path.dirname(fileURLToPath(import.meta.url));
const { tokensCss } = generateTokens(tokens);
writeFileSync(path.join(directory, "tokens.css"), tokensCss, "utf8");
