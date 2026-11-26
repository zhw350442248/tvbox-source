// 网络层：直连 + 环境变量代理（HTTPS_PROXY/HTTP_PROXY）隧道，跨平台
const net = require('net');
const tls = require('tls');
const { URL } = globalThis;

function decodeBody(buf, headers) {
  const te = (headers['transfer-encoding'] || '').toLowerCase();
  if (te.includes('chunked')) {
    let out = Buffer.alloc(0), pos = 0;
    while (pos < buf.length) {
      const eol = buf.indexOf('\r\n', pos);
      if (eol < 0) break;
      const size = parseInt(buf.slice(pos, eol).toString().trim(), 16);
      if (!size || isNaN(size)) break;
      out = Buffer.concat([out, buf.slice(eol + 2, eol + 2 + size)]);
      pos = eol + 2 + size + 2;
    }
    return out.toString('utf8');
  }
  const cl = parseInt(headers['content-length'], 10);
  if (!isNaN(cl)) return buf.slice(0, cl).toString('utf8');
  return buf.toString('utf8');
}

function parseHead(head) {
  const lines = head.split('\r\n');
  const status = parseInt((lines[0] || '').split(' ')[1], 10) || 0;
  const headers = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { status, headers };
}

function proxyOf(u) {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!p) return null;
  try { return new URL(p); } catch { return null; }
}

function viaProxy(target, timeout) {
  const u = new URL(target);
  const proxy = proxyOf(target);
  const port = u.port || (u.protocol === 'https:' ? 443 : 80);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fin = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const sock = net.connect(Number(proxy.port) || 8080, proxy.hostname, () => {
      sock.write(`CONNECT ${u.hostname}:${port} HTTP/1.1\r\nHost: ${u.hostname}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    });
    const timer = setTimeout(() => { sock.destroy(); fin(reject, new Error('timeout')); }, timeout);

    let head = '';
    const onData = (d) => {
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        clearTimeout(timer); sock.destroy();
        return fin(reject, new Error('proxy: ' + head.split('\r\n')[0]));
      }
      let tlsSock;
      const onTls = () => {
        tlsSock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\n` +
          `User-Agent: okhttp/3.15\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`
        );
      };
      if (u.protocol === 'https:') {
        tlsSock = tls.connect({ socket: sock, servername: u.hostname, rejectUnauthorized: false }, onTls);
      } else {
        tlsSock = sock;
        onTls();
      }
      let raw = Buffer.alloc(0);
      tlsSock.on('data', c => { raw = Buffer.concat([raw, c]); });
      tlsSock.on('end', () => {
        clearTimeout(timer);
        const sep = raw.indexOf('\r\n\r\n');
        if (sep < 0) return fin(reject, new Error('bad response'));
        const { status, headers } = parseHead(raw.slice(0, sep).toString('latin1'));
        if (status !== 200) return fin(reject, new Error('HTTP ' + status));
        fin(resolve, decodeBody(raw.slice(sep + 4), headers));
      });
      tlsSock.on('error', e => { clearTimeout(timer); fin(reject, e); });
    };
    sock.on('data', onData);
    sock.on('error', e => { clearTimeout(timer); fin(reject, e); });
  });
}

async function requestText(target, timeout = 10000) {
  if (proxyOf(target)) return viaProxy(target, timeout);
  const mod = target.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.get(target, {
      headers: { 'User-Agent': 'okhttp/3.15', 'Accept': '*/*', 'Accept-Encoding': 'identity' },
      timeout,
      rejectUnauthorized: false,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

module.exports = { requestText, proxyOf };
