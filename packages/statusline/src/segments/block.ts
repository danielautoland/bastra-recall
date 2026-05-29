import { debug } from "../utils/logger";
import { minutesUntilReset } from "../utils/formatters";
import type { ClaudeHookData } from "../utils/claude";

export interface BlockInfo {
  nativeUtilization: number;
  timeRemaining: number;
}

export class BlockProvider {
  async getActiveBlockInfo(
    hookData?: ClaudeHookData,
  ): Promise<BlockInfo | null> {
    const fiveHour = hookData?.rate_limits?.five_hour;
    if (!fiveHour) {
      debug("Block segment: No native rate_limits data available");
      return null;
    }

    const timeRemaining = minutesUntilReset(fiveHour.resets_at);

    debug(
      `Block segment: Using native rate_limits: ${fiveHour.used_percentage}%, resets in ${timeRemaining}m`,
    );

    return {
      nativeUtilization: fiveHour.used_percentage,
      timeRemaining,
    };
  }
}
