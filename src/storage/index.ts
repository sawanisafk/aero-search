export {
  AIDX_VERSION,
  serializeSegment,
  deserializeSegment,
  writeSegment,
  readSegment,
  exportSegmentJson,
} from './segment.js';
export { loadCorpus, extractTitle, extractText } from './corpus.js';
export type { CorpusDocumentMeta, CorpusManifest, LoadedCorpus } from './corpus.js';
