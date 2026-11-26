#!/usr/bin/env node
/**
 * HPP 插件源扫描器
 *
 * hghub-plugins 里的东西是 HGhub（HPP 1.0）插件，不是 TVBox 源，
 * 两套协议不通用。但插件 meta 里写了上游站点域名，这些站点里
 * 有一部分本身就是苹果 CMS V10 站，只是没在插件里用 CMS 接口。
 *
 * 本脚本：拉 hghub-plugins → 逐个插件提取 linkDomains / SITE
 *        → 对每个 origin 试苹果CMS采集接口 → 命中就转成 TVBox type:1
 *
 *   node hghub-scan.js            # 打印探测表
 *   node hghub-scan.js --json     # 只输出 JSON（rebuild.js 用）
 *
 * 环境变量：
 *   HGHUB_REPO=CoderL98/hghub-plugins   上游仓库
 *   HGHUB_TAG=main                      分支/标签
 *   HPP_CONC=8                          并发
 *   HPP_TIMEOUT=8000                    单请求超时 ms
 *   HPP=0                               关掉（rebuild.js 里生效）
 */
const { requestText } = require('./net');

const REPO = process.env.HGHUB_REPO || 'CoderL98/hghub-plugins';
const TAG = process.env.HGHUB_TAG || 'main';
const CONC = Number(process.env.HPP_CONC || 8);
const HPP_TIMEOUT = Number(process.env.HPP_TIMEOUT || 8000);
const UA = 'Mozilla/5.0 (Linux; Android 11; M2007J3SC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

// 上游列表镜像，按顺序回退
const BASES = [
  `https://raw.githubusercontent.com/${REPO}/${TAG}`,
  `https://cdn.jsdelivr.net/gh/${REPO}@${TAG}`,
  `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO}/${TAG}`,
];

// 苹果CMS V10 采集接口常见落点
const CMS_PATHS = [
  '/api.php/provide/vod',
  '/provide/vod',
  '/api/provide/vod',
  '/api.php/provide/vod/at/json',
  '/vod/api.php/provide/vod',
  '/index.php/api/vod',
];

function get(pathname) {
  let lastErr;
  return (async () => {
    for (const b of BASES) {
      try { return await requestText(b + pathname, HPP_TIMEOUT, UA); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('mirror all failed');
  })();
}

function originOf(raw) {
  if (!raw) return '';
  const s = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  try { return new URL(s).origin; } catch { return ''; }
}

function metaOf(src) {
  const head = src.slice(0, 6000);
  const pick = (re) => (head.match(re) || [])[1] || '';
  const ld = (src.match(/linkDomains:\s*\[([^\]]*)\]/) || [])[1] || '';
  return {
    id: pick(/\bid:\s*'([^']+)'/),
    name: pick(/\bname:\s*'([^']+)'/),
    version: pick(/\bversion:\s*'([^']+)'/),
    mature: /\bmature:\s*true\b/.test(head),
    site: pick(/(?:const|let|var)\s+SITE\s*=\s*'([^']+)'/),
    linkDomains: [...ld.matchAll(/'([^']+)'/g)].map((m) => m[1]),
  };
}

async function probeList(origin) {
  // 首页都不通就直接放弃，省掉 6 次无效请求
  try {
    await requestText(origin + '/', HPP_TIMEOUT, UA);
  } catch (e) {
    // 首页非 200 也可能只是首页路由特殊，只有连不上才判定死站
    const m = String(e.message || '');
    if (/timeout|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|socket hang up/i.test(m)) {
      return { ok: false, dead: true, note: m };
    }
  }
  for (const p of CMS_PATHS) {
    const url = origin + p + '?ac=list';
    try {
      const txt = await requestText(url, HPP_TIMEOUT, UA);
      const j = JSON.parse(txt);
      const total = Number(j.total) || 0;
      const list = Array.isArray(j.list) ? j.list.length : 0;
      const cls = Array.isArray(j.class) ? j.class.length : 0;
      if (total > 0 || list > 0 || cls > 0) {
        return { ok: true, api: origin + p, total, list, class: cls };
      }
    } catch { /* 下一个路径 */ }
  }
  return { ok: false };
}

async function pool(items, worker, conc) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }));
  return out;
}

/** 扫描主入口：返回命中 CMS 接口的站点 */
async function scanHpp() {
  const manifest = JSON.parse(await get('/manifest.json'));
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  if (!plugins.length) throw new Error('manifest 里没有 plugins');

  // 拉每个插件的 JS，提取域名
  const metas = await pool(plugins, async (p) => {
    const file = /\.js$/.test(p.url) ? p.url : `plugins/${p.id}.js`;
    try {
      const src = await get('/' + file.replace(/^\//, ''));
      return { ...metaOf(src), listed: p };
    } catch (e) {
      return { id: p.id, name: p.name, mature: false, site: '', linkDomains: [], error: e.message };
    }
  }, CONC);

  // 汇总 origin，去重
  const originMap = new Map();
  for (const m of metas) {
    const os = [...new Set([originOf(m.site), ...m.linkDomains.map(originOf)].filter(Boolean))];
    m.origins = os;
    for (const o of os) {
      if (!originMap.has(o)) originMap.set(o, []);
      originMap.get(o).push(m.id);
    }
  }

  const origins = await pool([...originMap.keys()], async (o) => ({ origin: o, ...(await probeList(o)) }), CONC);

  const byOrigin = new Map(origins.map((r) => [r.origin, r]));
  const hits = [];
  for (const m of metas) {
    for (const o of m.origins || []) {
      const r = byOrigin.get(o);
      if (r && r.ok) {
        hits.push({
          id: m.id,
          name: m.name,
          mature: !!m.mature,
          origin: o,
          api: r.api,
          total: r.total,
        });
      }
    }
  }

  return { plugins: metas, origins, hits };
}

module.exports = { scanHpp };

if (require.main === module) {
  const jsonOnly = process.argv.includes('--json');
  scanHpp().then((r) => {
    if (jsonOnly) { console.log(JSON.stringify(r.hits, null, 2)); return; }
    console.log(`插件 ${r.plugins.length} 个，上游 origin ${r.origins.length} 个\n`);
    for (const r2 of r.origins.sort((a, b) => a.origin.localeCompare(b.origin))) {
      console.log(`  ${r2.origin.padEnd(40)} ${r2.ok ? '✅ ' + r2.api + `  total=${r2.total}` : '— 无CMS接口'}`);
    }
    console.log(`\n命中 ${r.hits.length} 条：`);
    for (const h of r.hits) console.log(`  ${h.mature ? '🔞' : '  '} ${h.id.padEnd(12)} ${h.name.padEnd(10)} ${h.api}  total=${h.total}`);
  }).catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
