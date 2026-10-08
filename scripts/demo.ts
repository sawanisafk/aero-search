/**
 * Scripted end-to-end demo of the search engine over its REST API.
 *
 * Runs the app in-process (no port, no network) and walks the whole M5
 * surface the way the frontend uses it:
 *
 *   1  health / config
 *   2  ranked search (bm25) with diagnostics
 *   3  strategy sweep — every available ranking strategy, same query
 *   4  phrase query with phrase + proximity signals
 *   5  fuzzy recovery contrast (wonderlan vs wonderland)
 *   6  document detail with live PageRank and matched terms
 *   7  stats + committed benchmark artifacts (locked evaluation numbers)
 *
 * Exits non-zero if any step fails or a sanity check does not hold, so it
 * doubles as an end-to-end smoke test.
 *
 *   npm run demo
 */

import { buildApp } from '../src/api/app.js';
import { loadConfig } from '../src/api/config.js';
import type { SearchResponse } from '../src/api/index.js';

interface StepResult {
  readonly ok: boolean;
  readonly detail: string;
}

function qs(params: Record<string, string | number | boolean>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) u.set(k, String(v));
  return u.toString();
}

function short(s: string, n = 72): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = buildApp({ config: cfg, logger: false });
  const steps: StepResult[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    steps.push({ ok, detail });
    console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(34)} ${detail}`);
  };

  const get = async (url: string): Promise<{ status: number; body: unknown }> => {
    const res = await app.inject({ method: 'GET', url });
    let body: unknown = null;
    try {
      body = JSON.parse(res.body);
    } catch {
      body = null;
    }
    return { status: res.statusCode, body };
  };

  try {
    // 1. health + config
    console.log('\n[1/7] service');
    const health = await get('/health');
    const h = health.body as { version?: string; corpora?: string[] } | null;
    record('GET /health', health.status === 200 && h?.version !== undefined, `version ${h?.version} · corpora [${(h?.corpora ?? []).join(', ')}]`);

    const cfgRes = await get('/api/config');
    const c = cfgRes.body as
      | { defaultCorpus?: string; defaultStrategy?: string; defaultK?: number; strategies?: { id: string; available: boolean }[] }
      | null;
    const available = (c?.strategies ?? []).filter((s) => s.available);
    record(
      'GET /api/config',
      cfgRes.status === 200,
      `defaults ${c?.defaultCorpus}/${c?.defaultStrategy}/k=${c?.defaultK} · ${available.length}/${(c?.strategies ?? []).length} strategies available`,
    );

    // 2. ranked search
    console.log('[2/7] ranked search');
    const s1 = await get(`/api/search?${qs({ q: 'stem cells', strategy: 'bm25' })}`);
    const search = s1.body as SearchResponse | null;
    const top1 = search?.results[0];
    record(
      'GET /api/search (bm25)',
      s1.status === 200 && (search?.results.length ?? 0) > 0 && top1 !== undefined,
      `${search?.results.length ?? 0} hits · ${search?.meta.latencyMs.toFixed(2)} ms · #1 "${short(top1?.title ?? '', 44)}" score ${top1?.score.toFixed(4) ?? '—'}`,
    );

    // 3. strategy sweep
    console.log('[3/7] strategy sweep (same query)');
    for (const s of available) {
      const r = await get(`/api/search?${qs({ q: 'stem cells', strategy: s.id, k: 5 })}`);
      const body = r.body as SearchResponse | null;
      const hit = body?.results[0];
      record(
        `strategy ${s.id}`,
        r.status === 200,
        `#1 ${short(hit?.title ?? '(none)', 40)} · score ${hit?.score.toFixed(4) ?? '—'} · engine ${body?.meta.strategyDetail.engineId ?? '?'}`,
      );
    }

    // 4. phrase query
    console.log('[4/7] phrase + proximity');
    const s4 = await get(`/api/search?${qs({ q: '"stem cell"', strategy: 'bm25-phrase', k: 5 })}`);
    const phrase = s4.body as SearchResponse | null;
    const signals = phrase?.results[0]?.signals ?? {};
    record(
      'phrase query',
      s4.status === 200 && (phrase?.results.length ?? 0) > 0,
      `${phrase?.results.length ?? 0} hits · phrase=${signals['phrase']?.toFixed(3) ?? '—'} proximity=${signals['proximity']?.toFixed(3) ?? '—'}`,
    );

    // 5. fuzzy recovery contrast (static-v1 contains "wonderland"; scifact does not)
    console.log('[5/7] fuzzy recovery');
    const noFuzzy = await get(`/api/search?${qs({ q: 'wonderlan', corpus: 'static-v1', strategy: 'bm25' })}`);
    const withFuzzy = (await get(
      `/api/search?${qs({ q: 'wonderlan', corpus: 'static-v1', strategy: 'bm25', fuzzy: true, fuzzyEdits: 1 })}`,
    )) as { status: number; body: SearchResponse | null };
    const nf = noFuzzy.body as SearchResponse | null;
    const expansions = withFuzzy.body?.meta.fuzzy.expansions ?? [];
    const recovered = expansions.flatMap((e) => e.variants);
    record(
      'fuzzy contrast',
      noFuzzy.status === 200 && withFuzzy.status === 200 && recovered.includes('wonderland'),
      `exact ${(nf?.results.length ?? 0)} hits → fuzzy ${(withFuzzy.body?.results.length ?? 0)} hits · expansions [${recovered.join(', ')}]`,
    );

    // 6. document detail
    console.log('[6/7] document detail');
    const docId = top1?.docId ?? '';
    const d = await get(`/api/documents/scifact/${encodeURIComponent(docId)}?${qs({ q: 'stem cells' })}`);
    const doc = d.body as
      | { title?: string; pagerank?: number | null; matchedTerms?: { term: string }[] | null }
      | null;
    record(
      'GET /api/documents/scifact/:id',
      d.status === 200 && typeof doc?.title === 'string',
      `"${short(doc?.title ?? '', 44)}" · pagerank ${doc?.pagerank?.toFixed(6) ?? '—'} · ${(doc?.matchedTerms ?? []).length} matched terms`,
    );

    // 7. stats + committed benchmarks
    console.log('[7/7] stats + recorded experiments');
    const st = await get('/api/stats');
    const stats = st.body as
      | { corpus?: { name?: string; numDocs?: number; vocabSize?: number }; pagerank?: { iterations?: number; source?: string } }
      | null;
    record(
      'GET /api/stats',
      st.status === 200,
      `${stats?.corpus?.name} · ${stats?.corpus?.numDocs} docs · vocab ${stats?.corpus?.vocabSize} · PR ${stats?.pagerank?.source ?? 'unavailable'}`,
    );

    const b = await get('/api/benchmarks');
    const bench = b.body as
      | {
          runs?: { strategy: string | null; fuzzy: boolean; map: number }[];
          fuzzyBenches?: unknown[];
          queryBenches?: unknown[];
        }
      | null;
    const bm25Run = (bench?.runs ?? []).find((r) => r.strategy === 'bm25-k1.2-b0.75' && !r.fuzzy);
    record(
      'GET /api/benchmarks',
      b.status === 200 && bm25Run !== undefined && Math.abs((bm25Run?.map ?? 0) - 0.6436) < 0.0001,
      `${(bench?.runs ?? []).length} runs · ${(bench?.fuzzyBenches ?? []).length} fuzzy · ${(bench?.queryBenches ?? []).length} latency · bm25 MAP ${bm25Run?.map.toFixed(4) ?? '—'}`,
    );
  } finally {
    await app.close();
  }

  const failed = steps.filter((s) => !s.ok);
  console.log(`\ndemo: ${steps.length - failed.length}/${steps.length} steps ok`);
  if (failed.length > 0) {
    console.error('demo FAILED');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
