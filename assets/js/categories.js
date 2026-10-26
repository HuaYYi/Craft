// 分组树工具：构建树、路径、继承属性
//
// 数据结构（data/categories.json 是扁平数组，靠 parentId 组树）：
// { id, name, parentId, isLeaf, sort, desc,
//   attrs: [{ key, label, type, options?, required? }] }
//
// 约定：
//   - categoryId 为空字符串 '' 表示「未分组」（虚拟节点，不入库）
//   - 非末级分组的 attrs = 给下级分组的字段定义（直接下级在「本级属性值」填值，值存各自 attrValues）
//   - 末级分组的 attrs = 物料属性（进物料档案的列和表单，值存每个物料的 attrs）
//   - 只有 isLeaf 的分组能挂物料
//   - 分组没有子分组时可以设为末级；有子分组时强制非末级

// ---------- 树 ----------
export function buildTree(categories) {
  const byId = new Map(categories.map(c => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortFn = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name, 'zh');
  const walk = (list) => {
    list.sort(sortFn);
    for (const n of list) walk(n.children);
  };
  walk(roots);
  return roots;
}

export function findCategory(categories, id) {
  return categories.find(c => c.id === id) || null;
}

// 分组路径（从根到自身）
export function categoryPath(categories, id) {
  const out = [];
  let cur = findCategory(categories, id);
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? findCategory(categories, cur.parentId) : null;
  }
  return out;
}

export function categoryPathNames(categories, id) {
  return categoryPath(categories, id).map(c => c.name);
}

export function categoryPathString(categories, id) {
  return categoryPathNames(categories, id).join(' / ');
}

// 所有后代 id（含自身）
export function selfAndDescendantIds(categories, id) {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of categories) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function childIds(categories, id) {
  return categories.filter(c => c.parentId === id).map(c => c.id);
}

// ---------- 属性继承 ----------
// 生效属性值 = 沿祖先链合并各分组的 attrValues（同名 key 子级覆盖父级）
// 分组属性是整个分组一份值，物料不单独填写，展示时从这里带出来
export function effectiveValues(categories, id) {
  const merged = {};
  for (const c of categoryPath(categories, id)) Object.assign(merged, c.attrValues || {});
  return merged;
}

// 属性值 → 显示文本（数组用 / 连接，range 用 ~ 连接，checkbox 显示 是/否）
export function fmtAttrValue(def, v) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
  if (Array.isArray(v)) return v.join('/');
  if (def.type === 'range') return `${v.min ?? ''}~${v.max ?? ''}`;
  if (def.type === 'checkbox') return v ? '是' : '否';
  return String(v);
}

// 按名称路径解析分组，返回叶子分组；不存在则按需创建
// segments: ['成品', 'EVRP', 'EVRP 158°C']
// 返回 { categoryId, created: [{name, parentId}] }
export function resolveOrCreatePath(categories, segments, mintId) {
  const created = [];
  let parentId = null;
  let current = null;

  for (let i = 0; i < segments.length; i++) {
    const name = segments[i].trim();
    if (!name) continue;
    current = categories.find(c => c.parentId === (parentId ?? null) && c.name === name);
    if (!current) {
      current = {
        id: mintId(),
        name,
        parentId,
        isLeaf: i === segments.length - 1,
        // 追加到同级末尾
        sort: categories.filter(c => (c.parentId ?? null) === (parentId ?? null)).length,
        desc: '',
        attrs: [],
      };
      categories.push(current);
      created.push(current);
    }
    parentId = current.id;
  }

  // 路径末端必须是末级；中间节点必须非末级
  if (current) {
    reconcileLeafFlags(categories, current.id);
  }
  return { categoryId: current?.id || null, created };
}

// 根据是否有子分组，修正自身与祖先的 isLeaf
export function reconcileLeafFlags(categories, id) {
  const self = findCategory(categories, id);
  if (self) {
    self.isLeaf = !categories.some(c => c.parentId === self.id);
  }
  const chain = categoryPath(categories, id).slice(0, -1);
  for (const anc of chain) anc.isLeaf = false;
}

// 新建分组对象（默认非末级；末级在「分组管理」里勾选，末级不能再挂子分组）
export function makeCategory(mintId, { name, parentId = null, desc = '', attrs = [], sort = 0 }) {
  return {
    id: mintId(),
    name,
    parentId,
    isLeaf: false,
    sort,
    desc,
    attrs,
  };
}

// 移动分组（含子树）到新父级，防环
export function canMove(categories, id, newParentId) {
  if (!newParentId) return true;
  if (id === newParentId) return false;
  return !selfAndDescendantIds(categories, id).has(newParentId);
}

// 拖拽移动分组：newParentId=null 表示移到根级；beforeId 指定插到哪个同级之前（null=末尾）
// 直接改传入的数组，返回发生变化的分组记录（自身/新旧父级 isLeaf、同级 sort 重排），调用方负责存草稿
export function moveCategory(categories, id, newParentId, beforeId = null) {
  const np = newParentId ?? null;
  if (!canMove(categories, id, np)) return [];
  const node = findCategory(categories, id);
  if (!node) return [];
  const oldParentId = node.parentId ?? null;

  const changed = new Map();
  const touch = (c) => changed.set(c.id, c);

  node.parentId = np;
  touch(node);

  // 新同级按 sort 排序后插入指定位置，再整体重排 sort
  const siblings = categories
    .filter(c => (c.parentId ?? null) === np && c.id !== id)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name, 'zh'));
  let idx = beforeId ? siblings.findIndex(c => c.id === beforeId) : -1;
  if (idx < 0) idx = siblings.length;
  siblings.splice(idx, 0, node);
  siblings.forEach((c, i) => { if (c.sort !== i) { c.sort = i; touch(c); } });

  // isLeaf 修正：新父级变非末级；旧父级没子级了变末级；自身按实际子级修正
  if (np) {
    const p = findCategory(categories, np);
    if (p && p.isLeaf) { p.isLeaf = false; touch(p); }
  }
  if (oldParentId && oldParentId !== np) {
    const op = findCategory(categories, oldParentId);
    if (op && !categories.some(c => c.parentId === op.id) && !op.isLeaf) { op.isLeaf = true; touch(op); }
  }
  const selfLeaf = !categories.some(c => c.parentId === id);
  if (node.isLeaf !== selfLeaf) { node.isLeaf = selfLeaf; touch(node); }

  return Array.from(changed.values());
}
