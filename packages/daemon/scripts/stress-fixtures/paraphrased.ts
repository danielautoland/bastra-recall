/**
 * Paraphrased recall fixtures (Issue #2, #8).
 *
 * Each entry maps an existing memory id (gold) to 3-5 paraphrases of its
 * recall_when trigger that ideally share *zero* literal tokens with the
 * original recall_when phrases.
 *
 * Rules of thumb when adding entries:
 *  - The memory id MUST exist in the live vault. If a memory is renamed or
 *    deleted, drop the entry — the harness reports unknown ids as errors,
 *    not as misses.
 *  - Paraphrases must be plausible real-world queries (something a developer
 *    actually types), not just synonym soups.
 *  - Mix English / German per how the memory is written. Recall is one index;
 *    the language of the paraphrase should follow the language of the body.
 */

export interface ParaphrasedCase {
  /** Existing memory id in the vault. */
  id: string;
  /** Human-readable handle for the report (short). */
  label: string;
  /** Paraphrases of the memory's recall_when trigger. */
  paraphrases: string[];
}

export const PARAPHRASED_CASES: ParaphrasedCase[] = [
  {
    id: "lesson-hover-icon-tailwind-vs-inline-precedence",
    label: "tailwind hover vs inline color",
    paraphrases: [
      "icon farbe ändert sich nicht beim mouseover",
      "framework utility class wird ignoriert wenn style attribut gesetzt",
      "stylesheet rule loses to attribute",
      "warum überschreibt die direkte stilangabe die klassenregel",
    ],
  },
  {
    id: "lesson-buttons-always-with-hover",
    label: "button needs hover state",
    paraphrases: [
      "knopf reagiert nicht auf zeiger",
      "interactive element ohne visuelles feedback wirkt kaputt",
      "buttons sollten immer einen mouseover effekt haben",
      "feedback fehlt beim drüberfahren",
    ],
  },
  {
    id: "lesson-css-pixel-fix-one-value-at-a-time",
    label: "pixel fix discipline",
    paraphrases: [
      "spacing genau anpassen ohne andere werte zu verändern",
      "fine tuning layout iterativ",
      "ein parameter pro durchgang ändern beim layouting",
      "nur eine größe gleichzeitig modifizieren bei feinjustierung",
    ],
  },
  {
    id: "swiftui-scrollview-macos-14-trailing-inset-nsscroller-custom-drawing-geister-ove",
    label: "macos scrollview trailing inset",
    paraphrases: [
      "rechter rand bei apple framework liste lässt sich nicht entfernen",
      "implizites padding rechts in apples ui framework",
      "scrollbar bereich erscheint doppelt nach custom drawing",
      "wie verschwindet die reservierte spalte am rand der liste",
    ],
  },
  {
    id: "macos-window-auto-grow-vstack-frame-maxinfinity-nsviewrepresentable-clipping",
    label: "macos window grows with content",
    paraphrases: [
      "apple desktop fenster wird größer wenn viel inhalt rein kommt",
      "embedded native view treibt enclosing layout auf",
      "intrinsic content size leakt nach oben durch das layout",
      "host fenster bläst sich auf bei großen embedded views",
    ],
  },
  {
    id: "nshostingcontroller-sizingoptions-empty-blocks-window-auto-grow",
    label: "hostingcontroller sizing options",
    paraphrases: [
      "swift host bridge controller verhindert window grow",
      "appkit bridge wrapper unterdrückt automatisches wachsen",
      "native bridge controller mit leeren sizing flags",
      "intrinsic measurement deaktivieren am bridge layer",
    ],
  },
  {
    id: "swiftui-sheets-modal-views-nie-mit-frame-width-height-fix-immer-min-ideal",
    label: "modal view fixed frame trap",
    paraphrases: [
      "popup overlay verhindert resize des fensters",
      "feste größenangabe blockiert parent resize",
      "dialog view sperrt fenster auf min dimension",
      "frame mit harten zahlen sperrt das hauptfenster",
    ],
  },
  {
    id: "subprocess-pipes-readabilityhandler-statt-filehandle-read-uptocount",
    label: "subprocess pipe blocking",
    paraphrases: [
      "kindprozess output liest sich nicht zurück",
      "stdout vom child process hängt beim async lesen",
      "spawn process pipe bleibt blockiert in swift",
      "byte read from spawned tool never returns",
    ],
  },
  {
    id: "macos-native-app-gotchas-tcc-braucht-bundle-find-node-fur-path-axuielementref-cf",
    label: "macos native app gotchas",
    paraphrases: [
      "app erscheint nicht in privacy einstellungen",
      "permission dialog wird nicht gespeichert ohne bundle id",
      "accessibility ref crasht weil wrapper released wird",
      "doppelklick start kennt homebrew tools nicht",
    ],
  },
  {
    id: "git-add-commit-committed-alles-im-index-nicht-nur-die-neu-added-files",
    label: "git commit pulls staged WIP",
    paraphrases: [
      "versionierung committet ungewollt vorgemerkte änderungen mit",
      "staged work in progress landet im falschen snapshot",
      "vcs nimmt index inhalt beim festschreiben mit",
      "wie verhindere ich dass bereits markierte dateien mit einchecken",
    ],
  },
  {
    id: "pref-no-git-without-instruction",
    label: "no git without instruction",
    paraphrases: [
      "versionierung niemals ohne expliziten auftrag ausführen",
      "snapshots nur auf direkte anweisung erzeugen",
      "ohne user freigabe keine repository operationen",
      "claude darf das tooling für commits nicht eigenständig nutzen",
    ],
  },
  {
    id: "nexus-recall-claude-darf-git-vollstandig-verwalten-override-der-globalen-no-git-",
    label: "in this project claude manages git",
    paraphrases: [
      "in diesem projekt darf der assistent commits autonom machen",
      "override der vcs sperre für bastra recall",
      "ausnahme zur globalen sperre für versionierung",
      "scope spezifische erlaubnis für branching und pushes",
    ],
  },
  {
    id: "m0-eval-ergebnis-bm25-recall-when-reichen-fur-v0",
    label: "M0 eval result decision",
    paraphrases: [
      "vector search wirklich nötig für version 0",
      "lexikalische suche schon gut genug",
      "search quality baseline ergebnis dokumentiert",
      "embeddings vertagt weil baseline reicht",
    ],
  },
  {
    id: "chokidar-erkennt-neue-files-im-google-drive-vault-nicht-zuverlassig",
    label: "watcher misses google drive files",
    paraphrases: [
      "fs watcher auf cloud mount unzuverlässig",
      "neue dateien im synced ordner werden nicht erkannt",
      "filesystem events bei cloud storage fehlen",
      "live reload klappt nicht auf gdrive",
    ],
  },
  {
    id: "watcher-fix-verifiziert-usepolling-reindexfile-lost-cloud-mount-problem",
    label: "watcher polling fixes cloud",
    paraphrases: [
      "manueller reindex pfad löst sync probleme auf cloud volume",
      "polling modus statt native fs events bei drive ordner",
      "watcher zuverlässig machen für mounted cloud storage",
      "explicit reindex call statt auf event zu warten",
    ],
  },
  {
    id: "nexus-recall-save-und-recall-trigger-autonom-ohne-user-aufforderung",
    label: "autonomous save and recall triggers",
    paraphrases: [
      "wann soll der assistent von sich aus memory speichern",
      "kriterien für autonomes erinnern abrufen ohne prompt",
      "self triggered persistence rules",
      "automatisch gespeichert werden ohne user befehl",
    ],
  },
  {
    id: "nexus-recall-no-overengineering",
    label: "stay pragmatic, no overengineering",
    paraphrases: [
      "minimum was funktioniert dann iterieren",
      "keine abstraktion für hypothetische zukunft",
      "pragmatische lösung statt phasenplanung über phase 7",
      "lean implementation philosophy für dieses projekt",
    ],
  },
  {
    id: "nexus-mac-app-tauri-2-stack-setup-permissions-ipc",
    label: "tauri 2 stack mac app",
    paraphrases: [
      "welcher stack steckt in der desktop variante",
      "rust frontend setup mit reactivem ui in der app",
      "tray icon und global shortcut im native wrapper",
      "ipc bridge zwischen node sidecar und gui",
    ],
  },
  {
    id: "nexus-mac-app-sidebar-mode-mit-ax-resize-anderer-apps-magnet-rectangle-pattern",
    label: "sidebar mode resizes other apps",
    paraphrases: [
      "andockmodus der das andere fenster ranfahren lässt",
      "magnet ähnliches verhalten in unserer app",
      "rectangle clone funktionalität in der desktop variante",
      "via accessibility andere fenster verkleinern",
    ],
  },
  {
    id: "nexus-mac-app-clipboard-observer-arboard-polling-sqlite-nexus-recall-clipboard-d",
    label: "clipboard observer details",
    paraphrases: [
      "zwischenablage history wird wie geloggt",
      "polling alle 250ms auf zwischenspeicher",
      "wie speichert die app vergangene copies",
      "duplikatfilter über hash für clipboard history",
    ],
  },
  {
    id: "claude-code-plugin-skill-mcp-disk-layout-fur-discovery",
    label: "claude code disk layout",
    paraphrases: [
      "wo liegen die claude code erweiterungen auf platte",
      "marktplatz cache ordner für extensions",
      "aktive plugin version marker file",
      "settings json struktur für enabled extensions",
    ],
  },
  {
    id: "bei-bastra-recall-fragen-immer-zuerst-recall-niemals-daniel-nach-repo-info-frage",
    label: "look it up before asking",
    paraphrases: [
      "info zum projekt erst aus memory holen statt zu fragen",
      "vault konsultieren bevor user gestört wird",
      "lookup discipline beim eigenen tool",
      "kein klärungsbedarf wenn antwort im vault liegt",
    ],
  },
  {
    id: "agent-darf-user-system-anweisungen-niemals-ignorieren-auch-nicht-hook-hints",
    label: "must follow system instructions",
    paraphrases: [
      "anweisungen aus hooks und reminder müssen befolgt werden",
      "ignorieren von hint blocks ist nicht erlaubt",
      "system reminder verpflichtend behandeln",
      "directives aus reminders gleichwertig zu user prompt",
    ],
  },
  {
    id: "pref-pitch-ideas-not-implement",
    label: "pitch first, do not implement",
    paraphrases: [
      "neue ideen erstmal kurz vorstellen statt direkt zu bauen",
      "konzept vorschlagen vor umsetzung",
      "1 bis 3 sätze als pitch geben",
      "kein eigenmächtiges umsetzen einer neuen idee",
    ],
  },
  {
    id: "pref-no-backend-kill-or-bg-restart",
    label: "do not kill backend autonomously",
    paraphrases: [
      "dev server nicht eigenständig neustarten",
      "prozess management bleibt beim user",
      "kein restart von services ohne expliziten auftrag",
      "im hintergrund laufende dienste nicht beenden",
    ],
  },
];
