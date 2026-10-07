/**
 * Production HTML extraction (M3) — the M1 fixture loader's regex pipeline
 * stays as-is for the bundled corpus; this is the crawler's path.
 */

import * as cheerio from 'cheerio';
import type { Heading } from '../storage/repositories.js';

export interface ExtractedLink {
  /** Href exactly as written in the markup. */
  rawHref: string;
  /** Absolute URL after <base href> + page-URL resolution, null if unresolvable. */
  href: string | null;
  anchor: string;
  position: number;
}

export interface ExtractedPage {
  title: string;
  headings: Heading[];
  meta: Record<string, string>;
  text: string;
  links: ExtractedLink[];
  canonicalUrl: string | null;
}

const META_NAMES = new Set([
  'description',
  'keywords',
  'robots',
  'og:title',
  'og:description',
  'og:site_name',
]);

const NON_TEXT_TAGS = 'script, style, noscript, template, svg, iframe';

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function resolve(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);

  const baseHref = $('base[href]').first().attr('href');
  const effectiveBase =
    (baseHref !== undefined && resolve(baseHref, pageUrl)) || pageUrl;

  const title = collapse($('title').first().text());

  const meta: Record<string, string> = {};
  $('meta').each((_, el) => {
    const name = ($(el).attr('name') ?? $(el).attr('property') ?? '').toLowerCase();
    const content = $(el).attr('content');
    if (name !== '' && content !== undefined && META_NAMES.has(name)) {
      meta[name] = content.trim();
    }
  });

  const headings: Heading[] = [];
  $('h1, h2, h3').each((_, el) => {
    const text = collapse($(el).text());
    if (text !== '') headings.push({ level: el.tagName, text });
  });

  const links: ExtractedLink[] = [];
  $('a[href]').each((_, el) => {
    const rawHref = ($(el).attr('href') ?? '').trim();
    if (rawHref === '') return;
    links.push({
      rawHref,
      href: resolve(rawHref, effectiveBase),
      anchor: collapse($(el).text()),
      position: links.length,
    });
  });

  let canonicalUrl: string | null = null;
  $('link').each((_, el) => {
    const rel = ($(el).attr('rel') ?? '').toLowerCase();
    if (rel === 'canonical' && canonicalUrl === null) {
      const href = $(el).attr('href');
      if (href !== undefined) canonicalUrl = resolve(href.trim(), effectiveBase);
    }
  });

  $(NON_TEXT_TAGS).remove();
  // cheerio's parser always synthesizes <body>, including for fragments.
  const text = collapse($('body').text());

  return { title, headings, meta, text, links, canonicalUrl };
}
