import { describe, expect, it } from 'vitest';
import { extractPage } from '../src/crawler/extract.js';
import { contentHash } from '../src/crawler/dedupe.js';

const PAGE_URL = 'https://x.org/dir/page.html';

function page(html: string, url = PAGE_URL) {
  return extractPage(html, url);
}

describe('extractPage', () => {
  it('extracts the title with whitespace collapsed', () => {
    const p = page('<html><head><title>  Hello\n  World  </title></head><body></body></html>');
    expect(p.title).toBe('Hello World');
  });

  it('extracts h1–h3 in document order and skips deeper levels', () => {
    const p = page(`
      <body>
        <h1>Main</h1><h2>Sub</h2><h3>Deep</h3><h4>Not extracted</h4>
        <h2>   </h2>
      </body>`);
    expect(p.headings).toEqual([
      { level: 'h1', text: 'Main' },
      { level: 'h2', text: 'Sub' },
      { level: 'h3', text: 'Deep' },
    ]);
  });

  it('extracts selected meta tags keyed case-insensitively', () => {
    const p = page(`
      <head>
        <meta name="Description" content="A page about things">
        <meta name="keywords" content="a, b">
        <meta property="og:title" content="OG Title">
        <meta name="viewport" content="width=device-width">
      </head><body></body>`);
    expect(p.meta).toEqual({
      description: 'A page about things',
      keywords: 'a, b',
      'og:title': 'OG Title',
    });
  });

  it('extracts visible body text, dropping script/style and collapsing whitespace', () => {
    const p = page(`
      <head><title>Ignore me</title></head>
      <body>
        First   paragraph.
        <script>var x = 1;</script>
        <style>.a { color: red }</style>
        Second
        <noscript>fallback</noscript>
        paragraph.
      </body>`);
    expect(p.text).toBe('First paragraph. Second paragraph.');
  });

  it('falls back to the whole document when there is no body', () => {
    const p = page('<div>Only a fragment</div>');
    expect(p.text).toBe('Only a fragment');
  });

  it('resolves links against the page URL with position and anchor text', () => {
    const p = page(`
      <body>
        <a href="/one">First link</a>
        <a href="two">  Second\n link </a>
        <a href="https://other.org/three">Absolute</a>
        <a href="#top">Fragment only</a>
        <a href=""></a>
        <a>no href</a>
      </body>`);
    expect(p.links).toEqual([
      { rawHref: '/one', href: 'https://x.org/one', anchor: 'First link', position: 0 },
      { rawHref: 'two', href: 'https://x.org/dir/two', anchor: 'Second link', position: 1 },
      { rawHref: 'https://other.org/three', href: 'https://other.org/three', anchor: 'Absolute', position: 2 },
      { rawHref: '#top', href: 'https://x.org/dir/page.html#top', anchor: 'Fragment only', position: 3 },
    ]);
  });

  it('honors <base href> for relative link resolution', () => {
    const p = page(`
      <head><base href="https://cdn.x.org/base/"></head>
      <body><a href="img">go</a></body>`);
    expect(p.links[0]?.href).toBe('https://cdn.x.org/base/img');
  });

  it('keeps non-http hrefs as written (scheme filtering happens at normalize time)', () => {
    const p = page('<body><a href="javascript:void(0)">x</a><a href="mailto:a@b.c">m</a></body>');
    expect(p.links.map((l) => l.href)).toEqual(['javascript:void(0)', 'mailto:a@b.c']);
  });

  it('extracts and resolves the canonical link', () => {
    const p = page(`
      <head><link rel="Canonical" href="/canonical-page"></head><body></body>`);
    expect(p.canonicalUrl).toBe('https://x.org/canonical-page');
    expect(page('<body></body>').canonicalUrl).toBeNull();
  });
});

describe('contentHash', () => {
  it('is insensitive to whitespace differences', () => {
    expect(contentHash('alpha beta\ngamma')).toBe(contentHash('  alpha    beta gamma '));
  });

  it('differs for different text and is a 40-hex sha1', () => {
    expect(contentHash('alpha')).not.toBe(contentHash('alphb'));
    expect(contentHash('alpha')).toMatch(/^[0-9a-f]{40}$/);
  });
});
