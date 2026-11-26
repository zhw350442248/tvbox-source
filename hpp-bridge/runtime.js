/**
 * HPP 插件运行时 shim —— 让 hghub-plugins 的 HPP 1.0 插件能在 TVBox / drpy 里跑
 *
 * HPP 插件用到的宿主 API 面（从 21 个插件里实测归纳）：
 *   hg.http.fetch({url, headers, responseType, timeoutMs, retry, maxBytes, signal}) -> {ok, status, data}
 *   hg.html.parse(html) -> doc，doc.select(css) / doc.first(css) / el.attr(k) / el.text()
 *   hg.codec.base64Decode / base64Encode / utf8
 *   hg.PluginError(code, msg, extra)
 *   hg.endpoint.current.url
 *   hg.storage（星芽短剧用）
 *
 * 本文件只用纯 JS，不依赖 DOM / Node API，QuickJS 可直接跑。
 */

/* ------------------------------------------------------------------ *
 * 1. HTML 解析（树）
 * ------------------------------------------------------------------ */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

const ENTITY = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019', middot: '\u00b7',
};

function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    const v = ENTITY[body.toLowerCase()];
    return v == null ? all : v;
  });
}

function parseAttrs(raw) {
  const attrs = {};
  if (!raw) return attrs;
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const k = m[1].toLowerCase();
    const v = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
    attrs[k] = decodeEntities(v);
  }
  return attrs;
}

function makeEl(tag, attrs, parent) {
  return { tag: tag.toLowerCase(), attrs: attrs || {}, children: [], parent: parent || null };
}

function parseHTML(html) {
  const src = String(html == null ? '' : html);
  const root = makeEl('#root', {}, null);
  const stack = [root];
  let textBuf = '';
  let i = 0;
  const n = src.length;

  const flush = () => {
    if (!textBuf) return;
    const parent = stack[stack.length - 1];
    parent.children.push({ tag: '#text', text: decodeEntities(textBuf), parent });
    textBuf = '';
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { textBuf += src.slice(i); break; }
    if (lt > i) textBuf += src.slice(i, lt);

    // 注释
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    // 结束标签
    if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt);
      if (gt < 0) { textBuf += src.slice(lt); break; }
      const tag = src.slice(lt + 2, gt).trim().toLowerCase().split(/\s+/)[0];
      flush();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) { stack.length = k; break; }
      }
      i = gt + 1;
      continue;
    }
    // <!doctype / <?xml
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const gt = src.indexOf('>', lt);
      i = gt < 0 ? n : gt + 1;
      continue;
    }

    // 开始标签
    const head = /^<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/.exec(src.slice(lt, lt + 8000));
    if (!head) { textBuf += '<'; i = lt + 1; continue; }

    const tagName = head[1].toLowerCase();
    const attrs = parseAttrs(head[2]);
    const selfClose = head[3] === '/' || VOID.has(tagName);
    flush();

    const el = makeEl(tagName, attrs, stack[stack.length - 1]);
    stack[stack.length - 1].children.push(el);
    i = lt + head[0].length;

    if (selfClose) continue;

    // script / style / textarea / title 内部不解析标签
    if (RAW.has(tagName)) {
      const closeRe = new RegExp('</' + tagName + '\\s*>', 'i');
      const rest = src.slice(i);
      const cm = closeRe.exec(rest);
      const inner = cm ? rest.slice(0, cm.index) : rest;
      if (inner) el.children.push({ tag: '#text', text: tagName === 'textarea' || tagName === 'title' ? decodeEntities(inner) : inner, parent: el });
      i = cm ? i + cm.index + cm[0].length : n;
      continue;
    }

    stack.push(el);
  }
  flush();
  return root;
}

/* ------------------------------------------------------------------ *
 * 2. CSS 选择器（子集：后代 / 子代 / 并集 / tag / .class / #id / [attr] / [attr=v]）
 * ------------------------------------------------------------------ */
function parseSelector(sel) {
  // 返回 [[ {tag, id, classes, attrs, comb} ... ] ...]，外层是并集
  return String(sel).split(',').map((part) => {
    const tokens = part.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
    const steps = [];
    let comb = ' ';
    for (const t of tokens) {
      if (t === '>') { comb = '>'; continue; }
      const step = { tag: '', id: '', classes: [], attrs: [], comb };
      const re = /([#.]?[\w-]+|\[[^\]]*\])/g;
      let m;
      while ((m = re.exec(t))) {
        const tk = m[1];
        if (tk[0] === '.') step.classes.push(tk.slice(1));
        else if (tk[0] === '#') step.id = tk.slice(1);
        else if (tk[0] === '[') {
          const am = /^\[([\w:-]+)(?:[*^$]?=\s*"?([^"\]]*)"?)?\]$/.exec(tk);
          if (am) step.attrs.push({ name: am[1].toLowerCase(), value: am[2] });
        } else if (tk !== '*') step.tag = tk.toLowerCase();
      }
      steps.push(step);
      comb = ' ';
    }
    return steps;
  }).filter((s) => s.length);
}

function matchStep(el, step) {
  if (!el || el.tag === '#text' || el.tag === '#root') return false;
  if (step.tag && el.tag !== step.tag) return false;
  if (step.id && el.attrs.id !== step.id) return false;
  for (const c of step.classes) {
    const cls = (el.attrs.class || '').split(/\s+/);
    if (cls.indexOf(c) < 0) return false;
  }
  for (const a of step.attrs) {
    if (!(a.name in el.attrs)) return false;
    if (a.value != null && a.value !== '' && el.attrs[a.name] !== a.value) return false;
  }
  return true;
}

function descendants(el, out) {
  for (const c of el.children) {
    if (c.tag === '#text') continue;
    out.push(c);
    descendants(c, out);
  }
  return out;
}

function selectAll(root, selector) {
  const groups = parseSelector(selector);
  const result = [];
  const seen = new Set();
  for (const steps of groups) {
    // 逐级求交集
    let current = [root];
    for (const step of steps) {
      const next = [];
      for (const base of current) {
        const pool = step.comb === '>' && steps.indexOf(step) > 0
          ? base.children.filter((c) => c.tag !== '#text')
          : descendants(base, []);
        for (const el of pool) {
          if (matchStep(el, step)) next.push(el);
        }
      }
      current = next;
      if (!current.length) break;
    }
    for (const el of current) {
      if (!seen.has(el)) { seen.add(el); result.push(el); }
    }
  }
  return result;
}

function elText(el) {
  if (!el) return '';
  if (el.tag === '#text') return el.text || '';
  let s = '';
  for (const c of el.children) s += elText(c);
  return s;
}

function wrapEl(el) {
  const api = {
    tag: el.tag,
    attrs: el.attrs,
    attr(name) { return el.attrs[String(name).toLowerCase()]; },
    text() { return elText(el).replace(/\s+/g, ' ').trim(); },
    html() { return serialize(el); },
    first(sel) { const l = selectAll(el, sel); return l.length ? wrapEl(l[0]) : null; },
    select(sel) { return selectAll(el, sel).map(wrapEl); },
    find(sel) { return selectAll(el, sel).map(wrapEl); },
    parent() { return el.parent && el.parent.tag !== '#root' ? wrapEl(el.parent) : null; },
    children() { return el.children.filter((c) => c.tag !== '#text').map(wrapEl); },
    _el: el,
  };
  return api;
}

function serialize(el) {
  if (el.tag === '#text') return el.text || '';
  if (el.tag === '#root') return el.children.map(serialize).join('');
  const a = Object.entries(el.attrs || {}).map(([k, v]) => ` ${k}="${v}"`).join('');
  return `<${el.tag}${a}>${el.children.map(serialize).join('')}</${el.tag}>`;
}

function parseHtmlDoc(html) {
  const root = parseHTML(html);
  return {
    select(sel) { return selectAll(root, sel).map(wrapEl); },
    first(sel) { const l = selectAll(root, sel); return l.length ? wrapEl(l[0]) : null; },
    root: wrapEl(root),
  };
}

/* ------------------------------------------------------------------ *
 * 3. codec
 * ------------------------------------------------------------------ */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Decode(str) {
  const s = String(str || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const out = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=') break;
    const v = B64.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out;
}

function base64Encode(bytes) {
  const arr = bytes || [];
  let out = '';
  for (let i = 0; i < arr.length; i += 3) {
    const a = arr[i], b = arr[i + 1], c = arr[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b || 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c || 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 3b. 哈希（MD5 / SHA1 / SHA256）—— 纯 JS 同步实现
 * ------------------------------------------------------------------ */
function rol32(n, c) { return (n << c) | (n >>> (32 - c)); }
function ror32(n, c) { return (n >>> c) | (n << (32 - c)); }

function padMsg(bytes, little) {
  const msg = Array.from(bytes);
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  const byteAt = (n) => Math.floor(bitLen / Math.pow(2, 8 * n)) & 0xff;
  if (little) {
    for (let i = 0; i < 8; i++) msg.push(i < 4 ? byteAt(i) : 0);
  } else {
    for (let i = 7; i >= 0; i--) msg.push(byteAt(i));
  }
  return msg;
}

function md5(bytes) {
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const msg = padMsg(bytes, true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = msg[off + i * 4] | (msg[off + i * 4 + 1] << 8) | (msg[off + i * 4 + 2] << 16) | (msg[off + i * 4 + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D;
      D = C; C = B;
      B = (B + rol32((A + F + K[i] + M[g]) | 0, S[i])) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = [];
  for (const v of [a0, b0, c0, d0]) for (let i = 0; i < 4; i++) out.push((v >>> (8 * i)) & 0xff);
  return out;
}

function sha1(bytes) {
  const msg = padMsg(bytes, false);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const W = new Int32Array(80);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
    }
    for (let i = 16; i < 80; i++) W[i] = rol32(W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (rol32(a, 5) + f + e + k + W[i]) | 0;
      e = d; d = c; c = rol32(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = [];
  for (const v of [h0, h1, h2, h3, h4]) for (let i = 0; i < 4; i++) out.push((v >>> (24 - 8 * i)) & 0xff);
  return out;
}

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256(bytes) {
  const msg = padMsg(bytes, false);
  let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const W = new Int32Array(64);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = ror32(W[i - 15], 7) ^ ror32(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = ror32(W[i - 2], 17) ^ ror32(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ror32(e, 6) ^ ror32(e, 11) ^ ror32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + W[i]) | 0;
      const S0 = ror32(a, 2) ^ ror32(a, 13) ^ ror32(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = [];
  for (const v of H) for (let i = 0; i < 4; i++) out.push((v >>> (24 - 8 * i)) & 0xff);
  return out;
}

function hexEncode(bytes) {
  let s = '';
  const arr = bytes || [];
  for (let i = 0; i < arr.length; i++) s += (arr[i] & 0xff).toString(16).padStart(2, '0');
  return s;
}

function hexDecode(str) {
  const s = String(str || '').replace(/[^0-9a-fA-F]/g, '');
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}

/* ------------------------------------------------------------------ *
 * 3c. AES（CBC 解密 + PKCS7）
 * ------------------------------------------------------------------ */
const SBOX = (() => {
  const s = new Array(256);
  const inv = new Array(256);
  // 用数学构造 S-box，避免手抄 256 个常量出错
  let p = 1, q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    s[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  for (let i = 0; i < 256; i++) inv[s[i]] = i;
  return { s, inv };
})();

function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }
function mul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
}

function expandKey(key) {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = [];
  for (let i = 0; i < nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  const rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w[i - 1].slice();
    if (i % nk === 0) {
      t = [t[1], t[2], t[3], t[0]].map((b) => SBOX.s[b]);
      t[0] ^= rcon[(i / nk) - 1];
    } else if (nk > 6 && i % nk === 4) {
      t = t.map((b) => SBOX.s[b]);
    }
    w.push(w[i - nk].map((b, j) => b ^ t[j]));
  }
  return { w, nr };
}

function decryptBlock(block, w, nr) {
  let s = block.slice();
  const addRK = (r) => {
    for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) s[4 * c + k] ^= w[4 * r + c][k];
  };
  addRK(nr);
  for (let r = nr - 1; r >= 1; r--) {
    // InvShiftRows
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) s[4 * ((c + k) % 4) + k] = t[4 * c + k];
    // InvSubBytes
    for (let i = 0; i < 16; i++) s[i] = SBOX.inv[s[i]];
    addRK(r);
    // InvMixColumns
    for (let c = 0; c < 4; c++) {
      const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
      s[4 * c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
      s[4 * c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
      s[4 * c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
      s[4 * c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
    }
  }
  // 最后一轮：只有 InvShiftRows / InvSubBytes / AddRK
  const t = s.slice();
  for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) s[4 * ((c + k) % 4) + k] = t[4 * c + k];
  for (let i = 0; i < 16; i++) s[i] = SBOX.inv[s[i]];
  addRK(0);
  return s;
}

function aesDecryptCbc(key, iv, data) {
  const { w, nr } = expandKey(key);
  const out = [];
  let prev = iv.slice(0, 16);
  for (let off = 0; off < data.length; off += 16) {
    const block = data.slice(off, off + 16);
    if (block.length < 16) break;
    const dec = decryptBlock(block, w, nr);
    for (let i = 0; i < 16; i++) out.push(dec[i] ^ prev[i]);
    prev = block;
  }
  // PKCS7 去填充
  if (out.length) {
    const pad = out[out.length - 1];
    if (pad > 0 && pad <= 16 && pad <= out.length) out.length -= pad;
  }
  return out;
}

function aesDecrypt(opts, data) {
  const o = opts || {};
  const key = Array.from(o.key || []);
  let iv = o.iv ? Array.from(o.iv) : null;
  const bytes = Array.from(data || []);
  const mode = String(o.mode || 'cbc').toLowerCase();
  if (!iv) iv = new Array(16).fill(0);
  if (mode !== 'cbc') {
    // ECB：每块 IV 为 0
    const out = [];
    const { w, nr } = expandKey(key);
    for (let off = 0; off < bytes.length; off += 16) {
      const dec = decryptBlock(bytes.slice(off, off + 16), w, nr);
      for (const b of dec) out.push(b);
    }
    if (out.length) {
      const pad = out[out.length - 1];
      if (pad > 0 && pad <= 16 && pad <= out.length) out.length -= pad;
    }
    return out;
  }
  return aesDecryptCbc(key, iv, bytes);
}

const CRYPTO = {
  digest(algo, data) {
    const bytes = typeof data === 'string' ? utf8Encode(data) : Array.from(data || []);
    const a = String(algo || 'md5').toLowerCase();
    if (a === 'md5') return md5(bytes);
    if (a === 'sha1') return sha1(bytes);
    if (a === 'sha256') return sha256(bytes);
    throw new Error('unsupported digest: ' + algo);
  },
  aesDecrypt,
  randomUUID() {
    const h = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
      else if (i === 14) s += '4';
      else if (i === 19) s += h[((Math.random() * 4) | 0) + 8];
      else s += h[(Math.random() * 16) | 0];
    }
    return s;
  },
};

function utf8Encode(str) {
  const out = [];
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function utf8Decode(bytes) {
  const b = Array.from(bytes || []);
  let out = '';
  for (let i = 0; i < b.length;) {
    const c = b[i++];
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0xe0) out += String.fromCharCode(((c & 31) << 6) | (b[i++] & 63));
    else if (c < 0xf0) out += String.fromCharCode(((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63));
    else {
      const cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. hg 宿主对象
 * ------------------------------------------------------------------ */
class PluginError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'PluginError';
    this.code = code || 'PLUGIN_ERROR';
    this.extra = extra;
  }
}

/**
 * @param {object} opts
 * @param {(req:{url:string, headers?:object, method?:string, body?:any, timeoutMs?:number}) => Promise<{status:number, ok:boolean, data:any, text?:string}>} opts.http
 *        宿主 HTTP 实现（TVBox 传 request 包装，Node 传 fetch 包装）
 * @param {object} [opts.endpoint]  {current:{url}} 或 {list:[]}
 * @param {object} [opts.storage]   get/set 接口
 */
function createHg(opts) {
  const httpImpl = opts.http;
  const store = {
    _m: {},
    _exp: {},
    async get(k) {
      if (store._exp[k] && Date.now() > store._exp[k]) { delete store._m[k]; delete store._exp[k]; return undefined; }
      return store._m[k];
    },
    async set(k, v, o) {
      store._m[k] = v;
      if (o && o.ttlSec) store._exp[k] = Date.now() + o.ttlSec * 1000;
      return true;
    },
    async remove(k) { delete store._m[k]; delete store._exp[k]; return true; },
    async clear() { store._m = {}; store._exp = {}; return true; },
  };
  const storage = opts.storage || store;
  const settings = opts.settings || {
    _s: {},
    get(k, d) { return k in this._s ? this._s[k] : d; },
    set(k, v) { this._s[k] = v; },
    all() { return Object.assign({}, this._s); },
  };

  const hg = {
    PluginError,
    endpoint: opts.endpoint || { current: { url: opts.site || '' }, list() { return []; } },
    storage,
    settings,
    html: { parse: parseHtmlDoc },
    codec: {
      base64Decode,
      base64Encode,
      hexEncode,
      hexDecode,
      utf8Encode,
      utf8Decode,
      utf8: { encode: utf8Encode, decode: utf8Decode },
    },
    crypto: CRYPTO,
    http: {
      async fetch(req) {
        const r = await httpImpl({
          url: req.url,
          headers: req.headers,
          method: req.method || 'GET',
          body: req.body,
          timeoutMs: req.timeoutMs || 15000,
        });
        const ok = r.ok != null ? r.ok : r.status >= 200 && r.status < 300;
        let data = r.data;
        if (data === undefined) {
          const text = r.text != null ? r.text : '';
          if (req.responseType === 'json') {
            try { data = JSON.parse(text); } catch { data = null; }
          } else data = text;
        }
        return { ok, status: r.status || 0, data, headers: r.headers || {} };
      },
    },
  };
  return hg;
}

/* ------------------------------------------------------------------ *
 * 5. 导出
 * ------------------------------------------------------------------ */
module.exports = { createHg, PluginError, parseHTML, parseHtmlDoc, selectAll, base64Decode, base64Encode };
