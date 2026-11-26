/**
 * HPP → 苹果CMS V10 协议适配 Worker
 *
 * 把 hghub-plugins 的 HPP 1.0 插件包装成 TVBox type:1 能吃的 CMS 采集接口。
 * TVBox 侧只需要一条 api：https://<your-worker>/api.php/provide/vod
 *
 * 路由：
 *   /api.php/provide/vod?ac=list                     首页 + 分类
 *   /api.php/provide/vod?ac=detail&t=<tid>&pg=<page> 分类列表
 *   /api.php/provide/vod?ac=detail&wd=<kw>&pg=<page> 搜索
 *   /api.php/provide/vod?ac=detail&ids=<id>          详情
 *   /play?p=<plugin>&id=<episodeId>                  播放跳转（302 到代理）
 *   /proxy?u=<encoded>&r=<referer>                   流代理（补 Referer/UA）
 *
 * 部署：
 *   npm i -D esbuild && node build.mjs     -> dist/worker.js
 *   CF Dashboard → Workers → 新建 → 粘贴 -> Deploy
 */
import { createHg } from './runtime.js';
import { PLUGINS } from './plugins.generated.js';

const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 11; M2007J3SC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const PAGE_SIZE = 20;

/* ---------------- 宿主 HTTP（Worker fetch） ---------------- */
async function httpImpl(req) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs || 15000);
  try {
    const res = await fetch(req.url, {
      method: req.method || 'GET',
      headers: req.headers || {},
      body: req.body,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return { ok: res.ok, status: res.status, data, text, headers: Object.fromEntries(res.headers) };
  } catch (e) {
    return { ok: false, status: 0, text: '', err: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 插件实例缓存 ---------------- */
const instances = new Map();

function getPlugin(id) {
  if (instances.has(id)) return instances.get(id);
  const p = PLUGINS[id];
  if (!p) throw new Error('unknown plugin: ' + id);
  const site = (p.meta && p.meta.site) || '';
  const hg = createHg({
    http: httpImpl,
    site,
    endpoint: { current: { url: site }, list: () => [{ id: 'main', label: '主站', url: site }] },
  });
  const inst = p.factory(hg);
  instances.set(id, { meta: p.meta, inst });
  return instances.get(id);
}

/* ---------------- 结构转换 ---------------- */
function mediaToVod(m) {
  return {
    vod_id: m.id,
    vod_name: m.title || '',
    vod_pic: m.cover || '',
    vod_remarks: m.remarks || '',
    type_name: m.type || '',
  };
}

function epKey(pluginId, episodeId) {
  return pluginId + '|' + episodeId;
}

function splitEpKey(k) {
  const i = k.indexOf('|');
  return i < 0 ? ['', k] : [k.slice(0, i), k.slice(i + 1)];
}

/* ---------------- CMS 响应 ---------------- */
function cmsList(items, page, total, classes) {
  const body = {
    code: 1,
    msg: '数据列表',
    page,
    pagecount: total > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : page + 1,
    limit: String(PAGE_SIZE),
    total: total || items.length,
    list: items.map(mediaToVod),
  };
  if (classes && classes.length) body.class = classes;
  return body;
}

async function cmsDetail(pluginId, ids, origin) {
  const { inst } = getPlugin(pluginId);
  let detail;
  try {
    detail = await inst.media.getDetail({ id: ids });
  } catch (e) {
    // 上游改版 / 无分集时，返回基本条目而不是让整个接口 500
    return {
      list: [{
        vod_id: ids,
        vod_name: String(ids).split('/').filter(Boolean).pop() || String(ids),
        vod_pic: '',
        vod_content: '（该站暂无可用分集：' + String(e && e.message || e) + '）',
        vod_play_from: '',
        vod_play_url: '',
      }],
    };
  }
  const playlists = detail.playlists || [];
  const froms = [];
  const urls = [];
  for (let i = 0; i < playlists.length; i++) {
    const pl = playlists[i];
    froms.push(pl.label || ('线路' + (i + 1)));
    const eps = (pl.episodes || []).map((ep) => {
      const name = ep.label || String(ep.episodeNumber || ep.index || '');
      const link = origin + '/play?p=' + encodeURIComponent(pluginId) + '&id=' + encodeURIComponent(epKey(pluginId, ep.id));
      return name + '$' + link;
    });
    urls.push(eps.join('#'));
  }
  return {
    list: [{
      vod_id: detail.id,
      vod_name: detail.title || '',
      vod_pic: detail.cover || '',
      vod_content: detail.description || '',
      type_name: detail.type || '',
      vod_year: detail.year || '',
      vod_area: detail.area || '',
      vod_remarks: detail.remarks || '',
      vod_play_from: froms.join('$$$'),
      vod_play_url: urls.join('$$$'),
    }],
  };
}

/* ---------------- 播放 / 代理 ---------------- */
async function handlePlay(url) {
  const p = url.searchParams.get('p') || '';
  const key = url.searchParams.get('id') || '';
  const [, episodeId] = splitEpKey(key);
  const pluginId = p || splitEpKey(key)[0];
  const { inst } = getPlugin(pluginId);
  const result = await inst.media.resolvePlayback({ episodeId });
  const stream = (result.streams || [])[0];
  if (!stream) return json({ error: 'no stream' }, 502);

  const hdr = stream.headers || {};
  const referer = hdr.Referer || hdr.referer || '';
  const ua = hdr['User-Agent'] || hdr['user-agent'] || '';
  const proxied = new URL(url.origin + '/proxy');
  proxied.searchParams.set('u', stream.url);
  if (referer) proxied.searchParams.set('r', referer);
  if (ua) proxied.searchParams.set('a', ua);
  return Response.redirect(proxied.toString(), 302);
}

async function handleProxy(url) {
  const target = url.searchParams.get('u');
  if (!target) return new Response('missing u', { status: 400 });
  const referer = url.searchParams.get('r') || '';
  const ua = url.searchParams.get('a') || DEFAULT_UA;

  const headers = { 'User-Agent': ua, Accept: '*/*' };
  if (referer) headers.Referer = referer;

  const res = await fetch(target, { headers, redirect: 'follow' });
  const ct = res.headers.get('content-type') || '';
  const isM3u8 = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(target);

  if (!isM3u8) {
    // ts / mp4 直接透传
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': ct || 'application/octet-stream', 'access-control-allow-origin': '*' },
    });
  }

  // m3u8 里的相对分片地址要重写成代理地址
  const text = await res.text();
  const base = new URL(target);
  const toProxy = (rel) => {
    const abs = new URL(rel, base).toString();
    const q = new URL(url.origin + '/proxy');
    q.searchParams.set('u', abs);
    if (referer) q.searchParams.set('r', referer);
    if (ua) q.searchParams.set('a', ua);
    return q.toString();
  };
  const rewritten = text.split('\n').map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) {
      // 处理 #EXT-X-KEY 里的 URI
      if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) {
        return line.replace(/URI="([^"]+)"/, (_, u) => 'URI="' + toProxy(u) + '"');
      }
      return line;
    }
    return toProxy(t);
  }).join('\n');

  return new Response(rewritten, {
    status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*' },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}

/* ---------------- 主入口 ---------------- */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/play') return await handlePlay(url);
      if (path === '/proxy') return await handleProxy(url);

      // 插件清单，方便调试
      if (path === '/plugins') {
        return json(Object.keys(PLUGINS).map((id) => ({
          id,
          name: PLUGINS[id].meta.name,
          mature: !!PLUGINS[id].meta.mature,
        })));
      }

      // 整份 TVBox 配置：api 按当前请求的 Host 动态生成，本地 / CF 都能直接用
      if (path === '/config' || path === '/tvbox-config.json') {
        const origin = url.origin;
        const all = Object.entries(PLUGINS).map(([id, p]) => ({
          key: 'hpp_' + id,
          name: (p.meta.mature ? '🔞' : '') + p.meta.name,
          type: 1,
          api: origin + '/api.php/provide/vod?p=' + id,
          searchable: 1,
          quickSearch: 1,
          filterable: 0,
          ext: '',
          group: p.meta.mature ? '🔞18+' : '影视',
        }));
        const adult = all.filter((s) => s.group === '🔞18+');
        const normal = all.filter((s) => s.group !== '🔞18+');
        return json({
          spider: '',
          wallpaper: '',
          logo: '',
          sites: [...adult, ...normal],
          lives: [],
          rules: [],
          ads: ['mimg.0c1q0l.cn', 'www.163.com', 'pic1.zhimg.com'],
          flags: ['youku', 'qq', 'iqiyi', 'qiyi', 'letv', 'sohu', 'mgtv', 'bilibili'],
          ijk: [{ group: '软解码', options: [{ category: 4, name: 'mediacodec', value: '1' }] }],
          doh: [{ name: 'AliDNS', url: 'https://dns.alidns.com/dns-query', ips: ['223.5.5.5', '223.6.6.6'] }],
        });
      }

      if (!/\/api\.php\/provide\/vod$/.test(path)) {
        return json({ code: 0, msg: 'not found', hint: 'use /api.php/provide/vod' }, 404);
      }

      const ac = (url.searchParams.get('ac') || 'list').toLowerCase();
      // 单站模式：?p=<pluginId>；不传则用全部插件的前缀路由 /p/<id>/api.php/provide/vod
      const pm = /^\/p\/([^/]+)\/api\.php\/provide\/vod$/.exec(path);
      const pluginId = url.searchParams.get('p') || (pm ? pm[1] : '') || '';

      if (!pluginId) {
        // 无 p 参数：只列插件，交给 TVBox 当分类用（可选）
        return json(cmsList([], 1, 0, Object.keys(PLUGINS).map((id) => ({
          type_id: id,
          type_name: PLUGINS[id].meta.name,
        }))));
      }

      const { inst } = getPlugin(pluginId);
      const pg = parseInt(url.searchParams.get('pg') || '1', 10) || 1;

      if (ac === 'list' || ac === 'videolist') {
        const cats = await inst.catalog.getCategories();
        const classes = (cats || []).map((c) => ({ type_id: c.id, type_name: c.label }));
        const first = url.searchParams.get('t');
        if (!first) {
          return json(cmsList([], 1, 0, classes));
        }
        const r = await inst.catalog.list({ categoryId: first, cursor: String(pg) });
        return json(cmsList(r.items || [], pg, (r.items || []).length, classes));
      }

      if (ac === 'detail') {
        const ids = url.searchParams.get('ids');
        const wd = url.searchParams.get('wd') || url.searchParams.get('key') || '';
        if (ids) {
          const body = await cmsDetail(pluginId, decodeURIComponent(ids), url.origin);
          return json(body);
        }
        if (wd) {
          const r = await inst.search.search({ query: wd, cursor: String(pg) });
          return json(cmsList(r.items || [], pg, (r.items || []).length));
        }
        const t = url.searchParams.get('t');
        const r = t
          ? await inst.catalog.list({ categoryId: t, cursor: String(pg) })
          : await inst.search.search({ query: '', cursor: String(pg) });
        return json(cmsList(r.items || [], pg, (r.items || []).length));
      }

      return json({ code: 0, msg: 'unsupported ac=' + ac }, 400);
    } catch (e) {
      return json({ code: 0, msg: String(e && e.message || e) }, 500);
    }
  },
};
