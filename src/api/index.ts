/**
 * Public barrel for the API layer — tests and scripts import from here.
 */

export { buildApp, type BuildAppOptions } from './app.js';
export { loadConfig, type ApiConfig, MAX_K, MAX_PAGE, MAX_QUERY_LENGTH } from './config.js';
export {
  SearchService,
  ServiceError,
  STRATEGY_LABELS,
  type SearchParams,
  type SearchResponse,
  type SearchHit,
  type DocDetail,
  type StatsResponse,
  type ConfigResponse,
} from './search-service.js';
export { createDocStore, type DocStore, type DocMeta } from './doc-store.js';
export { makeSnippet, type Snippet, type SnippetHighlight } from './snippets.js';
