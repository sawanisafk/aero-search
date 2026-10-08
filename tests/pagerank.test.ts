import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  DEFAULT_DAMPING,
  pageRank,
} from '../src/core/link/pagerank.js';

const D = DEFAULT_DAMPING; // 0.85

function sum(xs: Float64Array): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function closeTo(actual: number, expected: number, eps = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThan(eps);
}

describe('pageRank — hand-computable graphs', () => {
  it('single edge 0→1: closed form 1/(2+d), (1+d)/(2+d)', () => {
    const { scores, converged, iterations } = pageRank(2, [[0, 1]], { tolerance: 1e-13, maxIterations: 1000 });
    // s0 = 1/(2+d), s1 = (1+d)/(2+d)  (derived in tests/PAGE-RANK notes)
    closeTo(scores[0]!, 1 / (2 + D));
    closeTo(scores[1]!, (1 + D) / (2 + D));
    expect(converged).toBe(true);
    expect(iterations).toBeGreaterThanOrEqual(1);
    closeTo(sum(scores), 1);
  });

  it('directed cycle: uniform 1/N', () => {
    const { scores } = pageRank(3, [
      [0, 1],
      [1, 2],
      [2, 0],
    ]);
    for (const s of scores) closeTo(s, 1 / 3);
  });

  it('two-node mutual link: uniform 1/2', () => {
    const { scores } = pageRank(2, [
      [0, 1],
      [1, 0],
    ]);
    closeTo(scores[0]!, 0.5);
    closeTo(scores[1]!, 0.5);
  });

  it('two sources, one sink (0→2, 1→2): sink = (1+2d)/(3+2d)', () => {
    const { scores } = pageRank(3, [
      [0, 2],
      [1, 2],
    ], { tolerance: 1e-13, maxIterations: 1000 });
    const sink = (1 + 2 * D) / (3 + 2 * D);
    closeTo(scores[2]!, sink);
    closeTo(scores[0]!, (1 - sink) / 2);
    closeTo(scores[1]!, (1 - sink) / 2);
    closeTo(sum(scores), 1);
  });

  it('disconnected components: mass splits evenly across identical cycles', () => {
    const { scores } = pageRank(4, [
      [0, 1],
      [1, 0],
      [2, 3],
      [3, 2],
    ]);
    for (const s of scores) closeTo(s, 0.25);
  });

  it('no edges at all: every node dangling, teleport gives uniform 1/N', () => {
    const { scores, converged, iterations } = pageRank(3, []);
    for (const s of scores) closeTo(s, 1 / 3);
    expect(converged).toBe(true);
    expect(iterations).toBe(1); // fixed point after one iteration
  });

  it('self-loop node ranks higher than loopless sibling (0↔1, 0→0)', () => {
    const withLoop = pageRank(2, [
      [0, 1],
      [1, 0],
      [0, 0],
    ]);
    const without = pageRank(2, [
      [0, 1],
      [1, 0],
    ]);
    expect(withLoop.scores[0]).toBeGreaterThan(without.scores[0]!);
    closeTo(sum(withLoop.scores), 1);
  });
});

describe('pageRank — invariants', () => {
  const edges: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 0],
    [2, 3],
    [3, 2],
    [4, 3],
    [1, 3],
    [3, 0],
  ];

  it('scores sum to 1 for an asymmetric graph with dangling nodes', () => {
    const { scores, converged } = pageRank(6, edges);
    closeTo(sum(scores), 1);
    expect(converged).toBe(true);
    expect(scores.every((s) => s > 0)).toBe(true); // teleport keeps support full
  });

  it('deterministic: identical graph → bitwise-identical scores', () => {
    const a = pageRank(6, edges).scores;
    const b = pageRank(6, [...edges].reverse()).scores; // input order irrelevant
    expect(a).toEqual(b);
  });

  it('duplicate edges are deduplicated (positions collapse)', () => {
    const single = pageRank(3, [
      [0, 2],
      [1, 2],
    ]).scores;
    const duplicated = pageRank(3, [
      [0, 2],
      [0, 2],
      [1, 2],
      [1, 2],
      [1, 2],
    ]).scores;
    expect(duplicated).toEqual(single);
  });

  it('convergence: residual below tolerance at stop, monotone decrease', () => {
    const res = pageRank(6, edges, { tolerance: 1e-9, maxIterations: 1000 });
    expect(res.converged).toBe(true);
    expect(res.residual).toBeLessThan(1e-9);
  });

  it('maxIterations cap reports not-converged instead of silently stopping', () => {
    const res = pageRank(6, edges, { tolerance: 1e-15, maxIterations: 5 });
    expect(res.converged).toBe(false);
    expect(res.iterations).toBe(5);
    expect(res.residual).toBeGreaterThan(0);
  });

  it('respects an explicit damping factor (d=0 → pure teleport)', () => {
    const { scores, iterations } = pageRank(3, [[0, 2], [1, 2]], { dampingFactor: 0 });
    for (const s of scores) closeTo(s, 1 / 3);
    expect(iterations).toBe(1);
  });
});

describe('pageRank — validation', () => {
  it('rejects N = 0, bad damping, bad tolerance, bad maxIterations', () => {
    expect(() => pageRank(0, [])).toThrow(/numNodes/);
    expect(() => pageRank(2, [], { dampingFactor: 1 })).toThrow(/dampingFactor/);
    expect(() => pageRank(2, [], { dampingFactor: -0.1 })).toThrow(/dampingFactor/);
    expect(() => pageRank(2, [], { tolerance: 0 })).toThrow(/tolerance/);
    expect(() => pageRank(2, [], { maxIterations: 0 })).toThrow(/maxIterations/);
  });

  it('rejects out-of-range endpoints', () => {
    expect(() => buildGraph(2, [[0, 2]])).toThrow(/outside/);
    expect(() => buildGraph(2, [[-1, 0]])).toThrow(/outside/);
  });
});
