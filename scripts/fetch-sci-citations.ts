/**
 * Builds a REAL citation graph over the SciFact corpus (M4-B):
 *
 *   npx tsx scripts/fetch-sci-citations.ts
 *
 * Source: Semantic Scholar Graph API `POST /graph/v1/paper/batch`
 * (`fields=paperId,references.paperId`). Our corpus `_id`s are S2 CorpusIds,
 * so every corpus paper is resolved to its SHA1 paperId; references arrive as
 * SHA1s and are mapped back into the corpus id space. Direction: from → to
 * means "from cites to" (authority flows to the cited paper, matching
 * PageRank's link semantics).
 *
 * The unauthenticated API is a shared, intermittently-throttled pool: every
 * chunk retries with exponential backoff. Output (committed eval input):
 *
 *   data/eval/scifact-citations.json
 *     { source, fetchedAt, request, stats, edges: [[from, to], ...] }
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256, writeJson } from './lib/dataset.js';

const API = 'https://api.semanticscholar.org/graph/v1/paper/batch?fields=paperId,references.paperId';
const CHUNK = 200;
const MAX_ATTEMPTS_PER_CHUNK = 12;
const BASE_BACKOFF_MS = 4_000;
const POLITE_GAP_MS = 1_200;

interface CorpusLine {
  _id: string;
}

interface BatchResponseEntry {
  paperId?: string;
  references?: { paperId?: string }[] | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchChunk(ids: string[]): Promise<BatchResponseEntry[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_CHUNK; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (res.status === 429) {
        const wait = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), 45_000);
        lastErr = new Error(`429 (attempt ${attempt}/${MAX_ATTEMPTS_PER_CHUNK})`);
        console.log(`  429 — backing off ${(wait / 1000).toFixed(0)}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        await sleep(BASE_BACKOFF_MS * attempt);
        continue;
      }
      const json = (await res.json()) as BatchResponseEntry[];
      if (!Array.isArray(json) || json.length !== ids.length) {
        lastErr = new Error(`expected ${ids.length} entries, got ${json?.length}`);
        await sleep(BASE_BACKOFF_MS);
        continue;
      }
      await sleep(POLITE_GAP_MS);
      return json;
    } catch (err) {
      lastErr = err;
      await sleep(BASE_BACKOFF_MS * attempt);
    }
  }
  throw new Error(`chunk of ${ids.length} ids failed after ${MAX_ATTEMPTS_PER_CHUNK} attempts: ${String(lastErr)}`);
}

async function main(): Promise<void> {
  const corpusPath = path.join(process.cwd(), 'data', 'corpora', 'scifact', 'corpus.jsonl');
  const corpusIds = fs
    .readFileSync(corpusPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as CorpusLine)._id);
  console.log(`[citations] corpus ids: ${corpusIds.length}`);

  const shaToCorpusId = new Map<string, string>();
  const refsByCorpusId = new Map<string, string[]>(); // corpusId -> referenced SHA1s
  let papersWithReferences = 0;

  for (let start = 0, chunkNo = 0; start < corpusIds.length; start += CHUNK, chunkNo++) {
    const ids = corpusIds.slice(start, start + CHUNK);
    const t0 = Date.now();
    const entries = await fetchChunk(ids.map((id) => `CorpusId:${id}`));
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const corpusId = ids[i]!;
      if (entry == null) continue; // unresolved paper → no SHA1, no references
      if (entry.paperId) shaToCorpusId.set(entry.paperId, corpusId);
      if (Array.isArray(entry.references) && entry.references.length > 0) {
        papersWithReferences++;
        refsByCorpusId.set(
          corpusId,
          entry.references
            .map((r) => r?.paperId)
            .filter((x): x is string => typeof x === 'string'),
        );
      }
    }
    console.log(
      `  chunk ${chunkNo + 1}/${Math.ceil(corpusIds.length / CHUNK)} ` +
        `(${ids.length} ids, map=${shaToCorpusId.size}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }

  if (shaToCorpusId.size < corpusIds.length * 0.9) {
    throw new Error(`SHA1 map too small (${shaToCorpusId.size}/${corpusIds.length}) — rerun`);
  }

  // CorpusId -> SHA1 set per source, then keep references that are corpus docs.
  const corpusIdToSha = new Map<string, string>();
  for (const [sha, cid] of shaToCorpusId) corpusIdToSha.set(cid, sha);

  const pairSet = new Set<string>();
  let totalRefs = 0;
  let sourcesWithEdges = 0;
  for (const [cid, refShas] of refsByCorpusId) {
    totalRefs += refShas.length;
    let own = 0;
    for (const sha of refShas) {
      const target = shaToCorpusId.get(sha);
      if (target === undefined || target === cid) continue;
      pairSet.add(`${Number(cid)},${Number(target)}`);
      own++;
    }
    if (own > 0) sourcesWithEdges++;
  }
  const edges = [...pairSet]
    .map((p) => p.split(',').map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const outPath = path.join(process.cwd(), 'data', 'eval', 'scifact-citations.json');
  const artifact = {
    kind: 'citation-graph',
    source: 'Semantic Scholar Graph API POST /graph/v1/paper/batch (fields=paperId,references.paperId)',
    fetchedAt: new Date().toISOString(),
    request: {
      corpusFile: 'data/corpora/scifact/corpus.jsonl',
      corpusSha256: sha256(fs.readFileSync(corpusPath)),
      chunkSize: CHUNK,
      idsRequested: corpusIds.length,
      idSpace: 'corpus _id = S2 CorpusId; edges mapped back from SHA1 paperIds',
      direction: 'from cites to (authority flows to the cited paper)',
    },
    stats: {
      papersResolved: shaToCorpusId.size,
      papersWithReferences: papersWithReferences,
      papersWithoutReferencesOrElided: corpusIds.length - papersWithReferences,
      totalReferences: totalRefs,
      inCorpusEdges: edges.length,
      sourcesWithEdges,
      graphHash: sha256(`${corpusIds.length}\n${edges.map(([u, v]) => `${u},${v}`).join('\n')}\n`),
    },
    edges,
  };
  writeJson(outPath, artifact);

  console.log(`[citations] resolved  ${shaToCorpusId.size}/${corpusIds.length}`);
  console.log(`[citations] with refs ${papersWithReferences} (elided/none: ${corpusIds.length - papersWithReferences})`);
  console.log(`[citations] refs      ${totalRefs} total → ${edges.length} in-corpus edges`);
  console.log(`[citations] sources   ${sourcesWithEdges} papers with ≥1 in-corpus citation`);
  console.log(`[citations] graphHash ${artifact.stats.graphHash}`);
  console.log(`[citations] artifact  ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
