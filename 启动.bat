@echo off
rem Craft 系统一键启动：起一个本地静态服务并打开浏览器
rem 关闭弹出的「Craft 服务」黑窗口即停止服务
chcp 65001 >nul
cd /d %~dp0

rem 已在运行则直接开页面，不重复起服务
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://localhost:8765/).StatusCode | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  start "" http://localhost:8765
  exit /b
)

start "Craft 服务" powershell -NoProfile -ExecutionPolicy Bypass -Command "$l=New-Object System.Net.HttpListener; $l.Prefixes.Add('http://localhost:8765/'); $l.Start(); Write-Host 'Craft 系统运行中：http://localhost:8765 （关闭本窗口即停止）'; $mime=@{'.html'='text/html; charset=utf-8';'.js'='text/javascript; charset=utf-8';'.css'='text/css; charset=utf-8';'.json'='application/json; charset=utf-8';'.png'='image/png';'.jpg'='image/jpeg';'.jpeg'='image/jpeg';'.gif'='image/gif';'.svg'='image/svg+xml';'.ico'='image/x-icon';'.woff'='font/woff';'.woff2'='font/woff2'}; while($l.IsListening){ try { $c=$l.GetContext(); $p=$c.Request.Url.LocalPath; if($p -eq '/'){ $p='/index.html' }; $f=Join-Path (Get-Location) ($p.TrimStart('/') -replace '/','\'); if(Test-Path $f -PathType Leaf){ $b=[System.IO.File]::ReadAllBytes($f); $t=$mime[[System.IO.Path]::GetExtension($f).ToLower()]; if($t){ $c.Response.ContentType=$t }; $c.Response.ContentLength64=$b.Length; $c.Response.OutputStream.Write($b,0,$b.Length) } else { $c.Response.StatusCode=404 } } catch {}; try { $c.Response.Close() } catch {} }"

timeout /t 1 /nobreak >nul
start "" http://localhost:8765
