import { claudeDesktopAdapter } from "./adapters/claude-desktop.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { cursorAdapter } from "./adapters/cursor.js";
import type { Adapter } from "./types.js";

export const ADAPTERS: Record<string, Adapter> = {
  "claude-desktop": claudeDesktopAdapter,
  "claude-code": claudeCodeAdapter,
  "cursor": cursorAdapter,
};

export function resolveTargets(surface: string | null): Adapter[] | { error: string } {
  if (!surface) return { error: "missing surface — use one of: claude-desktop, claude-code, cursor, all" };
  if (surface === "all") return Object.values(ADAPTERS);
  const a = ADAPTERS[surface];
  if (!a) return { error: `unknown surface '${surface}' — supported: ${Object.keys(ADAPTERS).join(", ")}` };
  return [a];
}
