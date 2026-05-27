# Bastra Recall — Stress Eval Report

- **Run date:** 2026-05-27T15:06:38.294Z
- **Vault path:** `~/Library/CloudStorage/GoogleDrive-nevoigt@n0mad.ai/Meine Ablage/OBSIDIAN/Daniel Nevoigt`
- **Vault size:** 163 memories
- **Search provider:** BM25-only

## Comparison to M0 baseline

M0 used each memory's own first `recall_when` as the query (trivial). Stress-eval uses paraphrased queries with zero literal-token overlap.

| metric | M0 (own trigger) | Stress (paraphrased) |
|---|---:|---:|
| Recall@1 | 98.3% | 57.0% |
| Recall@3 | 100.0% | 75.0% |
| MRR      | 0.992 | 0.667 |

## Slice 1 — Paraphrased

- Cases: 100 across 25 memories
- Recall@1: **57.0%**
- Recall@3: **75.0%**
- MRR: **0.667**
- Pass criterion: Recall@3 ≥ 0.7
- **Verdict: PASS**

### Misses — 25

| rank | gold | paraphrase | top hit (won) |
|---|---|---|---|
| — | `lesson-hover-icon-tailwind-vs-inline-precedence` | icon farbe ändert sich nicht beim mouseover | `bastra-app-icon-andert-sich-nicht-deriveddata-loschen-nicht-macos-icon-cache` |
| — | `lesson-hover-icon-tailwind-vs-inline-precedence` | stylesheet rule loses to attribute | `bastra-io-design-guide-zeigt-visuelle-beispiele-keine-text-beschreibungen` |
| — | `lesson-hover-icon-tailwind-vs-inline-precedence` | warum überschreibt die direkte stilangabe die klassenregel | `bastra-bridge-oss-muss-komplette-vault-funktionalitat-ohne-die-pro-mac-app-biete` |
| — | `lesson-buttons-always-with-hover` | knopf reagiert nicht auf zeiger | `chokidar-erkennt-neue-files-im-google-drive-vault-nicht-zuverlassig` |
| 10 | `lesson-buttons-always-with-hover` | interactive element ohne visuelles feedback wirkt kaputt | `bug-report-ist-kein-refactor-auftrag-minimaler-fix-nichts-umgestalten-ohne-erlau` |
| — | `lesson-buttons-always-with-hover` | feedback fehlt beim drüberfahren | `carnexus-action-button-row-tinting` |
| — | `lesson-css-pixel-fix-one-value-at-a-time` | fine tuning layout iterativ | `lesson-no-double-borders-between-panels` |
| 7 | `lesson-css-pixel-fix-one-value-at-a-time` | nur eine größe gleichzeitig modifizieren bei feinjustierung | `nshostingcontroller-sizingoptions-empty-blocks-window-auto-grow` |
| — | `swiftui-scrollview-macos-14-trailing-inset-nsscroller-custom-drawing-geister-ove` | rechter rand bei apple framework liste lässt sich nicht ent… | `tool-search-queries-bei-deferred-mcps-kurz-und-mit-server-name-nicht-tool-namen-` |
| 4 | `swiftui-scrollview-macos-14-trailing-inset-nsscroller-custom-drawing-geister-ove` | implizites padding rechts in apples ui framework | `bei-ui-layout-anderungen-bestehende-strukturen-nicht-komplett-ersetzen-sondern-n` |
| — | `swiftui-scrollview-macos-14-trailing-inset-nsscroller-custom-drawing-geister-ove` | wie verschwindet die reservierte spalte am rand der liste | `gh-cli-issues-pinnen-via-graphql-mutation-pinissue-kein-subcommand` |
| — | `subprocess-pipes-readabilityhandler-statt-filehandle-read-uptocount` | kindprozess output liest sich nicht zurück | `zeichenlimits-exakt-einhalten-und-lange-vor-ausgabe-verifizieren` |
| — | `pref-no-git-without-instruction` | claude darf das tooling für commits nicht eigenständig nutz… | `nexus-recall-claude-darf-git-vollstandig-verwalten-override-der-globalen-no-git-` |
| 4 | `nexus-recall-claude-darf-git-vollstandig-verwalten-override-der-globalen-no-git-` | override der vcs sperre für bastra recall | `bastra-repo-split-bastra-open-public-bastra-pro-private-nexus-internal-issues` |
| 10 | `m0-eval-ergebnis-bm25-recall-when-reichen-fur-v0` | lexikalische suche schon gut genug | `auto-mode-bei-explizitem-auftrag-direkt-ausfuhren-nicht-warten-auf-go` |
| — | `watcher-fix-verifiziert-usepolling-reindexfile-lost-cloud-mount-problem` | explicit reindex call statt auf event zu warten | `auto-mode-bei-explizitem-auftrag-direkt-ausfuhren-nicht-warten-auf-go` |
| — | `nexus-recall-no-overengineering` | lean implementation philosophy für dieses projekt | `bastra-projekt-ubersicht-master` |
| 10 | `nexus-mac-app-tauri-2-stack-setup-permissions-ipc` | welcher stack steckt in der desktop variante | `bastra-io-designguide-ist-template-setup-fur-bastra-stack-nutzer` |
| — | `nexus-mac-app-sidebar-mode-mit-ax-resize-anderer-apps-magnet-rectangle-pattern` | andockmodus der das andere fenster ranfahren lässt | `swiftui-zwei-sheet-modifier-auf-gleicher-view-einer-wird-silently-unterdruckt` |
| 5 | `nexus-mac-app-sidebar-mode-mit-ax-resize-anderer-apps-magnet-rectangle-pattern` | rectangle clone funktionalität in der desktop variante | `tool-search-queries-bei-deferred-mcps-kurz-und-mit-server-name-nicht-tool-namen-` |
| — | `nexus-mac-app-clipboard-observer-arboard-polling-sqlite-nexus-recall-clipboard-d` | zwischenablage history wird wie geloggt | `wenn-daniel-sagt-design-wie-x-exakt-1-1-x-als-vorlage-nehmen` |
| 4 | `nexus-mac-app-clipboard-observer-arboard-polling-sqlite-nexus-recall-clipboard-d` | wie speichert die app vergangene copies | `nexus-mac-app-sidebar-mode-mit-ax-resize-anderer-apps-magnet-rectangle-pattern` |
| 10 | `bei-bastra-recall-fragen-immer-zuerst-recall-niemals-daniel-nach-repo-info-frage` | vault konsultieren bevor user gestört wird | `bastra-bridge-oss-muss-komplette-vault-funktionalitat-ohne-die-pro-mac-app-biete` |
| 5 | `bei-bastra-recall-fragen-immer-zuerst-recall-niemals-daniel-nach-repo-info-frage` | kein klärungsbedarf wenn antwort im vault liegt | `chokidar-erkennt-neue-files-im-google-drive-vault-nicht-zuverlassig` |
| — | `pref-pitch-ideas-not-implement` | neue ideen erstmal kurz vorstellen statt direkt zu bauen | `bastra-license-distribution-via-lemon-squeezy-direkt-vertrieb` |

## Slice 2 — Cross-Memory

- Cases: 10
- Passed: 8/10
- Aggregate Recall@k: **87.5%**
- **Verdict: FAIL**

| pass | query | expected | found | missing |
|:---:|---|---:|---:|---|
| ✓ | tailwind hover und inline style precedence problem | 3 | 3/3 | — |
| ✓ | macos swiftui scrollview und window sizing fallen | 3 | 3/3 | — |
| ✓ | git workflow regeln für claude in projekten | 3 | 3/3 | — |
| ✓ | chokidar watcher unzuverlässig auf cloud storage vault | 2 | 2/2 | — |
| × | nexus recall save trigger und recall trigger autonomie | 3 | 2/3 | `nexus-recall-no-overengineering` |
| ✓ | mac app tauri architektur clipboard sidebar | 3 | 3/3 | — |
| ✓ | claude code skill plugin disk layout discovery | 1 | 1/1 | — |
| ✓ | m0 eval recall qualität und embeddings entscheidung | 1 | 1/1 | — |
| ✓ | macos native app permissions tcc und subprocess pipes | 2 | 2/2 | — |
| × | agent instruction compliance hooks und user preferences | 3 | 1/3 | `pref-pitch-ideas-not-implement` `pref-no-backend-kill-or-bg-restart` |

## Slice 3 — Anti-Hallucination

- Cases: 12
- Noise cutoff: <80
- Median top-score: **62.5**
- Under-cutoff cases: **8/12** (66.7%)
- **Verdict: PASS (median < cutoff)**

### Histogram

| bucket | count |
|---|---:|
| 0-30 | 4 |
| 30-60 | 2 |
| 60-100 | 3 |
| 100-150 | 3 |
| >=150 | 0 |

### Per query

| query | top score | top hit |
|---|---:|---|
| kubernetes ingress controller setup | 53.4 | `bastra-io-designguide-ist-template-setup-fur-bast…` |
| tensorflow gradient descent optimizer tuning | 18.5 | `hook-follow-through-anomalie-98-4-high-score-hits…` |
| redis cluster sharding strategy slot migration | 102.8 | `strategie-plan-lifecycle-plan-file-privates-track…` |
| elasticsearch shard allocation balancer threshold | 15.6 | `pref-extract-reusable-modules-immediately` |
| django middleware request response lifecycle hooks | 74.5 | `subprocess-pipes-readabilityhandler-statt-filehan…` |
| kotlin coroutines structured concurrency cancellation | 36.2 | `yaml-frontmatter-aus-swift-schreiben-alle-string-…` |
| postgres logical replication slot lag monitoring | 29.9 | `bastra-nach-direktem-file-write-von-mac-app-reind…` |
| terraform aws lambda cold start warmup | 133.8 | `pref-no-backend-kill-or-bg-restart` |
| graphql federation supergraph composition errors | 98.9 | `gh-cli-issues-pinnen-via-graphql-mutation-pinissu…` |
| rabbitmq dead letter exchange retry pattern | 101.1 | `swiftui-keine-state-mutation-aus-computed-view-pr…` |
| ffmpeg hardware acceleration h264 hevc transcode | 7.1 | `doc-inbox-20201118-085412-2026-05-11-jpg` |
| opentelemetry tracing span context propagation | 62.5 | `strategie-plan-lifecycle-plan-file-privates-track…` |

---

_Generated by `scripts/eval-stress.ts` (Issues #2, #8)._
