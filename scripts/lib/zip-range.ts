/**
 * HTTP range fetching of individual zip members — lets the CQADupStack
 * fetch script pull single corpus/qrels members out of the 5.34 GB BEIR
 * cqadupstack.zip without downloading the archive.
 *
 * WHAT: resolves the zip central directory (ZIP64-aware: EOCD -> ZIP64
 *   locator -> ZIP64 EOCD -> central directory) from a 128 KB tail fetch,
 *   then range-downloads and inflates a named member.
 * WHY: the archive's per-stack queries.jsonl files are 92 MB-2.7 GB
 *   compressed, but corpus.jsonl (5-30 MB) and qrels/test.tsv (5-30 KB)
 *   are small; selective fetch keeps the migration reproducible in seconds.
 * DATA IN: zip URL + Content-Range sizes (server must advertise
 *   Accept-Ranges — verified for public.ukp.informatik.tu-darmstadt.de).
 * DATA OUT: ZipEntry list and member bytes.
 * CONNECTS TO: scripts/fetch-cqadupstack.ts (only caller).
 */

import zlib from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  /** 0 = stored, 8 = deflate (the only methods the BEIR zips use) */
  readonly method: number;
  readonly compSize: number;
  readonly uncompSize: number;
  readonly localOffset: number;
}

/**
 * Inclusive byte range GET; requires the server to honor Range.
 * Bounded retries: the BEIR host intermittently drops mid-transfer
 * connections ("terminated" from undici) — each attempt is a fresh request.
 */
export async function fetchRange(url: string, start: number, endInclusive: number, attempts = 3): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
      if (res.status !== 206 && res.status !== 200) {
        throw new Error(`HTTP ${res.status} (${url})`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`range fetch ${start}-${endInclusive} failed after ${attempts} attempts: ${detail} (${url})`);
}

/** Total object size via a one-byte range request (Content-Range: bytes 0-0/N). */
export async function remoteSize(url: string): Promise<number> {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const contentRange = res.headers.get('content-range');
  await res.arrayBuffer();
  if (res.status !== 206 || contentRange === null) {
    throw new Error(`server did not honor range requests (HTTP ${res.status}): ${url}`);
  }
  const m = /\/(\d+)\s*$/.exec(contentRange);
  if (m === null) throw new Error(`unparseable Content-Range "${contentRange}" (${url})`);
  return Number(m[1]);
}

/** Parse the central directory of a remote zip (ZIP64-aware). */
export async function readZipEntries(url: string, size: number): Promise<ZipEntry[]> {
  const TAIL = 131072;
  const tail = await fetchRange(url, size - TAIL, size - 1);
  const tailStart = size - tail.length;

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip EOCD signature not found in archive tail');

  let entryCount = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) {
      throw new Error('zip64 EOCD locator missing after saturated EOCD fields');
    }
    const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
    const zin = z64Offset - tailStart;
    if (zin < 0 || zin + 56 > tail.length || tail.readUInt32LE(zin) !== 0x06064b50) {
      throw new Error(`zip64 EOCD record not present in archive tail (offset ${z64Offset})`);
    }
    entryCount = Number(tail.readBigUInt64LE(zin + 32));
    cdSize = Number(tail.readBigUInt64LE(zin + 40));
    cdOffset = Number(tail.readBigUInt64LE(zin + 48));
  }
  if (cdOffset + cdSize > size) throw new Error('central directory extends past archive end');

  const inTail = cdOffset >= tailStart && cdOffset + cdSize <= size;
  const cd = inTail
    ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
    : await fetchRange(url, cdOffset, cdOffset + cdSize - 1);

  const entries: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    // ZIP64 extended information extra field (tag 0x0001) fills saturated 32-bit values
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let ep = p + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const tag = cd.readUInt16LE(ep);
        const sz = cd.readUInt16LE(ep + 2);
        if (tag === 0x0001) {
          let q = ep + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
          break;
        }
        ep += 4 + sz;
      }
    }
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.length !== entryCount) {
    throw new Error(`parsed ${entries.length} zip entries, EOCD announced ${entryCount}`);
  }
  return entries;
}

/** Range-fetch + inflate one member; verifies the inflated byte count. */
export async function fetchZipMember(url: string, entry: ZipEntry): Promise<Buffer> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
  }
  const hdr = await fetchRange(url, entry.localOffset, entry.localOffset + 29);
  if (hdr.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`bad local file header for ${entry.name}`);
  }
  const nameLen = hdr.readUInt16LE(26);
  const extraLen = hdr.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const data = await fetchRange(url, dataStart, dataStart + entry.compSize - 1);
  const buf = entry.method === 0 ? data : zlib.inflateRawSync(data);
  if (buf.length !== entry.uncompSize) {
    throw new Error(`${entry.name}: inflated ${buf.length} bytes, expected ${entry.uncompSize}`);
  }
  return buf;
}
