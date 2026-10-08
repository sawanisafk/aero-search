/**
 * Fastify HTTP layer — routes, validation, errors, static frontend.
 *
 * WHAT: maps HTTP requests onto SearchService calls and nothing else.
 *   Query-string validation is declarative (JSON Schema) with the same caps
 *   as the service (defence in depth); errors come back as a single shape
 *   { error: { code, message } } with the ServiceError status preserved.
 * WHY: keep the API "dumb" — no ranking logic, no file reads, no engine
 *   imports beyond the service (the service is the only seam).
 * FAILURES: 400 VALIDATION (schema) / QUERY_PARSE / INVALID_* (service),
 *   404 NOT_FOUND, 503 INDEX_UNAVAILABLE, 500 INTERNAL (never leaks paths).
 * CONNECTS TO M0-M4: SearchService -> scripts/lib pipeline; @fastify/static
 *   serves web/dist when it exists (SPA fallback for non-/api paths).
 */

import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { loadConfig, type ApiConfig } from './config.js';
import { SearchService, ServiceError } from './search-service.js';

export interface BuildAppOptions {
  readonly config?: ApiConfig;
  readonly service?: SearchService;
  readonly logger?: boolean;
}

interface SearchQueryString {
  q: string;
  k?: number;
  page?: number;
  strategy?: string;
  corpus?: string;
  fuzzy?: boolean;
  fuzzyEdits?: 1 | 2;
  implicit?: 'and' | 'or';
}

interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.code(status).send(body);
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const cfg: ApiConfig = opts.config ?? loadConfig();
  const app: FastifyInstance = Fastify({
    logger: opts.logger === true,
    // URL ids (crawled doc URLs) can be long — allow them as route params.
    routerOptions: { maxParamLength: 4096 },
    ajv: {
      customOptions: {
        coerceTypes: true,
        useDefaults: true,
        removeAdditional: true,
        allErrors: false,
      },
    },
  });
  const service = opts.service ?? new SearchService(cfg);

  app.register(cors, {
    origin: cfg.corsOrigins.length > 0 ? [...cfg.corsOrigins] : false,
    methods: ['GET', 'HEAD', 'OPTIONS'],
  });

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ServiceError) {
      return sendError(reply, error.status, error.code, error.message);
    }
    const err = error as {
      validation?: { instancePath?: string; message?: string }[];
      statusCode?: number;
      code?: string;
      message?: string;
    };
    if (Array.isArray(err.validation)) {
      const first = err.validation[0];
      const where = first?.instancePath !== undefined && first.instancePath.length > 0
        ? `${first.instancePath}: `
        : '';
      return sendError(reply, 400, 'VALIDATION', `${where}${first?.message ?? 'invalid query'}`);
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      return sendError(reply, status, err.code ?? 'BAD_REQUEST', err.message ?? 'bad request');
    }
    request.log.error({ err: error }, 'unhandled error');
    return sendError(reply, 500, 'INTERNAL', 'internal server error');
  });

  app.get('/health', async () => service.health());

  app.get<{ Querystring: SearchQueryString }>(
    '/api/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          additionalProperties: false,
          properties: {
            q: { type: 'string', minLength: 1, maxLength: cfg.maxQueryLength },
            k: { type: 'integer', minimum: 1, maximum: cfg.maxK },
            page: { type: 'integer', minimum: 1, maximum: cfg.maxPage },
            strategy: { type: 'string', minLength: 1, maxLength: 64 },
            corpus: { type: 'string', minLength: 1, maxLength: 64 },
            fuzzy: { type: 'boolean' },
            fuzzyEdits: { type: 'integer', enum: [1, 2] },
            implicit: { type: 'string', enum: ['and', 'or'] },
          },
        },
      } as const,
    },
    async (req) => {
      const qs = req.query;
      return service.search({
        q: qs.q,
        ...(qs.k === undefined ? {} : { k: qs.k }),
        ...(qs.page === undefined ? {} : { page: qs.page }),
        ...(qs.strategy === undefined ? {} : { strategy: qs.strategy }),
        ...(qs.corpus === undefined ? {} : { corpus: qs.corpus }),
        ...(qs.fuzzy === undefined ? {} : { fuzzy: qs.fuzzy }),
        ...(qs.fuzzyEdits === undefined ? {} : { fuzzyEdits: qs.fuzzyEdits }),
        ...(qs.implicit === undefined ? {} : { implicit: qs.implicit }),
      });
    },
  );

  app.get<{ Params: { corpus: string; '*': string }; Querystring: { q?: string; fuzzy?: boolean } }>(
    '/api/documents/:corpus/*',
    {
      schema: {
        params: {
          type: 'object',
          required: ['corpus'],
          properties: {
            corpus: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', minLength: 1, maxLength: cfg.maxQueryLength },
            fuzzy: { type: 'boolean' },
          },
        },
      } as const,
    },
    async (req) => {
      // find-my-way decodes params once; decode a second time only when an
      // encoded % still remains (ids are raw URLs, rarely percent-encoded).
      let id = req.params['*'] ?? '';
      if (id.includes('%')) {
        try {
          id = decodeURIComponent(id);
        } catch {
          /* keep raw — it is already the decoded form */
        }
      }
      const q = req.query.q;
      return service.document(
        req.params.corpus,
        id,
        {
          ...(q === undefined ? {} : { q }),
          ...(req.query.fuzzy === undefined ? {} : { fuzzy: req.query.fuzzy }),
        },
      );
    },
  );

  app.get<{ Querystring: { corpus?: string } }>(
    '/api/stats',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { corpus: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      } as const,
    },
    async (req) => service.stats(req.query.corpus),
  );

  app.get('/api/config', async () => service.config());

  app.get('/api/benchmarks', async () => service.benchmarks());

  // Serve the built frontend (web/dist) when present; SPA fallback for
  // client-side routes, JSON 404 for anything under /api.
  const distDir = path.join(cfg.root, 'web', 'dist');
  const hasDist = fs.existsSync(path.join(distDir, 'index.html'));
  if (hasDist) {
    app.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? req.url;
    const isApi = url === '/api' || url.startsWith('/api/');
    if (isApi || !hasDist || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return sendError(reply, 404, 'NOT_FOUND', `no route for ${req.method} ${url}`);
    }
    return reply.sendFile('index.html');
  });

  return app;
}
