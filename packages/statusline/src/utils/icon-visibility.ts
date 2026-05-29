import type { PowerlineConfig, LineConfig } from "../config/loader";

export type SegmentKey = keyof LineConfig["segments"];

export function shouldShowIcon(
  globalShowIcons: boolean | undefined,
  perSegmentShowIcon: boolean | undefined,
): boolean {
  return perSegmentShowIcon ?? globalShowIcons ?? true;
}

export function findSegmentShowIcon(
  config: PowerlineConfig,
  segKey: SegmentKey,
): boolean | undefined {
  for (const line of config.display.lines) {
    const seg = line.segments[segKey] as { showIcon?: boolean } | undefined;
    if (seg?.showIcon !== undefined) return seg.showIcon;
  }
  return undefined;
}

export function resolveIconVisibility(
  config: PowerlineConfig,
  segKey: SegmentKey,
): boolean {
  return shouldShowIcon(
    config.display?.showIcons,
    findSegmentShowIcon(config, segKey),
  );
}
