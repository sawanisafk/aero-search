/**
 * Minimal growable Uint32 buffer used while staging postings during index
 * construction. Doubling growth keeps appends amortized O(1) while staying
 * in typed-array memory (the whole point of ADR-008).
 */
export class GrowableUint32 {
  private buf: Uint32Array;
  private len = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint32Array(Math.max(1, initialCapacity));
  }

  get length(): number {
    return this.len;
  }

  get capacity(): number {
    return this.buf.length;
  }

  push(value: number): void {
    if (this.len === this.buf.length) this.grow();
    this.buf[this.len++] = value >>> 0;
  }

  at(index: number): number {
    if (index < 0 || index >= this.len) throw new RangeError(`index ${index} out of bounds`);
    return this.buf[index]!;
  }

  /** Return a trimmed copy of the used region. */
  trim(): Uint32Array {
    return this.buf.slice(0, this.len);
  }

  private grow(): void {
    const next = new Uint32Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }
}
