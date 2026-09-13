// src/engine/RenderEngine.js
// iOS Remastered — Motor de render propio
// HTML + CSS → DOM → CSSOM → Layout → Paint (canvas 2D) → Hit-testing
// Todo a mano. Sin dependencias externas. Un solo archivo.
//
// Alcance real: HTML estático + CSS. NO ejecuta JS de las páginas.
// Soporta: block/inline/flex layout, position rel/abs/fixed, bordes,
// gradientes, sombras, transforms, z-index, opacity, overflow, scroll,
// hit-testing, hover, click. NO soporta: grid completo, @keyframes,
// pseudo-elementos con contenido, var() anidado, baseline flex.

/* ============================================================================
 * SECCIÓN 1 · UTILIDADES
 * ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';

function isWhitespace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}
function isAlpha(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
function isDigit(c) { return c >= '0' && c <= '9'; }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201C', rdquo: '\u201D', middot: '·', deg: '°',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  times: '×', divide: '÷', plusmn: '±', ne: '≠', le: '≤', ge: '≥',
};

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    const v = ENTITIES[body.toLowerCase()];
    return v != null ? v : m;
  });
}

function parseNumber(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/^(-?\d*\.?\d+)(px|%|em|rem|pt|vh|vw)?$/i);
  if (!m) return null;
  return { n: parseFloat(m[1]), unit: (m[2] || 'px').toLowerCase() };
}

function parseColor(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6) {
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    }
    if (h.length === 8) {
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: parseInt(h.slice(6, 8), 16) / 255 };
    }
    return null;
  }
  const rgb = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: parts[0] | 0, g: parts[1] | 0, b: parts[2] | 0, a: parts.length > 3 ? parts[3] : 1 };
  }
  const named = NAMED_COLORS[s];
  return named ? hexToRgb(named) : null;
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}
function rgbaToCss(c) {
  return `rgba(${c.r},${c.g},${c.b},${c.a})`;
}
function lighten(c, amt) {
  return { r: Math.min(255, c.r + amt), g: Math.min(255, c.g + amt), b: Math.min(255, c.b + amt), a: c.a };
}

const NAMED_COLORS = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000',
  olive: '#808000', lime: '#00ff00', teal: '#008080', navy: '#000080',
  fuchsia: '#ff00ff', aqua: '#00ffff', orange: '#ffa500', purple: '#800080',
  pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082',
  violet: '#ee82ee', tomato: '#ff6347', salmon: '#fa8072', khaki: '#f0e68c',
  transparent: 'transparent', rebeccapurple: '#663399',
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', beige: '#f5f5dc',
  coral: '#ff7f50', crimson: '#dc143c', darkblue: '#00008b', darkgray: '#a9a9a9',
  darkgreen: '#006400', darkorange: '#ff8c00', darkred: '#8b0000',
  deepskyblue: '#00bfff', dodgerblue: '#1e90ff', firebrick: '#b22222',
  forestgreen: '#228b22', hotpink: '#ff69b4', ivory: '#fffff0',
  lavender: '#e6e6fa', lightblue: '#add8e6', lightgray: '#d3d3d3',
  lightgreen: '#90ee90', lightyellow: '#ffffe0', linen: '#faf0e6',
  midnightblue: '#191970', orangered: '#ff4500', orchid: '#da70d6',
  plum: '#dda0dd', royalblue: '#4169e1', seagreen: '#2e8b57',
  sienna: '#a0522d', skyblue: '#87ceeb', slateblue: '#6a5acd',
  steelblue: '#4682b4', tan: '#d2b48c', thistle: '#d8bfd8',
  turquoise: '#40e0d0', wheat: '#f5deb3', whitesmoke: '#f5f5f5',
};

/* ============================================================================
 * SECCIÓN 2 · HTML TOKENIZER + PARSER
 * ========================================================================== */

const VOID_ELEMENTS = new Set([
  'area','base','br','col','embed','hr','img','input','link','meta',
  'param','source','track','wbr',
]);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

class HTMLParser {
  constructor(html) {
    this.html = html || '';
    this.pos = 0;
    this.len = this.html.length;
    this.root = this._mkNode('document', {});
    this.stack = [this.root];
  }

  _mkNode(tagName, attrs) {
    return {
      type: 'element',
      tagName: tagName.toLowerCase(),
      attributes: attrs || {},
      children: [],
      parent: null,
      text: null,
    };
  }

  _mkText(text) {
    return { type: 'text', text, children: [], parent: null, tagName: '#text', attributes: {} };
  }

  _peek(n = 0) { return this.html[this.pos + n] || ''; }
  _eof() { return this.pos >= this.len; }
  _advance(n = 1) { this.pos = Math.min(this.len, this.pos + n); }

  _skipWhitespace() {
    while (!this._eof() && isWhitespace(this._peek())) this._advance();
  }

  _startsWith(s) {
    return this.html.startsWith(s, this.pos);
  }

  _readUntilCloseTag(tagName) {
    const lower = this.html.toLowerCase();
    const target = `</${tagName}`;
    const idx = lower.indexOf(target, this.pos);
    if (idx === -1) {
      const text = this.html.slice(this.pos);
      this.pos = this.len;
      return text;
    }
    const text = this.html.slice(this.pos, idx);
    this.pos = idx;
    return text;
  }

  _parseTagName() {
    let s = '';
    while (!this._eof() && /[a-zA-Z0-9\-_:.]/.test(this._peek())) {
      s += this._peek();
      this._advance();
    }
    return s.toLowerCase();
  }

  _parseAttributes() {
    const attrs = {};
    while (true) {
      this._skipWhitespace();
      const c = this._peek();
      if (!c || c === '>' || c === '/' || this._eof()) break;
      let name = '';
      while (!this._eof() && /[^\s=>\/]/.test(this._peek())) {
        name += this._peek();
        this._advance();
      }
      if (!name) { this._advance(); continue; }
      name = name.toLowerCase();
      this._skipWhitespace();
      let value = '';
      if (this._peek() === '=') {
        this._advance();
        this._skipWhitespace();
        const q = this._peek();
        if (q === '"' || q === "'") {
          this._advance();
          const end = this.html.indexOf(q, this.pos);
          if (end === -1) { value = this.html.slice(this.pos); this.pos = this.len; }
          else { value = this.html.slice(this.pos, end); this.pos = end + 1; }
        } else {
          while (!this._eof() && !isWhitespace(this._peek()) && this._peek() !== '>' && this._peek() !== '/') {
            value += this._peek();
            this._advance();
          }
        }
      } else {
        value = name;
      }
      attrs[name] = decodeEntities(value);
    }
    return attrs;
  }

  _appendText(text) {
    if (!text) return;
    const decoded = decodeEntities(text);
    if (!decoded) return;
    const parent = this.stack[this.stack.length - 1];
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === 'text') {
      last.text += decoded;
    } else {
      const node = this._mkText(decoded);
      node.parent = parent;
      parent.children.push(node);
    }
  }

  parse() {
    while (!this._eof()) {
      const c = this._peek();
      if (c === '<') {
        if (this._startsWith('<!--')) {
          const end = this.html.indexOf('-->', this.pos + 4);
          this.pos = end === -1 ? this.len : end + 3;
          continue;
        }
        if (this._startsWith('<!')) {
          const end = this.html.indexOf('>', this.pos);
          this.pos = end === -1 ? this.len : end + 1;
          continue;
        }
        if (this._startsWith('</')) {
          this.pos += 2;
          const tag = this._parseTagName();
          const end = this.html.indexOf('>', this.pos);
          this.pos = end === -1 ? this.len : end + 1;
          for (let i = this.stack.length - 1; i > 0; i--) {
            if (this.stack[i].tagName === tag) {
              this.stack.length = i;
              break;
            }
          }
          continue;
        }
        if (isAlpha(this._peek(1)) || this._peek(1) === '!') {
          this._advance();
          const tagName = this._parseTagName();
          if (!tagName) { this._appendText('<'); continue; }
          const attrs = this._parseAttributes();
          this._skipWhitespace();
          const selfClosing = this._peek() === '/';
          if (selfClosing) this._advance();
          if (this._peek() === '>') this._advance();

          const node = this._mkNode(tagName, attrs);
          const parent = this.stack[this.stack.length - 1];
          node.parent = parent;
          parent.children.push(node);

          if (!VOID_ELEMENTS.has(tagName) && !selfClosing) {
            if (RAW_TEXT_ELEMENTS.has(tagName)) {
              const raw = this._readUntilCloseTag(tagName);
              if (raw) {
                const t = this._mkText(raw);
                t.parent = node;
                node.children.push(t);
              }
              const endTag = `</${tagName}>`;
              const lower = this.html.toLowerCase();
              if (lower.startsWith(endTag, this.pos)) {
                this.pos += endTag.length;
              }
            } else {
              this.stack.push(node);
            }
          }
          continue;
        }
        this._appendText('<');
        this._advance();
        continue;
      }
      let buf = '';
      while (!this._eof() && this._peek() !== '<') {
        buf += this._peek();
        this._advance();
      }
      this._appendText(buf);
    }
    return this.root;
  }
}

/* ============================================================================
 * SECCIÓN 3 · CSS PARSER
 * ========================================================================== */

class CSSParser {
  constructor(css) {
    this.css = css || '';
    this.pos = 0;
    this.len = this.css.length;
  }

  _peek(n = 0) { return this.css[this.pos + n] || ''; }
  _eof() { return this.pos >= this.len; }
  _advance(n = 1) { this.pos += n; }

  _skipWs() { while (!this._eof() && /\s/.test(this._peek())) this._advance(); }
  _skipComment() {
    if (this._peek() === '/' && this._peek(1) === '*') {
      const end = this.css.indexOf('*/', this.pos + 2);
      this.pos = end === -1 ? this.len : end + 2;
      return true;
    }
    return false;
  }

  parse() {
    const rules = [];
    while (!this._eof()) {
      this._skipWs();
      if (this._skipComment()) continue;
      if (this._eof()) break;
      if (this._peek() === '@') {
        this._parseAtRule(rules);
        continue;
      }
      const rule = this._parseRule();
      if (rule) rules.push(rule);
    }
    return rules;
  }

  _parseAtRule(rules) {
    let name = '';
    this._advance();
    while (!this._eof() && /[a-zA-Z-]/.test(this._peek())) { name += this._peek(); this._advance(); }
    name = name.toLowerCase();
    let prelude = '';
    let depth = 0;
    while (!this._eof()) {
      const c = this._peek();
      if (c === '{' && depth === 0) break;
      if (c === ';' && depth === 0) break;
      if (c === '(') depth++;
      else if (c === ')') depth--;
      prelude += c;
      this._advance();
    }
    if (this._peek() === ';') { this._advance(); return; }
    if (this._peek() !== '{') return;
    this._advance();
    const body = this._readBlock();

    if (name === 'media') {
      const mediaQuery = this._parseMediaQuery(prelude.trim());
      const sub = new CSSParser(body);
      const inner = sub.parse();
      rules.push({ type: 'media', query: mediaQuery, rules: inner });
    } else if (name === 'font-face') {
      const decl = parseDeclarations(body);
      rules.push({ type: 'font-face', decl });
    }
  }

  _parseMediaQuery(text) {
    const q = { raw: text };
    const m = text.match(/\(\s*(max|min)-width\s*:\s*([^)]+)\)/);
    if (m) q[`${m[1]}Width`] = parseNumber(m[2]);
    const h = text.match(/\(\s*(max|min)-height\s*:\s*([^)]+)\)/);
    if (h) q[`${h[1]}Height`] = parseNumber(h[2]);
    const o = text.match(/\(\s*orientation\s*:\s*([^)]+)\)/);
    if (o) q.orientation = o[1].trim();
    return q;
  }

  _parseRule() {
    let selectorText = '';
    while (!this._eof() && this._peek() !== '{' && this._peek() !== '}') {
      if (this._skipComment()) continue;
      selectorText += this._peek();
      this._advance();
    }
    if (this._peek() !== '{') return null;
    this._advance();
    const body = this._readBlock();
    const selectors = selectorText.split(',').map((s) => s.trim()).filter(Boolean);
    if (!selectors.length) return null;
    const parsedSelectors = selectors.map(parseSelector).filter(Boolean);
    const decls = parseDeclarations(body);
    return { type: 'rule', selectors: parsedSelectors, decls };
  }

  _readBlock() {
    let depth = 1;
    let start = this.pos;
    while (!this._eof() && depth > 0) {
      const c = this._peek();
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
      this._advance();
    }
    const text = this.css.slice(start, this.pos);
    if (this._peek() === '}') this._advance();
    return text;
  }
}

function parseDeclarations(body) {
  const out = [];
  let buf = '';
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      buf += c;
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; buf += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ';' && depth === 0) {
      const decl = parseDeclaration(buf);
      if (decl) out.push(decl);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) {
    const decl = parseDeclaration(buf);
    if (decl) out.push(decl);
  }
  return out;
}

function parseDeclaration(text) {
  const i = text.indexOf(':');
  if (i === -1) return null;
  const prop = text.slice(0, i).trim().toLowerCase();
  let value = text.slice(i + 1).trim();
  if (!prop || !value) return null;
  let important = false;
  if (/!\s*important$/i.test(value)) {
    important = true;
    value = value.replace(/!\s*important$/i, '').trim();
  }
  return { prop, value, important };
}

/* -------------------- Selectores -------------------- */

function parseSelector(text) {
  // Grammar: compound (combinator compound)*
  const tokens = tokenizeSelector(text);
  if (!tokens.length) return null;
  return { parts: tokens };
}

function tokenizeSelector(text) {
  const parts = [];
  let i = 0;
  const len = text.length;

  function readCompound() {
    const compound = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
    while (i < len) {
      const c = text[i];
      if (c === '*') { compound.tag = '*'; i++; }
      else if (c === '.') {
        i++;
        let cls = '';
        while (i < len && /[a-zA-Z0-9_-]/.test(text[i])) cls += text[i++];
        if (cls) compound.classes.push(cls);
      } else if (c === '#') {
        i++;
        let id = '';
        while (i < len && /[a-zA-Z0-9_-]/.test(text[i])) id += text[i++];
        if (id) compound.id = id;
      } else if (c === '[') {
        const end = text.indexOf(']', i);
        if (end === -1) { i = len; break; }
        const inside = text.slice(i + 1, end).trim();
        const m = inside.match(/^([^\s~|^$*]+)(?:([~|^$*]?=)["']?([^"'\]]*)["']?)?$/);
        if (m) compound.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[3] || null });
        i = end + 1;
      } else if (c === ':') {
        i++;
        if (text[i] === ':') i++; // pseudo-element, lo ignoramos
        let name = '';
        while (i < len && /[a-zA-Z-]/.test(text[i])) name += text[i++];
        let arg = null;
        if (text[i] === '(') {
          const end = text.indexOf(')', i);
          if (end !== -1) { arg = text.slice(i + 1, end); i = end + 1; }
        }
        if (name) compound.pseudos.push({ name: name.toLowerCase(), arg });
      } else if (isAlpha(c)) {
        let tag = '';
        while (i < len && /[a-zA-Z0-9_-]/.test(text[i])) tag += text[i++];
        compound.tag = tag.toLowerCase();
      } else {
        break;
      }
    }
    return compound;
  }

  while (i < len) {
    while (i < len && /\s/.test(text[i])) i++;
    if (i >= len) break;

    const combMatch = text.slice(i).match(/^[>+~]/);
    let combinator = null;
    if (combMatch) {
      combinator = combMatch[0];
      i += 1;
      while (i < len && /\s/.test(text[i])) i++;
    } else if (parts.length > 0) {
      combinator = ' ';
    }

    const compound = readCompound();
    if (!compound.tag && !compound.id && !compound.classes.length && !compound.attrs.length && !compound.pseudos.length) break;
    parts.push({ combinator, compound });
  }
  return parts;
}

function matchesSelector(node, selector, ctx) {
  if (node.type !== 'element') return false;
  const parts = selector.parts;
  return matchParts(node, parts, parts.length - 1, ctx);
}

function matchParts(node, parts, idx, ctx) {
  const part = parts[idx];
  if (!matchCompound(node, part.compound, ctx)) return false;
  if (idx === 0) return true;
  const comb = part.combinator;
  if (comb === ' ') {
    let p = node.parent;
    while (p) {
      if (p.type === 'element' && matchParts(p, parts, idx - 1, ctx)) return true;
      p = p.parent;
    }
    return false;
  }
  if (comb === '>') {
    const p = node.parent;
    return p && p.type === 'element' && matchParts(p, parts, idx - 1, ctx);
  }
  if (comb === '+' || comb === '~') {
    const parent = node.parent;
    if (!parent) return false;
    const sibs = parent.children.filter((c) => c.type === 'element');
    const i = sibs.indexOf(node);
    if (i <= 0) return false;
    if (comb === '+') return matchParts(sibs[i - 1], parts, idx - 1, ctx);
    for (let k = i - 1; k >= 0; k--) {
      if (matchParts(sibs[k], parts, idx - 1, ctx)) return true;
    }
    return false;
  }
  return false;
}

function matchCompound(node, c, ctx) {
  if (c.tag && c.tag !== '*' && node.tagName !== c.tag) return false;
  if (c.id && node.attributes.id !== c.id) return false;
  if (c.classes.length) {
    const cls = (node.attributes.class || '').split(/\s+/).filter(Boolean);
    for (const x of c.classes) if (!cls.includes(x)) return false;
  }
  for (const a of c.attrs) {
    const val = node.attributes[a.name];
    if (val == null) return false;
    if (a.op === '=' && val !== a.value) return false;
    if (a.op === '~=' && !val.split(/\s+/).includes(a.value)) return false;
    if (a.op === '^=' && !val.startsWith(a.value)) return false;
    if (a.op === '$=' && !val.endsWith(a.value)) return false;
    if (a.op === '*=' && !val.includes(a.value)) return false;
    if (a.op === '|=' && val !== a.value && !val.startsWith(a.value + '-')) return false;
  }
  for (const p of c.pseudos) {
    if (!matchPseudo(node, p, ctx)) return false;
  }
  return true;
}

function matchPseudo(node, p, ctx) {
  switch (p.name) {
    case 'first-child': {
      const parent = node.parent;
      if (!parent) return false;
      const sibs = parent.children.filter((c) => c.type === 'element');
      return sibs[0] === node;
    }
    case 'last-child': {
      const parent = node.parent;
      if (!parent) return false;
      const sibs = parent.children.filter((c) => c.type === 'element');
      return sibs[sibs.length - 1] === node;
    }
    case 'only-child': {
      const parent = node.parent;
      if (!parent) return false;
      const sibs = parent.children.filter((c) => c.type === 'element');
      return sibs.length === 1 && sibs[0] === node;
    }
    case 'nth-child': {
      const parent = node.parent;
      if (!parent || !p.arg) return false;
      const sibs = parent.children.filter((c) => c.type === 'element');
      const i = sibs.indexOf(node) + 1;
      return matchNth(i, p.arg);
    }
    case 'nth-of-type': {
      const parent = node.parent;
      if (!parent || !p.arg) return false;
      const sibs = parent.children.filter((c) => c.type === 'element' && c.tagName === node.tagName);
      const i = sibs.indexOf(node) + 1;
      return matchNth(i, p.arg);
    }
    case 'hover':
      return ctx && ctx.hoverNodes ? ctx.hoverNodes.has(node) : false;
    case 'focus':
      return ctx && ctx.focusedNode === node;
    case 'active':
      return ctx && ctx.activeNode === node;
    case 'not': {
      if (!p.arg) return true;
      const inner = parseSelector(p.arg.trim());
      return !inner || !matchesSelector(node, inner, ctx);
    }
    case 'root':
      return node === ctx?.root;
    default:
      return true;
  }
}

function matchNth(i, arg) {
  const s = arg.trim().toLowerCase();
  if (s === 'odd') return i % 2 === 1;
  if (s === 'even') return i % 2 === 0;
  const m = s.match(/^(-?\d*)n(\s*([+-])\s*(\d+))?$/);
  if (m) {
    const a = m[1] === '' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10);
    const b = m[4] ? parseInt(m[4], 10) * (m[3] === '-' ? -1 : 1) : 0;
    if (a === 0) return i === b;
    const k = (i - b) / a;
    return Number.isInteger(k) && k >= 0;
  }
  const n = parseInt(s, 10);
  return !isNaN(n) && i === n;
}

function specificity(selector) {
  let a = 0, b = 0, c = 0;
  for (const part of selector.parts) {
    const comp = part.compound;
    if (comp.id) a++;
    b += comp.classes.length + comp.attrs.length;
    for (const p of comp.pseudos) {
      if (p.name === 'not' && p.arg) {
        const inner = parseSelector(p.arg.trim());
        if (inner) {
          const s = specificity(inner);
          a += s[0]; b += s[1]; c += s[2];
        }
      } else if (p.name !== 'hover' && p.name !== 'focus' && p.name !== 'active') {
        b++;
      }
    }
    if (comp.tag && comp.tag !== '*') c++;
  }
  return [a, b, c];
}

function compareSpecificity(s1, s2) {
  for (let i = 0; i < 3; i++) {
    if (s1[i] !== s2[i]) return s1[i] - s2[i];
  }
  return 0;
}

/* ============================================================================
 * SECCIÓN 4 · STYLE ENGINE — cascada, herencia, estilos computados
 * ========================================================================== */

const INHERITED_PROPS = new Set([
  'color','font-family','font-size','font-style','font-weight','font-variant',
  'line-height','letter-spacing','word-spacing','text-align','text-indent',
  'text-transform','white-space','visibility','cursor','list-style-type',
  'list-style-position','direction','quotes','word-break','overflow-wrap',
]);

const DEFAULT_STYLES = {
  display: 'inline',
  position: 'static',
  top: 'auto', right: 'auto', bottom: 'auto', left: 'auto',
  width: 'auto', height: 'auto',
  'min-width': '0', 'min-height': '0',
  'max-width': 'none', 'max-height': 'none',
  margin: '0', 'margin-top': '0', 'margin-right': '0', 'margin-bottom': '0', 'margin-left': '0',
  padding: '0', 'padding-top': '0', 'padding-right': '0', 'padding-bottom': '0', 'padding-left': '0',
  'border-width': '0', 'border-style': 'none', 'border-color': 'currentColor',
  'border-top-width': '0', 'border-right-width': '0', 'border-bottom-width': '0', 'border-left-width': '0',
  'border-top-style': 'none', 'border-right-style': 'none', 'border-bottom-style': 'none', 'border-left-style': 'none',
  'border-top-color': 'currentColor', 'border-right-color': 'currentColor', 'border-bottom-color': 'currentColor', 'border-left-color': 'currentColor',
  'border-radius': '0',
  'background-color': 'transparent',
  'background-image': 'none',
  color: '#000000',
  'font-family': 'system-ui, -apple-system, sans-serif',
  'font-size': '16px',
  'font-style': 'normal',
  'font-weight': '400',
  'line-height': 'normal',
  'text-align': 'left',
  'text-decoration': 'none',
  'text-transform': 'none',
  'letter-spacing': 'normal',
  'white-space': 'normal',
  overflow: 'visible',
  'overflow-x': 'visible',
  'overflow-y': 'visible',
  'z-index': 'auto',
  opacity: '1',
  'box-shadow': 'none',
  transform: 'none',
  'transform-origin': '50% 50%',
  'flex-direction': 'row',
  'flex-wrap': 'nowrap',
  'justify-content': 'flex-start',
  'align-items': 'stretch',
  'align-self': 'auto',
  'align-content': 'stretch',
  'flex-grow': '0',
  'flex-shrink': '1',
  'flex-basis': 'auto',
  gap: '0',
  'row-gap': '0', 'column-gap': '0',
  order: '0',
  float: 'none',
  clear: 'none',
  visibility: 'visible',
  cursor: 'auto',
  'list-style-type': 'disc',
  'list-style-position': 'outside',
  'vertical-align': 'baseline',
  transition: 'none',
};

const UA_STYLES = {
  'html, body, div, p, h1, h2, h3, h4, h5, h6, ul, ol, li, section, article, header, footer, nav, aside, main, figure, figcaption, blockquote, pre, hr, form, table, tr, td, th, thead, tbody': 'display:block',
  'span, a, strong, em, b, i, u, code, label, small, sub, sup': 'display:inline',
  'li': 'display:list-item',
  'head, title, meta, link, style, script': 'display:none',
  'h1': 'font-size:2em;font-weight:bold;margin:0.67em 0',
  'h2': 'font-size:1.5em;font-weight:bold;margin:0.83em 0',
  'h3': 'font-size:1.17em;font-weight:bold;margin:1em 0',
  'h4': 'font-size:1em;font-weight:bold;margin:1.33em 0',
  'h5': 'font-size:0.83em;font-weight:bold;margin:1.67em 0',
  'h6': 'font-size:0.67em;font-weight:bold;margin:2.33em 0',
  'p': 'margin:1em 0',
  'ul, ol': 'margin:1em 0;padding-left:40px',
  'li': 'display:list-item;margin:0.25em 0',
  'a': 'color:#0000EE;text-decoration:underline;cursor:pointer',
  'strong, b': 'font-weight:bold',
  'em, i': 'font-style:italic',
  'u': 'text-decoration:underline',
  'code, pre': 'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.9em',
  'pre': 'display:block;white-space:pre;margin:1em 0;padding:0',
  'blockquote': 'margin:1em 40px',
  'hr': 'display:block;border:0;border-top:1px solid #ccc;margin:0.5em 0;height:0',
  'img': 'display:inline-block',
  'table': 'border-collapse:separate;border-spacing:2px',
  'td, th': 'padding:1px;vertical-align:inherit',
  'th': 'font-weight:bold;text-align:center',
  'button': 'display:inline-block;padding:2px 8px;border:1px solid #999;background:#eee;font:inherit;cursor:pointer',
  'input': 'display:inline-block;padding:2px 4px;border:1px solid #999;font:inherit',
  'textarea': 'display:inline-block;padding:2px 4px;border:1px solid #999;font:inherit',
  'label': 'display:inline',
};

let UA_RULES = null;
function getUARules() {
  if (UA_RULES) return UA_RULES;
  UA_RULES = [];
  for (const sel of Object.keys(UA_STYLES)) {
    const decls = parseDeclarations(UA_STYLES[sel]);
    const selectors = sel.split(',').map((s) => parseSelector(s.trim())).filter(Boolean);
    UA_RULES.push({
      type: 'rule',
      selectors,
      decls,
      origin: 'ua',
    });
  }
  return UA_RULES;
}

class StyleEngine {
  constructor(rules, opts = {}) {
    this.rules = rules || [];
    this.viewport = opts.viewport || { width: 800, height: 600 };
    this.fontBase = opts.fontBase || 16;
    this.hoverNodes = new Set();
    this.focusedNode = null;
    this.activeNode = null;
    this.root = null;
  }

  computeAll(root) {
    this.root = root;
    const ctx = {
      hoverNodes: this.hoverNodes,
      focusedNode: this.focusedNode,
      activeNode: this.activeNode,
      root,
    };
    this._walk(root, null, ctx);
  }

  _walk(node, parentComputed, ctx) {
    if (node.type === 'element') {
      node.computed = this._compute(node, parentComputed, ctx);
    }
    for (const child of node.children) {
      this._walk(child, node.computed || parentComputed, ctx);
    }
  }

  _compute(node, parentComputed, ctx) {
    const computed = {};

    // Herencia
    if (parentComputed) {
      for (const prop of INHERITED_PROPS) {
        if (parentComputed[prop] != null) computed[prop] = parentComputed[prop];
      }
    } else {
      for (const prop of INHERITED_PROPS) {
        computed[prop] = DEFAULT_STYLES[prop];
      }
    }

    // Reset no-heredables a default
    for (const prop of Object.keys(DEFAULT_STYLES)) {
      if (computed[prop] === undefined) computed[prop] = DEFAULT_STYLES[prop];
    }

    // Aplicar reglas por orden de especificidad + origen
    const matches = [];
    const allRules = [...getUARules(), ...this.rules];

    for (const rule of allRules) {
      if (rule.type === 'media') {
        if (!this._matchMedia(rule.query)) continue;
        for (const sub of rule.rules) {
          if (sub.type === 'rule') {
            for (const sel of sub.selectors) {
              if (matchesSelector(node, sel, ctx)) {
                const spec = specificity(sel);
                matches.push({ decls: sub.decls, spec, origin: rule.origin || 'author' });
              }
            }
          }
        }
        continue;
      }
      if (rule.type === 'rule') {
        for (const sel of rule.selectors) {
          if (matchesSelector(node, sel, ctx)) {
            const spec = specificity(sel);
            matches.push({ decls: rule.decls, spec, origin: rule.origin || 'author' });
          }
        }
      }
    }

    // Ordenar: origen (UA < author) y especificidad, y orden original
    matches.sort((x, y) => {
      const xOrigin = x.origin === 'ua' ? 0 : 1;
      const yOrigin = y.origin === 'ua' ? 0 : 1;
      if (xOrigin !== yOrigin) return xOrigin - yOrigin;
      return compareSpecificity(x.spec, y.spec);
    });

    // Aplicar
    for (const m of matches) {
      for (const d of m.decls) {
        if (d.important || !m.decls.some((dd) => dd.prop === d.prop && dd.important)) {
          computed[d.prop] = d.value;
        }
      }
    }

    // Inline styles ganan
    const inlineStyle = node.attributes.style;
    if (inlineStyle) {
      const inline = parseDeclarations(inlineStyle);
      for (const d of inline) {
        computed[d.prop] = d.value;
      }
    }

    // Shorthands → longhands
    this._expandShorthands(computed);

    // Valores por defecto para display según tag si no se especificó
    if (!computed.display || computed.display === 'inline') {
      // Los defaults de display están en UA, así que ya están aplicados
    }

    // Font-size: resolver em/% contra padre
    computed['font-size'] = this._resolveFontSize(computed['font-size'], parentComputed);

    return computed;
  }

  _resolveFontSize(value, parentComputed) {
    const parsed = parseNumber(value);
    if (!parsed) return value;
    if (parsed.unit === 'px') return `${parsed.n}px`;
    if (parsed.unit === 'pt') return `${parsed.n * 1.333}px`;
    if (parsed.unit === 'em' || parsed.unit === 'rem') {
      const base = parsed.unit === 'rem' ? this.fontBase
        : (parentComputed ? parseFloat(parentComputed['font-size']) || this.fontBase : this.fontBase);
      return `${parsed.n * base}px`;
    }
    if (parsed.unit === '%') {
      const base = parentComputed ? parseFloat(parentComputed['font-size']) || this.fontBase : this.fontBase;
      return `${(parsed.n / 100) * base}px`;
    }
    return value;
  }

  _expandShorthands(c) {
    // margin / padding
    for (const base of ['margin', 'padding']) {
      if (c[base]) {
        const parts = c[base].trim().split(/\s+/);
        const [t, r = t, b = t, l = r] = parts;
        c[`${base}-top`] = t;
        c[`${base}-right`] = r;
        c[`${base}-bottom`] = b;
        c[`${base}-left`] = l;
      }
    }
    // border
    if (c.border) {
      const parts = c.border.trim().split(/\s+/);
      let width = '0', style = 'none', color = 'currentColor';
      for (const p of parts) {
        if (/^\d|px|em|rem|thin|medium|thick/.test(p)) width = p;
        else if (/^(none|solid|dashed|dotted|double|groove|ridge|inset|outset|hidden)$/.test(p)) style = p;
        else color = p;
      }
      if (width === 'thin') width = '1px';
      if (width === 'medium') width = '3px';
      if (width === 'thick') width = '5px';
      for (const side of ['top', 'right', 'bottom', 'left']) {
        c[`border-${side}-width`] = width;
        c[`border-${side}-style`] = style;
        c[`border-${side}-color`] = color;
      }
    }
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (c[`border-${side}`]) {
        const parts = c[`border-${side}`].trim().split(/\s+/);
        let width = '0', style = 'none', color = 'currentColor';
        for (const p of parts) {
          if (/^\d|px|em|rem|thin|medium|thick/.test(p)) width = p;
          else if (/^(none|solid|dashed|dotted|double)$/.test(p)) style = p;
          else color = p;
        }
        c[`border-${side}-width`] = width;
        c[`border-${side}-style`] = style;
        c[`border-${side}-color`] = color;
      }
    }
    // background
    if (c.background && c.background !== 'none') {
      const bg = c.background.trim();
      if (bg.startsWith('linear-gradient')) {
        c['background-image'] = bg;
      } else if (parseColor(bg)) {
        c['background-color'] = bg;
      }
    }
    // overflow
    if (c.overflow && c.overflow !== 'visible') {
      c['overflow-x'] = c.overflow;
      c['overflow-y'] = c.overflow;
    }
    // flex (flex: grow shrink basis)
    if (c.flex) {
      const parts = c.flex.trim().split(/\s+/);
      if (parts[0] === '1' && parts.length === 1) {
        c['flex-grow'] = '1'; c['flex-shrink'] = '1'; c['flex-basis'] = '0%';
      } else {
        if (parts[0] != null) c['flex-grow'] = parts[0];
        if (parts[1] != null) c['flex-shrink'] = parts[1];
        if (parts[2] != null) c['flex-basis'] = parts[2];
      }
    }
    // gap
    if (c.gap) {
      const parts = c.gap.trim().split(/\s+/);
      c['row-gap'] = parts[0];
      c['column-gap'] = parts[1] || parts[0];
    }
  }

  _matchMedia(q) {
    if (!q) return true;
    const vw = this.viewport.width, vh = this.viewport.height;
    if (q.maxWidth) {
      const v = toPx(q.maxWidth, vw);
      if (vw > v) return false;
    }
    if (q.minWidth) {
      const v = toPx(q.minWidth, vw);
      if (vw < v) return false;
    }
    if (q.maxHeight) {
      const v = toPx(q.maxHeight, vh);
      if (vh > v) return false;
    }
    if (q.minHeight) {
      const v = toPx(q.minHeight, vh);
      if (vh < v) return false;
    }
    if (q.orientation) {
      const isPortrait = vh >= vw;
      if (q.orientation === 'portrait' && !isPortrait) return false;
      if (q.orientation === 'landscape' && isPortrait) return false;
    }
    return true;
  }
}

function toPx(v, base) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (v.unit === 'px') return v.n;
  if (v.unit === '%') return (v.n / 100) * base;
  if (v.unit === 'em' || v.unit === 'rem') return v.n * 16;
  return v.n;
}

/* ============================================================================
 * SECCIÓN 5 · LAYOUT ENGINE — cajas y posiciones
 * ========================================================================== */

class LayoutEngine {
  constructor(opts = {}) {
    this.viewport = opts.viewport || { width: 800, height: 600 };
    this.textMeasurer = opts.textMeasurer || defaultTextMeasurer;
  }

  layout(root) {
    const viewportBox = {
      x: 0, y: 0, width: this.viewport.width, height: this.viewport.height,
      contentX: 0, contentY: 0,
      contentWidth: this.viewport.width,
      contentHeight: this.viewport.height,
    };
    const html = findElement(root, 'html') || root;
    const body = findElement(html, 'body') || html;
    // Layout del body dentro del viewport
    this._layoutBlock(body, viewportBox, { x: 0, y: 0, width: this.viewport.width });
  }

  _layoutBlock(node, parentBox, availableBox) {
    const c = node.computed;
    if (!c) return;
    const display = c.display;

    node.box = {
      x: availableBox.x,
      y: availableBox.y,
      width: 0,
      height: 0,
      contentX: 0, contentY: 0, contentWidth: 0, contentHeight: 0,
      marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
      paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      borderTop: 0, borderRight: 0, borderBottom: 0, borderLeft: 0,
    };

    if (display === 'none') {
      node.box.width = 0;
      node.box.height = 0;
      return;
    }

    const parentFontSize = parentBox.fontSize || 16;
    const fontSize = parseFloat(c['font-size']) || 16;
    node.box.fontSize = fontSize;

    // Resolver margin/padding/border
    const mt = resolveLength(c['margin-top'], availableBox.width, fontSize) || 0;
    const mr = resolveLength(c['margin-right'], availableBox.width, fontSize) || 0;
    const mb = resolveLength(c['margin-bottom'], availableBox.width, fontSize) || 0;
    const ml = resolveLength(c['margin-left'], availableBox.width, fontSize) || 0;
    const pt = resolveLength(c['padding-top'], availableBox.width, fontSize) || 0;
    const pr = resolveLength(c['padding-right'], availableBox.width, fontSize) || 0;
    const pb = resolveLength(c['padding-bottom'], availableBox.width, fontSize) || 0;
    const pl = resolveLength(c['padding-left'], availableBox.width, fontSize) || 0;
    const bt = resolveBorderWidth(c['border-top-width'], c['border-top-style']);
    const br = resolveBorderWidth(c['border-right-width'], c['border-right-style']);
    const bb = resolveBorderWidth(c['border-bottom-width'], c['border-bottom-style']);
    const bl = resolveBorderWidth(c['border-left-width'], c['border-left-style']);

    node.box.marginTop = mt;
    node.box.marginRight = mr;
    node.box.marginBottom = mb;
    node.box.marginLeft = ml;
    node.box.paddingTop = pt;
    node.box.paddingRight = pr;
    node.box.paddingBottom = pb;
    node.box.paddingLeft = pl;
    node.box.borderTop = bt;
    node.box.borderRight = br;
    node.box.borderBottom = bb;
    node.box.borderLeft = bl;

    const horizontalExtra = ml + mr + pl + pr + bl + br;
    const verticalExtra = mt + mb + pt + pb + bt + bb;

    // Ancho
    let width;
    const explicitWidth = c.width && c.width !== 'auto'
      ? resolveLength(c.width, availableBox.width, fontSize) : null;

    if (explicitWidth != null) {
      width = explicitWidth;
    } else if (display === 'block' || display === 'list-item' || display === 'flex') {
      width = availableBox.width - horizontalExtra;
    } else {
      width = null; // inline / inline-block / shrink-to-fit
    }

    // Posición X (bloque: x + margin-left)
    node.box.x = availableBox.x + ml;

    // Si es block/flex y tiene width explícito, aplicamos margin auto horizontal
    if ((display === 'block' || display === 'flex') && explicitWidth != null) {
      const free = availableBox.width - explicitWidth - horizontalExtra;
      if (free > 0) {
        if (c['margin-left'] === 'auto' && c['margin-right'] === 'auto') {
          node.box.x = availableBox.x + ml + free / 2;
        } else if (c['margin-left'] === 'auto') {
          node.box.x = availableBox.x + free;
        }
      }
    }

    node.box.y = availableBox.y + mt;

    const contentX = node.box.x + pl + bl;
    const contentY = node.box.y + pt + bt;
    let contentWidth = width != null ? width : 0;

    // Aplicamos min/max width
    const minW = resolveLength(c['min-width'], availableBox.width, fontSize);
    const maxW = resolveLength(c['max-width'], availableBox.width, fontSize);
    if (minW != null && contentWidth < minW) contentWidth = minW;
    if (maxW != null && contentWidth > maxW) contentWidth = maxW;

    node.box.contentX = contentX;
    node.box.contentY = contentY;
    node.box.contentWidth = contentWidth;

    // Layout de hijos
    const children = node.children.filter((ch) => ch.type === 'element' && ch.computed && ch.computed.display !== 'none');

    if (display === 'flex') {
      this._layoutFlex(node, { x: contentX, y: contentY, width: contentWidth }, fontSize);
    } else if (display === 'block' || display === 'list-item' || display === 'flex') {
      let cursorY = contentY;
      let prevMarginBottom = 0;
      for (const child of children) {
        const childDisplay = child.computed.display;
        if (childDisplay === 'inline' || childDisplay === 'inline-block') {
          // agrupamos runs inline
          cursorY = this._layoutInlineRun(children, children.indexOf(child), { x: contentX, y: cursorY, width: contentWidth }, fontSize);
          break;
        }
        this._layoutBlock(child, node.box, { x: contentX, y: cursorY, width: contentWidth });
        // colapso de márgenes simple
        const mt = child.box.marginTop;
        const collapse = Math.max(prevMarginBottom, mt);
        cursorY = child.box.y + child.box.height + child.box.marginBottom - mt + collapse - prevMarginBottom + child.box.marginBottom - child.box.marginBottom;
        // Simplificado: y final = child.y + height + marginBottom
        cursorY = child.box.y + child.box.height + child.box.marginBottom;
        prevMarginBottom = child.box.marginBottom;
      }
      node.box.contentHeight = cursorY - contentY;
      if (contentWidth === 0 && width == null) {
        node.box.contentWidth = contentWidth;
      }
    } else {
      // inline / inline-block: layout de hijos inline
      const run = this._layoutInlineRun(children, 0, { x: contentX, y: contentY, width: contentWidth || availableBox.width }, fontSize);
      node.box.contentHeight = run - contentY;
    }

    // Altura
    const explicitHeight = c.height && c.height !== 'auto'
      ? resolveLength(c.height, availableBox.height, fontSize) : null;
    let height;
    if (explicitHeight != null) {
      height = explicitHeight;
    } else {
      height = node.box.contentHeight;
    }

    const minH = resolveLength(c['min-height'], availableBox.height, fontSize);
    const maxH = resolveLength(c['max-height'], availableBox.height, fontSize);
    if (minH != null && height < minH) height = minH;
    if (maxH != null && height > maxH) height = maxH;

    node.box.contentHeight = height;
    if (contentWidth != null) node.box.contentWidth = contentWidth;
    if (width == null) {
      // shrink-to-fit para inline-block
      node.box.contentWidth = node.box.contentWidth || 0;
    }

    node.box.width = (node.box.contentWidth || width || 0) + pl + pr + bl + br;
    node.box.height = height + pt + pb + bt + bb;

    // overflow → scroll
    if (c['overflow-x'] === 'auto' || c['overflow-x'] === 'scroll' ||
        c['overflow-y'] === 'auto' || c['overflow-y'] === 'scroll') {
      node.scrollable = true;
      node.scrollX = node.scrollX || 0;
      node.scrollY = node.scrollY || 0;
      node.scrollWidth = Math.max(node.box.contentWidth, node.box.width);
      node.scrollHeight = Math.max(node.box.contentHeight, node.box.height);
    }

    // Posicionamiento relativo/absoluto/fixed
    const pos = c.position;
    if (pos === 'relative' || pos === 'absolute' || pos === 'fixed') {
      const top = resolveLength(c.top, availableBox.height, fontSize);
      const right = resolveLength(c.right, availableBox.width, fontSize);
      const bottom = resolveLength(c.bottom, availableBox.height, fontSize);
      const left = resolveLength(c.left, availableBox.width, fontSize);
      if (left != null) node.box.x += left;
      if (right != null && left == null) node.box.x -= right;
      if (top != null) node.box.y += top;
      if (bottom != null && top == null) node.box.y -= bottom;
    }
  }

  _layoutFlex(node, contentBox, parentFontSize) {
    const c = node.computed;
    const direction = c['flex-direction'] || 'row';
    const wrap = c['flex-wrap'] === 'wrap' || c['flex-wrap'] === 'wrap-reverse';
    const justify = c['justify-content'] || 'flex-start';
    const alignItems = c['align-items'] || 'stretch';
    const gap = resolveLength(c.gap, contentBox.width, parentFontSize) || 0;
    const rowGap = resolveLength(c['row-gap'], contentBox.height, parentFontSize) || gap;
    const colGap = resolveLength(c['column-gap'], contentBox.width, parentFontSize) || gap;

    const isRow = direction === 'row' || direction === 'row-reverse';
    const isReverse = direction === 'row-reverse' || direction === 'column-reverse';

    let children = node.children.filter((ch) => ch.type === 'element' && ch.computed && ch.computed.display !== 'none');
    if (isReverse) children = children.slice().reverse();

    // Fase 1: medir hijos
    for (const child of children) {
      const cc = child.computed;
      const childFontSize = parseFloat(cc['font-size']) || parentFontSize;

      // medir tamaño base (auto)
      if (isRow) {
        const basis = cc['flex-basis'] && cc['flex-basis'] !== 'auto'
          ? resolveLength(cc['flex-basis'], contentBox.width, childFontSize)
          : (cc.width && cc.width !== 'auto' ? resolveLength(cc.width, contentBox.width, childFontSize) : null);
        // Si no hay width explícito, medimos shrink-to-fit
        let baseWidth = basis;
        if (baseWidth == null) {
          baseWidth = this._measureShrinkToFit(child, contentBox.width, childFontSize);
        }
        const extra = resolveBoxExtra(child, contentBox.width, childFontSize);
        baseWidth += extra.horizontal;
        child._flexBase = baseWidth;
        child._flexMin = cc['min-width'] && cc['min-width'] !== '0'
          ? resolveLength(cc['min-width'], contentBox.width, childFontSize) + extra.horizontal
          : 0;
      } else {
        const basis = cc['flex-basis'] && cc['flex-basis'] !== 'auto'
          ? resolveLength(cc['flex-basis'], contentBox.height, childFontSize)
          : (cc.height && cc.height !== 'auto' ? resolveLength(cc.height, contentBox.height, childFontSize) : null);
        let baseHeight = basis;
        if (baseHeight == null) {
          baseHeight = this._measureHeightAuto(child, contentBox.width, childFontSize);
        }
        const extra = resolveBoxExtra(child, contentBox.width, childFontSize);
        baseHeight += extra.vertical;
        child._flexBase = baseHeight;
        child._flexMin = cc['min-height'] && cc['min-height'] !== '0'
          ? resolveLength(cc['min-height'], contentBox.height, childFontSize) + extra.vertical
          : 0;
      }
    }

    // Fase 2: repartir espacio (main axis)
    const mainSize = isRow ? contentBox.width : contentBox.height;
    const totalBase = children.reduce((a, ch) => a + (ch._flexBase || 0), 0) + (children.length - 1) * (isRow ? colGap : rowGap);
    const free = mainSize - totalBase;

    let sizes = children.map((ch) => ch._flexBase || 0);

    if (free > 0) {
      const growSum = children.reduce((a, ch) => a + (parseFloat(ch.computed['flex-grow']) || 0), 0);
      if (growSum > 0) {
        for (let i = 0; i < children.length; i++) {
          const g = parseFloat(children[i].computed['flex-grow']) || 0;
          if (g > 0) sizes[i] += (g / growSum) * free;
        }
      }
    } else if (free < 0) {
      // shrink
      const shrinkSum = children.reduce((a, ch) => {
        const s = parseFloat(ch.computed['flex-shrink']);
        return a + (isNaN(s) ? 1 : s) * (ch._flexBase || 0);
      }, 0);
      if (shrinkSum > 0) {
        for (let i = 0; i < children.length; i++) {
          const s = parseFloat(children[i].computed['flex-shrink']);
          const sh = isNaN(s) ? 1 : s;
          const reduce = (sh * (children[i]._flexBase || 0) / shrinkSum) * (-free);
          sizes[i] = Math.max(children[i]._flexMin || 0, sizes[i] - reduce);
        }
      }
    }

    // Fase 3: layout definitivo de cada hijo
    let cursorMain = 0;
    // Alineación por justify
    const totalSizes = sizes.reduce((a, b) => a + b, 0) + (children.length - 1) * (isRow ? colGap : rowGap);
    const remaining = mainSize - totalSizes;
    let justifyOffset = 0;
    let justifyBetween = 0;
    if (justify === 'center') justifyOffset = remaining / 2;
    else if (justify === 'flex-end') justifyOffset = remaining;
    else if (justify === 'space-between' && children.length > 1) justifyBetween = remaining / (children.length - 1);
    else if (justify === 'space-around' && children.length > 0) {
      justifyOffset = remaining / (children.length * 2);
      justifyBetween = remaining / children.length;
    }
    else if (justify === 'space-evenly' && children.length > 0) {
      justifyOffset = remaining / (children.length + 1);
      justifyBetween = remaining / (children.length + 1);
    }

    cursorMain = justifyOffset;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const cc = child.computed;
      const size = sizes[i];

      // Cross axis
      let crossPos = 0;
      let crossSize = isRow ? contentBox.height : contentBox.width;
      let crossOverride = null;
      const align = cc['align-self'] && cc['align-self'] !== 'auto' ? cc['align-self'] : alignItems;
      if (align === 'center') crossPos = (crossSize - size) / 2;
      else if (align === 'flex-end') crossPos = crossSize - size;
      else if (align === 'stretch') {
        // estiramos: el hijo ocupa todo el cross
        const extra = resolveBoxExtra(child, contentBox.width, parseFloat(cc['font-size']) || parentFontSize);
        if (isRow) {
          if (cc.height === 'auto' || !cc.height || cc.height === 'auto') {
            child._forcedHeight = crossSize - extra.vertical;
          }
        } else {
          if (cc.width === 'auto' || !cc.width || cc.width === 'auto') {
            child._forcedWidth = crossSize - extra.horizontal;
          }
        }
      }

      let childX, childY, childW, childH;
      if (isRow) {
        const extra = resolveBoxExtra(child, contentBox.width, parseFloat(cc['font-size']) || parentFontSize);
        childX = contentBox.x + cursorMain;
        childY = contentBox.y + crossPos;
        childW = size - extra.horizontal;
        childH = child._forcedHeight != null ? child._forcedHeight : null;

        // Layout hijo con width fijo
        child.computed = { ...child.computed, width: `${Math.max(0, childW)}px` };
        this._layoutBlock(child, node.box, { x: childX, y: childY, width: childW });
        if (childH != null) {
          child.box.height = Math.max(child.box.height, childH + extra.vertical);
        }
        cursorMain += size + colGap + justifyBetween;
      } else {
        const extra = resolveBoxExtra(child, contentBox.width, parseFloat(cc['font-size']) || parentFontSize);
        childX = contentBox.x + crossPos;
        childY = contentBox.y + cursorMain;
        childH = size - extra.vertical;
        childW = child._forcedWidth != null ? child._forcedWidth : null;

        child.computed = { ...child.computed, height: `${Math.max(0, childH)}px` };
        this._layoutBlock(child, node.box, { x: childX, y: childY, width: childW || contentBox.width });
        cursorMain += size + rowGap + justifyBetween;
      }
    }

    // Altura del contenedor flex = max de hijos (row) o cursor (column)
    if (isRow) {
      let maxH = 0;
      for (const child of children) {
        const bottom = (child.box.y - contentBox.y) + child.box.height + child.box.marginBottom;
        if (bottom > maxH) maxH = bottom;
      }
      node.box.contentHeight = maxH;
    } else {
      node.box.contentHeight = cursorMain - justifyOffset;
    }
  }

  _layoutInlineRun(children, startIdx, contentBox, parentFontSize) {
    let cursorX = contentBox.x;
    let cursorY = contentBox.y;
    let lineHeight = 0;
    let maxLineHeight = parentFontSize * 1.3;

    for (let i = startIdx; i < children.length; i++) {
      const child = children[i];
      const display = child.computed.display;
      if (display === 'block' || display === 'flex' || display === 'list-item') {
        // Terminamos el run; el caller debe continuar con bloque
        continue;
      }
      if (child.type === 'text') continue;
    }

    // Recorremos hijos incluyendo nodos de texto
    const runChildren = [];
    const parent = children[startIdx]?.parent;
    const parentChildren = parent ? parent.children : children;
    for (const ch of parentChildren) {
      if (ch.type === 'text') {
        runChildren.push(ch);
      } else if (ch.type === 'element' && (ch.computed.display === 'inline' || ch.computed.display === 'inline-block' || ch.computed.display === 'inline-flex')) {
        runChildren.push(ch);
      } else if (ch.type === 'element') {
        break;
      }
    }

    for (const child of runChildren) {
      if (child.type === 'text') {
        const parentNode = parent || child.parent;
        const cc = parentNode?.computed || {};
        const font = parseFont(cc);
        const text = child.text;
        const words = text.split(/(\s+)/);
        for (const w of words) {
          if (!w) continue;
          const wSize = this.textMeasurer(w, font);
          if (cursorX + wSize > contentBox.x + contentBox.width && cursorX > contentBox.x) {
            cursorX = contentBox.x;
            cursorY += maxLineHeight;
            maxLineHeight = font.size * 1.3;
          }
          if (!w.trim()) {
            cursorX += wSize;
            continue;
          }
          child.box = child.box || {};
          child.box.x = cursorX;
          child.box.y = cursorY;
          child.box.width = wSize;
          child.box.height = font.size * 1.2;
          child.box.contentX = cursorX;
          child.box.contentY = cursorY;
          child.box.contentWidth = wSize;
          child.box.contentHeight = child.box.height;
          child.box.font = font;
          cursorX += wSize;
          maxLineHeight = Math.max(maxLineHeight, font.size * 1.3);
        }
      } else if (child.type === 'element') {
        if (child.computed.display === 'inline-block' || child.computed.display === 'inline-flex') {
          this._layoutBlock(child, parent?.box || contentBox, { x: cursorX, y: cursorY, width: contentBox.width - (cursorX - contentBox.x) });
          cursorX += child.box.width;
          maxLineHeight = Math.max(maxLineHeight, child.box.height);
          if (cursorX > contentBox.x + contentBox.width) {
            cursorX = contentBox.x;
            cursorY += maxLineHeight;
            maxLineHeight = parentFontSize * 1.3;
          }
        } else {
          // inline: layout de su contenido en la misma línea
          const cc = child.computed;
          const font = parseFont(cc);
          // Texto dentro
          const innerText = collectText(child);
          const words = innerText.split(/(\s+)/);
          let firstWord = true;
          for (const w of words) {
            if (!w) continue;
            const wSize = this.textMeasurer(w, font);
            if (cursorX + wSize > contentBox.x + contentBox.width && cursorX > contentBox.x) {
              cursorX = contentBox.x;
              cursorY += maxLineHeight;
              maxLineHeight = font.size * 1.3;
            }
            if (!w.trim()) {
              cursorX += wSize;
              continue;
            }
            if (firstWord) {
              child.box = {
                x: cursorX, y: cursorY, width: 0, height: font.size * 1.2,
                contentX: cursorX, contentY: cursorY,
                contentWidth: 0, contentHeight: font.size * 1.2,
                marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
                paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
                borderTop: 0, borderRight: 0, borderBottom: 0, borderLeft: 0,
                font,
              };
              firstWord = false;
            }
            child.box.width += wSize;
            child.box.contentWidth += wSize;
            child.box.height = Math.max(child.box.height, font.size * 1.2);
            cursorX += wSize;
            maxLineHeight = Math.max(maxLineHeight, font.size * 1.3);
          }
          if (child.box) {
            child.box.height = Math.max(child.box.height, font.size * 1.2);
          }
        }
      }
    }

    return cursorY + maxLineHeight;
  }

  _measureShrinkToFit(node, availWidth, parentFontSize) {
    const c = node.computed;
    const text = collectText(node).trim();
    const font = parseFont(c);
    if (!text) return 0;
    return Math.min(availWidth, this.textMeasurer(text, font));
  }

  _measureHeightAuto(node, availWidth, parentFontSize) {
    const c = node.computed;
    const text = collectText(node).trim();
    if (!text) return 0;
    const font = parseFont(c);
    const width = availWidth;
    const words = text.split(/(\s+)/);
    let lines = 1, lineW = 0;
    for (const w of words) {
      if (!w) continue;
      const wSize = this.textMeasurer(w, font);
      if (lineW + wSize > width && lineW > 0) {
        lines++;
        lineW = wSize;
      } else {
        lineW += wSize;
      }
    }
    return lines * font.size * 1.3;
  }
}

function defaultTextMeasurer(text, font) {
  if (typeof document === 'undefined') return text.length * font.size * 0.5;
  const canvas = defaultTextMeasurer._canvas || (defaultTextMeasurer._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = `${font.style} ${font.weight} ${font.size}px ${font.family}`;
  return ctx.measureText(text).width;
}

function parseFont(c) {
  const family = (c && c['font-family']) || 'system-ui, -apple-system, sans-serif';
  const size = parseFloat((c && c['font-size']) || '16') || 16;
  const weight = (c && c['font-weight']) || '400';
  const style = (c && c['font-style']) || 'normal';
  return { family, size, weight, style };
}

function collectText(node) {
  if (node.type === 'text') return node.text || '';
  let s = '';
  for (const ch of node.children) s += collectText(ch);
  return s;
}

function resolveLength(value, base, fontSize) {
  if (value == null || value === 'auto' || value === 'none') return null;
  const p = parseNumber(value);
  if (!p) return null;
  if (p.unit === 'px') return p.n;
  if (p.unit === 'pt') return p.n * 1.333;
  if (p.unit === '%') return (p.n / 100) * (base || 0);
  if (p.unit === 'em' || p.unit === 'rem') return p.n * (fontSize || 16);
  return p.n;
}

function resolveBorderWidth(w, style) {
  if (!style || style === 'none' || style === 'hidden') return 0;
  if (w === 'thin') return 1;
  if (w === 'medium') return 3;
  if (w === 'thick') return 5;
  const v = resolveLength(w, 0, 16);
  return v || 0;
}

function resolveBoxExtra(node, base, fontSize) {
  const c = node.computed;
  const mt = resolveLength(c['margin-top'], base, fontSize) || 0;
  const mr = resolveLength(c['margin-right'], base, fontSize) || 0;
  const mb = resolveLength(c['margin-bottom'], base, fontSize) || 0;
  const ml = resolveLength(c['margin-left'], base, fontSize) || 0;
  const pt = resolveLength(c['padding-top'], base, fontSize) || 0;
  const pr = resolveLength(c['padding-right'], base, fontSize) || 0;
  const pb = resolveLength(c['padding-bottom'], base, fontSize) || 0;
  const pl = resolveLength(c['padding-left'], base, fontSize) || 0;
  const bt = resolveBorderWidth(c['border-top-width'], c['border-top-style']);
  const br = resolveBorderWidth(c['border-right-width'], c['border-right-style']);
  const bb = resolveBorderWidth(c['border-bottom-width'], c['border-bottom-style']);
  const bl = resolveBorderWidth(c['border-left-width'], c['border-left-style']);
  return {
    horizontal: ml + mr + pl + pr + bl + br,
    vertical: mt + mb + pt + pb + bt + bb,
    top: mt + pt + bt, right: mr + pr + br, bottom: mb + pb + bb, left: ml + pl + bl,
  };
}

function findElement(root, tag) {
  if (root.tagName === tag) return root;
  for (const ch of root.children || []) {
    const found = findElement(ch, tag);
    if (found) return found;
  }
  return null;
}

/* ============================================================================
 * SECCIÓN 6 · PAINT ENGINE — canvas 2D
 * ========================================================================== */

class PaintEngine {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.viewport = opts.viewport || { width: 800, height: 600 };
    this.dpr = opts.dpr || (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  }

  paint(root) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.viewport.width, this.viewport.height);
    ctx.restore();

    const html = findElement(root, 'html') || root;
    const body = findElement(html, 'body') || html;
    this._paintNode(body, { x: 0, y: 0, width: this.viewport.width, height: this.viewport.height }, 0);
  }

  _paintNode(node, clip, baseZ) {
    if (node.type !== 'element') return;
    const c = node.computed;
    if (!c) return;
    if (c.display === 'none') return;
    if (c.visibility === 'hidden' && false) return; // aún reserva espacio

    const box = node.box;
    if (!box) return;
    if (box.width <= 0 && box.height <= 0 && c.display !== 'inline') return;

    const ctx = this.ctx;
    ctx.save();

    // Transform (basic: translate/scale/rotate)
    const transform = parseTransform(c.transform);
    if (transform) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      ctx.translate(cx, cy);
      if (transform.translate) ctx.translate(transform.translate[0], transform.translate[1]);
      if (transform.scale) ctx.scale(transform.scale[0], transform.scale[1]);
      if (transform.rotate) ctx.rotate(transform.rotate);
      ctx.translate(-cx, -cy);
    }

    // Opacidad
    if (c.opacity && c.opacity !== '1') {
      ctx.globalAlpha = parseFloat(c.opacity);
    }

    // Fondo
    this._paintBackground(node, box);

    // Bordes
    this._paintBorders(node, box, c);

    // Overflow hidden → clip
    if (c['overflow-x'] === 'hidden' || c['overflow-y'] === 'hidden' ||
        c['overflow-x'] === 'auto' || c['overflow-y'] === 'auto' ||
        c['overflow-x'] === 'scroll' || c['overflow-y'] === 'scroll') {
      ctx.beginPath();
      ctx.rect(box.contentX, box.contentY, box.contentWidth, Math.max(box.contentHeight, box.height - box.paddingTop - box.paddingBottom - box.borderTop - box.borderBottom));
      ctx.clip();
    }

    // Texto (si es inline o tiene hijos de texto directos)
    if (isTextContainer(node)) {
      this._paintText(node, box, c);
    }

    // Imagen
    if (node.tagName === 'img') {
      this._paintImage(node, box, c);
    }

    // Inputs / buttons
    if (node.tagName === 'input' || node.tagName === 'textarea') {
      this._paintInput(node, box, c);
    }

    // Hijos
    const children = node.children.filter((ch) => ch.type === 'element' && ch.computed && ch.computed.display !== 'none');
    // Ordenar por z-index
    const sorted = children.slice().sort((a, b) => {
      const za = parseInt(a.computed['z-index']) || 0;
      const zb = parseInt(b.computed['z-index']) || 0;
      return za - zb;
    });
    for (const child of sorted) {
      this._paintNode(child, clip, baseZ);
    }

    ctx.restore();
  }

  _paintBackground(node, box) {
    const c = node.computed;
    const ctx = this.ctx;

    // Color
    const bgColor = parseColor(c['background-color']);
    const bgImage = c['background-image'];
    const radius = parseRadius(c['border-radius']);

    if (bgImage && bgImage !== 'none' && bgImage.startsWith('linear-gradient')) {
      const grad = parseLinearGradient(bgImage);
      if (grad) {
        const g = ctx.createLinearGradient(
          box.x + grad.x0 * box.width, box.y + grad.y0 * box.height,
          box.x + grad.x1 * box.width, box.y + grad.y1 * box.height
        );
        for (const stop of grad.stops) {
          g.addColorStop(stop.pos, stop.color);
        }
        ctx.fillStyle = g;
        roundRect(ctx, box.x, box.y, box.width, box.height, radius);
        ctx.fill();
      }
    } else if (bgColor && bgColor.a > 0) {
      ctx.fillStyle = rgbaToCss(bgColor);
      roundRect(ctx, box.x, box.y, box.width, box.height, radius);
      ctx.fill();
    }
  }

  _paintBorders(node, box, c) {
    const ctx = this.ctx;
    const sides = ['top', 'right', 'bottom', 'left'];
    for (const side of sides) {
      const style = c[`border-${side}-style`];
      if (!style || style === 'none' || style === 'hidden') continue;
      const width = resolveBorderWidth(c[`border-${side}-width`], style);
      if (width <= 0) continue;
      const color = parseColor(resolveCurrentColor(c[`border-${side}-color`], c)) || { r: 0, g: 0, b: 0, a: 1 };
      ctx.strokeStyle = rgbaToCss(color);
      ctx.lineWidth = width;
      if (style === 'dashed') ctx.setLineDash([6, 4]);
      else if (style === 'dotted') ctx.setLineDash([2, 3]);
      else ctx.setLineDash([]);
      ctx.beginPath();
      const half = width / 2;
      if (side === 'top') { ctx.moveTo(box.x, box.y + half); ctx.lineTo(box.x + box.width, box.y + half); }
      else if (side === 'right') { ctx.moveTo(box.x + box.width - half, box.y); ctx.lineTo(box.x + box.width - half, box.y + box.height); }
      else if (side === 'bottom') { ctx.moveTo(box.x, box.y + box.height - half); ctx.lineTo(box.x + box.width, box.y + box.height - half); }
      else if (side === 'left') { ctx.moveTo(box.x + half, box.y); ctx.lineTo(box.x + half, box.y + box.height); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  _paintText(node, box, c) {
    if (node._textPainted) return;
    const ctx = this.ctx;
    const font = parseFont(c);
    const color = parseColor(resolveCurrentColor(c.color, c)) || { r: 0, g: 0, b: 0, a: 1 };
    ctx.font = `${font.style} ${font.weight} ${font.size}px ${font.family}`;
    ctx.fillStyle = rgbaToCss(color);
    ctx.textBaseline = 'top';

    const textAlign = c['text-align'] || 'left';
    const lineHeight = c['line-height'] && c['line-height'] !== 'normal'
      ? resolveLength(c['line-height'], font.size, font.size) || font.size * 1.3
      : font.size * 1.3;

    const textDecoration = c['text-decoration'];
    const textTransform = c['text-transform'];

    // Layout de línea: recorremos nodos hijos (text + inline)
    const fragments = collectFragments(node);
    let cursorX = box.contentX;
    let cursorY = box.contentY;
    let lineFragments = [];
    let lineWidth = 0;

    const pushLine = () => {
      if (!lineFragments.length) return;
      let startX = cursorX;
      const avail = box.contentWidth;
      if (textAlign === 'center') startX = box.contentX + (avail - lineWidth) / 2;
      else if (textAlign === 'right') startX = box.contentX + avail - lineWidth;
      else if (textAlign === 'justify') startX = box.contentX;
      let x = startX;
      for (const f of lineFragments) {
        ctx.font = `${f.font.style} ${f.font.weight} ${f.font.size}px ${f.font.family}`;
        ctx.fillStyle = rgbaToCss(f.color);
        let txt = f.text;
        if (textTransform === 'uppercase') txt = txt.toUpperCase();
        else if (textTransform === 'lowercase') txt = txt.toLowerCase();
        else if (textTransform === 'capitalize') txt = txt.replace(/\b\w/g, (m) => m.toUpperCase());
        ctx.fillText(txt, x, cursorY + (lineHeight - f.font.size) / 2);
        if (textDecoration && textDecoration.includes('underline')) {
          ctx.strokeStyle = rgbaToCss(f.color);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, cursorY + lineHeight - 2);
          ctx.lineTo(x + f.width, cursorY + lineHeight - 2);
          ctx.stroke();
        }
        if (textDecoration && textDecoration.includes('line-through')) {
          ctx.strokeStyle = rgbaToCss(f.color);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, cursorY + lineHeight / 2);
          ctx.lineTo(x + f.width, cursorY + lineHeight / 2);
          ctx.stroke();
        }
        x += f.width;
      }
      lineFragments = [];
      lineWidth = 0;
      cursorY += lineHeight;
      cursorX = box.contentX;
    };

    for (const f of fragments) {
      if (f.text === '\n') { pushLine(); continue; }
      const words = f.text.split(/(\s+)/);
      for (const w of words) {
        if (!w) continue;
        ctx.font = `${f.font.style} ${f.font.weight} ${f.font.size}px ${f.font.family}`;
        const wSize = ctx.measureText(w).width;
        if (cursorX + wSize > box.contentX + box.contentWidth && cursorX > box.contentX) {
          pushLine();
        }
        if (!w.trim()) {
          cursorX += wSize;
          lineWidth += wSize;
          continue;
        }
        lineFragments.push({ ...f, text: w, width: wSize });
        cursorX += wSize;
        lineWidth += wSize;
      }
    }
    pushLine();
  }

  _paintImage(node, box, c) {
    const ctx = this.ctx;
    const src = node.attributes.src;
    if (!src) return;
    const img = getCachedImage(src);
    if (img && img.complete) {
      try {
        const radius = parseRadius(c['border-radius']);
        if (radius) {
          ctx.save();
          roundRect(ctx, box.contentX, box.contentY, box.contentWidth || box.width, box.contentHeight || box.height, radius);
          ctx.clip();
          ctx.drawImage(img, box.contentX, box.contentY, box.contentWidth || box.width, box.contentHeight || box.height);
          ctx.restore();
        } else {
          ctx.drawImage(img, box.contentX, box.contentY, box.contentWidth || box.width, box.contentHeight || box.height);
        }
      } catch { /* imagen aún no cargada */ }
    } else {
      // placeholder
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(box.contentX, box.contentY, box.contentWidth || 100, box.contentHeight || 100);
      ctx.strokeStyle = '#aaa';
      ctx.strokeRect(box.contentX, box.contentY, box.contentWidth || 100, box.contentHeight || 100);
    }
  }

  _paintInput(node, box, c) {
    const ctx = this.ctx;
    const value = node.attributes.value || node.attributes.placeholder || '';
    if (!value) return;
    const font = parseFont(c);
    ctx.font = `${font.style} ${font.weight} ${font.size}px ${font.family}`;
    ctx.fillStyle = node.attributes.placeholder && !node.attributes.value ? '#999' : rgbaToCss(parseColor(c.color) || { r: 0, g: 0, b: 0, a: 1 });
    ctx.textBaseline = 'middle';
    ctx.fillText(value, box.contentX + 4, box.contentY + (box.contentHeight || font.size * 1.3) / 2);
  }
}

const _imageCache = new Map();
function getCachedImage(src) {
  if (_imageCache.has(src)) return _imageCache.get(src);
  if (typeof Image === 'undefined') return null;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { img.complete = true; };
  img.src = src;
  _imageCache.set(src, img);
  return img;
}

function isTextContainer(node) {
  if (node.tagName === 'textarea') return true;
  for (const ch of node.children) {
    if (ch.type === 'text' && ch.text && ch.text.trim()) return true;
  }
  return false;
}

function collectFragments(node, inheritStyle = null) {
  const out = [];
  for (const ch of node.children) {
    if (ch.type === 'text') {
      const parent = ch.parent;
      const c = parent.computed;
      const font = parseFont(c);
      const color = parseColor(resolveCurrentColor(c.color, c)) || { r: 0, g: 0, b: 0, a: 1 };
      out.push({ text: ch.text, font, color });
    } else if (ch.type === 'element' && ch.computed && ch.computed.display !== 'none') {
      const c = ch.computed;
      const font = parseFont(c);
      const color = parseColor(resolveCurrentColor(c.color, c)) || { r: 0, g: 0, b: 0, a: 1 };
      // Recursivo
      for (const sub of ch.children) {
        if (sub.type === 'text') {
          out.push({ text: sub.text, font, color });
        } else if (sub.type === 'element' && sub.computed && sub.computed.display !== 'none') {
          out.push(...collectFragments(ch, { font, color }));
          break;
        }
      }
      if (ch.tagName === 'br') out.push({ text: '\n', font, color });
    }
  }
  return out;
}

function resolveCurrentColor(value, c) {
  if (value === 'currentColor' || value === 'currentcolor') return c.color || '#000';
  return value;
}

function parseRadius(value) {
  if (!value || value === '0') return 0;
  const n = parseFloat(value);
  return isNaN(n) ? 0 : n;
}

function parseTransform(value) {
  if (!value || value === 'none') return null;
  const out = {};
  const t = value.match(/translate\(([^)]+)\)/);
  if (t) {
    const parts = t[1].split(',').map((x) => parseFloat(x.trim()));
    out.translate = [parts[0] || 0, parts[1] || 0];
  }
  const s = value.match(/scale\(([^)]+)\)/);
  if (s) {
    const parts = s[1].split(',').map((x) => parseFloat(x.trim()));
    out.scale = [parts[0] || 1, parts[1] != null ? parts[1] : parts[0] || 1];
  }
  const r = value.match(/rotate\(([^)]+)\)/);
  if (r) {
    out.rotate = parseFloat(r[1]) * Math.PI / 180;
  }
  return (out.translate || out.scale || out.rotate) ? out : null;
}

function parseLinearGradient(value) {
  const m = value.match(/linear-gradient\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map((s) => s.trim());
  let angle = 180;
  let stopsStart = 0;
  const dir = parts[0].match(/^(-?\d+)deg$/);
  if (dir) { angle = parseFloat(dir[1]); stopsStart = 1; }
  else if (/^to\s/.test(parts[0])) {
    const dirMap = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 };
    angle = dirMap[parts[0]] || 180;
    stopsStart = 1;
  }
  const rad = (angle - 90) * Math.PI / 180;
  const x0 = 0.5 - Math.cos(rad) * 0.5;
  const y0 = 0.5 - Math.sin(rad) * 0.5;
  const x1 = 0.5 + Math.cos(rad) * 0.5;
  const y1 = 0.5 + Math.sin(rad) * 0.5;
  const stops = [];
  for (let i = stopsStart; i < parts.length; i++) {
    const p = parts[i];
    const sm = p.match(/^(.+?)\s+(\d+)%$/);
    let color, pos;
    if (sm) { color = sm[1].trim(); pos = parseFloat(sm[2]) / 100; }
    else { color = p; pos = (i - stopsStart) / Math.max(1, parts.length - 1 - stopsStart); }
    stops.push({ pos, color });
  }
  return { x0, y0, x1, y1, stops };
}

function roundRect(ctx, x, y, w, h, r) {
  if (!r) { ctx.beginPath(); ctx.rect(x, y, w, h); return; }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/* ============================================================================
 * SECCIÓN 7 · HIT-TESTING
 * ========================================================================== */

function hitTest(node, x, y) {
  if (node.type !== 'element') return null;
  const c = node.computed;
  if (!c || c.display === 'none') return null;
  const box = node.box;
  if (!box) return null;

  const inside = x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
  if (!inside) return null;

  // Buscar el hijo más profundo
  const children = node.children.filter((ch) => ch.type === 'element');
  let best = null;
  let bestZ = -Infinity;
  for (const ch of children) {
    const hit = hitTest(ch, x, y);
    if (hit) {
      const z = parseInt(ch.computed['z-index']) || 0;
      if (z >= bestZ) { best = hit; bestZ = z; }
    }
  }
  return best || node;
}

function collectHoverPath(node, x, y, path = []) {
  if (node.type !== 'element') return path;
  const box = node.box;
  if (!box) return path;
  if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
    path.push(node);
    for (const ch of node.children) {
      if (ch.type === 'element') collectHoverPath(ch, x, y, path);
    }
  }
  return path;
}

/* ============================================================================
 * SECCIÓN 8 · API PÚBLICA
 * ========================================================================== */

export class RenderEngine {
  constructor(opts = {}) {
    this.viewport = opts.viewport || { width: 402, height: 874 };
    this.dpr = opts.dpr || (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    this.ctx = opts.ctx || null;
    this.root = null;
    this.styles = null;
    this._hoverPath = [];
    this._lastHit = null;

    this.onNavigate = opts.onNavigate || null;
    this.onHover = opts.onHover || null;
    this.onClick = opts.onClick || null;
  }

  load(html, css) {
    // 1. HTML → DOM
    const parser = new HTMLParser(html);
    const doc = parser.parse();

    // 2. Extraer <style> y <link> como CSS adicional
    let extraCss = '';
    walk(doc, (node) => {
      if (node.tagName === 'style' && node.children[0]) {
        extraCss += '\n' + node.children[0].text;
      }
    });
    const fullCss = (css || '') + extraCss;

    // 3. CSS → reglas
    const cssParser = new CSSParser(fullCss);
    const rules = cssParser.parse();

    // 4. Aplicar estilos
    const styleEngine = new StyleEngine(rules, { viewport: this.viewport });
    styleEngine.computeAll(doc);

    // 5. Layout
    const layout = new LayoutEngine({ viewport: this.viewport });
    layout.layout(doc);

    this.root = doc;
    this.styles = styleEngine;

    // 6. Pintar
    if (this.ctx) this.paint();

    return doc;
  }

  paint() {
    if (!this.ctx || !this.root) return;
    const paint = new PaintEngine(this.ctx, { viewport: this.viewport });
    paint.paint(this.root);
  }

  setViewport(w, h) {
    this.viewport = { width: w, height: h };
    if (this.root && this.styles) {
      this.styles.viewport = this.viewport;
      this.styles.computeAll(this.root);
      const layout = new LayoutEngine({ viewport: this.viewport });
      layout.layout(this.root);
      this.paint();
    }
  }

  hit(x, y) {
    if (!this.root) return null;
    const html = findElement(this.root, 'html') || this.root;
    const body = findElement(html, 'body') || html;
    return hitTest(body, x, y);
  }

  hover(x, y) {
    if (!this.root) return;
    const path = this._hoverPath;
    path.length = 0;
    const html = findElement(this.root, 'html') || this.root;
    const body = findElement(html, 'body') || html;
    collectHoverPath(body, x, y, path);

    // Actualizar hoverNodes
    const newHover = new Set(path);
    const styles = this.styles;
    const prev = styles.hoverNodes;
    let changed = false;
    if (prev.size !== newHover.size) changed = true;
    else for (const n of newHover) if (!prev.has(n)) { changed = true; break; }

    if (changed) {
      styles.hoverNodes = newHover;
      styles.computeAll(this.root);
      const layout = new LayoutEngine({ viewport: this.viewport });
      layout.layout(this.root);
      this.paint();
    }
  }

  click(x, y) {
    const node = this.hit(x, y);
    this._lastHit = node;
    if (!node) return;

    // Buscar enlace ancestro
    let link = node;
    while (link && link.tagName !== 'a') link = link.parent;
    if (link && link.attributes.href) {
      if (this.onNavigate) this.onNavigate(link.attributes.href);
      return;
    }

    // Buscar button/input
    let interactive = node;
    while (interactive && !['button','input','textarea','select','label'].includes(interactive.tagName)) {
      interactive = interactive.parent;
    }
    if (interactive) {
      this.styles.activeNode = interactive;
      this.styles.focusedNode = interactive;
      this.styles.computeAll(this.root);
      const layout = new LayoutEngine({ viewport: this.viewport });
      layout.layout(this.root);
      this.paint();
      if (this.onClick) this.onClick(interactive);
    }
  }

  scroll(dx, dy, x, y) {
    if (!this.root) return;
    // Buscar contenedor scrolleable más profundo en (x,y)
    const node = this.hit(x, y);
    if (!node) {
      this._scrollRoot(dx, dy);
      return;
    }
    let cur = node;
    while (cur) {
      if (cur.scrollable) {
        const c = cur.computed;
        const canX = c['overflow-x'] === 'auto' || c['overflow-x'] === 'scroll';
        const canY = c['overflow-y'] === 'auto' || c['overflow-y'] === 'scroll';
        if (canY) {
          cur.scrollY = Math.max(0, Math.min(cur.scrollHeight - (cur.box.height - cur.box.paddingTop - cur.box.paddingBottom), cur.scrollY + dy));
        }
        if (canX) {
          cur.scrollX = Math.max(0, Math.min(cur.scrollWidth - (cur.box.width - cur.box.paddingLeft - cur.box.paddingRight), cur.scrollX + dx));
        }
        // Aplicamos offset a hijos pintando en coordenadas desplazadas
        applyScrollOffset(cur);
        this.paint();
        return;
      }
      cur = cur.parent;
    }
    this._scrollRoot(dx, dy);
  }

  _scrollRoot(dx, dy) {
    // Scroll global del body: trasladamos todo el body
    if (!this.root) return;
    const html = findElement(this.root, 'html') || this.root;
    const body = findElement(html, 'body') || html;
    body._globalScrollX = (body._globalScrollX || 0) + dx;
    body._globalScrollY = Math.max(0, (body._globalScrollY || 0) + dy);
    // Aplicamos un offset visual moviendo las cajas del body
    if (!body._originalBox) body._originalBox = { ...body.box };
    body.box.y = body._originalBox.y - body._globalScrollY;
    body.box.x = body._originalBox.x - body._globalScrollX;
    shiftChildren(body, -dx, -dy);
    this.paint();
  }

  resetScroll() {
    if (!this.root) return;
    const html = findElement(this.root, 'html') || this.root;
    const body = findElement(html, 'body') || html;
    body._globalScrollX = 0;
    body._globalScrollY = 0;
    if (body._originalBox) {
      body.box.y = body._originalBox.y;
      body.box.x = body._originalBox.x;
    }
    this.load(this._html || '', this._css || '');
  }
}

function walk(node, fn) {
  fn(node);
  for (const ch of node.children || []) walk(ch, fn);
}

function shiftChildren(node, dx, dy) {
  for (const ch of node.children) {
    if (ch.type !== 'element' || !ch.box) continue;
    ch.box.x += dx;
    ch.box.y += dy;
    ch.box.contentX += dx;
    ch.box.contentY += dy;
    shiftChildren(ch, dx, dy);
  }
}

function applyScrollOffset(node) {
  // Simplificación: trasladamos los hijos directos por el scrollY
  for (const ch of node.children) {
    if (ch.type !== 'element' || !ch.box) continue;
    if (!ch._origY) ch._origY = ch.box.y;
    if (!ch._origX) ch._origX = ch.box.x;
    ch.box.y = ch._origY - (node.scrollY || 0);
    ch.box.x = ch._origX - (node.scrollX || 0);
    ch.box.contentY = ch.box.y + ch.box.paddingTop + ch.box.borderTop;
    ch.box.contentX = ch.box.x + ch.box.paddingLeft + ch.box.borderLeft;
  }
}

/* ============================================================================
 * SECCIÓN 9 · UTILIDAD: PÁGINAS DE EJEMPLO
 * ========================================================================== */

export const SAMPLE_HTML = `
<!DOCTYPE html>
<html>
<head>
<title>Demo</title>
</head>
<body>
  <header style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 20px; text-align: center;">
    <h1 style="margin: 0; font-size: 42px; letter-spacing: -2px;">Render Engine</h1>
    <p style="margin: 8px 0 0; font-size: 16px; opacity: 0.9;">Motor propio en canvas</p>
  </header>

  <section style="padding: 20px;">
    <h2>Flexbox</h2>
    <div style="display: flex; gap: 12px; margin-top: 12px;">
      <div style="flex: 1; background: #0a84ff; color: white; padding: 16px; border-radius: 10px; text-align: center;">
        <strong>Azul</strong>
      </div>
      <div style="flex: 1; background: #30d158; color: white; padding: 16px; border-radius: 10px; text-align: center;">
        <strong>Verde</strong>
      </div>
      <div style="flex: 1; background: #ff9f0a; color: white; padding: 16px; border-radius: 10px; text-align: center;">
        <strong>Naranja</strong>
      </div>
    </div>
  </section>

  <section style="padding: 20px;">
    <h2>Bordes y sombras</h2>
    <div style="display: flex; gap: 12px; margin-top: 12px;">
      <div style="flex: 1; border: 3px solid #0a84ff; border-radius: 12px; padding: 20px; text-align: center;">
        Sólido
      </div>
      <div style="flex: 1; border: 3px dashed #ff453a; border-radius: 12px; padding: 20px; text-align: center;">
        Dashed
      </div>
    </div>
  </section>

  <section style="padding: 20px;">
    <h2>Texto</h2>
    <p>Esto es un párrafo normal. Con <strong>negrita</strong>, <em>cursiva</em>, <a href="https://example.com">un enlace</a> y texto <span style="color: #ff375f;">de color</span>.</p>
    <ul>
      <li>Primer elemento</li>
      <li>Segundo elemento</li>
      <li>Tercer elemento</li>
    </ul>
  </section>

  <footer style="background: #1c1c1e; color: #8e8e93; padding: 20px; text-align: center; font-size: 13px;">
    iOS Remastered · RenderEngine
  </footer>
</body>
</html>
`;

export const SAMPLE_CSS = `
body { font-family: system-ui, -apple-system, sans-serif; margin: 0; color: #1c1c1e; background: #f5f5f7; }
h1, h2 { color: inherit; }
a { color: #0a84ff; }
`;

export {
  HTMLParser, CSSParser, StyleEngine, LayoutEngine, PaintEngine,
  hitTest, parseSelector, matchesSelector, specificity,
  parseColor, parseNumber, decodeEntities,
};
