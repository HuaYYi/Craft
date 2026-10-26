# Craft · 静态物料后台

纯静态（HTML + 原生 JS）物料 / 分组管理后台，数据存仓库里的 JSON，改动先缓存在浏览器，确认后一次性 commit 提交。

## 功能

- **分组树**：不限层级，可自定义「末级分组」；末级分组才挂物料档案；未指定分组的物料归入固定的「未分组」；节点可拖拽调整层级与顺序（拖到节点中部=成为子级，上/下边缘=同级排序，空白处=移到根级）
- **物料档案**：物料编码、名称、物料属性（末级分组定义的字段，每个物料各自填值）、位置（云端淡绿点/本地灰点）、最近编辑时间；在哪个分组下新增就进哪个分组，弹窗不再重复选分组
- **分组管理**（统一一个「保存」按钮）
  1. 分组属性（名称/排序/是否末级/描述）
  2. 继承的属性（上级定义的字段，在本组填值；整组一份，不进物料档案；上级没有则不显示）
  3. 字段定义：非末级分组 = 给下级分组添加属性（下级自动继承，在各自分组管理里填值）；末级分组 = 物料属性（进入物料档案的列和表单，每个物料各自填值）
- **批量操作**：勾选后批量转移分组（含转移到「未分组」）、批量删除
- **Excel**：按当前分组导出（含子分组全部物料）；多级分组合并为一列「分组」用 `/` 分隔（如 `父级1/子级1`），分组为空即未分组；不导出属性列——导出只锁定分组路径，属性在页面里维护，避免导出后被改出「同分组不同属性值」的坏数据；改完再导入，按「物料编码」匹配更新，分组路径自动解析/创建，改过分组的物料会落到新分组
- **统一提交**：右侧竖排操作列 + 顶部「提交管理(N)」，勾选改动 → 一个 Git commit → 清空已提交草稿
- **PAT 只在内存**，刷新即失效，不写 localStorage

## 目录

```
index.html                    入口
assets/css/admin.css          样式
assets/js/config.js           默认仓库配置 / 字段类型 / 位置枚举
assets/js/store.js            IndexedDB 草稿缓存
assets/js/github.js           Git Data API（blobs → tree → commit → ref）
assets/js/categories.js       分组树构建 / 路径 / 属性继承
assets/js/excel.js            Excel 导入导出（SheetJS）
assets/js/fields.js           动态表单渲染与校验
assets/js/ui.js               Toast / Modal / confirm
assets/js/app.js              页面编排
assets/vendor/xlsx.full.min.js  SheetJS（本地内置，离线可用）
data/categories.json          分组数据
data/materials.json           物料数据
```

## 数据结构

```json
// categories.json
[{ "id":"c_x", "name":"成品", "parentId":null, "isLeaf":false, "sort":0, "desc":"",
   "attrs":[{"key":"voltage","label":"电压等级","type":"select","options":["110kV","220kV"],"required":false}],
   "attrValues":{"voltage":"110kV"} }]
// 物料的 categoryId 为空字符串 '' 表示「未分组」

// materials.json（attrs 只存末级分组定义的字段值，每个物料各自一份）
[{ "id":"m_x", "categoryId":"c_leaf", "code":"120201501", "name":"110kV 配电变压器",
   "attrs":{}, "location":"cloud", "syncedAt":"2026-10-26T...",
   "createdAt":"...", "updatedAt":"...", "createdBy":"", "updatedBy":"" }]
```

## 本地运行

```bash
python -m http.server 8080
# 浏览器打开 http://localhost:8080
```

## 提交流程

1. 「设置」页确认 Owner / Repo / Branch
2. 右上角「提交管理(N)」→ 填入 Fine-grained PAT（本仓库 Contents: Read and write）
3. 勾选要提交的改动 → 填写说明 → 提交
4. 一次 commit 写入 `data/categories.json` 与 `data/materials.json`，已提交草稿自动清空
