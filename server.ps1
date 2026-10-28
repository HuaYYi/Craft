﻿# Craft 系统本地静态服务
#
# 用法：由「启动.bat」调用，不要直接双击本文件
# 关闭运行本脚本的窗口即停止服务
#
# 说明：用 Windows 自带的 HttpListener，不需要 Node / Python

$ErrorActionPreference = 'Stop'

$root   = $PSScriptRoot
$port   = 8765
$prefix = "http://localhost:$port/"
$url    = "http://localhost:$port"

# ---------- 启动监听 ----------
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  # 端口已被占用（服务大概率已在运行）：直接打开页面
  Write-Host "端口 $port 已被占用，可能服务已在运行，直接打开页面。" -ForegroundColor Yellow
  Start-Process $url
  Start-Sleep -Seconds 2
  exit 0
}

# ---------- 资源类型 ----------
$mime = @{
  '.html'  = 'text/html; charset=utf-8'
  '.js'    = 'text/javascript; charset=utf-8'
  '.css'   = 'text/css; charset=utf-8'
  '.json'  = 'application/json; charset=utf-8'
  '.svg'   = 'image/svg+xml'
  '.png'   = 'image/png'
  '.jpg'   = 'image/jpeg'
  '.jpeg'  = 'image/jpeg'
  '.gif'   = 'image/gif'
  '.ico'   = 'image/x-icon'
  '.woff'  = 'font/woff'
  '.woff2' = 'font/woff2'
}

Write-Host ""
Write-Host "  Craft 系统运行中：$url" -ForegroundColor Green
Write-Host "  关闭本窗口即停止服务" -ForegroundColor DarkGray
Write-Host ""

Start-Process $url

# ---------- 请求循环 ----------
while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }

  try {
    $path = $ctx.Request.Url.LocalPath
    if ($path -eq '/') { $path = '/index.html' }
    $file = Join-Path $root ($path.TrimStart('/') -replace '/', '\')

    # 只允许访问项目目录内的文件
    $full = [System.IO.Path]::GetFullPath($file)
    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      $ctx.Response.StatusCode = 403
    }
    elseif (Test-Path $full -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $type  = $mime[[System.IO.Path]::GetExtension($full).ToLower()]
      if ($type) { $ctx.Response.ContentType = $type }
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    else {
      $ctx.Response.StatusCode = 404
    }
  } catch {
    try { $ctx.Response.StatusCode = 500 } catch { }
  } finally {
    try { $ctx.Response.Close() } catch { }
  }
}