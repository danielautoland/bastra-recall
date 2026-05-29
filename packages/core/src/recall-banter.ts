/**
 * Recall-Banter-Engine (#38).
 *
 * Pro Stage 3–5 deutsche und englische Varianten, plus ein Pool an
 * „Slow-Phrasen" für Stages, die spürbar lange brauchen. Banter ist UI
 * über dem Event-Stream — niemals blockierend, niemals länger als die
 * Stage selbst.
 *
 * Toggle via `BASTRA_BANTER` env-var:
 *   - `on`     → Stages + Phrasen (default)
 *   - `terse`  → Stages, keine Phrasen
 *   - `off`    → gar nichts (Stages werden trotzdem emittet, der Caller
 *                kann sie still loggen)
 *
 * Der Picker ist deterministisch über `(stageName, durationBucket)`
 * gestreut — gleicher Stage in derselben Sekunde liefert die gleiche
 * Phrase. Das macht Tests stabil ohne Seed-Injection.
 */
import type { RecallStage } from "./recall-stages.js";

export type BanterMode = "on" | "terse" | "off";
export type BanterLang = "de" | "en";

interface PhrasePool {
  de: string[];
  en: string[];
}

const STAGE_PHRASES: Record<RecallStage["name"], PhrasePool> = {
  "query.parse": {
    de: [
      "Query zerlegen …",
      "Stichworte sortieren …",
      "Was suchst du eigentlich?",
      "Tokens packen …",
    ],
    en: [
      "Parsing the query …",
      "Sorting keywords …",
      "What are we looking for?",
      "Tokenizing …",
    ],
  },
  "cache.hit": {
    de: [
      "Schon im Kopf — direkt zurück!",
      "Cache greift, kurzer Weg.",
      "Kenn ich, da war ich gerade.",
      "Cache-Hit — instant.",
    ],
    en: [
      "Already in my head — instant.",
      "Cache hit, taking the shortcut.",
      "Been there a second ago.",
      "Straight from cache.",
    ],
  },
  "bm25.search": {
    de: [
      "Stichwörter durchforsten …",
      "BM25 wühlt im Index …",
      "Treffer einsammeln …",
      "Index abklappern …",
      "Lexikalisch matchen …",
    ],
    en: [
      "Scanning keywords …",
      "BM25 doing its thing …",
      "Collecting matches …",
      "Combing the index …",
      "Lexical match in progress …",
    ],
  },
  "vector.search": {
    de: [
      "Semantik abgleichen …",
      "Embeddings nachdenken lassen …",
      "Vektoren vergleichen …",
      "Bedeutung suchen, nicht nur Worte …",
    ],
    en: [
      "Comparing semantics …",
      "Embeddings pondering …",
      "Vector math in progress …",
      "Meaning over words …",
    ],
  },
  "rrf.fuse": {
    de: [
      "Treffer fusionieren …",
      "Rankings verschmelzen …",
      "Reciprocal-Rank tanzt …",
      "Listen mergen …",
    ],
    en: [
      "Fusing rankings …",
      "Merging hit lists …",
      "RRF doing the dance …",
      "Combining scores …",
    ],
  },
  "hops.expand": {
    de: [
      "Nachbarn besuchen …",
      "Related-via folgen …",
      "Ein Hop weiter …",
      "Verwandte einsammeln …",
    ],
    en: [
      "Visiting neighbors …",
      "Following related-via …",
      "One hop further …",
      "Collecting kinfolk …",
    ],
  },
  "staleness.rank": {
    de: [
      "Frische prüfen …",
      "Alte Memories sanft rausnehmen …",
      "Staleness-Re-Rank …",
      "Wie alt ist das nochmal?",
    ],
    en: [
      "Checking freshness …",
      "Gently demoting old memories …",
      "Staleness re-rank …",
      "How old is this again?",
    ],
  },
  done: {
    de: [
      "Da, bitte.",
      "Hab ich dir.",
      "Fertig.",
      "Soweit alles.",
    ],
    en: [
      "There you go.",
      "Got you.",
      "Done.",
      "All set.",
    ],
  },
  error: {
    de: [
      "Hmm, da ging was schief.",
      "Das wollte nicht.",
      "Fehler — guck mal nach.",
    ],
    en: [
      "Hmm, something tripped.",
      "That didn't work.",
      "Error — please check.",
    ],
  },
};

/** Phrasen für Stages, die spürbar lange brauchen (> 500 ms). Wird
 *  unabhängig vom Stage-Pool benutzt, damit die UX auch dann charmant
 *  bleibt, wenn der eigentliche Stage-Banter schon ausgespielt war. */
const SLOW_PHRASES: PhrasePool = {
  de: [
    "Heute dauert's wieder, einen Moment …",
    "Mein Gott, das zieht sich. Bitte etwas Geduld!",
    "Ich grabe gerade tief — gleich da.",
    "Embeddings haben heute Pause? Moment …",
    "Brauche kurz, sorry — der Vault ist voll.",
  ],
  en: [
    "Taking a moment today, hang tight …",
    "Wow, this is slow. Patience, please.",
    "Digging deep — almost there.",
    "Embeddings on a coffee break? One sec …",
    "Vault is dense today — bear with me.",
  ],
};

const VERY_SLOW_PHRASES: PhrasePool = {
  de: [
    "Okay, das wird heute eine längere Reise …",
    "Eine Sekunde noch — die Memories sind träge.",
    "Du, das dauert wirklich. Nicht weglaufen!",
  ],
  en: [
    "Okay, this is taking a while …",
    "Hold on — memories are sluggish today.",
    "Really slow, this one. Don't run off!",
  ],
};

const SLOW_STAGE_MS = 500;
const VERY_SLOW_STAGE_MS = 1000;

/**
 * Mode aus `BASTRA_BANTER` env-var. Default `on`. Unbekannte Werte
 * fallen auf `on` zurück — kein Fail-Hard für Typos im RC-File.
 */
export function banterModeFromEnv(env: NodeJS.ProcessEnv = process.env): BanterMode {
  const raw = (env.BASTRA_BANTER ?? "on").toLowerCase();
  if (raw === "off") return "off";
  if (raw === "terse") return "terse";
  return "on";
}

/**
 * Liefert eine Banter-Phrase für eine Stage. `null` bedeutet „nichts
 * zeigen" (`mode = "off"` oder `mode = "terse"`). Bei „slow"-Phrasen
 * mit `durationMs > 500 ms` wird zusätzlich aus dem SLOW-Pool gepickt,
 * statt aus dem Stage-Pool — der User sieht, dass die App den
 * Latenz-Spike erkannt hat, statt einer normalen Stage-Phrase.
 */
export function pickPhrase(
  stage: RecallStage,
  mode: BanterMode,
  lang: BanterLang,
): string | null {
  if (mode === "off" || mode === "terse") return null;

  const duration = stage.durationMs ?? 0;
  if (duration >= VERY_SLOW_STAGE_MS) {
    return pickFromPool(VERY_SLOW_PHRASES, lang, deterministicSeed(stage));
  }
  if (duration >= SLOW_STAGE_MS) {
    return pickFromPool(SLOW_PHRASES, lang, deterministicSeed(stage));
  }
  const pool = STAGE_PHRASES[stage.name];
  if (!pool) return null;
  return pickFromPool(pool, lang, deterministicSeed(stage));
}

/**
 * Stabile, billige Streuung über `(stageName, sekundenBucket)`. Tests
 * können denselben Stage in derselben Sekunde mehrfach picken und
 * bekommen dieselbe Phrase — keine Snapshot-Drift.
 */
function deterministicSeed(stage: RecallStage): number {
  const bucket = Math.floor(stage.startedAtMs / 1000);
  let hash = 0;
  const key = `${stage.name}:${bucket}`;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pickFromPool(pool: PhrasePool, lang: BanterLang, seed: number): string {
  const arr = pool[lang];
  if (arr.length === 0) return "";
  return arr[seed % arr.length];
}
