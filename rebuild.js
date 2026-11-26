#!/usr/bin/env node
/**
 * TVBox 源整合 · 一键重建（跨平台，GitHub Actions 与本地通用）
 *
 *   node rebuild.js                        # 拉源 -> 测活 -> 生成可用版/全量版
 *   node rebuild.js --all                  # 额外生成全量版（默认也生成）
 *   WORKER_HOST=abc.workers.dev node rebuild.js   # 额外生成 CF Worker 中转版
 *   CONC=12 TIMEOUT=8000 node rebuild.js   # 调并发与超时
 *
 * 产出：tvbox-config.json / tvbox-config-full.json / tvbox-config-proxy.json(可选) / report.json
 */
const fs = require('fs');
const { requestText } = require('./net');

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CONC = Number(process.env.CONC || 8);
const TIMEOUT = Number(process.env.TIMEOUT || 10000);
const WORKER_HOST = process.env.WORKER_HOST || '';

const SOURCES = [
  ['hafrey1', 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/main/LunaTV-config.json'],
  ['hafrey1-jsd', 'https://cdn.jsdelivr.net/gh/hafrey1/LunaTV-config@main/LunaTV-config.json'],
  ['cunhappy', 'https://raw.githubusercontent.com/cunhappy/LunaTV-config/main/LunaTV-config.json'],
  ['Asterism', 'https://gitea.com/Asterism/LunaTV-config/raw/branch/main/LunaTV-config.json'],
  ['hafrey1-jin18', 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/main/jin18.txt'],
  ['hafrey1-jingjian', 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/main/jingjian.txt'],
];

function b58decode(s) {
  s = s.trim();
  let n = 0n;
  for (const ch of s) {
    const i = A.indexOf(ch);
    if (i < 0) throw new Error('非 Base58 字符: ' + ch);
    n = n * 58n + BigInt(i);
  }
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  const b = Buffer.from(h, 'hex');
  let z = 0;
  for (const ch of s) { if (ch === '1') z++; else break; }
  return Buffer.concat([Buffer.alloc(z), b]).toString('utf8');
}

function parseConfig(text) {
  const t = text.trim().replace(/^\uFEFF/, '');
  if (t.startsWith('{')) return JSON.parse(t);
  return JSON.parse(b58decode(t));
}

function normHost(api) {
  try {
    const m = /[?&]url=([^&]+)/.exec(api);
    return new URL(m ? decodeURIComponent(m[1]) : api).host.toLowerCase();
  } catch { return api; }
}

async function probe(api) {
  const url = api + (api.includes('?') ? '&' : '?') + 'ac=list';
  try {
    const text = await requestText(url, TIMEOUT);
    const j = JSON.parse(text);
    const total = Number(j.total) || 0;
    const n = Array.isArray(j.list) ? j.list.length : 0;
    return { ok: total > 0 || n > 0, total, note: n > 0 || total > 0 ? 'ok' : 'empty' };
  } catch (e) {
    return { ok: false, total: 0, note: e.message || 'error' };
  }
}

async function fetchMerge() {
  const merged = { cache_time: 7200, api_site: {} };
  const seen = new Set();
  const stat = [];
  for (const [name, url] of SOURCES) {
    try {
      const cfg = parseConfig(await requestText(url, TIMEOUT));
      const sites = cfg.api_site || {};
      let added = 0;
      for (const [key, v] of Object.entries(sites)) {
        const h = normHost(v.api);
        if (seen.has(h)) continue;
        seen.add(h);
        merged.api_site[key] = v;
        added++;
      }
      stat.push({ source: name, total: Object.keys(sites).length, added });
      console.log(`  源 ${name.padEnd(18)} ${Object.keys(sites).length} 站, 新增 ${added}`);
    } catch (e) {
      stat.push({ source: name, error: e.message });
      console.log(`  源 ${name.padEnd(18)} 失败: ${e.message}`);
    }
  }
  return { merged, stat };
}

async function probeAll(merged) {
  const entries = Object.entries(merged.api_site);
  const rows = new Array(entries.length);
  let i = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < entries.length) {
      const idx = i++;
      const [key, v] = entries[idx];
      const r = await probe(v.api);
      rows[idx] = { key, name: v.name, api: v.api, detail: v.detail || '', ...r };
    }
    if (i && i % 20 === 0) process.stdout.write(`  测活 ${i}/${entries.length}\r`);
  }));
  const ok = rows.filter(r => r.ok).length;
  console.log(`\n  测活完成: 可用 ${ok}/${rows.length}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return rows;
}

function makeKey(api) {
  let h;
  try {
    const m = /[?&]url=([^&]+)/.exec(api);
    h = new URL(m ? decodeURIComponent(m[1]) : api).host;
  } catch { h = 'x' + Math.random().toString(36).slice(2, 8); }
  return 'cms_' + h.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function buildSites(rows, mode) {
  const used = new Set();
  const uniq = (base) => { let k = base, n = 2; while (used.has(k)) k = base + '_' + n++; used.add(k); return k; };

  const byName = new Map();
  for (const r of rows) {
    if (mode === 'alive' && !r.ok) continue;
    const n = String(r.name).trim();
    const prev = byName.get(n);
    if (!prev || (r.ok && !prev.ok) || (r.ok === prev.ok && (r.total || 0) > (prev.total || 0))) byName.set(n, r);
  }

  const adult = [], normal = [];
  for (const r of [...byName.values()].sort((a, b) => (b.total || 0) - (a.total || 0))) {
    const s = {
      key: uniq(makeKey(r.api)),
      name: r.name,
      type: 1,
      api: r.api,
      searchable: 1,
      quickSearch: 1,
      filterable: 0,
      ext: '',
    };
    (/🔞/.test(r.name) ? adult : normal).push({ ...s, group: /🔞/.test(r.name) ? '🔞18+' : '影视' });
  }
  return { sites: [...adult, ...normal], adult: adult.length, normal: normal.length };
}

function makeConfig(sites) {
  return {
    spider: '',
    wallpaper: '',
    logo: '',
    sites,
    lives: [],
    rules: [],
    ads: ['mimg.0c1q0l.cn', 'www.163.com', 'pic1.zhimg.com', 'img.pconline.com.cn'],
    flags: ['youku', 'qq', 'iqiyi', 'qiyi', 'letv', 'sohu', 'tudou', 'pptv', 'mgtv', 'wasu', 'bilibili', 'renrenmi'],
    ijk: [{ group: '软解码', options: [{ category: 4, name: 'mediacodec', value: '1' }, { category: 4, name: 'mediacodec-hevc', value: '1' }] }],
    doh: [{ name: 'AliDNS', url: 'https://dns.alidns.com/dns-query', ips: ['223.5.5.5', '223.6.6.6'] }],
  };
}

function writeJson(f, obj) {
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
  console.log(`  -> ${f}  ${fs.statSync(f).size} bytes`);
}

(async () => {
  console.log('[1/3] 拉取并合并 LunaTV 源');
  const { merged, stat } = await fetchMerge();
  console.log(`  合并后 ${Object.keys(merged.api_site).length} 站（按主机去重）`);

  console.log('[2/3] 逐站测活');
  const rows = await probeAll(merged);

  console.log('[3/3] 生成配置');
  const a = buildSites(rows, 'alive');
  writeJson('tvbox-config.json', makeConfig(a.sites));
  console.log(`     可用版 ${a.sites.length} 站（🔞${a.adult} / 影视${a.normal}）`);

  const f = buildSites(rows, 'all');
  writeJson('tvbox-config-full.json', makeConfig(f.sites));
  console.log(`     全量版 ${f.sites.length} 站（🔞${f.adult} / 影视${f.normal}）`);

  if (WORKER_HOST) {
    const p = buildSites(rows, 'alive');
    p.sites.forEach(s => { s.api = 'https://' + WORKER_HOST + '/' + encodeURIComponent(s.api); });
    writeJson('tvbox-config-proxy.json', makeConfig(p.sites));
    console.log(`     中转版 ${p.sites.length} 站（经 ${WORKER_HOST}）`);
  }

  writeJson('report.json', {
    built_at: new Date().toISOString(),
    sources: stat,
    merged: Object.keys(merged.api_site).length,
    alive: rows.filter(r => r.ok).length,
    rows,
  });

  const alive = rows.filter(r => r.ok).length;
  console.log(`\n完成：合并 ${rows.length} 站，可用 ${alive} 站`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
