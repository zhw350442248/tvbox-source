# 交互式写入 GitHub PAT 并当场校验（格式 / 有效性 / scope）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\set-token.ps1
$ErrorActionPreference = 'Stop'
$file = "$env:USERPROFILE\.gh_token"

Write-Host ''
Write-Host '=== 写入 GitHub Token ===' -ForegroundColor Cyan
Write-Host '提示：先在 GitHub 页面点复制 token，再回到这里粘贴（Ctrl+V），然后回车'
Write-Host ''

$tk = Read-Host -Prompt '粘贴 token'
$tk = ($tk -as [string]).Trim()

if (-not $tk) { Write-Host '[x] 没读到内容' -ForegroundColor Red; exit 1 }

# 常见粘贴事故：把整条命令当 token 粘进来
if ($tk -match '\s' -or $tk -match 'Set-Content|Read-Host|ghp_你的') {
  Write-Host '[x] 这不是 token，看起来是命令文本或占位符' -ForegroundColor Red
  Write-Host '    正确做法：只粘贴 ghp_ 开头的那 40 个字符' -ForegroundColor Yellow
  exit 1
}

if ($tk -notmatch '^gh[opsu]_[A-Za-z0-9]{36,}$') {
  Write-Host "[x] 格式不对：长度 $($tk.Length)，应以 ghp_ / github_pat_ 开头，共 40 字符左右" -ForegroundColor Red
  Write-Host "    你输入的: $($tk.Substring(0,[Math]::Min(12,$tk.Length)))..." -ForegroundColor Yellow
  exit 1
}

Write-Host '[1/2] 校验 token 有效性...'
try {
  $r = Invoke-WebRequest -Uri 'https://api.github.com/user' -Headers @{
    Authorization = "token $tk"
    Accept        = 'application/vnd.github+json'
    'User-Agent'  = 'tvbox-setup'
  } -UseBasicParsing -TimeoutSec 25
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 401) {
    Write-Host '[x] 401 Bad credentials —— token 串不对（多半是复制时漏字符或多了空格）' -ForegroundColor Red
    Write-Host '    回 GitHub 删掉这个 token，重新生成一个再复制' -ForegroundColor Yellow
  } elseif ($code -eq 403) {
    Write-Host '[x] 403 —— 可能是出口 IP 被限流，稍等再试；token 本身通常没问题' -ForegroundColor Red
  } else {
    Write-Host "[x] 请求失败 HTTP $code : $($_.Exception.Message)" -ForegroundColor Red
  }
  exit 1
}

$me = $r.Content | ConvertFrom-Json
Write-Host "      ✓ 认证通过，账号: $($me.login)" -ForegroundColor Green

$scopes = ''
try {
  $scopes = [string]($r.Headers['x-oauth-scopes'])
} catch { $scopes = '' }
Write-Host "      scopes: $(if($scopes){$scopes}else{'(未返回，fine-grained token 正常)'})"

$missing = @()
if ($scopes) {
  if ($scopes -notmatch 'repo') { $missing += 'repo' }
  if ($scopes -notmatch 'workflow') { $missing += 'workflow' }
}
if ($missing.Count -gt 0) {
  Write-Host "[!] 缺少 scope: $($missing -join ', ')" -ForegroundColor Yellow
  if ($missing -contains 'workflow') {
    Write-Host '    没有 workflow 时，推送 .github/workflows/rebuild.yml 会被 GitHub 拒绝。' -ForegroundColor Yellow
    Write-Host '    建议删掉重生成，记得勾 workflow；也可以先跑推送，失败了我再处理。' -ForegroundColor Yellow
  }
}

Write-Host '[2/2] 写入凭证文件...'
[IO.File]::WriteAllText($file, $tk, [Text.UTF8Encoding]::new($false))
Write-Host "      ✓ 已写入 $file" -ForegroundColor Green

Write-Host ''
Write-Host '=== 完成，可以推送了 ===' -ForegroundColor Cyan
Write-Host '下一步二选一：'
Write-Host '  1) 回我一句「好了」，我来推'
Write-Host '  2) 自己跑：.\push.cmd tvbox-source'
Write-Host ''
