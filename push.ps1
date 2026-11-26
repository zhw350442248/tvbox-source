# 把本目录推送到 GitHub，并给出订阅地址
# 用法:
#   $env:GH_TOKEN='ghp_xxx'; .\push.ps1 -Repo 你的用户名/tvbox-source
#   .\push.ps1 -Repo 你的用户名/tvbox-source -Token ghp_xxx -Private
param(
  [Parameter(Mandatory = $true)][string]$Repo,          # user/repo
  [string]$Token = $env:GH_TOKEN,
  [switch]$Private,
  [switch]$Force,
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

token 生成页：https://github.com/settings/tokens
  classic token      -> 勾 repo（私有仓再勾 workflow）
  fine-grained token -> 选该仓库 + Contents: Read and write + Workflows: Read and write
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
try {
  $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $api -TimeoutSec 20
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  throw "token 校验失败 HTTP $code（401=token 无效/过期，403=权限不足或限流）: $($_.Exception.Message)"
}
Write-Host "      登录身份: $($me.login)"
if ($owner -ne $me.login) { Write-Host "      目标属主 $owner 与 token 属主 $($me.login) 不同，组织仓需对应写权限" }

Write-Host "[2/5] 创建/确认仓库 $Repo"
$repoReady = $false
try {
  $body = @{ name = $name; private = [bool]$Private; description = $Description; auto_init = $false } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $api -Body $body -ContentType 'application/json' -TimeoutSec 30
  Write-Host "      已创建: $($r.html_url)"
  $repoReady = $true
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 422) {
    Write-Host "      仓库已存在，继续推送"
    $repoReady = $true
  } else {
    Write-Host "      API 建仓失败 HTTP $code，改为手动模式："
    Write-Host "      打开 https://github.com/new 建一个空仓库 $name（不要勾 README/.gitignore），然后重跑本脚本"
    Write-Host "      推送地址仍为 https://github.com/$Repo.git"
  }
}

$cloneUrl = "https://github.com/$Repo.git"

Write-Host "[3/5] 初始化本地仓库"
Push-Location $dir
try {
  if (-not (Test-Path '.git')) { git init -b $Branch 2>&1 | Out-Null }
  git config user.name  "tvbox-bot"
  git config user.email "tvbox-bot@users.noreply.github.com"
  git config core.autocrlf true
  $readme = Join-Path $dir 'README.md'
  if (Test-Path $readme) {
    $txt = [IO.File]::ReadAllText($readme, [Text.Encoding]::UTF8)
    if ($txt -match 'GITHUB_USER') {
      [IO.File]::WriteAllText($readme, ($txt -replace 'GITHUB_USER', $owner), [Text.UTF8Encoding]::new($false))
      Write-Host "      README 订阅地址已替换为 $owner"
    }
  }
  git add -A
  $status = @(git status --porcelain)
  if ($status.Count -gt 0) {
    git commit -q -m "chore: 更新 TVBox 配置"
    Write-Host "      已提交 $($status.Count) 个文件变更"
  } else {
    Write-Host "      无变更需要提交"
  }
  git branch -M $Branch

  Write-Host "[4/5] 推送"
  $pushUrl = "https://x-access-token:$Token@github.com/$Repo.git"
  git remote remove origin 2>$null
  git remote add origin $cloneUrl
  $pushArgs = @('push', $pushUrl, "HEAD:$Branch")
  if ($Force) { $pushArgs += '--force' }
  & git @pushArgs 2>&1 | ForEach-Object { if ($_ -match 'error|fatal') { Write-Host "      $_" } }
  if ($LASTEXITCODE -ne 0) {
    throw "推送失败。远端已有提交时加 -Force 覆盖：.\push.ps1 -Repo $Repo -Force"
  }
  git branch --set-upstream-to="origin/$Branch" 2>$null | Out-Null
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

每日自动重建：
  仓库 Settings -> Actions -> General -> Workflow permissions 选 "Read and write permissions"
  然后 Actions 页确认 "rebuild-tvbox-config" 已启用（cron 每天 UTC 19:30 跑）

加 CF Worker 中转版：
  1) CF Dashboard 建 Worker，粘贴 cf-worker-proxy.js，Deploy
  2) 仓库 Settings -> Secrets and variables -> Actions -> Variables
     New repository variable: WORKER_HOST = 你的.workers.dev
  3) Actions 页 Run workflow 一次，仓库会多出 tvbox-config-proxy.json
"@
} finally {
  Pop-Location
}
