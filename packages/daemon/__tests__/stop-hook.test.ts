import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  evaluateHeuristics,
  detectFrustration,
  detectFeatureCompletion,
  detectArchitectureDecision,
  formatSuggestion,
  parseTranscriptFile,
  normalizeTurns,
  type TranscriptTurn,
} from "../src/stop-hook.js";

function userTurn(content: string): TranscriptTurn {
  return { role: "user", content };
}
function assistantTurn(content: string): TranscriptTurn {
  return { role: "assistant", content };
}

describe("stop-hook: detectFrustration", () => {
  it("fires on >=3 'wieder' tokens in window", () => {
    const turns: TranscriptTurn[] = [
      userTurn("schon wieder kaputt"),
      assistantTurn("sorry"),
      userTurn("wieder das gleiche!"),
      assistantTurn("fixe ich"),
      userTurn("wieder!"),
    ];
    const s = detectFrustration(turns);
    assert.ok(s);
    assert.equal(s!.heuristic, "frustration-density");
  });

  it("counts CAPS-words as frustration cues", () => {
    const turns: TranscriptTurn[] = [
      userTurn("NEIN das war FALSCH"),
      userTurn("wieder kaputt"),
      userTurn("ECHT JETZT"),
    ];
    const s = detectFrustration(turns);
    assert.ok(s);
  });

  it("does not fire below threshold", () => {
    const turns: TranscriptTurn[] = [
      userTurn("normal"),
      userTurn("alles ok"),
      userTurn("klingt gut"),
    ];
    assert.equal(detectFrustration(turns), null);
  });
});

describe("stop-hook: detectFeatureCompletion", () => {
  it("fires on git commit + >=3 file tokens", () => {
    const turns: TranscriptTurn[] = [
      assistantTurn(
        "running git commit -m 'feat: x'\n" +
          "edited packages/daemon/src/foo.ts, packages/daemon/src/bar.ts, packages/daemon/__tests__/foo.test.ts",
      ),
    ];
    const s = detectFeatureCompletion(turns);
    assert.ok(s);
    assert.equal(s!.heuristic, "feature-completion");
    assert.equal(s!.type, "project-fact");
  });

  it("does not fire without commit mention", () => {
    const turns: TranscriptTurn[] = [
      assistantTurn("just reading foo.ts, bar.ts, baz.ts — no changes"),
    ];
    assert.equal(detectFeatureCompletion(turns), null);
  });

  it("does not fire without enough files", () => {
    const turns: TranscriptTurn[] = [
      assistantTurn("git commit -m 'tweak'\nonly foo.ts touched"),
    ];
    assert.equal(detectFeatureCompletion(turns), null);
  });
});

describe("stop-hook: detectArchitectureDecision", () => {
  it("fires on 'ok dann'", () => {
    const turns: TranscriptTurn[] = [
      userTurn("ok dann nehmen wir Drizzle"),
    ];
    const s = detectArchitectureDecision(turns);
    assert.ok(s);
    assert.equal(s!.heuristic, "architecture-decision");
    assert.equal(s!.type, "decision");
  });

  it("fires on 'lass uns'", () => {
    assert.ok(detectArchitectureDecision([userTurn("lass uns mit MapKit gehen")]));
  });

  it("does not fire on neutral chatter", () => {
    assert.equal(
      detectArchitectureDecision([userTurn("schauen wir mal weiter")]),
      null,
    );
  });
});

describe("stop-hook: evaluateHeuristics", () => {
  it("returns empty array on neutral transcript", () => {
    const out = evaluateHeuristics([
      userTurn("bitte X"),
      assistantTurn("done"),
    ]);
    assert.deepEqual(out, []);
  });

  it("can fire multiple heuristics at once", () => {
    const turns: TranscriptTurn[] = [
      userTurn("wieder kaputt"),
      userTurn("schon wieder"),
      userTurn("WIE OFT NOCH"),
      assistantTurn("git commit -m 'fix'\nedited a.ts, b.ts, c.ts"),
      userTurn("ok dann nehmen wir das"),
    ];
    const out = evaluateHeuristics(turns);
    const kinds = out.map((s) => s.heuristic).sort();
    assert.deepEqual(kinds, [
      "architecture-decision",
      "feature-completion",
      "frustration-density",
    ]);
  });
});

describe("stop-hook: formatSuggestion", () => {
  it("emits <save-eval> block with title/type/body lines", () => {
    const s = {
      heuristic: "frustration-density" as const,
      title: "x",
      type: "lesson" as const,
      body: "the body",
    };
    const out = formatSuggestion(s);
    assert.match(out, /<save-eval>/);
    assert.match(out, /heuristic: frustration-density/);
    assert.match(out, /title: "x"/);
    assert.match(out, /type: lesson/);
    assert.match(out, /<\/save-eval>/);
  });
});

describe("stop-hook: parseTranscriptFile", () => {
  it("parses JSONL", () => {
    const raw = [
      JSON.stringify({ role: "user", content: "hi" }),
      JSON.stringify({ role: "assistant", content: "ok" }),
    ].join("\n");
    const turns = parseTranscriptFile(raw);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, "user");
  });

  it("parses Claude-Code nested message shape", () => {
    const raw = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hello" },
    });
    const turns = parseTranscriptFile(raw);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].content, "hello");
  });

  it("parses array-of-content-blocks", () => {
    const items = [{ role: "user", content: [{ type: "text", text: "hi there" }] }];
    const turns = normalizeTurns(items);
    assert.equal(turns[0].content, "hi there");
  });

  it("returns empty on garbage input", () => {
    assert.deepEqual(parseTranscriptFile("not json at all"), []);
  });
});
