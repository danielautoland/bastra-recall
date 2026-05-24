#!/usr/bin/env tsx
/**
 * One-shot: persist the M0 eval result as a memory in the vault,
 * exercising the new saveMemory() path end-to-end.
 */
import { saveMemory } from "@bastra-recall/core";

const VAULT_PATH = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
if (!VAULT_PATH) {
  console.error("FATAL: BASTRA_VAULT_PATH not set");
  process.exit(2);
}

async function main(): Promise<void> {
  const result = await saveMemory(VAULT_PATH!, {
    title: "M0 Eval-Ergebnis: BM25 + recall_when reichen für v0",
    type: "decision",
    summary:
      "M0-Eval gegen 59 echte Memories: Recall@1 98.3%, Recall@3 100%, MRR 0.992. Hypothese aus PLAN.md hält — Embeddings können auf v0.5+ vertagt bleiben.",
    body: `
## Was gemessen wurde

Pro Memory M wurde dessen erstes \`recall_when\`-Pattern als Query genutzt. Erwartung: M ist Top-Hit (Recall@1).

Skript: \`packages/daemon/scripts/eval.ts\` — re-runnable mit
\`\`\`
NEXUS_VAULT_PATH=… npx tsx scripts/eval.ts
\`\`\`

## Ergebnisse (2026-05-01)

- **Recall@1: 98.3%** (58/59)
- **Recall@3: 100%** (59/59)
- **MRR: 0.992**
- **recall_when-steered: 100%** (jeder Treffer hatte mind. einen recall_when-Token in matched_terms)
- Misses: keine
- Rank-2-Fälle: 1 — semantisch sinnvoller Tie ("neue Feature-Idee in carnexus" → MVP-Focus-Memory gewann gegen MVP-Deadline-Memory). Kein Bug.

## Was das beweist

Die im PLAN.md identifizierte "riskiest assumption" — *FTS5 + recall_when-Patterns retrieve the right memory* — hält für **eigene Trigger**. BM25-Boosting (recall_when=5, title=4, tags=3) reicht. Keine Embeddings nötig in v0.

## Was das NICHT beweist

Trivial-Baseline: jedes Memory bekommt seinen *eigenen* perfekten Trigger. Echte Belastung fehlt:

1. Paraphrasierte Queries ("Daniel will im Juni live" statt "MVP-Deadline 2026-06-01")
2. Cross-Memory-Queries (eine Query, mehrere relevante Memories)
3. Anti-Hallucination (Query ohne passendes Memory — was wird zurückgegeben?)
4. Skalierung auf 200+/500+ Memories

Diese Tests gehören in M0.5 oder beim ersten Schmerz.

## Implikation für Roadmap

- **v0**: aktueller Stack bleibt (MiniSearch + BM25 + recall_when-Boost).
- **v0.5+**: Embeddings nur, wenn paraphrased-query-Eval unter Schwelle fällt.
- **Nicht jetzt**: Hybrid-Ranking, Re-Ranker, Vector-DB.
`,
    topic_path: ["bastra-recall", "eval", "M0"],
    tags: ["bastra-recall", "eval", "decision", "search", "bm25"],
    scope: "bastra-recall",
    recall_when: [
      "search-quality of bastra-recall in Frage stellen",
      "Embeddings für bastra-recall überlegen",
      "BM25 vs vector retrieval Trade-off",
      "M0 eval ergebnis nachschauen",
      "ist FTS5/MiniSearch genug?",
    ],
    related: [
      "nexus-recall-ambition-best-memory-tool",
      "nexus-recall-no-overengineering",
    ],
    source: "Eval-Lauf 2026-05-01, scripts/eval.ts",
    confidence: 0.9,
    affects_files: [
      "packages/daemon/scripts/eval.ts",
      "packages/daemon/src/search.ts",
    ],
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
