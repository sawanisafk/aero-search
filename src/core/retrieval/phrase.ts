/**
 * Positional phrase matching — implemented in M2 Phase 4 (positional
 * retrieval over the index's position runs). This stub exists so the boolean
 * evaluator's AST handling is complete from Phase 2; the Phase 4 commit
 * replaces this file with the real positional intersection.
 */

export function matchPhrase(_reader: unknown, _terms: readonly string[]): Uint32Array {
  throw new Error('positional phrase matching is not implemented yet (M2 Phase 4)');
}
