# Craft · 静态物料后台

纯静态（HTML + 原生 JS）物料 / 分组管理后台，数据存仓库里的 JSON，改动先缓存在浏览器，确认后一次性 commit 提交。

## 功能

- **分组树**：不限层级，可自定义「末级分组」；末级分组才挂物料档案；未指定分组的物料归入固定的「未分组」；节点可拖拽调整层级与顺序（拖到节点中部=成为子级，上/下边缘=同级排序，空白处=移到根级）
- **物料档案**：物料编码（按「年月日 + 四位流水号」自动生成，不可手改）、名称、物料属性（末级分组定义的字段，每个物料各自填值）、位置（云端淡绿点/本地灰点）、最近编辑时间；列表不显示内部 ID；在哪个分组下新增就进哪个分组，弹窗不再重复选分组
- **分组管理**（统一一个「保存」按钮）
  1. 分组属性（名称/排序/是否末级/描述）
  2. 本级属性值（直接父级定义的字段，在本组填值；整组一份，不进物料档案）
  3. 继承的属性（更高层分组已填好的值，只读显示，带「来自 X」标识）
  4. 字段定义：非末级分组 = 给下级分组添加属性（下级自动继承）；末级分组 = 物料属性（进入物料档案的列和表单）；可选「关联属性集合」实时复用一整套字段，也可「脱离关联」复制成本组自有字段
- **复制分组**（分组管理右侧 ⧉）：连同子分组一起复制到指定层级（默认原层级），名称可改；可选「仅分组数据」或「分组数据 + 物料档案」。分组数据含名称/描述/排序/末级标记/属性字段/整组属性值；带物料时物料生成新编码（当天流水号顺延），全部落草稿
- **系统设置**：
  - 字典设置：字典 = 选项库（显示名 + 存储值），「下拉单选 / 单选 / 多选」类型属性直接引用字典，改一次所有引用字段一起生效；被引用的字典不允许删除
  - 属性集合：一整套属性模板，供分组管理关联（一个分组最多关联一个集合；关联字段只读，只能在集合里改）。关联时**替换**本组原有字段并清理这些字段已填的值（分组属性值 + 物料属性值），保存前会弹窗列明影响范围并要求确认；清理只写草稿，提交前可丢弃
- **批量操作**：勾选后批量转移分组（含转移到「未分组」）、批量删除
- **Excel**：按当前分组导出（含子分组全部物料），列只有「物料编码 / 物料名称 / 各属性列 / 分组」；按物料编码自然排序；多级分组合并为一列「分组」用 `\` 分隔（如 `父级1\子级1`），分组为空即未分组；不导出内部 ID、位置、时间、创建人/修改人等内部状态；改完再导入，按「物料编码」匹配更新，Excel 里为空的属性保留原值，分组路径自动解析/创建，改过分组的物料会落到新分组
- **统一提交**：右侧竖排操作列 + 顶部「提交管理(N)」，勾选改动 → 一个 Git commit → 清空已提交草稿；仓库设置（Owner/Repo/Branch）也在这个页面
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
data/dictionaries.json        字典（选项库）数据
data/attrSets.json            属性集合数据
```

## 数据结构

```json
// categories.json
[{ "id":"c_x", "name":"成品", "parentId":null, "isLeaf":false, "sort":0, "desc":"",
   "attrSetId":"set_x",
   "attrs":[{"key":"section","label":"标称截面","type":"select","dictId":"dict_x","required":false}],
   "attrValues":{"section":"35"} }]
// 生效字段 = 关联集合的 attrs + 本组 attrs（同名 key 本组覆盖）
// 字段的 dictId 指向字典；options 由字典实时解析出来
// 物料的 categoryId 为空字符串 '' 表示「未分组」

// dictionaries.json
[{ "id":"dict_x", "name":"标称截面", "items":[{"value":"35","label":"35平方"}] }]

// attrSets.json（一整套属性模板，供多个分组关联复用）
[{ "id":"set_x", "name":"电缆通用属性",
   "attrs":[{"key":"voltage","label":"电压","type":"number"},{"key":"use","label":"用途","type":"text"}] }]

// materials.json（attrs 只存末级分组的生效字段值，每个物料各自一份）
[{ "id":"m_x", "categoryId":"c_leaf", "code":"202610270001", "name":"110kV 配电变压器",
   "attrs":{}, "location":"cloud", "syncedAt":"2026-10-26T...",
   "createdAt":"...", "updatedAt":"...", "createdBy":"", "updatedBy":"" }]
```

## 本地运行

```bash
python -m http.server 8080
# 浏览器打开 http://localhost:8080
```

## 提交流程

1. 右上角「提交管理(N)」→ 确认 Owner / Repo / Branch → 填入 Fine-grained PAT（本仓库 Contents: Read and write）
2. 勾选要提交的改动 → 填写说明 → 提交
3. 一次 commit 写入 `data/categories.json` / `materials.json` / `dictionaries.json` / `attrSets.json`（有变化的才写），已提交草稿自动清空
