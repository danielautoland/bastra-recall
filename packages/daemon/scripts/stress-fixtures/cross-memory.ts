/**
 * Cross-memory recall fixtures (Issue #2, #8).
 *
 * Queries that should surface MULTIPLE memories (2-4 each) — graders test
 * whether all expected ids appear in top-k where k = max(4, expected.length).
 *
 * The optional `oneHop` flag marks queries where one of the expected ids is
 * not a direct lexical hit but is `related_via`-linked to a seed in the top
 * results. The harness re-runs the same query with `expand_hops: 1` and
 * grades the 1-hop slice separately.
 */

export interface CrossMemoryCase {
  query: string;
  expected: string[];
  /** Optional: ids that are expected to surface only via 1-hop expansion. */
  oneHop?: string[];
}

export const CROSS_MEMORY_CASES: CrossMemoryCase[] = [
  {
    query: "tailwind hover und inline style precedence problem",
    expected: [
      "lesson-hover-icon-tailwind-vs-inline-precedence",
      "lesson-buttons-always-with-hover",
      "lesson-css-pixel-fix-one-value-at-a-time",
    ],
  },
  {
    query: "macos swiftui scrollview und window sizing fallen",
    expected: [
      "swiftui-scrollview-macos-14-trailing-inset-nsscroller-custom-drawing-geister-ove",
      "macos-window-auto-grow-vstack-frame-maxinfinity-nsviewrepresentable-clipping",
      "nshostingcontroller-sizingoptions-empty-blocks-window-auto-grow",
    ],
  },
  {
    query: "git workflow regeln für claude in projekten",
    expected: [
      "pref-no-git-without-instruction",
      "nexus-recall-claude-darf-git-vollstandig-verwalten-override-der-globalen-no-git-",
      "git-add-commit-committed-alles-im-index-nicht-nur-die-neu-added-files",
    ],
  },
  {
    query: "chokidar watcher unzuverlässig auf cloud storage vault",
    expected: [
      "chokidar-erkennt-neue-files-im-google-drive-vault-nicht-zuverlassig",
      "watcher-fix-verifiziert-usepolling-reindexfile-lost-cloud-mount-problem",
    ],
  },
  {
    query: "nexus recall save trigger und recall trigger autonomie",
    expected: [
      "nexus-recall-save-und-recall-trigger-autonom-ohne-user-aufforderung",
      "nexus-recall-no-overengineering",
      "bei-bastra-recall-fragen-immer-zuerst-recall-niemals-daniel-nach-repo-info-frage",
    ],
  },
  {
    query: "mac app tauri architektur clipboard sidebar",
    expected: [
      "nexus-mac-app-tauri-2-stack-setup-permissions-ipc",
      "nexus-mac-app-clipboard-observer-arboard-polling-sqlite-nexus-recall-clipboard-d",
      "nexus-mac-app-sidebar-mode-mit-ax-resize-anderer-apps-magnet-rectangle-pattern",
    ],
  },
  {
    query: "claude code skill plugin disk layout discovery",
    expected: [
      "claude-code-plugin-skill-mcp-disk-layout-fur-discovery",
    ],
  },
  {
    query: "m0 eval recall qualität und embeddings entscheidung",
    expected: [
      "m0-eval-ergebnis-bm25-recall-when-reichen-fur-v0",
    ],
  },
  {
    query: "macos native app permissions tcc und subprocess pipes",
    expected: [
      "macos-native-app-gotchas-tcc-braucht-bundle-find-node-fur-path-axuielementref-cf",
      "subprocess-pipes-readabilityhandler-statt-filehandle-read-uptocount",
    ],
  },
  {
    query: "agent instruction compliance hooks und user preferences",
    expected: [
      "agent-darf-user-system-anweisungen-niemals-ignorieren-auch-nicht-hook-hints",
      "pref-pitch-ideas-not-implement",
      "pref-no-backend-kill-or-bg-restart",
    ],
  },
];
