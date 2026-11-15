// 集中配置：硬编码默认值放这里，便于一处修改
export const CONFIG = {
  // 数据仓库默认值：登录后从 PAT 可访问的仓库中选择，留空表示必须手动选择
  defaultDataOwner: '',
  defaultDataRepo: '',
  defaultDataBranch: 'main',

  // 数据仓库内文件路径（代码仓库不再存放任何数据）
  categoriesPath: 'data/categories.json',
  materialsRoot: 'data/materials',
  materialsManifestPath: 'data/materials/manifest.json',
  materialsSearchIndexPath: 'data/materials/search-index.json',
  legacyMaterialsPath: 'data/materials.json',
  materialChunkSize: 500,
  dictionariesPath: 'data/dictionaries.json',
  attrSetsPath: 'data/attrSets.json',

  // 附件限制
  attachmentMaxSizeMB: 25,

  // IndexedDB
  dbName: 'craft-admin',
  dbVersion: 1,

  // GitHub API
  apiBase: 'https://api.github.com',
  rawBase: 'https://raw.githubusercontent.com',
};

// localStorage 中保存的数据仓库设置（PAT 的保存策略见 auth.js）
export const LS_KEYS = {
  dataOwner: 'craft.data.owner',
  dataRepo: 'craft.data.repo',
  dataBranch: 'craft.data.branch',
};

// 字段类型的元信息（显示名 + 是否需要 options）
export const FIELD_TYPES = {
  text:        { label: '文本',       needsOptions: false },
  textarea:    { label: '多行文本',   needsOptions: false },
  number:      { label: '数字',       needsOptions: false },
  select:      { label: '下拉单选',   needsOptions: true  },
  radio:       { label: '单选',       needsOptions: true  },
  multiselect: { label: '多选',       needsOptions: true  },
  range:       { label: '区间(min-max)', needsOptions: false },
  date:        { label: '日期',       needsOptions: false },
  checkbox:    { label: '开关',       needsOptions: false },
};

// 物料位置
export const LOCATION = {
  cloud: '云端',
  local: '本地',
};
