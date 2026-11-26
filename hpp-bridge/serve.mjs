#!/usr/bin/env node
/**
 * 本地跑 Worker：不用 Cloudflare 账号，先在局域网里把 TVBox 打通
 *
 *   node serve.mjs
 *   PORT=8787 node serve.mjs
 *
 * 然后 TVBox 配置里写：
 *   http://<本机局域网IP>:8787/api.php/provide/vod?p=4kav
 *
 * 自检：
 *   http://127.0.0.1:8787/plugins
 */
import http from 'node:http';
import os from 'node:os';
import worker from './dist/worker.mjs';

const PORT = Number(process.env.PORT || 8787);

function lanIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) out.push({ name, ip: n.address });
    }
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = `http://${host}${req.url}`;
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const rq = new Request(url, {
      method: req.method,
      headers: req.headers,
      body,
    });
    const resp = await worker.fetch(rq);
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(resp.status, headers);
    const buf = Buffer.from(await resp.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 0, msg: String(e && e.message || e) }));
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Worker 本地已启动，监听 0.0.0.0:${PORT}\n`);
  console.log('自检：');
  console.log(`  http://127.0.0.1:${PORT}/plugins`);
  console.log(`  http://127.0.0.1:${PORT}/api.php/provide/vod?ac=list&p=4kav\n`);
  console.log('TVBox / 影视仓里填（用下面任一局域网 IP）：');
  for (const { name, ip } of lanIPs()) {
    console.log(`  [${name}]  http://${ip}:${PORT}/api.php/provide/vod?p=4kav`);
  }
  console.log('\nWindows 防火墙若拦截，管理员 PowerShell 执行一次：');
  console.log(`  New-NetFirewallRule -DisplayName "tvbox-hpp" -Direction Inbound -Protocol TCP -LocalPort ${PORT} -Action Allow`);
  console.log('\nCtrl+C 停止');
});
