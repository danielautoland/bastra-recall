/**
 * Topic detection for PreToolUse hooks.
 *
 * Pure, deterministic, no IO. Given a tool invocation we are about to make
 * (Write / Edit / MultiEdit), turn it into a recall() query plus topic tags
 * that future-Claude has likely tagged in the vault.
 *
 * The heuristic is intentionally simple — extension + path segments +
 * content keywords. AST parsing is out of scope until v0.5; the recall
 * weighting puts `recall_when` at 5x and title at 4x, so even rough hints
 * tend to retrieve the right memory if the saver populated `recall_when`
 * with action phrases ("writing tsx with input", etc.).
 */
import { basename, extname } from "node:path";

export interface ToolIntent {
  tool_name: "Write" | "Edit" | "MultiEdit" | "NotebookEdit" | string;
  file_path: string | null;
  /** Concatenated content / new_string excerpt(s). May be empty. */
  content_excerpt: string;
}

export interface TopicResult {
  /** Natural-language query string for recall(). */
  query: string;
  /** Distinct topics, ordered by signal strength. */
  topics: string[];
  /** Detected file kind, e.g. "tsx", "css", "sql". May be "" if unknown. */
  filetype: string;
}

const EXT_TOPICS: Record<string, string[]> = {
  ".tsx": ["react", "tsx", "component", "ui"],
  ".jsx": ["react", "jsx", "component", "ui"],
  ".ts": ["typescript"],
  ".js": ["javascript"],
  ".mjs": ["javascript", "esm"],
  ".cjs": ["javascript", "commonjs"],
  ".css": ["css", "styles"],
  ".scss": ["scss", "css", "styles"],
  ".html": ["html", "markup"],
  ".vue": ["vue", "component", "ui"],
  ".svelte": ["svelte", "component", "ui"],
  ".py": ["python"],
  ".rb": ["ruby"],
  ".go": ["golang"],
  ".rs": ["rust"],
  ".swift": ["swift"],
  ".kt": ["kotlin"],
  ".java": ["java"],
  ".sh": ["shell", "bash"],
  ".zsh": ["shell", "zsh"],
  ".sql": ["sql", "database", "schema"],
  ".prisma": ["prisma", "schema", "database"],
  ".graphql": ["graphql", "schema"],
  ".gql": ["graphql", "schema"],
  ".yaml": ["yaml", "config"],
  ".yml": ["yaml", "config"],
  ".toml": ["toml", "config"],
  ".json": ["json", "config"],
  ".md": ["markdown", "docs"],
  ".mdx": ["mdx", "markdown", "docs"],
};

const PATH_SEGMENT_TOPICS: Record<string, string[]> = {
  api: ["api", "endpoint"],
  apis: ["api", "endpoint"],
  routes: ["routing", "api"],
  pages: ["routing", "page"],
  app: ["routing"],
  components: ["component", "ui"],
  hooks: ["react-hook"],
  tests: ["testing", "test"],
  __tests__: ["testing", "test"],
  spec: ["testing", "test"],
  e2e: ["testing", "e2e"],
  migrations: ["migration", "schema", "database"],
  schema: ["schema"],
  models: ["model", "schema"],
  styles: ["css", "styles"],
  ui: ["ui"],
  forms: ["form", "ui"],
  auth: ["auth", "security"],
  middleware: ["middleware"],
  lib: ["library"],
  utils: ["utility"],
  scripts: ["script"],
  daemon: ["daemon"],
};

/** Order matters — the first match wins for filetype labelling. */
const CONTENT_PATTERNS: { re: RegExp; topics: string[] }[] = [
  // React / JSX intent
  { re: /<input\b/i, topics: ["input", "form"] },
  { re: /<button\b/i, topics: ["button", "ui"] },
  { re: /<form\b/i, topics: ["form", "ui"] },
  { re: /<select\b/i, topics: ["select", "form"] },
  { re: /<textarea\b/i, topics: ["textarea", "form"] },
  { re: /\buseState\b/, topics: ["react-hook", "state"] },
  { re: /\buseEffect\b/, topics: ["react-hook", "effect"] },
  { re: /\buseMemo\b|\buseCallback\b/, topics: ["react-hook", "memoization"] },
  { re: /\buseRef\b/, topics: ["react-hook", "ref"] },
  // CSS intent
  { re: /\b(display\s*:\s*grid|grid-template)/i, topics: ["css-grid", "layout"] },
  { re: /\b(display\s*:\s*flex|flex-direction)/i, topics: ["flexbox", "layout"] },
  { re: /:focus(-visible|-within)?\b/, topics: ["focus", "accessibility"] },
  { re: /\b(outline|box-shadow|ring-)/, topics: ["focus-ring", "outline"] },
  { re: /\bz-index\b/i, topics: ["stacking", "z-index"] },
  { re: /\boverflow\s*:/i, topics: ["overflow", "scrollbar"] },
  { re: /\bscrollbar\b/i, topics: ["scrollbar"] },
  // SQL / migration intent
  { re: /\bCREATE\s+TABLE\b/i, topics: ["sql", "schema", "migration"] },
  { re: /\bALTER\s+TABLE\b/i, topics: ["sql", "migration", "schema-change"] },
  { re: /\bINSERT\s+INTO\b/i, topics: ["sql", "insert"] },
  { re: /\bSELECT\b.+\bFROM\b/is, topics: ["sql", "query"] },
  // Auth / security
  { re: /\b(jwt|bearer|oauth|session)\b/i, topics: ["auth", "security"] },
  { re: /\bbcrypt|argon2|sha-?256|crypto\b/i, topics: ["crypto", "security"] },
  // Tests
  { re: /\b(describe|it|test|expect)\s*\(/, topics: ["testing"] },
];

/**
 * Scan path segments looking for known topic-rich folders.
 * Walks left→right so the deepest topic ends up first.
 */
function pathSegmentTopics(filePath: string): string[] {
  const segments = filePath.split("/").map((s) => s.toLowerCase());
  const out: string[] = [];
  for (const seg of segments) {
    const t = PATH_SEGMENT_TOPICS[seg];
    if (t) out.push(...t);
  }
  return out;
}

/** Best-effort project name from cwd, e.g. /Users/x/Projekte/bastra-recall → "bastra-recall". */
export function detectProject(cwd: string): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  // Common roots: Projekte, projects, Code, Workspace, src, repos
  const ROOTS = new Set(["projekte", "projects", "code", "workspace", "src", "repos"]);
  for (let i = 0; i < parts.length - 1; i++) {
    if (ROOTS.has(parts[i].toLowerCase())) return parts[i + 1];
  }
  // Fallback: last segment (good when cwd *is* the repo root).
  return parts[parts.length - 1] ?? null;
}

export function detectTopics(intent: ToolIntent): TopicResult {
  const topics = new Set<string>();
  const fp = intent.file_path ?? "";
  const ext = fp ? extname(fp).toLowerCase() : "";
  const filetype = ext.startsWith(".") ? ext.slice(1) : "";

  const extTopics = EXT_TOPICS[ext];
  if (extTopics) for (const t of extTopics) topics.add(t);

  for (const t of pathSegmentTopics(fp)) topics.add(t);

  const content = intent.content_excerpt ?? "";
  if (content) {
    for (const { re, topics: ts } of CONTENT_PATTERNS) {
      if (re.test(content)) for (const t of ts) topics.add(t);
    }
  }

  const topicList = [...topics];
  const fileLabel = filetype || (fp ? basename(fp) : "file");
  const intentVerb = intent.tool_name === "Write" ? "writing" : "editing";

  // Build a recall query. We bias toward action verbs (writing/editing) +
  // filetype + the top topics. The vault's `recall_when` patterns tend to
  // be phrased like "creating new input component" — so action verbs help.
  //
  // We deliberately do NOT inject the full file_path into the query: project
  // / monorepo names (e.g. "bastra-recall") are very high-frequency tokens
  // across project memorys and would drown out specific topic signal. Path
  // segments still feed `topics` above, which is enough.
  const head = `${intentVerb} ${fileLabel}`;
  const tail = topicList.length ? ` involving ${topicList.slice(0, 6).join(", ")}` : "";
  const query = head + tail;

  return { query, topics: topicList, filetype };
}

/**
 * Pull a representative content excerpt out of a Claude-Code tool_input
 * payload. Caps at maxChars to keep the recall query bounded — the goal is
 * topic detection, not full-text similarity.
 */
export function extractContentExcerpt(
  toolName: string,
  toolInput: Record<string, unknown>,
  maxChars = 4000,
): string {
  const pieces: string[] = [];
  if (toolName === "Write" && typeof toolInput.content === "string") {
    pieces.push(toolInput.content);
  }
  if (toolName === "Edit") {
    if (typeof toolInput.new_string === "string") pieces.push(toolInput.new_string);
    if (typeof toolInput.old_string === "string") pieces.push(toolInput.old_string);
  }
  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits as { new_string?: unknown; old_string?: unknown }[]) {
      if (typeof e.new_string === "string") pieces.push(e.new_string);
      if (typeof e.old_string === "string") pieces.push(e.old_string);
    }
  }
  if (toolName === "NotebookEdit" && typeof toolInput.new_source === "string") {
    pieces.push(toolInput.new_source);
  }
  const joined = pieces.join("\n");
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}
