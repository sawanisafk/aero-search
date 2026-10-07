/**
 * English stop-word list for the analysis pipeline (classic IR-style list).
 *
 * Design note (documented in docs/INDEXING.md): stop-word removal is a
 * configurable analysis option, not hard-coded behavior — the evaluation
 * harness can compare stemming on/off and stop-words on/off as experimental
 * axes. The active configuration is frozen into the index segment header so
 * query analysis always matches index analysis.
 *
 * Entries are normalized with the same rules the tokenizer applies to tokens
 * (lowercase, apostrophes stripped: "can't" -> "cant"), so lookup happens on
 * the normalized token before stemming.
 */

const RAW = [
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are',
  "aren't", 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both',
  'but', 'by', 'can', "can't", 'cannot', 'could', "couldn't", 'did', "didn't", 'do', 'does',
  "doesn't", 'doing', "don't", 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had',
  "hadn't", 'has', "hasn't", 'have', "haven't", 'having', 'he', "he'd", "he'll", "he's", 'her',
  'here', "here's", 'hers', 'herself', 'him', 'himself', 'his', 'how', "how's", 'i', "i'd",
  "i'll", "i'm", "i've", 'if', 'in', 'into', 'is', "isn't", 'it', "it's", 'its', 'itself',
  "let's", 'me', 'more', 'most', "mustn't", 'my', 'myself', 'no', 'nor', 'not', 'of', 'off',
  'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', "shan't", 'she', "she'd", "she'll", "she's", 'should', "shouldn't", 'so', 'some',
  'such', 'than', 'that', "that's", 'the', 'their', 'theirs', 'them', 'themselves', 'then',
  'there', "there's", 'these', 'they', "they'd", "they'll", "they're", "they've", 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', "wasn't", 'we', "we'd",
  "we'll", "we're", "we've", 'were', "weren't", 'what', "what's", 'when', "when's", 'where',
  "where's", 'which', 'while', 'who', "who's", 'whom', 'why', "why's", 'with', "won't", 'would',
  "wouldn't", 'you', "you'd", "you'll", "you're", "you've", 'your', 'yours', 'yourself',
  'yourselves',
];

function normalizeStopword(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set(RAW.map(normalizeStopword));
