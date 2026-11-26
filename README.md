# TVBox 源整合配置

把 LunaTV / MoonTV 生态的苹果 CMS V10 采集接口（`api_site`）整合成 **TVBox 可直接导入的 config**，每日自动重建。

## 订阅地址

| 版本 | 地址 |
|---|---|
| 可用版（每站实测通过） | `https://raw.githubusercontent.com/zhw350442248/tvbox-source/main/tvbox-config.json` |
| 全量版（不筛活） | `https://raw.githubusercontent.com/zhw350442248/tvbox-source/main/tvbox-config-full.json` |
| 中转版（经 CF Worker） | `https://raw.githubusercontent.com/zhw350442248/tvbox-source/main/tvbox-config-proxy.json` |

raw.githubusercontent.com 被墙时换加速前缀：

```
https://gh-proxy.com/https://raw.githubusercontent.com/zhw350442248/tvbox-source/main/tvbox-config.json
https://cdn.jsdelivr.net/gh/zhw350442248/tvbox-source@main/tvbox-config.json
```

TVBox / 影视仓 / takagen99 / Fongmi：设置 → 配置地址 → 粘贴上面任一 URL。

## 怎么来的

1. 拉取多个 LunaTV 配置源（hafrey1 / cunhappy / Asterism / 精简版 / 精简+成人版）
2. 按 `api` 主机去重合并
3. 逐站请求 `?ac=list` 测活，记录 `total` 片量
4. 同名站保留片量大的那条，成人组 / 影视组分别按片量降序
5. 输出 `type: 1` 的 TVBox sites（纯 CMS JSON 接口，不依赖 spider.jar）

## 本地重建

```bash
node rebuild.js

# 走代理（本地直连被 RST 时）
HTTPS_PROXY=http://127.0.0.1:7890 node rebuild.js      # Linux/macOS
$env:HTTPS_PROXY='http://127.0.0.1:7890'; node rebuild.js   # Windows PowerShell

# 生成 CF Worker 中转版
WORKER_HOST=abc.workers.dev node rebuild.js

# 调并发 / 超时
CONC=12 TIMEOUT=8000 node rebuild.js
```

产出：

| 文件 | 内容 |
|---|---|
| `tvbox-config.json` | 只含实测可用站点 |
| `tvbox-config-full.json` | 全部合并站点 |
| `tvbox-config-proxy.json` | api 前缀改为 `<WORKER_HOST>/<encoded>`，需设置 `WORKER_HOST` |
| `report.json` | 每站测活明细（ok / total / 错误原因） |

## 自动重建

`.github/workflows/rebuild.yml` 每天 03:30（北京时间）跑一次：拉源 → 测活 → 生成 → commit。
也可在 Actions 页手动 `Run workflow`。

GitHub Actions 的 runner 在海外，成人 CMS 站可直连，实测可用率比墙内高。

## Cloudflare Worker 中转（可选）

盒子没法挂代理时用。`cf-worker-proxy.js` 粘到 CF Workers 里 Deploy，然后在仓库 Settings → Variables 加 `WORKER_HOST=你的.workers.dev`，workflow 会自动多生成一份 `tvbox-config-proxy.json`。

Worker 支持两种调用：

```
https://WORKER/<urlencode(目标api)>?ac=detail&wd=xxx     # 路径模式，TVBox 拼接不会打架
https://WORKER/?url=<urlencode(目标api)>&ac=detail&wd=xxx # 参数模式
```

## 说明

- `type: 1` = CMS JSON 直链，不需要 `spider.jar`，不涉及 jar 加载校验。
- 两个 http 明文站（`fhapi9.com`、`caiji.dyttzyapi.com`）在部分 Android 9+ 壳上会被 cleartext 拦截，需要的话删掉对应 sites 项。
- 源站域名和可用性天天变，靠 CI 每日重建维持；单站失效不影响整份配置。
- 本仓库只存配置，不存任何视频内容，全部链接指向第三方采集接口。
