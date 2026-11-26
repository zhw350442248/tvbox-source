/**
 * TVBox CMS 采集接口中转 Worker（Cloudflare Workers）
 *
 * 作用：盒子直连被墙/被 RST 的成人 CMS 站时，把请求经 CF 出口转发，
 *      盒子只需能连 Worker 域名（workers.dev 或自定义域）。
 *
 * 用法（路径模式，推荐）：
 *   api 填 https://YOUR-WORKER.workers.dev/https%3A%2F%2F91md.me%2Fapi.php%2Fprovide%2Fvod
 *   TVBox 自己拼 ?ac=detail&wd=xxx 时，Worker 自动透传给目标站。
 *
 * 用法（参数模式）：
 *   api 填 https://YOUR-WORKER.workers.dev/?url=https%3A%2F%2F91md.me%2Fapi.php%2Fprovide%2Fvod
 *
 * 部署：CF Dashboard -> Workers -> 新建 -> 粘贴本文件 -> Deploy
 */

const UA = 'okhttp/3.15';
const ALLOW = ['*']; // 收紧时改成具体域名白名单，如 ['91md.me','shayuapi.com']

export default {
  async fetch(request) {
    const u = new URL(request.url);

    let target = '';
    if (u.pathname.length > 1) {
      try { target = decodeURIComponent(u.pathname.slice(1)); } catch { target = ''; }
    }
    if (!target) target = u.searchParams.get('url') || '';
    if (!target) {
      return json({ code: 1, msg: 'usage: /<encoded-url> or /?url=<encoded-url>' }, 400);
    }

    let t;
    try { t = new URL(target); } catch { return json({ code: 1, msg: 'bad target url' }, 400); }
    if (ALLOW[0] !== '*' && !ALLOW.includes(t.host)) {
      return json({ code: 1, msg: 'host not allowed: ' + t.host }, 403);
    }

    // 透传除 url 外的所有 query（ac / wd / pg / t / ids ...）
    const qs = new URLSearchParams(u.search);
    qs.delete('url');
    const extra = qs.toString();
    const finalUrl = t.origin + t.pathname + (t.search ? t.search.slice(1) + (extra ? '&' + extra : '') : (extra ? '?' + extra : ''));

    const headers = {
      'User-Agent': UA,
      'Referer': t.origin + '/',
      'Accept': 'application/json, text/plain, */*',
    };

    let resp;
    try {
      resp = await fetch(finalUrl, { headers, redirect: 'follow', cf: { cacheTtl: 0 } });
    } catch (e) {
      return json({ code: 1, msg: 'upstream error: ' + e.message }, 502);
    }

    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: resp.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'x-upstream': t.host,
      },
    });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}
