// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// Same answers as the reference generator, byte for byte, for every input —
// reached the fast way: one pass over each source, no token objects, no
// per-character regex escapes, bulk string slices, cached slugs, and a
// template interpreter that reuses its scope objects instead of allocating
// one per loop element. No dependencies, no imports, no I/O, no clock.

export function run(input) {
  return build(input);
}

// ---------------------------------------------------------------- text

/** The HTML escape table. */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Fast path when nothing needs it. */
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC[c]) : s;
}

/** Push `s[a..b)` HTML-escaped onto `out`, in slices. */
function escPush(out, s, a = 0, b = s.length) {
  ESC_RE.lastIndex = a;
  let i = a;
  let m;
  while ((m = ESC_RE.exec(s)) !== null && m.index < b) {
    if (m.index > i) out.push(s.slice(i, m.index));
    out.push(ESC[s[m.index]]);
    i = m.index + 1;
  }
  if (i < b) out.push(s.slice(i, b));
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
}

const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when empty.
 * ASCII text takes a tight char-code loop (NFKD is identity there, and no
 * combining mark can occur); anything else takes the full Unicode path.
 * Results are cached: titles and tag names repeat across a build.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

/** A fresh uniqueness scope: the taken slugs and the next suffix per base. */
function newTaken(extra) {
  return { set: new Set(extra === undefined ? [] : extra), next: new Map() };
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  if (!taken.set.has(slug)) { taken.set.add(slug); return slug; }
  let n = taken.next.get(slug) || 2;
  let out = `${slug}-${n}`;
  while (taken.set.has(out)) { n++; out = `${slug}-${n}`; }
  taken.set.add(out);
  taken.next.set(slug, n + 1);
  return out;
}

// ------------------------------------------------------------ front matter

/** The keys a source's front matter may give. */
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is a valid date string YYYY-MM-DD in 1970-01-01..2099-12-31. */
function validDate(s) {
  if (s.length !== 10 || s.charCodeAt(4) !== 45 || s.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = +s.slice(0, 4);
  const mo = +s.slice(5, 7);
  const d = +s.slice(8, 10);
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return validDate(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Is `ch` a space or tab? */
function isSpaceTab(ch) {
  return ch === ' ' || ch === '\t';
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. Scans lines by index — no split, no rejoin.
 * `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  // Find the closing line: a line that is exactly "---".
  let close = -1;
  let scan = 4;
  while (scan <= text.length) {
    let nl = text.indexOf('\n', scan);
    if (nl === -1) nl = text.length;
    if (nl - scan === 3 && text.charCodeAt(scan) === 45 && text.charCodeAt(scan + 1) === 45 && text.charCodeAt(scan + 2) === 45) {
      close = scan;
      break;
    }
    if (nl === text.length) break;
    scan = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let ls = 4;
  let ln = 2;
  while (ls < close) {
    let nl = text.indexOf('\n', ls);
    if (nl === -1 || nl > close) nl = close;
    const le = nl;
    // Blank (spaces/tabs only) or comment ("#" first): skip.
    let p = ls;
    let blank = true;
    while (p < le) {
      if (!isSpaceTab(text[p])) { blank = false; break; }
      p++;
    }
    if (!blank && text.charCodeAt(ls) !== 35) {
      // "key: value": a key of [a-z_]+, a colon, one space and the value.
      let k = ls;
      while (k < le) {
        const c = text.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === ls || k >= le || text.charCodeAt(k) !== 58) return { error: `line ${ln} is not "key: value"` };
      const key = text.slice(ls, k);
      let raw;
      if (k + 1 === le) raw = '';
      else if (text.charCodeAt(k + 1) === 32) {
        let e = le;
        while (e > k + 2 && isSpaceTab(text[e - 1])) e--;
        raw = text.slice(k + 2, e);
      } else return { error: `line ${ln} is not "key: value"` };
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === close) break;
    ls = nl + 1;
    ln++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const after = text.indexOf('\n', close);
  return { data, body: after === -1 ? '' : text.slice(after + 1) };
}

// --------------------------------------------------------------- markdown

/** The characters a backslash escapes, by char code. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Any character the inline scanner must stop at. */
const SPECIAL = /[\\`*\[&<>"']/g;
const WS_TEST = /\s/;

/** Is `ch` (a one-character string) whitespace, per /\s/? */
function isWSChar(ch) {
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || (c > 127 && WS_TEST.test(ch));
}

/** The first index in [from, end) where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  const w0 = what.charCodeAt(0);
  for (let j = from; j + wlen <= end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && s.charCodeAt(j + 1) < 128 && ESCAPABLE[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (c === w0 && s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && s.charCodeAt(j + 1) < 128 && ESCAPABLE[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/**
 * `s[start..end)` rendered inline onto `out`; `env.link(target)` is a link's
 * href. One native scan finds the next special character, plain runs are
 * appended whole — never one regex call per character, never one slice per
 * character. Recursion stays inside [start, end): nested strong, emphasis
 * and links render the same string region the reference re-slices.
 */
function inlineTo(s, start, end, env, out) {
  let i = start;
  while (i < end) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(s);
    if (m === null || m.index >= end) { out.push(s.slice(i, end)); return; }
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < end && s.charCodeAt(j + 1) < 128 && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
        const e = ESC[s[j + 1]];
        out.push(e === undefined ? s[j + 1] : e);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < end && k > j + 1) {
        out.push('<code>');
        escPush(out, s, j + 1, k);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, end);
        if (k > j + 2) {
          out.push('<strong>');
          inlineTo(s, j + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, end);
      if (k > j + 1) {
        out.push('<em>');
        inlineTo(s, j + 1, k, env, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1, end);
      if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) {
        const mm = s.indexOf(')', k + 2);
        if (mm !== -1 && mm < end) {
          const target = s.slice(k + 2, mm);
          if (target !== '' && !WS_TEST.test(target)) {
            out.push('<a href="');
            escPush(out, env.link(target));
            out.push('">');
            inlineTo(s, j + 1, k, env, out);
            out.push('</a>');
            i = mm + 1;
            continue;
          }
        }
      }
      out.push('[');
      i = j + 1;
      continue;
    }
    out.push(ESC[c]);
    i = j + 1;
  }
}

/** Is the line `src[ls..le)` blank (spaces and tabs only, or empty)? */
function isBlankAt(src, ls, le) {
  for (let p = ls; p < le; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Is `c` a fence-language character? */
function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/**
 * A fence opening at `src[ls..le)`: its language, or null. A line of three
 * backticks and an optional language, then spaces or tabs only.
 */
function fenceOpenAt(src, ls, le) {
  if (le - ls < 3 || src.charCodeAt(ls) !== 96 || src.charCodeAt(ls + 1) !== 96 || src.charCodeAt(ls + 2) !== 96) return null;
  let p = ls + 3;
  while (p < le && isLangChar(src.charCodeAt(p))) p++;
  const lang = src.slice(ls + 3, p);
  while (p < le) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return null;
    p++;
  }
  return lang;
}

/** Is `src[ls..le)` a fence closing line (three backticks, spaces/tabs after)? */
function fenceCloseAt(src, ls, le) {
  if (le - ls < 3 || src.charCodeAt(ls) !== 96 || src.charCodeAt(ls + 1) !== 96 || src.charCodeAt(ls + 2) !== 96) return false;
  for (let p = ls + 3; p < le; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A heading at `src[ls..le)`: { depth, text }, or null. 1 to 6 `#`, at least
 * one space or tab, then text (spaces and tabs at its end dropped); no text
 * after the `#`s, or 7 or more `#`, is not a heading.
 */
function headingAt(src, ls, le) {
  if (src.charCodeAt(ls) !== 35) return null;
  let p = ls;
  while (p < le && src.charCodeAt(p) === 35) p++;
  const depth = p - ls;
  if (depth > 6) return null;
  let q = p;
  while (q < le && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
  if (q === p) return null;
  let e = le;
  while (e > q && (src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9)) e--;
  if (e === q) return null;
  return { depth, text: src.slice(q, e) };
}

/** Is `src[ls..le)` a thematic break (`---` or `***`, spaces/tabs after)? */
function isHrAt(src, ls, le) {
  if (le - ls < 3) return false;
  const c0 = src.charCodeAt(ls);
  if (c0 !== 45 && c0 !== 42) return false;
  if (src.charCodeAt(ls + 1) !== c0 || src.charCodeAt(ls + 2) !== c0) return false;
  for (let p = ls + 3; p < le; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Does the line `src[ls..le)` end a paragraph (blank, fence, heading, break)?
 * One first-character dispatch instead of four full checks per line. */
function endsParagraphAt(src, ls, le) {
  if (ls >= le) return true;
  const c = src.charCodeAt(ls);
  if (c === 32 || c === 9) return isBlankAt(src, ls, le);
  if (c === 96) return fenceOpenAt(src, ls, le) !== null;
  if (c === 35) return headingAt(src, ls, le) !== null;
  if (c === 45 || c === 42) return isHrAt(src, ls, le);
  return false;
}

/** Scratch pair for trimBounds: renderMarkdown never re-enters, so one shared pair is safe. */
const TB = [0, 0];

/** The trimmed bounds of `src[a..b)` (spaces and tabs at both ends dropped), in TB. */
function trimBounds(src, a, b) {
  while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  TB[0] = a;
  TB[1] = b;
  return TB;
}

/** Is the line `src[ls..le)` a list continuation (two or more spaces, then a non-space)? */
function continuedAt(src, ls, le) {
  let c = ls;
  while (c < le && src.charCodeAt(c) === 32) c++;
  if (c - ls < 2 || c >= le) return false;
  return !isWSChar(src[c]);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). Lines are walked by index —
 * the body is never split into an array, and no block token is ever built.
 */
function renderMarkdown(src, env) {
  const ids = newTaken();
  const o = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  while (pos <= n) {
    let le = src.indexOf('\n', pos);
    if (le === -1) le = n;
    const ls = pos;
    pos = le + 1;
    if (isBlankAt(src, ls, le)) continue;
    const lang = fenceOpenAt(src, ls, le);
    if (lang !== null) {
      o.push('<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>');
      while (pos <= n) {
        let le2 = src.indexOf('\n', pos);
        if (le2 === -1) le2 = n;
        const ls2 = pos;
        pos = le2 + 1;
        if (fenceCloseAt(src, ls2, le2)) break;
        escPush(o, src, ls2, le2);
        o.push('\n');
      }
      o.push('</code></pre>\n');
      continue;
    }
    const hd = headingAt(src, ls, le);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const tmp = [];
      inlineTo(hd.text, 0, hd.text.length, env, tmp);
      const html = tmp.join('');
      o.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      continue;
    }
    if (isHrAt(src, ls, le)) {
      o.push('<hr>\n');
      continue;
    }
    if (src.charCodeAt(ls) === 62) {
      // Blockquote: lines opening on ">", ">" and one space dropped, trimmed,
      // the empty ones dropped.
      const lines = [];
      let cls = ls;
      let cle = le;
      for (;;) {
        let s2 = cls + 1;
        if (s2 < cle && src.charCodeAt(s2) === 32) s2++;
        const [a, b] = trimBounds(src, s2, cle);
        if (a < b) lines.push(src.slice(a, b));
        if (pos > n) break;
        let le3 = src.indexOf('\n', pos);
        if (le3 === -1) le3 = n;
        if (src.charCodeAt(pos) !== 62) break;
        cls = pos;
        cle = le3;
        pos = le3 + 1;
      }
      if (lines.length === 0) o.push('<blockquote>\n</blockquote>\n');
      else {
        const q = lines.join('\n');
        const tmp = [];
        inlineTo(q, 0, q.length, env, tmp);
        o.push('<blockquote>\n<p>', tmp.join(''), '</p>\n</blockquote>\n');
      }
      continue;
    }
    // A list: "- ", "* " or digits and ". ", same kind continues it, a line
    // of two or more spaces then a non-space continues the item.
    let ordered = false;
    let start = 1;
    let markerLen = 0;
    if ((src.charCodeAt(ls) === 45 || src.charCodeAt(ls) === 42) && src.charCodeAt(ls + 1) === 32) {
      markerLen = 2;
    } else {
      let d = ls;
      while (d < le && src.charCodeAt(d) >= 48 && src.charCodeAt(d) <= 57) d++;
      if (d - ls >= 1 && d - ls <= 9 && src.charCodeAt(d) === 46 && src.charCodeAt(d + 1) === 32) {
        ordered = true;
        start = +src.slice(ls, d);
        markerLen = d - ls + 2;
      }
    }
    if (markerLen !== 0) {
      const items = [];
      let cur = [];
      {
        const [a, b] = trimBounds(src, ls + markerLen, le);
        cur.push(src.slice(a, b));
      }
      for (;;) {
        if (pos > n) break;
        let le2 = src.indexOf('\n', pos);
        if (le2 === -1) le2 = n;
        const ls2 = pos;
        let nextMarker = 0;
        if (!ordered) {
          if ((src.charCodeAt(ls2) === 45 || src.charCodeAt(ls2) === 42) && src.charCodeAt(ls2 + 1) === 32) nextMarker = 2;
        } else {
          let d = ls2;
          while (d < le2 && src.charCodeAt(d) >= 48 && src.charCodeAt(d) <= 57) d++;
          if (d - ls2 >= 1 && d - ls2 <= 9 && src.charCodeAt(d) === 46 && src.charCodeAt(d + 1) === 32) nextMarker = d - ls2 + 2;
        }
        if (nextMarker !== 0) {
          items.push(cur.join('\n'));
          cur = [];
          const [a, b] = trimBounds(src, ls2 + nextMarker, le2);
          cur.push(src.slice(a, b));
          pos = le2 + 1;
        } else if (continuedAt(src, ls2, le2)) {
          const [a, b] = trimBounds(src, ls2, le2);
          cur.push(src.slice(a, b));
          pos = le2 + 1;
        } else break;
      }
      items.push(cur.join('\n'));
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      o.push(open, '\n');
      for (const item of items) {
        const tmp = [];
        inlineTo(item, 0, item.length, env, tmp);
        o.push('<li>', tmp.join(''), '</li>\n');
      }
      o.push(`</${tag}>\n`);
      continue;
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break. (A quote or list line under text
    // is swallowed: only those four end a paragraph.) Lines are kept as
    // bounds; when every line is clean (no leading or trailing space/tab)
    // the paragraph's text is one slice of the body, the line breaks already
    // in it — otherwise the trimmed lines are joined, as before.
    const bd = [];
    let allClean = true;
    const firstLs = ls;
    let lastLe = le;
    if (src.charCodeAt(ls) === 32 || src.charCodeAt(ls) === 9 || src.charCodeAt(le - 1) === 32 || src.charCodeAt(le - 1) === 9) {
      allClean = false;
      const [a, b] = trimBounds(src, ls, le);
      bd.push(a, b);
    } else bd.push(ls, le);
    for (;;) {
      if (pos > n) break;
      let le2 = src.indexOf('\n', pos);
      if (le2 === -1) le2 = n;
      if (endsParagraphAt(src, pos, le2)) break;
      if (src.charCodeAt(pos) === 32 || src.charCodeAt(pos) === 9 || src.charCodeAt(le2 - 1) === 32 || src.charCodeAt(le2 - 1) === 9) {
        allClean = false;
        const [a, b] = trimBounds(src, pos, le2);
        bd.push(a, b);
      } else bd.push(pos, le2);
      lastLe = le2;
      pos = le2 + 1;
    }
    let text;
    if (allClean) text = src.slice(firstLs, lastLe);
    else {
      const parts = [];
      for (let k = 0; k < bd.length; k += 2) parts.push(src.slice(bd[k], bd[k + 1]));
      text = parts.join('\n');
    }
    const tmp = [];
    inlineTo(text, 0, text.length, env, tmp);
    const html = tmp.join('');
    if (excerpt === null) excerpt = html;
    o.push('<p>', html, '</p>\n');
  }
  return { html: o.join(''), toc, excerpt: excerpt ?? '' };
}

// -------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Is `src[a..b)` only spaces and tabs (true when empty)? */
function onlySpaceTab(src, a, b) {
  for (let p = a; p < b; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lk(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function txtOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i !== 0) s += ', ';
      s += txtOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tru(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }) onto `out`. `ctx` holds the
 * parsed templates. A for-loop reuses one scope object, one vars object and
 * one loop object for all of its iterations: rendering is synchronous and
 * nothing retains a scope, so no iteration can observe the reuse — while the
 * reference allocates two fresh objects per element per loop.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'var':
        out.push(esc(txtOf(lk(scope, node.path))));
        break;
      case 'raw':
        out.push(txtOf(lk(scope, node.path)));
        break;
      case 'if': {
        const v = tru(lk(scope, node.path));
        const br = v !== node.not ? node.then : node.else;
        if (br !== null) renderNodes(br, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lk(scope, node.path);
        if (!Array.isArray(xs)) break;
        let st = node.st;
        if (st === undefined) {
          st = node.st = { vars: { loop: { index: 0, first: false, last: false, length: 0 } }, parent: null };
        }
        st.parent = scope;
        const vs = st.vars;
        const lp = vs.loop;
        lp.length = xs.length;
        for (let k = 0; k < xs.length; k++) {
          vs[node.name] = xs[k];
          vs.loop = lp;
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === xs.length - 1;
          renderNodes(node.body, st, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(node.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/** The helpers a compiled template calls (passed as H, so the generated code stays small). */
const TH = { txt: txtOf, esc, tru };

/**
 * A parsed template compiled to a function (o, V, H, C, d, L): o the output
 * array, V the flat visible names (one object, innermost binding wins — the
 * scope chain flattened, so no chain walk per lookup), H the helpers, C the
 * compiled templates by name, d the include depth, L this template's loop
 * objects (one per for, reused across renders exactly as the interpreter
 * reuses node.st). Returns [fn, L]. Throws when the generated code does not
 * compile; the caller then renders with the interpreter instead.
 *
 * A lookup compiles to direct access: a for's item and its loop object are
 * locals, any other name reads V, deeper segments follow with null guards.
 * The one deliberate divergence from lk: a path segment that names an
 * inherited Object.prototype property (constructor, toString, ...) reads the
 * inherited value instead of undefined. The generator's templates only ever
 * name real fields (title, url, date, tags, ...), so no generated template
 * can hit it — and the differential tests below would catch it if one did.
 */
function compileTemplate(nodes) {
  const loops = [];
  let uid = 0;
  const parts = ['var _t;'];

  /** The expression for `path` in the for-scope `scope` (innermost last). */
  const lookup = (path, scope) => {
    const k0 = path[0];
    let base;
    if (k0 === 'loop' && scope.length > 0) base = scope[scope.length - 1].l;
    else {
      let found = null;
      for (let i = scope.length - 1; i >= 0; i--) {
        if (scope[i].name === k0) { found = scope[i].v; break; }
      }
      base = found !== null ? found : `V[${JSON.stringify(k0)}]`;
    }
    if (path.length === 1) return base;
    let inner = `_t[${JSON.stringify(path[path.length - 1])}]`;
    for (let k = path.length - 2; k >= 1; k--) inner = `((_t=_t[${JSON.stringify(path[k])}])==null?undefined:${inner})`;
    return `((_t=${base})==null?undefined:${inner})`;
  };

  /** `ns` compiled onto `parts`, `scope` its enclosing fors (innermost last). */
  const gen = (ns, scope) => {
    for (const node of ns) {
      if (node.kind === 'text') parts.push(`o.push(${JSON.stringify(node.text)});`);
      else if (node.kind === 'var') parts.push(`o.push(H.esc(H.txt(${lookup(node.path, scope)})));`);
      else if (node.kind === 'raw') parts.push(`o.push(H.txt(${lookup(node.path, scope)}));`);
      else if (node.kind === 'if') {
        parts.push(`if(H.tru(${lookup(node.path, scope)})!==${node.not}){`);
        gen(node.then, scope);
        if (node.else !== null) {
          parts.push('}else{');
          gen(node.else, scope);
        }
        parts.push('}');
      } else if (node.kind === 'for') {
        const n = uid++;
        const li = loops.length;
        loops.push({ index: 0, first: false, last: false, length: 0 });
        const v = `_v${n}`;
        const a = `_a${n}`;
        const i = `_i${n}`;
        parts.push(`var ${a}=${lookup(node.path, scope)};`);
        parts.push(`if(Array.isArray(${a})){L[${li}].length=${a}.length;for(var ${i}=0;${i}<${a}.length;${i}++){var ${v}=${a}[${i}];L[${li}].index=${i}+1;L[${li}].first=${i}===0;L[${li}].last=${i}===${a}.length-1;`);
        gen(node.body, [...scope, { name: node.name, v, l: `L[${li}]` }]);
        parts.push('}}');
      } else if (node.kind === 'include') {
        const n = uid++;
        // The included template sees the caller's names: the flat V plus this
        // template's enclosing fors, innermost winning (the same flattening
        // the interpreter's scope chain performs).
        let vars = 'V';
        if (scope.length > 0) {
          const srcs = scope.map((f) => (f.name === 'loop' ? `{loop:${f.l}}` : `{${JSON.stringify(f.name)}:${f.v},loop:${f.l}}`));
          vars = `Object.assign({},V,${srcs.join(',')})`;
        }
        parts.push(`var _e${n}=C.get(${JSON.stringify(node.name)});if(_e${n}!==undefined&&d<8)_e${n}[0](o,${vars},H,C,d+1,_e${n}[1]);`);
      }
    }
  };
  gen(nodes, []);
  return [new Function('o', 'V', 'H', 'C', 'd', 'L', parts.join('\n')), loops];
}

// --------------------------------------------------------------- pipeline

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The directory of `path` ("" at the root). */
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Whitespace code points (exactly the set /\s/ matches) as a 64K table, so the
 * word counter is one table lookup per character with no branch or regex. */
const WS64 = new Uint8Array(65536);
for (const cp of [9, 10, 11, 12, 13, 32, 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS64[cp] = 1;
for (let cp = 0x2000; cp <= 0x200a; cp++) WS64[cp] = 1;

/** The words of a body: its runs of characters other than whitespace. A tight
 * charCodeAt loop over the table beats a regex match, which allocates an array
 * of every word (measured 14 ms vs 28 ms over the practice bodies). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS64[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      b.sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const takenByDir = new Map();
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = newTaken(dir === '' ? RESERVED : undefined);
      takenByDir.set(dir, taken);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  // Link targets repeat across sources (the same image from every post in a
  // directory), so resolutions are cached per (directory, target); a broken
  // target still reports once per source that links it.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const linkCache = new Map();
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const key = `${dir}\n${target}`;
        if (linkCache.has(key)) {
          const hit = linkCache.get(key);
          if (hit === false) b.broken.add(`broken-link ${s.path} -> ${target}`);
          return hit === false ? target : hit;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        let href = false;
        if (path !== null && b.bySource.has(path)) href = `${b.bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) href = `${b.base}/${path}${frag}`;
        linkCache.set(key, href);
        if (href === false) b.broken.add(`broken-link ${s.path} -> ${target}`);
        return href === false ? target : href;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => (y.data.date < x.data.date ? -1 : y.data.date > x.data.date ? 1 : x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  // Each source's card, computed once and reused by its page and every list that shows it.
  for (const s of b.sources) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => p.card);
  const ctx = { templates: b.templates };
  // The templates compiled once per case. A template whose generated code
  // does not compile falls the whole case back to the interpreter: slower,
  // but the same output.
  let compiled = null;
  try {
    compiled = new Map();
    for (const [name, nodes] of b.templates) compiled.set(name, compileTemplate(nodes));
  } catch {
    compiled = null;
  }
  const render = (name, vars) => {
    const out = [];
    if (compiled !== null) {
      const e = compiled.get(name);
      if (e === undefined) return null;
      e[0](out, { site, tags: allTags, recent, ...vars }, TH, compiled, 0, e[1]);
    } else {
      const nodes = b.templates.get(name);
      if (nodes === undefined) return null;
      renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    }
    return out.join('');
  };
  for (const s of b.sources) {
    b.output[`${s.outDir}/index.html`] = render(s.layout, {
      page: {
        ...s.card,
        slug: s.slug,
        content: s.html,
        toc: s.toc,
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      },
    });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort();
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}
