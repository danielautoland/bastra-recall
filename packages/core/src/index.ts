/**
 * @bastra-recall/core — public API.
 *
 * Reusable building blocks shared by the daemon (MCP server) and the
 * Mac-app surface. No transport coupling lives here.
 */

export { Vault } from "./vault.js";
export type { VaultEvent, VaultListener } from "./vault.js";

export { SearchIndex } from "./search.js";
export type { RecallHit, RecallOptions } from "./search.js";

export type { RecallStage, StageListener } from "./recall-stages.js";
export { RECALL_STAGE_ORDER, progressIndexFor } from "./recall-stages.js";

export { pickPhrase, pickToolPhrase, banterModeFromEnv } from "./recall-banter.js";
export type { BanterMode, BanterLang } from "./recall-banter.js";

export {
  saveMemory,
  deleteMemoryFile,
  slugify,
  SaveMemoryInput,
  extractWikilinks,
  stripAutoRelatedSection,
  AUTO_RELATED_START,
  AUTO_RELATED_END,
} from "./save.js";
export type { SaveMemoryResult, DeleteMemoryResult } from "./save.js";

export {
  MemoryTypeEnum,
  FrontmatterSchema,
  parseMemory,
  parseMemoryWith,
  NotAMemoryFile,
} from "./schema.js";
export type { Memory, MemoryType, Frontmatter } from "./schema.js";

export { detectTopics, detectProject, extractContentExcerpt } from "./topics.js";
export type { ToolIntent, TopicResult } from "./topics.js";

export {
  AuditLog,
  trashPathFor,
  moveToTrash,
  restoreFromTrash,
} from "./audit-log.js";
export type { AuditEntry, AuditOperation, AuditActor } from "./audit-log.js";

export {
  AuditContext,
  auditedSave,
  auditedSoftDelete,
  auditedRestore,
} from "./audit-save.js";

export {
  EmbeddingIndex,
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  fuseRRF,
} from "./embeddings.js";
export type { EmbeddingProvider, EmbeddingHit, EmbedListener } from "./embeddings.js";

export { EmbedCache, hashEmbedContent } from "./embed-cache.js";
export type { EmbedCacheEntry, EmbedCacheFile } from "./embed-cache.js";

export { RelatedEnricher } from "./related-enrich.js";
export type { RelatedEnricherOptions } from "./related-enrich.js";
