/**
 * Regression tests for the lenient free-text parse path (Plan A).
 *
 * The fixture table is the exact set of 33 CQADupStack queries the strict
 * parser rejects (unix 13 / tex 20 / programmers 0 — docs/EVALUATION.md §6).
 * Goldens (strict error code, recovered terms, repair actions) were generated
 * from this codebase itself. For every row we assert BOTH:
 *   1. the STRICT parser still throws the same code (unchanged semantics), and
 *   2. the lenient path recovers an AST whose analyzed terms are exactly the
 *      query's searchable terms, via the documented minimal repairs.
 *
 * Plus: strict-first equivalence on valid Boolean/phrase queries,
 * classification inputs for the harness categories, and termination on
 * pathological input.
 */

import { describe, expect, it } from 'vitest';
import {
  parseQuery,
  parseQueryLenient,
  tryParseQueryLenient,
  QueryParseError,
  type QueryParseOptions,
} from '../src/core/query/index.js';
import { analyzeQuery, positiveQueryTerms } from '../src/core/retrieval/index.js';
import { DEFAULT_ANALYSIS } from '../src/core/text/analyze.js';

const OPTS: QueryParseOptions = { implicitOperator: 'or' };

type Ast = Parameters<typeof analyzeQuery>[0];

function analyzedTerms(ast: Ast): string[] {
  return [...new Set(positiveQueryTerms(analyzeQuery(ast, DEFAULT_ANALYSIS)))].sort();
}

function strictCode(text: string): string | null {
  try {
    parseQuery(text, OPTS);
    return null;
  } catch (e) {
    return e instanceof QueryParseError ? e.code : 'NON_QUERY_PARSE_ERROR';
  }
}

interface Fixture {
  readonly dataset: string;
  readonly queryId: string;
  readonly text: string;
  readonly strictCode: string;
  readonly terms: readonly string[];
  readonly repairs: readonly string[];
}

const FIXTURES: readonly Fixture[] = [
  { dataset: 'unix', queryId: '3747', text: 'Understanding the exclamation mark (!) in bash', strictCode: 'EMPTY_GROUP', terms: ['bash', 'exclam', 'mark', 'understand'], repairs: ['remove_group'] },
  { dataset: 'unix', queryId: '130824', text: 'Difference between "." and "./" while setting the environment variables using export?', strictCode: 'EMPTY_PHRASE', terms: ['differ', 'environ', 'export', 'set', 'us', 'variabl'], repairs: ['remove_quoted_span', 'remove_quoted_span'] },
  { dataset: 'unix', queryId: '98693', text: 'getaddrinfo() from shell?', strictCode: 'EMPTY_GROUP', terms: ['getaddrinfo'], repairs: ['remove_group'] },
  { dataset: 'unix', queryId: '17815', text: 'running script with ". "" and with "source "', strictCode: 'EMPTY_PHRASE', terms: ['run', 'script', 'sourc'], repairs: ['remove_quoted_span', 'remove_quote'] },
  { dataset: 'unix', queryId: '110822', text: 'Using bash "&" operator with ";" delineator?', strictCode: 'EMPTY_PHRASE', terms: ['bash', 'delin', 'oper', 'us'], repairs: ['remove_quoted_span', 'remove_quoted_span'] },
  { dataset: 'unix', queryId: '73750', text: 'difference between function foo() {} and foo() {}', strictCode: 'EMPTY_GROUP', terms: ['differ', 'foo', 'function'], repairs: ['remove_group', 'remove_group'] },
  { dataset: 'unix', queryId: '61401', text: '"~/" receives a permission denied error in Csh', strictCode: 'EMPTY_PHRASE', terms: ['csh', 'deni', 'error', 'permiss', 'receiv'], repairs: ['remove_quoted_span'] },
  { dataset: 'unix', queryId: '151566', text: 'How can I pass a filename containing percent signs (%) as a parameter to a shell script in cron?', strictCode: 'EMPTY_GROUP', terms: ['contain', 'cron', 'filenam', 'paramet', 'pass', 'percent', 'script', 'sign'], repairs: ['remove_group'] },
  { dataset: 'unix', queryId: '80934', text: 'C Shell Array Declaration Syntax, () vs {}', strictCode: 'EMPTY_GROUP', terms: ['arrai', 'c', 'declar', 'syntax', 'vs'], repairs: ['remove_group'] },
  { dataset: 'unix', queryId: '85021', text: 'In Bash scripting, what\'s the meaning of " $! "?', strictCode: 'EMPTY_PHRASE', terms: ['bash', 'mean', 'script'], repairs: ['remove_quoted_span'] },
  { dataset: 'unix', queryId: '9361', text: 'What does "-" mean as an argument to a command?', strictCode: 'EMPTY_PHRASE', terms: ['argument', 'command', 'mean'], repairs: ['remove_quoted_span'] },
  { dataset: 'unix', queryId: '94345', text: 'Can i use & variable of sed for doing operation inside $()?', strictCode: 'EMPTY_GROUP', terms: ['insid', 'oper', 'sed', 'us', 'variabl'], repairs: ['remove_group'] },
  { dataset: 'unix', queryId: '96579', text: 'What is the difference between \' and "?', strictCode: 'UNBALANCED_QUOTE', terms: ['differ'], repairs: ['remove_quote'] },
  { dataset: 'tex', queryId: '169086', text: 'Why do we use a star (*) after a command in LaTeX?', strictCode: 'EMPTY_GROUP', terms: ['command', 'latex', 'star', 'us'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '80436', text: 'Testing for commercial at (@) in a string', strictCode: 'EMPTY_GROUP', terms: ['commerci', 'string', 'test'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '89626', text: 'Marks like "«»"', strictCode: 'EMPTY_PHRASE', terms: ['like', 'mark'], repairs: ['remove_quoted_span'] },
  { dataset: 'tex', queryId: '66893', text: 'How to get () instead of [] in bibliography list?', strictCode: 'EMPTY_GROUP', terms: ['bibliographi', 'get', 'instead', 'list'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '197958', text: 'How to break lines in a cell of table? a very long word contains "::" or "_"', strictCode: 'EMPTY_PHRASE', terms: ['break', 'cell', 'contain', 'line', 'long', 'tabl', 'word'], repairs: ['remove_quoted_span', 'remove_quoted_span'] },
  { dataset: 'tex', queryId: '117252', text: 'A large "#" symbol', strictCode: 'EMPTY_PHRASE', terms: ['larg', 'symbol'], repairs: ['remove_quoted_span'] },
  { dataset: 'tex', queryId: '168146', text: 'Apostrophe (\') in BibTeX not visible after compilation?', strictCode: 'EMPTY_GROUP', terms: ['apostroph', 'bibtex', 'compil', 'visibl'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '50827', text: 'A simpleton\'s guide to (...)TeX workflow with emacs', strictCode: 'EMPTY_GROUP', terms: ['emac', 'guid', 'simpleton', 'tex', 'workflow'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '134772', text: '\\left. \\middle/ \\right doesn\'t match height "/" with \\rule', strictCode: 'EMPTY_PHRASE', terms: ['height', 'left', 'match', 'middl', 'right', 'rule'], repairs: ['remove_quoted_span'] },
  { dataset: 'tex', queryId: '12773', text: '"(" or "\\left(" parentheses?', strictCode: 'EMPTY_PHRASE', terms: ['left', 'parenthes'], repairs: ['remove_quoted_span'] },
  { dataset: 'tex', queryId: '165718', text: 'How to make a delimiter out of a character, eg \\right!, similar to \\right)', strictCode: 'UNBALANCED_PAREN', terms: ['charact', 'delimit', 'eg', 'make', 'right', 'similar'], repairs: ['remove_stray_rparen'] },
  { dataset: 'tex', queryId: '74114', text: '\\( \\) don\'t work with TOC?', strictCode: 'EMPTY_GROUP', terms: ['toc', 'work'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '34670', text: 'babel shorthand "| doesn\'t work in macros', strictCode: 'UNBALANCED_QUOTE', terms: ['babel', 'macro', 'shorthand', 'work'], repairs: ['remove_quote'] },
  { dataset: 'tex', queryId: '28782', text: 'Left outer join symbol (⟕)', strictCode: 'EMPTY_GROUP', terms: ['join', 'left', 'outer', 'symbol'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '49115', text: 'Template (?) for Table Name Cards for a Formal Dinner', strictCode: 'EMPTY_GROUP', terms: ['card', 'dinner', 'formal', 'name', 'tabl', 'templat'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '176855', text: 'exchanging the performance of ":“ and "\\colon"', strictCode: 'UNBALANCED_QUOTE', terms: ['colon', 'exchang', 'perform'], repairs: ['remove_quote'] },
  { dataset: 'tex', queryId: '55054', text: '\\bordermatrix with brackets [ ] instead of parentheses ( )', strictCode: 'EMPTY_GROUP', terms: ['bordermatrix', 'bracket', 'instead', 'parenthes'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '165126', text: 'How do I use the ampersand (&) inside a foreach or conditional (or other group/environment) when building tables?', strictCode: 'EMPTY_GROUP', terms: ['ampersand', 'build', 'condit', 'environ', 'foreach', 'group', 'insid', 'tabl', 'us'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '108193', text: 'Not equal sign (≠) with a vertical bar', strictCode: 'EMPTY_GROUP', terms: ['bar', 'equal', 'sign', 'vertic'], repairs: ['remove_group'] },
  { dataset: 'tex', queryId: '124737', text: 'How to make citations appear within parentheses () instead of square brackets [ ]?', strictCode: 'EMPTY_GROUP', terms: ['appear', 'bracket', 'citat', 'instead', 'make', 'parenthes', 'squar', 'within'], repairs: ['remove_group'] },
];

describe('lenient parse: the 33 reported CQADupStack failures', () => {
  for (const f of FIXTURES) {
    it(`${f.dataset}/${f.queryId}: strict still throws ${f.strictCode}; lenient recovers [${f.terms.join(' ')}]`, () => {
      expect(strictCode(f.text)).toBe(f.strictCode);

      const r = tryParseQueryLenient(f.text, OPTS);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(analyzedTerms(r.query)).toEqual([...f.terms].sort());
      expect(r.repairs.map((x) => x.action)).toEqual([...f.repairs]);
      for (const rep of r.repairs) {
        expect(typeof rep.code).toBe('string');
        expect(rep.position).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it('covers all 33 reported failures (unix 13 / tex 20 / programmers 0)', () => {
    expect(FIXTURES).toHaveLength(33);
    expect(FIXTURES.filter((f) => f.dataset === 'unix')).toHaveLength(13);
    expect(FIXTURES.filter((f) => f.dataset === 'tex')).toHaveLength(20);
    expect(FIXTURES.filter((f) => f.dataset === 'programmers')).toHaveLength(0);
  });
});

describe('strict-first: valid queries are never altered', () => {
  const VALID: readonly string[] = [
    'foo AND (bar OR baz)',
    '(a OR b) AND NOT c',
    '"neural network" retrieval',
    'elizabeth bennet',
    'a OR b AND c',
    '((a b))',
    'a NOT b',
  ];
  for (const text of VALID) {
    it(`identical AST, zero repairs: ${text}`, () => {
      const strict = parseQuery(text, OPTS);
      const r = tryParseQueryLenient(text, OPTS);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.query).toEqual(strict);
      expect(r.repairs).toEqual([]);
    });
  }

  it('strict parser semantics untouched: bad Boolean queries still throw as documented', () => {
    expect(strictCode('foo AND')).toBe('MISSING_OPERAND');
    expect(strictCode('a AND (b OR c')).toBe('UNBALANCED_PAREN');
    expect(strictCode('')).toBe('EMPTY_QUERY');
    expect(strictCode('"neural network')).toBe('UNBALANCED_QUOTE');
  });
});

describe('classification inputs (harness categories)', () => {
  it('symbol-only query: phrase removed, then EMPTY_QUERY (empty, not syntax)', () => {
    const r = tryParseQueryLenient('"-"', OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('EMPTY_QUERY');
    expect(r.repairs.map((x) => x.action)).toEqual(['remove_quoted_span']);
  });

  it('group-only query: removed, then EMPTY_QUERY', () => {
    const r = tryParseQueryLenient('(!)', OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('EMPTY_QUERY');
    expect(r.repairs.map((x) => x.action)).toEqual(['remove_group']);
  });

  it('MISSING_OPERAND is NOT repaired (unsupported_syntax policy), original error preserved', () => {
    const r = tryParseQueryLenient('foo AND', OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('MISSING_OPERAND');
    expect(r.repairs).toEqual([]);
    expect(r.error).toBeInstanceOf(QueryParseError);
  });

  it('parseQueryLenient convenience wrapper throws the original strict error', () => {
    expect(() => parseQueryLenient('"-"', OPTS)).toThrow(QueryParseError);
    try {
      parseQueryLenient('"-"', OPTS);
    } catch (e) {
      expect((e as QueryParseError).code).toBe('EMPTY_QUERY');
    }
  });
});

describe('termination on pathological input (no infinite repair loops)', () => {
  const PATHOLOGICAL: readonly string[] = [
    '(((',
    ')))',
    '""""',
    '"(',
    ')',
    '()',
    '(a',
    'a)',
    '"a',
    '(',
    '"',
    '()()',
    '" "',
  ];
  for (const text of PATHOLOGICAL) {
    it(`terminates: ${JSON.stringify(text)}`, () => {
      const start = performance.now();
      let outcome: 'ok' | 'query-error' | 'other-error' | 'no-result' = 'no-result';
      try {
        parseQueryLenient(text, OPTS);
        outcome = 'ok';
      } catch (e) {
        outcome = e instanceof QueryParseError ? 'query-error' : 'other-error';
      }
      expect(performance.now() - start).toBeLessThan(500);
      // succeeds, or fails with a genuine typed parse error — never hangs,
      // never surfaces a non-QueryParseError from the repair loop
      expect(outcome).not.toBe('other-error');
      expect(outcome).not.toBe('no-result');
    });
  }
});
