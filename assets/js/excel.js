// Excel 导入导出（基于本地内置的 SheetJS，挂在 window.XLSX 上）
//
// 多级分组合并为一列「分组」，用 \ 分隔（如：父级1\子级1\子子级1）：
// 物料编码 | 物料名称 | 分组 | 属性列...
//
// 不导出内部 ID（导入按物料编码匹配）；
// 末级分组的物料属性跟随导出（每个属性单独一列），导入时按显示名写回；
// 分组属性在分组上统一维护，不导出也不导入；
// 位置/同步时间/创建人/修改人等内部状态不导出

import { categoryPathNames, fmtAttrValue, findCategory, withAttrSet, applyDictionaries } from './categories.js';

function ensureXLSX() {
  if (!window.XLSX) throw new Error('Excel 组件未加载（assets/vendor/xlsx.full.min.js）');
  return window.XLSX;
}

// ---------- 导出 ----------
/**
 * @param {Array} materials  要导出的物料（已按分组过滤）
 * @param {Array} categories 全部分组
 * @param {string} [groupName] 导出的分组名称，用作文件名前缀
 */
export function exportMaterials(materials, categories, attrSets = [], dictionaries = [], groupName) {
  const XLSX = ensureXLSX();

  // 物料属性列：当前导出物料所属末级分组生效字段（属性集合 + 自有字段）的并集
  const attrDefs = [];
  const seenKeys = new Set();
  for (const m of materials) {
    if (!m.categoryId) continue;
    const cat = findCategory(categories, m.categoryId);
    const defs = withAttrSet(cat, attrSets);
    for (const def of applyDictionaries(defs, dictionaries)) {
      if (!seenKeys.has(def.key)) { seenKeys.add(def.key); attrDefs.push(def); }
    }
  }

  const rows = materials.map(m => {
    const names = categoryPathNames(categories, m.categoryId); // ['父级','子级',...]
    const row = {
      '物料编码': m.code || '',
      '物料名称': m.name || '',
      '分组': names.join('\\'),
    };
    for (const def of attrDefs) row[def.label] = fmtAttrValue(def, m.attrs?.[def.key]);
    return row;
  });

  const headers = [
    '物料编码', '物料名称', '分组',
    ...attrDefs.map(d => d.label),
  ];
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  ws['!cols'] = headers.map(() => ({ wch: 16 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '物料档案');

  const name = makeFileName(groupName);
  XLSX.writeFile(wb, name);
  return rows.length;
}

// 文件名：分组名称 + 年月日 + 6 位随机哈希，避免同名文件重复
function makeFileName(groupName) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  // 分组名里的路径分隔符等字符在 Windows 文件名里非法，统一替换
  const base = String(groupName || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '物料档案';
  return `${base}${date}${randomHash6()}.xlsx`;
}

// 文件名后缀 6 位随机哈希，避免同名文件被覆盖
function randomHash6() {
  if (window.crypto?.getRandomValues) {
    return [...crypto.getRandomValues(new Uint8Array(3))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2, 8).padEnd(6, '0');
}

// ---------- 解析（导入用） ----------
// 返回 [{ id, code, name, groupNames: [], location, raw }]
// 不解析属性列：导入只锁定分组路径，属性在页面里维护
export function parseMaterialsFile(file) {
  const XLSX = ensureXLSX();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      try {
        const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        const out = rows.map(r => ({
          id: String(r['ID'] ?? '').trim(),
          code: String(r['物料编码'] ?? '').trim(),
          name: String(r['物料名称'] ?? '').trim(),
          groupNames: String(r['分组'] ?? '').split('\\').map(s => s.trim()).filter(Boolean),
          raw: r,
        })).filter(r => r.id || r.code || r.name);
        resolve(out);
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}
