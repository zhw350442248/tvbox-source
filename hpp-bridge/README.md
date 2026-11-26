# hghub-plugins → TVBox 整合

## 为什么不能直接合并

两个仓库是两套协议，实测确认：

| | zhw350442248/tvbox-source | CoderL98/hghub-plugins |
|---|---|---|
| 形态 | TVBox `config.json` | HPP 1.0 单文件 JS 插件 |
| 站点类型 | `type:1`，苹果CMS采集接口 | `export default function(hg)`，宿主注入 `hg.*` |
| 请求 | `?ac=list` / `?ac=detail&wd=` | `hg.http.fetch` + `hg.html.parse` |
| 宿主 | TVBox / 影视仓 / Fongmi | HGhub App（QuickJS） |
| 依赖 | 无，纯 JSON | `hg.http` / `hg.html` / `hg.crypto` / `hg.storage` |

TVBox 的 `type:3` 是 Spider 模式，无论 Jar 还是 Js，都靠客户端 spider 包反射生成解析类。
所以 HPP 插件不能改两行 JSON 就进 TVBox。

另外实测：21 个插件的 42 个上游 origin，**0 个**开着苹果CMS采集接口（都是 HTML 蜘蛛或自定义 App 接口）。

## 两条落地路线

### 路线 A：Worker 转 CMS（覆盖全部 21 个插件）

把 HPP 插件的五个域映射成苹果CMS协议，TVBox 里就是普通 `type:1`，不依赖任何 spider 包。

```
catalog.getCategories  →  ?ac=list   的 class
catalog.list           →  ?ac=detail&t=&pg=
search.search          →  ?ac=detail&wd=&pg=
media.getDetail        →  ?ac=detail&ids=  的 vod_play_from / vod_play_url
media.resolvePlayback  →  /play  302 到 /proxy
```

构建：

```bash
node build.mjs
# 产出 dist/worker.js (约 222 KB) + dist/tvbox-hpp.json
```

部署：

1. CF Dashboard → Workers & Pages → 创建 Worker
2. 把 `dist/worker.js` 全文粘进编辑器 → Deploy
3. 拿到 `https://xxx.workers.dev`
4. `WORKER_HOST=xxx.workers.dev node build.mjs` 重新生成 `dist/tvbox-hpp.json`
5. TVBox 里加站点，或直接把 `tvbox-hpp.json` 当配置地址

TVBox 站点条目长这样：

```json
{
  "key": "hpp_4kav",
  "name": "4k-av",
  "type": 1,
  "api": "https://xxx.workers.dev/api.php/provide/vod?p=4kav",
  "searchable": 1,
  "quickSearch": 1,
  "filterable": 0,
  "group": "影视"
}
```

路由：

```
/api.php/provide/vod?p=<插件id>&ac=list              分类
/api.php/provide/vod?p=<插件id>&ac=detail&t=&pg=     列表
/api.php/provide/vod?p=<插件id>&ac=detail&wd=&pg=    搜索
/api.php/provide/vod?p=<插件id>&ac=detail&ids=       详情
/play?p=<插件id>&id=<集id>                           播放跳转
/proxy?u=<url>&r=<referer>                           流代理（补 Referer/UA，重写 m3u8 分片）
/plugins                                             插件清单
```

### 路线 B：CI 探测 CMS（零部署）

`hghub-scan.js` 从 hghub-plugins 拉插件、提取上游域名，试苹果CMS常见落点，
命中的直接并进 `tvbox-config.json`。GitHub Actions 的 runner 在海外，连通性比墙内好。

`rebuild.js` 已接好，默认开启：

```bash
node rebuild.js                      # 含 HPP 探测
HPP=0 node rebuild.js                # 关掉
HPP_CONC=8 HPP_TIMEOUT=8000 node rebuild.js
```

## 运行时实现（runtime.js）

HPP 插件依赖的宿主 API 全部用纯 JS 实现，不依赖 DOM / Node / Web Crypto，
QuickJS 和 Workers 都能跑：

- `hg.http.fetch` — 包装宿主 HTTP
- `hg.html.parse` — 自写 HTML 树 + CSS 选择器（后代 / 子代 / 并集 / tag / .class / #id / [attr]）
- `hg.codec` — base64 / hex / utf8
- `hg.crypto.digest` — MD5 / SHA1 / SHA256（同步，已对 Node crypto 逐字节校验）
- `hg.crypto.aesDecrypt` — AES-CBC / ECB + PKCS7（已对 NIST SP800-38A 向量校验）
- `hg.crypto.randomUUID`、`hg.storage`（带 TTL）、`hg.settings`、`hg.PluginError`、`hg.endpoint`

## 实测结果

本机（无代理，境外站直连不稳）跑 `p=<id>` 全链路：

| 插件 | 列表 | 详情 | 线路 | 集数 |
|---|---|---|---|---|
| 4kav | 42 | 200 | 默认 | 1 |
| wwgz | 30 | 200 | xiguam3u8 | 1 |
| apple | 20 | 200 | 默认 | 1 |
| jpyy | 30 | 200 | 默认 | 1 |
| hdmoli | 40 | 200 | — | 0（站点已转网盘，分集区没了） |

其余：`saohuo`/`hjkk`/`xiaohys`/`aowu`/`tiantian` 报 `HTTP 0`（本机连不上），
`anfuns`/`jdys` 接口通但该分类空，`xingya` 上游登录结构变化。

上游站会改版、会换域名（`hdmoli.pro` → `www.hdmoli.com`），插件本身也需要跟着更新。
桥接层不修上游，只保证插件能跑；插件里的域名过期了要改插件或覆盖 `endpoint.current.url`。

## 不做的部分

不存任何音视频内容，全部指向第三方站点。
