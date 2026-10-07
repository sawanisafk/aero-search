/**
 * Boolean set operations over sorted doc-id lists.
 *
 * Every posting list from IndexReader is ascending by construction (the
 * writer's counting sort preserves document order), which makes the classic
 * two-pointer algorithms applicable with no pre-sorting:
 *
 *   intersect: advance the smaller docId — O(|a| + |b|)
 *   union:     merge like mergesort, dedupe equal ids — O(|a| + |b|)
 *   difference: single pass, skip ids present in b — O(|a| + |b|)
 *
 * All inputs are treated as immutable; every function allocates a fresh
 * Uint32Array result so callers can compose freely (AND of an OR of a NOT…)
 * without aliasing surprises. Results are always ascending and duplicate-free.
 */

function toResult(capacity: number, filled: number, buf: Uint32Array): Uint32Array {
  return filled === capacity ? buf : buf.subarray(0, filled);
}

/** a ∩ b — ids present in both lists. */
export function intersect(a: Uint32Array, b: Uint32Array): Uint32Array {
  const buf = new Uint32Array(Math.min(a.length, b.length));
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) {
    const av = a[i]!;
    const bv = b[j]!;
    if (av < bv) i++;
    else if (av > bv) j++;
    else {
      buf[k++] = av;
      i++;
      j++;
    }
  }
  return toResult(buf.length, k, buf);
}

/** a ∪ b — ids in either list, ascending, deduplicated. */
export function union(a: Uint32Array, b: Uint32Array): Uint32Array {
  const buf = new Uint32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) {
    const av = a[i]!;
    const bv = b[j]!;
    if (av < bv) {
      buf[k++] = av;
      i++;
    } else if (av > bv) {
      buf[k++] = bv;
      j++;
    } else {
      buf[k++] = av;
      i++;
      j++;
    }
  }
  while (i < a.length) buf[k++] = a[i++]!;
  while (j < b.length) buf[k++] = b[j++]!;
  return toResult(buf.length, k, buf);
}

/** a \ b — ids in a that are absent from b (Boolean NOT substrate). */
export function difference(a: Uint32Array, b: Uint32Array): Uint32Array {
  const buf = new Uint32Array(a.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length) {
    const av = a[i]!;
    while (j < b.length && b[j]! < av) j++;
    if (j >= b.length || b[j]! !== av) buf[k++] = av;
    i++;
  }
  return toResult(buf.length, k, buf);
}

/** Universe {0, 1, …, n-1} — the complement domain for NOT. */
export function universe(n: number): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}
