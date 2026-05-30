import type { PowerlineConfig } from "./loader";

export const DEFAULT_CONFIG: PowerlineConfig = {
  theme: "dark",
  display: {
    style: "powerline",
    charset: "unicode",
    colorCompatibility: "auto",
    autoWrap: false,
    padding: 1,
    lines: [
      {
        segments: {
          directory: {
            enabled: true,
            style: "basename",
          },
          git: {
            enabled: true,
            showSha: false,
            showWorkingTree: false,
            showOperation: false,
            showTag: false,
            showTimeSinceCommit: false,
            showStashCount: false,
            showUpstream: false,
            showRepoName: false,
          },
          model: { enabled: true },
          session: {
            enabled: false,
            type: "tokens",
            costSource: "calculated",
            showUnits: true,
          },
          today: { enabled: false, type: "cost", showUnits: true },
          block: {
            enabled: false,
            type: "cost",
            burnType: "cost",
            displayStyle: "text",
          },
          weekly: { enabled: true, displayStyle: "text" },
          version: { enabled: false },
          tmux: { enabled: false },
          sessionId: { enabled: false, showIdLabel: true },
          context: {
            enabled: true,
            showPercentageOnly: false,
            displayStyle: "text",
            autocompactBuffer: 33000,
          },
          metrics: {
            enabled: false,
            showResponseTime: true,
            showLastResponseTime: true,
            showDuration: true,
            showMessageCount: true,
            showLinesAdded: true,
            showLinesRemoved: true,
          },
          agent: { enabled: true, showLabel: false },
          thinking: { enabled: false, showEnabled: true, showEffort: true },
          cacheTimer: { enabled: false },
          bastra: { enabled: true },
        },
      },
    ],
  },
  budget: {
    session: {
      warningThreshold: 80,
    },
    today: {
      warningThreshold: 80,
      amount: 50,
    },
    block: {
      warningThreshold: 80,
      amount: 15,
    },
  },
  modelContextLimits: {
    default: 200000,
    sonnet: 200000,
    opus: 200000,
  },
};
