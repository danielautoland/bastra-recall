import { copyFile, mkdir, readFile } from "node:fs/promises";
import { fileExists } from "./helpers.js";
import { SKILL_SOURCE_PATH, SKILL_TARGET_DIR, SKILL_TARGET_FILE } from "./paths.js";

export type SkillStepStatus =
  | "installed"
  | "already-installed"
  | "would-install"
  | "removed"
  | "not-present"
  | "would-remove"
  | "error";

export async function copySkill(opts: { dryRun: boolean }): Promise<{ status: SkillStepStatus; detail: string }> {
  if (!(await fileExists(SKILL_SOURCE_PATH))) {
    return { status: "error", detail: `skill source missing: ${SKILL_SOURCE_PATH}` };
  }
  if (await fileExists(SKILL_TARGET_FILE)) {
    const src = await readFile(SKILL_SOURCE_PATH, "utf8");
    const dst = await readFile(SKILL_TARGET_FILE, "utf8");
    if (src === dst) return { status: "already-installed", detail: `skill already at ${SKILL_TARGET_FILE}` };
  }
  if (opts.dryRun) {
    return { status: "would-install", detail: `would copy SKILL.md → ${SKILL_TARGET_FILE}` };
  }
  await mkdir(SKILL_TARGET_DIR, { recursive: true });
  await copyFile(SKILL_SOURCE_PATH, SKILL_TARGET_FILE);
  return { status: "installed", detail: `skill installed at ${SKILL_TARGET_FILE}` };
}
