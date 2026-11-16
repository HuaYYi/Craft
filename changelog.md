# 改动说明

基于 origin/main 31ec0d5。

## API 额度显示（头像环 + 菜单详情）
- assets/js/github.js：quota 状态、trackQuota()（解析 x-ratelimit-limit/remaining/reset 头）、getQuota()/onQuota()、429 中文提示
- assets/js/app.js：mountQuotaPill() 渲染头像环与菜单额度块；注意 SVG 的 className 只读，用 setAttribute('class', ...)
- admin.html：头像内嵌 SVG 环（#quotaRing / #quotaRingFill）；下拉菜单新增额度块（#quotaAmount / #quotaFill / #quotaFoot）
- assets/css/admin.css：.quota-ring 三档配色（≥30% 蓝 / 10%~30% 琥珀 / <10% 红）、.quota-block 样式；.avatar 改 flex 居中 + position:relative

## 登录页错误提示
- assets/js/login.js：401 → 账号无效或已过期；fetch 失败 → 连不上 GitHub 接口（原因）

## 本地运行
Windows 双击 `启动.bat`（server.ps1 起本地 HTTP），不要直接双击 html。
