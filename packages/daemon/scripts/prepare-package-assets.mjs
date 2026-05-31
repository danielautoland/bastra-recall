import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(packageRoot, "..", "skill", "SKILL.md");
const dst = resolve(packageRoot, "skill", "SKILL.md");

await mkdir(dirname(dst), { recursive: true });
await copyFile(src, dst);
