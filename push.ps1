# 把本目录推送到 GitHub，并给出订阅地址
# 用法:
#   $env:GH_TOKEN='ghp_xxx'; .\push.ps1 -Repo 你的用户名/tvbox-source
#   .\push.ps1 -Repo 你的用户名/tvbox-source -Token ghp_xxx -Private
param(
  [Parameter(Mandatory = $true)][string]$Repo,          # user/repo
  [string]$Token = $env:GH_TOKEN,
  [switch]$Private,
  [string]$Branch = 'main',
  [string]$Description = 'TVBox 源整合配置 · LunaTV/MoonTV CMS 采集接口，每日自动重建'
)

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot

if (-not $Token) {
  Write-Host @'
缺少 token。二选一：
  1) 环境变量：$env:GH_TOKEN='ghp_xxx'
  2) 参数：    .\push.ps1 -Repo user/repo -Token ghp_xxx

token 在 https://github.com/settings/tokens 生成：
  classic token 勾 repo（要私有仓再加 workflow）
  fine-grained token 选该仓库 + Contents: Read and write + Workflows: Read and write
'@
  exit 2
}

if ($Repo -notmatch '/') { throw "Repo 必须是 user/repo 形式，当前: $Repo" }
$owner, $name = $Repo.Split('/', 2)
$api = @{
  Authorization          = "Bearer $Token"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = 'tvbox-push'
  'X-GitHub-Api-Version' = '2022-11-28'
}

Write-Host "[1/5] 校验 token"
$me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $api -TimeoutSec 20
Write-Host "      登录身份: $($me.login)"
if ($owner -ne $me.login) { Write-Host "      注意: 目标是 $owner，token 属主是 $($me.login)（组织仓需要对应权限）" }

Write-Host "[2/5] 创建/确认仓库 $Repo"
try {
  $body = @{ name = $name; private = [bool]$Private; description = $Description; auto_init = $false } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $api -Body $body -ContentType 'application/json' -TimeoutSec 30
  Write-Host "      已创建: $($r.html_url)"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 422) { Write-Host "      仓库已存在，继续推送" }
  else { throw "创建仓库失败 HTTP $code : $($_.Exception.Message)" }
}

$cloneUrl = "https://github.com/$Repo.git"

Write-Host "[3/5] 初始化本地仓库"
Push-Location $dir
try {
  if (-not (Test-Path '.git')) { git init -b $Branch 2>&1 | Out-Null }
  git config user.name  "tvbox-bot"
  git config user.email "tvbox-bot@users.noreply.github.com"
  git add -A
  $status = git status --porcelain
  if ($status) {
    git commit -m "feat: TVBox 源整合配置（可用版/全量版 + 每日自动重建）" 2>&1 | Out-Null
    Write-Host "      已提交 $($status.Count) 个文件变更"
  } else {
    Write-Host "      无变更需要提交"
  }
  git branch -M $Branch

  Write-Host "[4/5] 推送"
  $pushUrl = "https://x-access-token:$Token@github.com/$Repo.git"
  git remote remove origin 2>$null
  git remote add origin $cloneUrl
  git push $pushUrl "HEAD:$Branch" --force -q
  git branch --set-upstream-to="origin/$Branch" 2>$null
  Write-Host "      推送完成: https://github.com/$Repo"

  Write-Host "[5/5] 订阅地址"
  $raw = "https://raw.githubusercontent.com/$Repo/$Branch"
  Write-Host @"

可用版 (推荐)   $raw/tvbox-config.json
全量版          $raw/tvbox-config-full.json
测活明细        $raw/report.json

被墙时换加速前缀：
  https://gh-proxy.com/$raw/tvbox-config.json
  https://cdn.jsdelivr.net/gh/$Repo@$Branch/tvbox-config.json

每日自动重建：仓库 Actions 页确认 "rebuild-tvbox-config" 已启用
（Settings -> Actions -> General -> Workflow permissions 选 Read and write permissions）

想开 CF Worker 中转版：
  1) CF Dashboard 建 Worker，粘贴 cf-worker-proxy.js，Deploy
  2) 仓库 Settings -> Secrets and variables -> Actions -> Variables
     New variable: WORKER_HOST = 你的.workers.dev
  3) Actions 页手动 Run workflow 一次，会多出 tvbox-config-proxy.json
"@
} finally {
  Pop-Location
}
