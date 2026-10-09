/**
 * Fetches the CQADupStack technical stacks (BEIR conversion) into
 * data/corpora/cqadupstack-<stack>/ and publishes per-dataset evaluation
 * inputs into data/eval/ (committed provenance).
 *
 *   npx tsx scripts/fetch-cqadupstack.ts            # Tier B (default demo)
 *   npx tsx scripts/fetch-cqadupstack.ts --full     # all nine stacks + Tier C
 *
 *   data/corpora/cqadupstack-<stack>/   gitignored (reproducible via manifest)
 *     corpus.jsonl    BEIR docs: {_id, title, text, metadata{tags}}
 *     queries.jsonl   queries: {_id, title, text}
 *     qrels/test.tsv  binary judgments (query-id corpus-id score)
 *   data/corpora/cqadupstack-tierb/     merged Tier B (programmers+unix+tex)
 *     corpus.jsonl    same rows + metadata.sourceDataset/originalId
 *   data/corpora/cqadupstack-tierc/     merged Tier C (nine stacks, --full)
 *   data/eval/                          committed
 *     cqadupstack-<stack>-queries.jsonl, cqadupstack-<stack>-qrels.tsv
 *     cqadupstack.manifest.json
 *
 * Sources (the 5.34 GB archive is never downloaded whole):
 *   - corpus + qrels: HTTP range fetch of single members out of the BEIR
 *     cqadupstack.zip (ZIP64 central directory parsed from a 128 KB tail;
 *     see scripts/lib/zip-range.ts).
 *   - queries: Hugging Face datasets-server /rows over BeIR/cqadupstack —
 *     the zip's own queries.jsonl embeds full duplicate-question bodies
 *     (92 MB-2.7 GB compressed per stack) and cannot be range-fetched.
 *
 * Validation runs in memory BEFORE anything is written: published
 * document/query/judgment counts, qrels query ids exactly equal to the
 * query set, every judged corpus id present in the corpus, no duplicate
 * document ids within a stack, and (for merged tiers) no id collisions
 * across stacks. Any mismatch fails the run — no half-validated writes.
 *
 * License note: derived from the Stack Exchange data dump as redistributed
 * by BEIR (HF card: cc-by-sa-4.0); the original CQADupStack distribution
 * site (nlp.cis.unimelb.edu.au) was unreachable at retrieval time. The
 * manifest records this honestly — verify the exact CC BY-SA version and
 * attribution requirements before redistributing the data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { hashFile, writeJson } from './lib/dataset.js';
import { fetchZipMember, readZipEntries, remoteSize, type ZipEntry } from './lib/zip-range.js';

const ZIP_URL = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/cqadupstack.zip';
const HF_DATASET = 'BeIR/cqadupstack';
const HF_ROWS_URL = (config: string, offset: number, length: number): string =>
  `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(HF_DATASET)}` +
  `&config=${config}&split=queries&offset=${offset}&length=${length}`;
const RETRIEVED = '2026-10-09';

/** Tier B = default demo; --full adds the remaining stacks (Tier C). */
const TIER_B = ['programmers', 'unix', 'tex'] as const;
const TIER_C_EXTRA = ['android', 'webmasters', 'mathematica', 'stats', 'physics', 'gaming'] as const;

/** Published counts measured from the BEIR archive + HF mirror (2026-10-09). */
const EXPECTED: Record<string, { docs: number; queries: number; judgments: number }> = {
  programmers: { docs: 32176, queries: 876, judgments: 1675 },
  unix: { docs: 47382, queries: 1072, judgments: 1693 },
  tex: { docs: 68184, queries: 2906, judgments: 5154 },
  android: { docs: 22998, queries: 699, judgments: 1696 },
  webmasters: { docs: 17405, queries: 506, judgments: 1395 },
  mathematica: { docs: 16705, queries: 804, judgments: 1358 },
  stats: { docs: 42269, queries: 652, judgments: 913 },
  physics: { docs: 38316, queries: 1039, judgments: 1933 },
  gaming: { docs: 45301, queries: 1595, judgments: 2263 },
};

const ROOT = process.cwd();
const CORPORA_DIR = path.join(ROOT, 'data', 'corpora');
const EVAL_DIR = path.join(ROOT, 'data', 'eval');
const MANIFEST_PATH = path.join(EVAL_DIR, 'cqadupstack.manifest.json');

function stackDir(stack: string): string {
  return path.join(CORPORA_DIR, `cqadupstack-${stack}`);
}

/** Tier names are already fully qualified ('cqadupstack-tierb') — no prefix. */
function tierDir(tier: string): string {
  return path.join(CORPORA_DIR, tier);
}

function countJsonLines(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (line.trim() !== '') n++;
  return n;
}

interface QrelRow {
  readonly queryId: string;
  readonly corpusId: string;
  readonly score: number;
}

/** qrels TSV -> rows; validates header and numeric scores (CRLF-safe). */
function parseQrels(text: string): QrelRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0]?.split('\t');
  if (header === undefined || header[0] !== 'query-id' || header[1] !== 'corpus-id' || header[2] !== 'score') {
    throw new Error(`unexpected qrels header: ${lines[0] ?? '<empty>'}`);
  }
  return lines.slice(1).map((l) => {
    const parts = l.split('\t');
    if (parts.length < 3) throw new Error(`malformed qrels row: ${l}`);
    return { queryId: parts[0]!, corpusId: parts[1]!, score: Number(parts[2]) };
  });
}

/** Query ids + texts from queries.jsonl (BEIR shape {_id, title?, text}). */
function parseQueries(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as { _id?: unknown; text?: unknown };
    if (typeof row._id !== 'string' || typeof row.text !== 'string') {
      throw new Error('queries.jsonl row without string _id/text');
    }
    if (out.has(row._id)) throw new Error(`duplicate query id ${row._id}`);
    out.set(row._id, row.text);
  }
  return out;
}

/** Document ids from corpus.jsonl, enforcing uniqueness within the stack. */
function corpusIds(text: string): Set<string> {
  const ids = new Set<string>();
  let docs = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    docs++;
    const row = JSON.parse(line) as { _id?: unknown };
    if (typeof row._id !== 'string') throw new Error('corpus row without string _id');
    if (ids.has(row._id)) throw new Error(`duplicate document id ${row._id}`);
    ids.add(row._id);
  }
  if (docs !== ids.size) throw new Error(`corpus parse mismatch: ${docs} rows, ${ids.size} ids`);
  return ids;
}

/**
 * Full validation of one stack's triple (counts + qrels<->queries<->corpus
 * id coverage). Throws with a precise message on the first violation.
 */
function validateStack(stack: string, corpus: string, queries: string, qrels: string): void {
  const expected = EXPECTED[stack];
  if (expected === undefined) throw new Error(`no published counts for stack "${stack}"`);
  const docs = countJsonLines(corpus);
  const queryMap = parseQueries(queries);
  const rows = parseQrels(qrels);
  const judgedQueries = new Set(rows.map((r) => r.queryId));

  const fail = (msg: string): never => {
    throw new Error(`cqadupstack/${stack}: ${msg}`);
  };
  if (docs !== expected.docs) fail(`documents ${docs}, published ${expected.docs}`);
  if (queryMap.size !== expected.queries) fail(`queries ${queryMap.size}, published ${expected.queries}`);
  if (rows.length !== expected.judgments) fail(`judgments ${rows.length}, published ${expected.judgments}`);

  for (const qid of judgedQueries) {
    if (!queryMap.has(qid)) fail(`qrels query ${qid} has no text in queries.jsonl`);
  }
  if (judgedQueries.size !== queryMap.size) {
    fail(`query set (${queryMap.size}) and qrels query set (${judgedQueries.size}) differ`);
  }
  const ids = corpusIds(corpus);
  for (const r of rows) {
    if (!ids.has(r.corpusId)) fail(`judged document ${r.corpusId} missing from corpus`);
  }
}

/** Fetch one stack's corpus + qrels (zip range) and queries (HF rows API). */
async function fetchStack(
  stack: string,
  entries: Map<string, ZipEntry>,
): Promise<void> {
  const dir = stackDir(stack);
  fs.mkdirSync(dir, { recursive: true });

  const member = (name: string): ZipEntry => {
    const e = entries.get(name);
    if (e === undefined) throw new Error(`zip member not found: ${name}`);
    return e;
  };
  let corpusBuf: Buffer;
  let qrelsBuf: Buffer;
  let queriesBuf: Buffer;
  try {
    corpusBuf = await fetchZipMember(ZIP_URL, member(`cqadupstack/${stack}/corpus.jsonl`));
  } catch (e) {
    throw new Error(`corpus member: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    qrelsBuf = await fetchZipMember(ZIP_URL, member(`cqadupstack/${stack}/qrels/test.tsv`));
  } catch (e) {
    throw new Error(`qrels member: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    queriesBuf = await fetchQueries(stack);
  } catch (e) {
    throw new Error(`queries API: ${e instanceof Error ? e.message : String(e)}`);
  }

  const corpus = corpusBuf.toString('utf8');
  const queries = queriesBuf.toString('utf8');
  const qrels = qrelsBuf.toString('utf8');
  validateStack(stack, corpus, queries, qrels);

  fs.writeFileSync(path.join(dir, 'corpus.jsonl'), corpusBuf);
  fs.writeFileSync(path.join(dir, 'queries.jsonl'), queriesBuf);
  fs.mkdirSync(path.join(dir, 'qrels'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'qrels', 'test.tsv'), qrelsBuf);
  console.log(
    `[cqadupstack] ${stack}: ${EXPECTED[stack]!.docs} docs, ` +
      `${EXPECTED[stack]!.queries} queries, ${EXPECTED[stack]!.judgments} judgments — validated`,
  );
}

/** Stream all queries for one stack from the HF datasets-server rows API. */
async function fetchQueries(stack: string): Promise<Buffer> {
  const lines: string[] = [];
  let offset = 0;
  let total = -1;
  const PAGE = 100;
  for (;;) {
    const rows = await fetchQueryPage(stack, offset);
    if (typeof rows.total === 'number') total = rows.total;
    for (const row of rows.rows) {
      if (typeof row._id !== 'string' || typeof row.text !== 'string') {
        throw new Error(`HF row for ${stack}@${offset} lacks _id/text`);
      }
      lines.push(
        JSON.stringify({ _id: row._id, title: typeof row.title === 'string' ? row.title : '', text: row.text }),
      );
    }
    offset += rows.rows.length;
    if (rows.rows.length < PAGE) break;
    // stay under the datasets-server rate limit on long stacks (tex = 30 pages)
    await new Promise((r) => setTimeout(r, 250));
  }
  if (total >= 0 && lines.length !== total) {
    throw new Error(`HF rows for ${stack}: fetched ${lines.length}, API reports ${total}`);
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/** One page with retry/backoff on 429/5xx (server enforces rate limits). */
async function fetchQueryPage(
  stack: string,
  offset: number,
): Promise<{ rows: Array<{ _id?: unknown; title?: unknown; text?: unknown }>; total?: number }> {
  const PAGE = 100;
  let lastError = '';
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(HF_ROWS_URL(stack, offset, PAGE));
    if (res.ok) {
      const body = (await res.json()) as {
        rows?: Array<{ row: { _id?: unknown; title?: unknown; text?: unknown } }>;
        num_rows_total?: number;
      };
      return {
        rows: (body.rows ?? []).map((r) => r.row),
        ...(typeof body.num_rows_total === 'number' ? { total: body.num_rows_total } : {}),
      };
    }
    lastError = `HTTP ${res.status}`;
    await res.arrayBuffer().catch(() => undefined);
    if (res.status !== 429 && res.status < 500) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * attempt;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`HF rows API ${lastError} for ${stack}@${offset}`);
}

/**
 * Merge stacks into one corpus. Stack Exchange post ids are NOT unique
 * across sites (verified collision: 110557 in programmers AND unix), so
 * merged document ids are rewritten to the globally-unique form
 * `<stack>:<originalId>` and provenance is preserved as
 * metadata.sourceDataset + metadata.originalId. Per-dataset evaluation on
 * the merged index therefore uses writeTierEvalInputs() qrels copies whose
 * corpus ids carry the same prefix — original-id qrels keep working against
 * the per-stack indexes.
 */
async function buildMerged(stacks: readonly string[], tierName: string): Promise<string> {
  const outFile = path.join(tierDir(tierName), 'corpus.jsonl');
  fs.mkdirSync(tierDir(tierName), { recursive: true });
  const out = fs.createWriteStream(outFile);
  // swallow async write errors — failures surface via explicit throws below
  // and the final await still observes 'error' via its own listener
  out.on('error', () => undefined);
  let docs = 0;
  try {
    for (const stack of stacks) {
      const file = path.join(stackDir(stack), 'corpus.jsonl');
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const line of lines) {
        if (line.trim() === '') continue;
        const row = JSON.parse(line) as {
          _id: string;
          title?: string;
          text?: string;
          metadata?: Record<string, unknown>;
        };
        const ok = out.write(
          `${JSON.stringify({
            _id: `${stack}:${row._id}`,
            title: row.title ?? '',
            text: row.text ?? '',
            metadata: { ...(row.metadata ?? {}), sourceDataset: stack, originalId: row._id },
          })}\n`,
        );
        docs++;
        if (!ok) await once(out, 'drain');
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      out.end();
    });
  } catch (e) {
    out.destroy();
    fs.rmSync(outFile, { force: true });
    throw e;
  }
  console.log(`[cqadupstack] ${tierName}: ${docs} docs merged from ${stacks.join('+')} (ids prefixed <stack>:<id>)`);
  return outFile;
}

/** Validate one stack's on-disk triple (same checks as the fetch path). */
function validateOnDisk(stack: string): void {
  const dir = stackDir(stack);
  validateStack(
    stack,
    fs.readFileSync(path.join(dir, 'corpus.jsonl'), 'utf8'),
    fs.readFileSync(path.join(dir, 'queries.jsonl'), 'utf8'),
    fs.readFileSync(path.join(dir, 'qrels', 'test.tsv'), 'utf8'),
  );
}

/**
 * Per-dataset eval inputs for a MERGED tier: the stack's queries unchanged
 * (query ids only join within one stack's run) plus a qrels copy whose
 * corpus ids are rewritten to the merged `<stack>:<id>` form.
 */
function writeTierEvalInputs(tierName: string, stacks: readonly string[]): void {
  fs.mkdirSync(EVAL_DIR, { recursive: true });
  for (const stack of stacks) {
    const queriesSrc = path.join(stackDir(stack), 'queries.jsonl');
    const qrelsSrc = path.join(stackDir(stack), 'qrels', 'test.tsv');
    fs.copyFileSync(queriesSrc, path.join(EVAL_DIR, `${tierName}-${stack}-queries.jsonl`));
    const remapped = fs
      .readFileSync(qrelsSrc, 'utf8')
      .split(/\r?\n/)
      .map((line, i) => {
        if (line.trim() === '') return '';
        const parts = line.split('\t');
        if (i === 0) return line; // header unchanged
        if (parts.length < 3) throw new Error(`malformed qrels row in ${qrelsSrc}: ${line}`);
        return `${parts[0]}\t${stack}:${parts[1]}\t${parts.slice(2).join('\t')}`;
      })
      .filter((l) => l !== '')
      .join('\n');
    fs.writeFileSync(path.join(EVAL_DIR, `${tierName}-${stack}-qrels.tsv`), `${remapped}\n`, 'utf8');
  }
  console.log(`[cqadupstack] ${tierName}: merged-tier eval inputs written for ${stacks.join(', ')}`);
}

/** Copy one stack's queries/qrels into the committed data/eval/ inputs. */
function writeEvalInputs(stack: string): void {
  fs.mkdirSync(EVAL_DIR, { recursive: true });
  fs.copyFileSync(
    path.join(stackDir(stack), 'queries.jsonl'),
    path.join(EVAL_DIR, `cqadupstack-${stack}-queries.jsonl`),
  );
  fs.copyFileSync(
    path.join(stackDir(stack), 'qrels', 'test.tsv'),
    path.join(EVAL_DIR, `cqadupstack-${stack}-qrels.tsv`),
  );
}

async function hfRevision(): Promise<string> {
  try {
    const res = await fetch(`https://huggingface.co/api/datasets/${HF_DATASET}`);
    const body = (await res.json()) as { sha?: unknown };
    return typeof body.sha === 'string' ? body.sha : 'unknown';
  } catch {
    const prior = readPriorManifest();
    return prior?.hf_revision ?? 'unknown';
  }
}

function readPriorManifest(): { hf_revision?: string } | null {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { hf_revision?: string };
  } catch {
    return null;
  }
}

/** Recompute every count/hash from disk — valid on first fetch and refresh. */
async function writeManifest(stacks: readonly string[], tiers: Record<string, readonly string[]>): Promise<void> {
  const perStack: Record<string, unknown> = {};
  for (const stack of stacks) {
    const dir = stackDir(stack);
    const qrelsText = fs.readFileSync(path.join(dir, 'qrels', 'test.tsv'), 'utf8');
    const rows = parseQrels(qrelsText);
    const queryMap = parseQueries(fs.readFileSync(path.join(dir, 'queries.jsonl'), 'utf8'));
    const corpusFile = path.join(dir, 'corpus.jsonl');
    validateStack(stack, fs.readFileSync(corpusFile, 'utf8'), fs.readFileSync(path.join(dir, 'queries.jsonl'), 'utf8'), qrelsText);
    perStack[stack] = {
      documents: EXPECTED[stack]!.docs,
      queries: queryMap.size,
      judgments: rows.length,
      corpus_jsonl_sha256: hashFile('sha256', corpusFile),
      queries_jsonl_sha256: hashFile('sha256', path.join(dir, 'queries.jsonl')),
      qrels_test_tsv_sha256: hashFile('sha256', path.join(dir, 'qrels', 'test.tsv')),
    };
    writeEvalInputs(stack);
  }

  const tierCounts: Record<string, unknown> = {};
  for (const [tier, tierStacks] of Object.entries(tiers)) {
    const merged = path.join(tierDir(tier), 'corpus.jsonl');
    if (!fs.existsSync(merged)) continue;
    writeTierEvalInputs(tier, tierStacks);
    tierCounts[tier] = {
      stacks: [...tierStacks],
      documents: countJsonLines(fs.readFileSync(merged, 'utf8')),
      queries: tierStacks.reduce((n, s) => n + EXPECTED[s]!.queries, 0),
      judgments: tierStacks.reduce((n, s) => n + EXPECTED[s]!.judgments, 0),
      default_demo: tier === 'cqadupstack-tierb',
      corpus_jsonl_sha256: hashFile('sha256', merged),
      id_scheme: '<stack>:<originalId> (Stack Exchange post ids collide across sites)',
    };
  }

  writeJson(MANIFEST_PATH, {
    name: 'cqadupstack',
    source:
      'CQADupStack technical Q&A stacks via the BEIR benchmark (Thakur et al., EMNLP 2021); ' +
      'originally distributed by the University of Melbourne NLP group ' +
      '(nlp.cis.unimelb.edu.au/resources/cqadupstack/, unreachable at retrieval time); ' +
      'derived from the Stack Exchange data dump',
    dataset_url: ZIP_URL,
    zip_size_bytes: await remoteSize(ZIP_URL),
    retrieval:
      'HTTP range fetch of individual zip members (ZIP64 central directory from a 128 KB tail) ' +
      '+ Hugging Face datasets-server /rows for queries (the zip queries.jsonl embeds full ' +
      'duplicate-question bodies, 92 MB-2.7 GB compressed per stack)',
    hf_dataset: `https://huggingface.co/datasets/${HF_DATASET}`,
    hf_revision: await hfRevision(),
    retrieved: RETRIEVED,
    counts: tierCounts,
    merged_eval_policy:
      'Merged-tier document ids are <stack>:<originalId> (Stack Exchange post ids collide across ' +
      'sites — verified: 110557 exists in both programmers and unix). Evaluate each dataset ' +
      'separately against the merged index using cqadupstack-<tier>-<stack>-{queries.jsonl,' +
      'qrels.tsv} (qrels corpus ids carry the same prefix); documents from other stacks are ' +
      'unjudged and contribute zero gain. Qrels are never merged across datasets, and metrics ' +
      'from different datasets are not comparable.',
    stacks: perStack,
    license:
      'Derived from the Stack Exchange data dump as redistributed by BEIR; the BEIR Hugging Face ' +
      'card lists cc-by-sa-4.0. The original CQADupStack distribution site was unreachable at ' +
      'retrieval time, so the exact CC BY-SA version and attribution requirements must be verified ' +
      'before redistributing the data. Used here for research/evaluation with attribution to ' +
      'CQADupStack and BEIR (Thakur et al., "BEIR: A Heterogeneous Benchmark for Zero-shot ' +
      'Evaluation of Information Retrieval Models", EMNLP 2021).',
    generator: 'scripts/fetch-cqadupstack.ts',
  });
}

/** A stack is complete only when all three files landed (fetch writes in order). */
function stackComplete(stack: string): boolean {
  const dir = stackDir(stack);
  return (
    fs.existsSync(path.join(dir, 'corpus.jsonl')) &&
    fs.existsSync(path.join(dir, 'queries.jsonl')) &&
    fs.existsSync(path.join(dir, 'qrels', 'test.tsv'))
  );
}

async function main(): Promise<void> {
  const full = process.argv.includes('--full');
  const force = process.argv.includes('--force');
  const stacks: readonly string[] = full ? [...TIER_B, ...TIER_C_EXTRA] : TIER_B;
  const tiers: Record<string, readonly string[]> = full
    ? { 'cqadupstack-tierb': TIER_B, 'cqadupstack-tierc': [...TIER_B, ...TIER_C_EXTRA] }
    : { 'cqadupstack-tierb': TIER_B };

  const complete = stacks.every((s) => stackComplete(s));
  if (complete && !force) {
    console.log('[cqadupstack] already fetched — validating + refreshing committed inputs');
    for (const stack of stacks) validateOnDisk(stack);
    for (const [tier, tierStacks] of Object.entries(tiers)) {
      if (!fs.existsSync(path.join(tierDir(tier), 'corpus.jsonl'))) {
        await buildMerged(tierStacks, tier);
      }
    }
    await writeManifest(stacks, tiers);
    return;
  }

  console.log(`[cqadupstack] reading central directory of ${ZIP_URL}`);
  let size: number;
  let entries: ZipEntry[];
  try {
    size = await remoteSize(ZIP_URL);
    entries = await readZipEntries(ZIP_URL, size);
  } catch (e) {
    throw new Error(`central directory phase: ${e instanceof Error ? e.message : String(e)}`);
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  console.log(`[cqadupstack] ${entries.length} zip entries (${(size / 1e9).toFixed(2)} GB archive)`);

  for (const stack of stacks) {
    if (!force && stackComplete(stack)) {
      console.log(`[cqadupstack] ${stack}: already on disk — skipping download`);
      continue;
    }
    try {
      await fetchStack(stack, byName);
    } catch (e) {
      throw new Error(`stack "${stack}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const [tier, tierStacks] of Object.entries(tiers)) {
    await buildMerged(tierStacks, tier);
  }
  await writeManifest(stacks, tiers);
  console.log('[cqadupstack] committed inputs written to data/eval/');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
