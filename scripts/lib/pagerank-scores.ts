/**
 * Eval-time PageRank over an offline citation graph (M4-B): maps the
 * committed Semantic Scholar edge list onto index docIds and runs the same
 * pure power-iteration core as the crawl job (`src/core/link/pagerank.ts`).
 *
 * Provenance contract: the graph file carries its own `graphHash` (computed
 * by the fetch script) and the run artifact records it plus the PageRank
 * parameters — a run is reproducible from the committed file alone. Endpoints
 * that do not exist in the index id map are a mapping bug, not data: we throw
 * instead of silently dropping edges.
 */

import fs from 'node:fs';
import {
  DEFAULT_DAMPING,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOLERANCE,
  pageRank,
  type PageRankOptions,
} from '../../src/core/link/pagerank.js';

export interface CitationGraph {
  readonly file: string;
  readonly kind: string;
  /** Directed edges [citing, cited] with endpoints as integer corpus ids. */
  readonly edges: ReadonlyArray<readonly [number, number]>;
  /** Hash of the edge list as recorded by the fetch script. */
  readonly graphHash: string;
  readonly stats: Readonly<Record<string, number>>;
}

export interface LinkGraphBundle {
  /** docId -> corpus document id. */
  readonly ids: readonly string[];
  readonly docIdByCorpusId: ReadonlyMap<string, number>;
}

export interface PageRankRunMeta {
  readonly damping: number;
  readonly tolerance: number;
  readonly maxIterations: number;
  readonly iterations: number;
  readonly converged: boolean;
  readonly residual: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly graphHash: string;
}

export function loadCitationGraph(file: string): CitationGraph {
  if (!fs.existsSync(file)) throw new Error(`citation graph not found: ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    kind?: unknown;
    edges?: unknown;
    graphHash?: unknown;
    stats?: unknown;
  };
  if (!Array.isArray(parsed.edges)) throw new Error(`${file}: missing "edges" array`);
  const statsObj =
    parsed.stats && typeof parsed.stats === 'object' ? (parsed.stats as Record<string, unknown>) : {};
  // Fetch scripts have placed the hash either at top level or inside stats.
  const graphHash =
    typeof parsed.graphHash === 'string' && parsed.graphHash.length > 0
      ? parsed.graphHash
      : typeof statsObj.graphHash === 'string' && statsObj.graphHash.length > 0
        ? statsObj.graphHash
        : undefined;
  if (graphHash === undefined) throw new Error(`${file}: missing "graphHash"`);
  const edges: [number, number][] = parsed.edges.map((e, i) => {
    if (!Array.isArray(e) || e.length !== 2) throw new Error(`${file}: edges[${i}] is not a pair`);
    const [u, v] = e as [unknown, unknown];
    if (!Number.isInteger(u) || !Number.isInteger(v)) {
      throw new Error(`${file}: edges[${i}] endpoints must be integer corpus ids`);
    }
    return [u as number, v as number];
  });
  const stats: Record<string, number> = {};
  for (const [k, v] of Object.entries(statsObj)) {
    if (typeof v === 'number') stats[k] = v;
  }
  return {
    file,
    kind: typeof parsed.kind === 'string' ? parsed.kind : 'unknown',
    edges,
    graphHash,
    stats,
  };
}

/**
 * PageRank scores for every index doc (length = ids.length, sums to 1).
 * Nodes are docIds; an edge appears iff BOTH endpoints map to index docs.
 */
export function pageRankForBundle(
  bundle: LinkGraphBundle,
  graph: CitationGraph,
  options: PageRankOptions = {},
): { scores: Float64Array; meta: PageRankRunMeta } {
  const mapped: [number, number][] = [];
  const map = (corpusId: number): number => {
    const docId = bundle.docIdByCorpusId.get(String(corpusId));
    if (docId === undefined) {
      throw new Error(
        `citation graph endpoint ${corpusId} (${graph.file}) not in index id map — mapping bug, refusing to drop edges`,
      );
    }
    return docId;
  };
  for (const [u, v] of graph.edges) mapped.push([map(u), map(v)]);

  const result = pageRank(bundle.ids.length, mapped, options);
  const meta: PageRankRunMeta = {
    damping: options.dampingFactor ?? DEFAULT_DAMPING,
    tolerance: options.tolerance ?? DEFAULT_TOLERANCE,
    maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    iterations: result.iterations,
    converged: result.converged,
    residual: result.residual,
    nodeCount: bundle.ids.length,
    edgeCount: mapped.length,
    graphHash: graph.graphHash,
  };
  return { scores: result.scores, meta };
}
