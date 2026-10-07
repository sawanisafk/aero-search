import { describe, expect, it } from 'vitest';
import { parseQuery, lex, QueryParseError, type Query } from '../src/core/query/index.js';

const t = (term: string): Query => ({ kind: 'term', term });

function expectParseError(fn: () => unknown, code: string, position?: number): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(QueryParseError);
    const err = e as QueryParseError;
    expect(err.code).toBe(code);
    if (position !== undefined) expect(err.position).toBe(position);
    return;
  }
  throw new Error(`expected QueryParseError(${code}) but nothing was thrown`);
}

describe('query lexer', () => {
  it('lexes terms with absolute positions', () => {
    expect(lex('foo bar')).toEqual([
      { type: 'term', text: 'foo', position: 0 },
      { type: 'term', text: 'bar', position: 4 },
    ]);
  });

  it('treats uppercase AND/OR/NOT as operators and lowercase as terms', () => {
    expect(lex('a AND b').map((t) => t.type)).toEqual(['term', 'and', 'term']);
    expect(lex('a and b').map((t) => t.type)).toEqual(['term', 'term', 'term']);
  });

  it('lexes phrases into ordered surface words', () => {
    const tokens = lex('x "Exact Phrase" y');
    expect(tokens[1]).toEqual({ type: 'phrase', terms: ['exact', 'phrase'], position: 2 });
  });

  it('normalizes phrase words with the shared tokenizer (apostrophes, hyphens)', () => {
    expect(lex('"don\'t stop"')[0]).toMatchObject({ type: 'phrase', terms: ['dont', 'stop'] });
    expect(lex('"state-of-the-art"')[0]).toMatchObject({
      type: 'phrase',
      terms: ['state', 'of', 'the', 'art'],
    });
  });

  it('records positions inside chunked terms after punctuation', () => {
    expect(lex('foo, bar')[0]).toEqual({ type: 'term', text: 'foo', position: 0 });
    expect(lex('foo, bar')[1]).toEqual({ type: 'term', text: 'bar', position: 5 });
  });

  it('throws UNBALANCED_QUOTE at the opening quote', () => {
    expectParseError(() => lex('ok "unclosed'), 'UNBALANCED_QUOTE', 3);
  });

  it('throws EMPTY_PHRASE for quotes with no words', () => {
    expectParseError(() => lex('a "" b'), 'EMPTY_PHRASE', 2);
  });
});

describe('parseQuery: terms and implicit AND', () => {
  it('parses a single term', () => {
    expect(parseQuery('darcy')).toEqual(t('darcy'));
  });

  it('joins adjacent terms with implicit AND (left-associative)', () => {
    expect(parseQuery('elizabeth bennet')).toEqual({
      kind: 'and',
      left: t('elizabeth'),
      right: t('bennet'),
    });
    expect(parseQuery('a b c')).toEqual({
      kind: 'and',
      left: { kind: 'and', left: t('a'), right: t('b') },
      right: t('c'),
    });
  });

  it('parses explicit AND / OR', () => {
    expect(parseQuery('a AND b')).toEqual({ kind: 'and', left: t('a'), right: t('b') });
    expect(parseQuery('a OR b')).toEqual({ kind: 'or', left: t('a'), right: t('b') });
  });

  it('parses NOT as a prefix that binds to one operand', () => {
    expect(parseQuery('NOT a')).toEqual({ kind: 'not', operand: t('a') });
    expect(parseQuery('NOT NOT a')).toEqual({ kind: 'not', operand: { kind: 'not', operand: t('a') } });
  });

  it('parses `a NOT b` as a AND (NOT b)', () => {
    expect(parseQuery('a NOT b')).toEqual({
      kind: 'and',
      left: t('a'),
      right: { kind: 'not', operand: t('b') },
    });
  });
});

describe('parseQuery: precedence', () => {
  it('AND binds tighter than OR: a OR b AND c', () => {
    expect(parseQuery('a OR b AND c')).toEqual({
      kind: 'or',
      left: t('a'),
      right: { kind: 'and', left: t('b'), right: t('c') },
    });
  });

  it('AND binds tighter than OR: a AND b OR c', () => {
    expect(parseQuery('a AND b OR c')).toEqual({
      kind: 'or',
      left: { kind: 'and', left: t('a'), right: t('b') },
      right: t('c'),
    });
  });

  it('NOT binds tightest: NOT a AND b', () => {
    expect(parseQuery('NOT a AND b')).toEqual({
      kind: 'and',
      left: { kind: 'not', operand: t('a') },
      right: t('b'),
    });
  });

  it('NOT binds tightest inside OR: a OR NOT b', () => {
    expect(parseQuery('a OR NOT b')).toEqual({
      kind: 'or',
      left: t('a'),
      right: { kind: 'not', operand: t('b') },
    });
  });

  it('mixes implicit and explicit AND at the same precedence', () => {
    expect(parseQuery('a AND b c')).toEqual({
      kind: 'and',
      left: { kind: 'and', left: t('a'), right: t('b') },
      right: t('c'),
    });
  });
});

describe('parseQuery: parentheses', () => {
  it('overrides precedence: (a OR b) AND c', () => {
    expect(parseQuery('(a OR b) AND c')).toEqual({
      kind: 'and',
      left: { kind: 'or', left: t('a'), right: t('b') },
      right: t('c'),
    });
  });

  it('supports nested groups and flattens redundant wrappers', () => {
    expect(parseQuery('((a b))')).toEqual({ kind: 'and', left: t('a'), right: t('b') });
  });

  it('allows a group adjacent to a term (implicit AND)', () => {
    expect(parseQuery('x (a OR b)')).toEqual({
      kind: 'and',
      left: t('x'),
      right: { kind: 'or', left: t('a'), right: t('b') },
    });
  });

  it('allows NOT directly inside a group', () => {
    expect(parseQuery('(NOT a) OR b')).toEqual({
      kind: 'or',
      left: { kind: 'not', operand: t('a') },
      right: t('b'),
    });
  });
});

describe('parseQuery: phrases', () => {
  it('parses a bare phrase', () => {
    expect(parseQuery('"quick brown fox"')).toEqual({
      kind: 'phrase',
      terms: ['quick', 'brown', 'fox'],
    });
  });

  it('combines phrases with boolean operators and groups', () => {
    expect(parseQuery('("a b" OR c) AND d')).toEqual({
      kind: 'and',
      left: { kind: 'or', left: { kind: 'phrase', terms: ['a', 'b'] }, right: t('c') },
      right: t('d'),
    });
  });

  it('treats a one-word phrase as a phrase node (not a term)', () => {
    expect(parseQuery('"solo"')).toEqual({ kind: 'phrase', terms: ['solo'] });
  });
});

describe('parseQuery: malformed queries', () => {
  it('rejects empty and punctuation-only queries with EMPTY_QUERY', () => {
    expectParseError(() => parseQuery(''), 'EMPTY_QUERY', 0);
    expectParseError(() => parseQuery('   '), 'EMPTY_QUERY', 0);
    expectParseError(() => parseQuery('... !!!'), 'EMPTY_QUERY', 0);
  });

  it('rejects dangling operators with MISSING_OPERAND at the operator', () => {
    expectParseError(() => parseQuery('a AND'), 'MISSING_OPERAND', 2);
    expectParseError(() => parseQuery('a OR'), 'MISSING_OPERAND', 2);
    expectParseError(() => parseQuery('NOT'), 'MISSING_OPERAND', 0);
    expectParseError(() => parseQuery('a AND OR b'), 'MISSING_OPERAND', 2);
    expectParseError(() => parseQuery('(a OR)'), 'MISSING_OPERAND', 3);
  });

  it('rejects a leading binary operator with MISSING_OPERAND', () => {
    expectParseError(() => parseQuery('OR a'), 'MISSING_OPERAND', 0);
    expectParseError(() => parseQuery('a AND )'), 'MISSING_OPERAND', 2);
  });

  it('rejects unbalanced parentheses with UNBALANCED_PAREN', () => {
    expectParseError(() => parseQuery('(a'), 'UNBALANCED_PAREN', 0);
    expectParseError(() => parseQuery('('), 'UNBALANCED_PAREN', 0);
    expectParseError(() => parseQuery('a)'), 'UNBALANCED_PAREN', 1);
    expectParseError(() => parseQuery(')'), 'UNBALANCED_PAREN', 0);
    expectParseError(() => parseQuery('(a) ('), 'UNBALANCED_PAREN', 4);
    expectParseError(() => parseQuery('(a (b'), 'UNBALANCED_PAREN', 3);
  });

  it('rejects empty groups with EMPTY_GROUP at the open paren', () => {
    expectParseError(() => parseQuery('()'), 'EMPTY_GROUP', 0);
    expectParseError(() => parseQuery('a OR ()'), 'EMPTY_GROUP', 5);
  });

  it('rejects unbalanced quotes before parsing', () => {
    expectParseError(() => parseQuery('"unclosed'), 'UNBALANCED_QUOTE', 0);
  });

  it('exposes code and position on the error instance', () => {
    const err = (() => {
      try {
        parseQuery('a AND');
        return undefined;
      } catch (e) {
        return e as QueryParseError;
      }
    })();
    expect(err).toBeInstanceOf(QueryParseError);
    expect(err!.name).toBe('QueryParseError');
    expect(err!.message).toContain('MISSING_OPERAND');
    expect(err!.position).toBe(2);
  });
});

describe('parseQuery: implicitOperator or (IR evaluation mode)', () => {
  it('joins bare adjacency with OR, left-associative', () => {
    expect(parseQuery('a b', { implicitOperator: 'or' })).toEqual({
      kind: 'or',
      left: t('a'),
      right: t('b'),
    });
    expect(parseQuery('a b c', { implicitOperator: 'or' })).toEqual({
      kind: 'or',
      left: { kind: 'or', left: t('a'), right: t('b') },
      right: t('c'),
    });
  });

  it('leaves explicit operators untouched', () => {
    expect(parseQuery('a AND b', { implicitOperator: 'or' })).toEqual({
      kind: 'and',
      left: t('a'),
      right: t('b'),
    });
    expect(parseQuery('a OR b', { implicitOperator: 'or' })).toEqual({
      kind: 'or',
      left: t('a'),
      right: t('b'),
    });
  });

  it('applies the implicit operator around NOT and phrases', () => {
    expect(parseQuery('a NOT b', { implicitOperator: 'or' })).toEqual({
      kind: 'or',
      left: t('a'),
      right: { kind: 'not', operand: t('b') },
    });
    expect(parseQuery('x "a b"', { implicitOperator: 'or' })).toEqual({
      kind: 'or',
      left: t('x'),
      right: { kind: 'phrase', terms: ['a', 'b'] },
    });
  });

  it('applies inside groups', () => {
    expect(parseQuery('(a b) c', { implicitOperator: 'or' })).toEqual({
      kind: 'or',
      left: { kind: 'or', left: t('a'), right: t('b') },
      right: t('c'),
    });
  });

  it('defaults to implicit AND when no option is given', () => {
    expect(parseQuery('a b')).toEqual({ kind: 'and', left: t('a'), right: t('b') });
  });

  it('still throws the same parse errors in or-mode', () => {
    expectParseError(() => parseQuery('a AND', { implicitOperator: 'or' }), 'MISSING_OPERAND', 2);
    expectParseError(() => parseQuery('()', { implicitOperator: 'or' }), 'EMPTY_GROUP', 0);
  });
});
