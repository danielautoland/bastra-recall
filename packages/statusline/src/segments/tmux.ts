import { exec } from "node:child_process";
import { promisify } from "node:util";
import { debug } from "../utils/logger";

const execAsync = promisify(exec);

export class TmuxService {
  async getSessionId(): Promise<string | null> {
    try {
      if (!process.env.TMUX_PANE) {
        debug(`TMUX_PANE not set, not in tmux session`);
        return null;
      }

      debug(`Getting tmux session ID, TMUX_PANE: ${process.env.TMUX_PANE}`);

      const result = await execAsync("tmux display-message -p '#S'", {
        encoding: "utf8",
        timeout: 1000,
      });
      const sessionId = result.stdout.trim();

      debug(`Tmux session ID: ${sessionId || "empty"}`);

      return sessionId || null;
    } catch (error) {
      debug(`Error getting tmux session ID:`, error);
      return null;
    }
  }

  isInTmux(): boolean {
    return !!process.env.TMUX_PANE;
  }
}
