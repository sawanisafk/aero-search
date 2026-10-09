/**
 * Trace Search seed: runs a curated set of REAL queries from the committed
 * CQADupStack eval inputs through the full engine pipeline —
 *
 *   parse -> analyze -> posting lookup -> candidate retrieval -> BM25 -> ranking
 *
 * — against the default demo index, and records every stage's actual numbers
 * in a committed artifact. Nothing here is illustrative: term lists, df/posting
 * counts, candidate totals, scores, and timings all come from the engine.
 *
 *   npx tsx scripts/trace-sample.ts                    # default corpus (cqadupstack-tierb)
 *   npx tsx scripts/trace-sample.ts --corpus cqadupstack-unix
 *
 * Output: data/eval/cqadupstack-trace-queries.json (regenerate after index rebuilds)
 *
 * Timings are single-run wall-clock measurements — indicative of stage
 * proportions, not benchmark statistics (use eval:run latency for that).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadIndexBundle } from './lib/retrieval-run.js';
import { getGitInfo } from './lib/dataset.js';
import { parseQuery, QueryParseError, type Query } from '../src/core/query/index.js';
import { analyzeQuery, retrieveAnalyzed, type AnalyzedQuery } from '../src/core/retrieval/index.js';
import { createStrategy } from '../src/core/ranking/index.js';

interface Selection {
  readonly stack: string;
  readonly queryId: string;
  readonly why: string;
}

/** Real query ids from data/eval/cqadupstack-<stack>-queries.jsonl. */
const SELECTION: readonly Selection[] = [
  { stack: 'unix', queryId: '116498', why: 'canonical short technical query (file permissions)' },
  { stack: 'unix', queryId: '18760', why: 'quoted command names + hyphenated flag (tail -f)' },
  { stack: 'unix', queryId: '12203', why: 'error-message style query with punctuation-heavy quoted text' },
  { stack: 'unix', queryId: '73750', why: 'known parse failure (EMPTY_GROUP on foo() {}) — records the failure path honestly' },
  { stack: 'tex', queryId: '103546', why: 'LaTeX control sequences (\\ref, \\label) through the analyzer' },
  { stack: 'tex', queryId: '114223', why: 'long natural question with repeated topic words (font files/sizes)' },
  { stack: 'programmers', queryId: '54451', why: 'short conceptual query with vs. separators' },
  { stack: 'programmers', queryId: '251126', why: 'natural question with comma + domain term (Web API)' },
];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

function queryText(stack: string, queryId: string): string {
  const file = path.join(process.cwd(), 'data', 'eval', `cqadupstack-${stack}-queries.jsonl`);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as { _id: string; text: string };
    if (row._id === queryId) return row.text;
  }
  throw new Error(`query ${queryId} not found in ${file}`);
}

function serializeAst(q: Query): unknown {
  switch (q.kind) {
    case 'term':
      return { kind: 'term', term: q.term };
    case 'phrase':
      return { kind: 'phrase', terms: q.terms };
    case 'and':
      return { kind: 'and', left: serializeAst(q.left), right: serializeAst(q.right) };
    case 'or':
      return { kind: 'or', left: serializeAst(q.left), right: serializeAst(q.right) };
    case 'not':
      return { kind: 'not', operand: serializeAst(q.operand) };
  }
}

function serializeAnalyzed(a: AnalyzedQuery): unknown {
  switch (a.kind) {
    case 'term':
      return { kind: 'term', terms: a.terms };
    case 'phrase':
      return { kind: 'phrase', terms: a.terms };
    case 'and':
      return { kind: 'and', left: serializeAnalyzed(a.left), right: serializeAnalyzed(a.right) };
    case 'or':
      return { kind: 'or', left: serializeAnalyzed(a.left), right: serializeAnalyzed(a.right) };
    case 'not':
      return { kind: 'not', operand: serializeAnalyzed(a.operand) };
  }
}

function collectTerms(a: AnalyzedQuery, out: Set<string>): void {
  switch (a.kind) {
    case 'term':
    case 'phrase':
      for (const t of a.terms) out.add(t);
      return;
    case 'and':
    case 'or':
      collectTerms(a.left, out);
      collectTerms(a.right, out);
      return;
    case 'not':
      collectTerms(a.operand, out);
  }
}

function main(): void {
  const corpus = argValue('--corpus') ?? 'cqadupstack-tierb';
  const bundle = loadIndexBundle(corpus);
  const strategy = createStrategy('bm25', {});
  const stats = bundle.reader.stats();

  // titles for the top hits (one pass over the corpus file, ids are line-keyed)
  const corpusFile = path.join(process.cwd(), 'data', 'corpora', corpus, 'corpus.jsonl');
  const titles = new Map<string, string>();
  if (fs.existsSync(corpusFile)) {
    for (const line of fs.readFileSync(corpusFile, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const d = JSON.parse(line) as { _id: string; title?: string };
      titles.set(d._id, d.title ?? '');
    }
  }

  const queries = SELECTION.map((sel) => {
    const text = queryText(sel.stack, sel.queryId);
    const stages: Record<string, number> = {};
    const t0 = performance.now();
    try {
      const parsed = parseQuery(text, { implicitOperator: 'or' });
      stages.parse_ms = performance.now() - t0;

      const t1 = performance.now();
      const analyzed = analyzeQuery(parsed, bundle.reader.analysis);
      stages.analysis_ms = performance.now() - t1;

      const t2 = performance.now();
      const distinct = new Set<string>();
      collectTerms(analyzed, distinct);
      const postings = [...distinct].map((term) => {
        const view = bundle.reader.postingsForTerm(term);
        return {
          term,
          in_index: view !== null,
          df: view?.df ?? 0,
          postings: view?.size ?? 0,
        };
      });
      stages.postings_ms = performance.now() - t2;

      const t3 = performance.now();
      const candidates = retrieveAnalyzed(bundle.reader, analyzed);
      stages.retrieve_ms = performance.now() - t3;

      const t4 = performance.now();
      const scored = strategy.rank(bundle.reader, analyzed, candidates);
      stages.rank_ms = performance.now() - t4;
      stages.total_ms = performance.now() - t0;

      return {
        stack: sel.stack,
        query_id: sel.queryId,
        why: sel.why,
        text,
        parsed: serializeAst(parsed),
        analyzed: serializeAnalyzed(analyzed),
        postings,
        candidate_docs: candidates.length,
        results: scored.slice(0, 10).map((s, i) => ({
          rank: i + 1,
          corpus_id: bundle.ids[s.docId]!,
          title: titles.get(bundle.ids[s.docId]!) ?? '',
          score: Number(s.score.toFixed(6)),
        })),
        timings_ms: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, Number(v.toFixed(3))])),
        parse_failure: null as string | null,
      };
    } catch (e) {
      const code = e instanceof QueryParseError ? e.code : 'INTERNAL';
      return {
        stack: sel.stack,
        query_id: sel.queryId,
        why: sel.why,
        text,
        parsed: null,
        analyzed: null,
        postings: [],
        candidate_docs: 0,
        results: [],
        timings_ms: { total_ms: Number((performance.now() - t0).toFixed(3)) },
        parse_failure: code,
      };
    }
  });

  const artifact = {
    generated_at: new Date().toISOString(),
    git: getGitInfo(),
    corpus: {
      name: corpus,
      corpus_hash: bundle.corpusHash,
      num_docs: stats.numDocs,
      vocab_size: stats.vocabSize,
      num_postings: stats.numPostings,
      avg_doc_length: stats.avgDocLength,
    },
    strategy: strategy.id,
    notes:
      'Every value is produced by the engine over the committed eval inputs (no fabricated ' +
      'data). Timings are single-run wall-clock per stage — indicative, not benchmark stats. ' +
      'Regenerate after index rebuilds: npm run trace:sample',
    selection_count: SELECTION.length,
    queries,
  };
  const out = path.join(process.cwd(), 'data', 'eval', 'cqadupstack-trace-queries.json');
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const failures = queries.filter((q) => q.parse_failure !== null).length;
  console.log(`[trace] ${queries.length} queries over ${corpus} (${stats.numDocs} docs)`);
  console.log(`[trace] parse failures recorded: ${failures}`);
  for (const q of queries) {
    console.log(
      `  ${q.stack}/${q.query_id}: ${q.parse_failure ?? `${q.candidate_docs} candidates, top score ${q.results[0]?.score ?? 'n/a'}`}`,
    );
  }
  console.log(`[trace] artifact ${out}`);
}

main();
