/**
 * PageRank (ARCHITECTURE §6): offline authority signal over the crawled
 * link graph — `π ← (1−d)/N + d·(Aᵀπ + dangling/N)`.
 *
 * Design decisions:
 * - Power iteration with the classic dangling-mass redistribution: nodes with
 *   out-degree 0 leak their mass uniformly to every node, so the walk is a
 *   single recurrent class regardless of disconnected components.
 * - Deterministic by construction: uniform 1/N start, edges deduplicated and
 *   sorted (u asc, v asc) before iteration, so accumulation order — and thus
 *   floating-point results — are bitwise reproducible across runs/platforms.
 * - Convergence: L1 residual ‖πₜ − πₜ₋₁‖₁ < tolerance (default 1e-6 per
 *   ARCHITECTURE). Hitting maxIterations returns converged=false with the
 *   residual — never a silent partial result.
 * - Pure functions over numeric arrays; no I/O. Node ids are caller-assigned
 *   0..N−1 (the job maps document urls ↔ ids); duplicate edges (same u→v at
 *   different crawl positions) count once, self-loops are kept.
 */

export interface PageRankOptions {
  /** Teleport retention of the random surfer's restart probability, (0, 1). Default 0.85. */
  dampingFactor?: number;
  /** Stop when the L1 residual of an iteration drops below this. Default 1e-6. */
  tolerance?: number;
  /** Hard iteration cap; result is flagged not-converged if reached. Default 100. */
  maxIterations?: number;
}

export interface PageRankResult {
  /** Stationary distribution, length N, sums to 1 (within fp error). */
  scores: Float64Array;
  /** Iterations actually executed (>= 1). */
  iterations: number;
  converged: boolean;
  /** L1 residual of the last iteration. */
  residual: number;
}

export interface AdjacencyGraph {
  numNodes: number;
  /** numNodes + 1 offsets into targets (CSR). */
  offsets: Uint32Array;
  /** Deduplicated targets, sorted by (source, target). */
  targets: Uint32Array;
  outDegree: Uint32Array;
}

export const DEFAULT_DAMPING = 0.85;
export const DEFAULT_TOLERANCE = 1e-6;
export const DEFAULT_MAX_ITERATIONS = 100;

/**
 * Deduplicate and sort edges into CSR adjacency. Out-of-range endpoints throw
 * — a graph that does not fit numNodes is a mapping bug, not data.
 */
export function buildGraph(numNodes: number, edges: Iterable<readonly [number, number]>): AdjacencyGraph {
  if (!Number.isInteger(numNodes) || numNodes < 1) {
    throw new Error(`pagerank: numNodes must be an integer >= 1, got ${numNodes}`);
  }
  const pairs = new Set<string>();
  for (const [u, v] of edges) {
    if (!Number.isInteger(u) || !Number.isInteger(v) || u < 0 || v < 0 || u >= numNodes || v >= numNodes) {
      throw new Error(`pagerank: edge (${u}, ${v}) outside 0..${numNodes - 1}`);
    }
    pairs.add(`${u},${v}`);
  }
  const sorted = [...pairs].map((p) => p.split(',').map(Number) as [number, number]);
  sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const outDegree = new Uint32Array(numNodes);
  for (const [u] of sorted) outDegree[u] = outDegree[u]! + 1;

  const offsets = new Uint32Array(numNodes + 1);
  for (const [u] of sorted) offsets[u + 1] = offsets[u + 1]! + 1;
  for (let i = 0; i < numNodes; i++) offsets[i + 1] = offsets[i + 1]! + offsets[i]!;

  const targets = new Uint32Array(sorted.length);
  const cursor = Uint32Array.from(offsets.subarray(0, numNodes));
  for (const [u, v] of sorted) { const at = cursor[u]!; targets[at] = v; cursor[u] = at + 1; }
  return { numNodes, offsets, targets, outDegree };
}

/**
 * Power-iteration PageRank. `edges` are deduplicated and sorted internally,
 * so identical graphs always produce bitwise-identical scores.
 */
export function pageRank(
  numNodes: number,
  edges: Iterable<readonly [number, number]>,
  options: PageRankOptions = {},
): PageRankResult {
  const d = options.dampingFactor ?? DEFAULT_DAMPING;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!(d >= 0 && d < 1)) throw new Error(`pagerank: dampingFactor must be in [0, 1), got ${d}`);
  if (!(tolerance > 0)) throw new Error(`pagerank: tolerance must be > 0, got ${tolerance}`);
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`pagerank: maxIterations must be an integer >= 1, got ${maxIterations}`);
  }

  const { offsets, targets, outDegree } = buildGraph(numNodes, edges);
  const n = numNodes;
  const teleport = (1 - d) / n;

  let current = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);

  let iterations = 0;
  let residual = Number.POSITIVE_INFINITY;
  let converged = false;

  for (let iter = 1; iter <= maxIterations; iter++) {
    iterations = iter;

    // Dangling mass: sum of scores of out-degree-0 nodes, redistributed uniformly.
    let dangling = 0;
    for (let u = 0; u < n; u++) if (outDegree[u] === 0) dangling += current[u]!;
    const danglingShare = (d * dangling) / n;

    next.fill(teleport + danglingShare);
    for (let u = 0; u < n; u++) {
      const degree = outDegree[u]!;
      if (degree === 0) continue;
      // A column-stochastic walk: node u splits its mass across its outlinks.
      const contribution = (d * current[u]!) / degree;
      for (let e = offsets[u]!; e < offsets[u + 1]!; e++) {
        const v = targets[e]!; next[v] = next[v]! + contribution;
      }
    }

    residual = 0;
    for (let i = 0; i < n; i++) residual += Math.abs(next[i]! - current[i]!);

    const swap = current;
    current = next;
    next = swap;

    if (residual < tolerance) {
      converged = true;
      break;
    }
  }

  return { scores: current, iterations, converged, residual };
}
