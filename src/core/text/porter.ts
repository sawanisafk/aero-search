/**
 * Porter stemming algorithm (1980) — faithful TypeScript port of the canonical
 * ANSI C implementation by Martin Porter:
 *   https://tartarus.org/martin/PorterStemmer/c.txt
 *
 * The C version is "definitive" per the author and differs from the published
 * paper at marked DEPARTURE points, all preserved here:
 *   1. Step 2 has the extra rule   (m>0) logi -> log
 *   2. Step 2 rule abli -> able    is replaced by bli -> ble
 *   3. Strings of length <= 2 are not stemmed at all
 *
 * The algorithm removes common English inflectional endings so that variant
 * forms of a word map to a common stem ("learning"/"learned" -> "learn"),
 * improving recall. It is deterministic, prefix-safe (never lengthens a word
 * beyond suffix substitutions) and requires no dictionary.
 *
 * Steps (applied in order, each rule set uses longest-suffix-match semantics):
 *   step1ab  plurals and -ed/-ing    caresses->caress, ponies->poni, cats->cat
 *   step1c   terminal y -> i         happy->happi, sky->sky
 *   step2    -ational/-tional/...    relational->relate, izer->ize
 *   step3    -icate/-ful/-ness       triplicate->triplic, happiness->happi
 *   step4    -ance/-ent/-ion/...     revival->reviv, dependent->depend
 *   step5    final -e, -ll -> -l     agree->agre, presumable...
 *
 * Measure m: number of VC sequences in the stem (<c>vcvc<v> gives 2).
 */

function isConsonant(w: string, i: number): boolean {
  const c = w[i];
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
  if (c === 'y') return i === 0 ? true : !isConsonant(w, i - 1);
  return true;
}

/** m(): number of consonant sequences in w[0..j] (Porter's measure). */
function measure(w: string, j: number): number {
  let n = 0;
  let i = 0;
  for (;;) {
    if (i > j) return n;
    if (!isConsonant(w, i)) break;
    i++;
  }
  i++;
  for (;;) {
    for (;;) {
      if (i > j) return n;
      if (isConsonant(w, i)) break;
      i++;
    }
    i++;
    n++;
    for (;;) {
      if (i > j) return n;
      if (!isConsonant(w, i)) break;
      i++;
    }
    i++;
  }
}

/** TRUE <=> w[0..j] contains a vowel */
function vowelInStem(w: string, j: number): boolean {
  for (let i = 0; i <= j; i++) if (!isConsonant(w, i)) return true;
  return false;
}

/** TRUE <=> w[k], w[k-1] form a double consonant */
function doubleConsonant(w: string, k: number): boolean {
  if (k < 1) return false;
  if (w[k] !== w[k - 1]) return false;
  return isConsonant(w, k);
}

/** TRUE <=> w[i-2..i] has the form CVC with second C not in {w, x, y} */
function cvc(w: string, i: number): boolean {
  if (i < 2 || !isConsonant(w, i) || isConsonant(w, i - 1) || !isConsonant(w, i - 2)) return false;
  const ch = w[i];
  if (ch === 'w' || ch === 'x' || ch === 'y') return false;
  return true;
}

/** ends(s): the prefix of w ending at the suffix occurrence, or null. */
function ends(w: string, k: number, suffix: string): number | null {
  const len = suffix.length;
  if (len > k + 1) return null;
  if (w[k] !== suffix[len - 1]) return null;
  if (!w.startsWith(suffix, k + 1 - len)) return null;
  return k - len;
}

/** setto: replace suffix that starts at j+1 with rep. */
function setto(w: string, j: number, rep: string): { w: string; k: number } {
  return { w: w.slice(0, j + 1) + rep, k: j + rep.length };
}

/** r(): conditionally replace when m(stem) > 0. */
function r(w: string, j: number, suffix: string, rep: string): string | null {
  if (measure(w, j) > 0) return setto(w, j, rep).w;
  return null;
}

function step1ab(word: string): string {
  let w = word;
  let k = w.length - 1;

  // step1a: plurals
  if (w[k] === 's') {
    const jSses = ends(w, k, 'sses');
    if (jSses !== null) {
      k -= 2;
      w = w.slice(0, k + 1);
    } else {
      const jIes = ends(w, k, 'ies');
      if (jIes !== null) {
        ({ w, k } = setto(w, jIes, 'i'));
      } else if (w[k - 1] !== 's') {
        k--;
        w = w.slice(0, k + 1);
      }
    }
  }

  // step1b: -ed / -ing / -eed
  const jEed = ends(w, k, 'eed');
  if (jEed !== null) {
    if (measure(w, jEed) > 0) {
      k--;
      w = w.slice(0, k + 1);
    }
    return w;
  }
  const jEd = ends(w, k, 'ed');
  const jIng = ends(w, k, 'ing');
  const j = jEd ?? jIng;
  if (j === null || !vowelInStem(w, j)) return w;

  k = j;
  w = w.slice(0, k + 1);

  let t = ends(w, k, 'at');
  if (t !== null) return setto(w, t, 'ate').w;
  t = ends(w, k, 'bl');
  if (t !== null) return setto(w, t, 'ble').w;
  t = ends(w, k, 'iz');
  if (t !== null) return setto(w, t, 'ize').w;
  if (doubleConsonant(w, k)) {
    const ch = w[k];
    k--;
    if (ch === 'l' || ch === 's' || ch === 'z') k++;
    w = w.slice(0, k + 1);
    return w;
  }
  if (measure(w, k) === 1 && cvc(w, k)) return setto(w, k, 'e').w;
  return w;
}

function step1c(w: string): string {
  const k = w.length - 1;
  const j = ends(w, k, 'y');
  if (j !== null && vowelInStem(w, j)) return w.slice(0, k) + 'i';
  return w;
}

function step2(word: string): string {
  const k = word.length - 1;
  if (k < 1) return word;
  const w = word;
  const tryRule = (suffix: string, rep: string): string | null => {
    const j = ends(w, k, suffix);
    if (j === null) return null;
    return r(w, j, suffix, rep) ?? w;
  };
  let out: string | null = null;
  switch (w[k - 1]) {
    case 'a':
      out = tryRule('ational', 'ate') ?? tryRule('tional', 'tion');
      break;
    case 'c':
      out = tryRule('enci', 'ence') ?? tryRule('anci', 'ance');
      break;
    case 'e':
      out = tryRule('izer', 'ize');
      break;
    case 'l':
      out =
        tryRule('bli', 'ble') ?? // -DEPARTURE- (published algorithm: abli -> able)
        tryRule('alli', 'al') ??
        tryRule('entli', 'ent') ??
        tryRule('eli', 'e') ??
        tryRule('ousli', 'ous');
      break;
    case 'o':
      out = tryRule('ization', 'ize') ?? tryRule('ation', 'ate') ?? tryRule('ator', 'ate');
      break;
    case 's':
      out =
        tryRule('alism', 'al') ??
        tryRule('iveness', 'ive') ??
        tryRule('fulness', 'ful') ??
        tryRule('ousness', 'ous');
      break;
    case 't':
      out = tryRule('aliti', 'al') ?? tryRule('iviti', 'ive') ?? tryRule('biliti', 'ble');
      break;
    case 'g':
      out = tryRule('logi', 'log'); // -DEPARTURE- (extra rule not in published paper)
      break;
  }
  return out ?? w;
}

function step3(word: string): string {
  const k = word.length - 1;
  if (k < 1) return word;
  const w = word;
  const tryRule = (suffix: string, rep: string): string | null => {
    const j = ends(w, k, suffix);
    if (j === null) return null;
    return r(w, j, suffix, rep) ?? w;
  };
  let out: string | null = null;
  switch (w[k]) {
    case 'e':
      out = tryRule('icate', 'ic') ?? tryRule('ative', '') ?? tryRule('alize', 'al');
      break;
    case 'i':
      out = tryRule('iciti', 'ic');
      break;
    case 'l':
      out = tryRule('ical', 'ic') ?? tryRule('ful', '');
      break;
    case 's':
      out = tryRule('ness', '');
      break;
  }
  return out ?? w;
}

function step4(word: string): string {
  const k = word.length - 1;
  if (k < 1) return word;
  const w = word;
  // Longest-match semantics (official page: "only one rule is applied, the one
  // with the longest matching suffix... whether the rule succeeds or fails").
  // So: find the FIRST matching suffix (in longest-first order per case), then
  // apply the (m>1) gate exactly once. Nested suffixes (ement > ment > ent)
  // make this observable: agreement -> agreement because ement matches first
  // but its stem "agr" has measure 1.
  const firstMatch = (...suffixes: string[]): number | null => {
    for (const s of suffixes) {
      const j = ends(w, k, s);
      if (j !== null) return j;
    }
    return null;
  };
  let j: number | null = null;
  switch (w[k - 1]) {
    case 'a':
      j = firstMatch('al');
      break;
    case 'c':
      j = firstMatch('ance', 'ence');
      break;
    case 'e':
      j = firstMatch('er');
      break;
    case 'i':
      j = firstMatch('ic');
      break;
    case 'l':
      j = firstMatch('able', 'ible');
      break;
    case 'n':
      j = firstMatch('ant', 'ement', 'ment', 'ent');
      break;
    case 'o': {
      // ((m>1) and (*s or *t)) ion -> "" means: taking off -ion leaves a stem
      // of measure > 1 ending in s or t.
      const jIon = ends(w, k, 'ion');
      if (jIon !== null && jIon >= 0 && (w[jIon] === 's' || w[jIon] === 't')) {
        j = jIon;
      } else {
        j = ends(w, k, 'ou');
      }
      break;
    }
    case 's':
      j = firstMatch('ism');
      break;
    case 't':
      j = firstMatch('ate', 'iti');
      break;
    case 'u':
      j = firstMatch('ous');
      break;
    case 'v':
      j = firstMatch('ive');
      break;
    case 'z':
      j = firstMatch('ize');
      break;
    default:
      return w;
  }
  if (j !== null && measure(w, j) > 1) return w.slice(0, j + 1);
  return w;
}

function step5(word: string): string {
  let w = word;
  let k = w.length - 1;
  if (w[k] === 'e') {
    const a = measure(w, k);
    if (a > 1 || (a === 1 && !cvc(w, k - 1))) {
      k--;
      w = w.slice(0, k + 1);
    }
  }
  k = w.length - 1;
  if (k >= 0 && w[k] === 'l' && doubleConsonant(w, k) && measure(w, k) > 1) {
    w = w.slice(0, k);
  }
  return w;
}

/**
 * Stem a single lowercase term.
 * Input must already be lowercase (the analyzer guarantees this).
 * Words of length <= 2 are returned unchanged (canonical DEPARTURE).
 */
export function stem(word: string): string {
  if (word.length <= 2) return word;
  let w = step1ab(word);
  if (w.length > 1) {
    w = step1c(w);
    w = step2(w);
    w = step3(w);
    w = step4(w);
    w = step5(w);
  }
  return w;
}
