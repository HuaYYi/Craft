// 集中配置：硬编码默认值放这里，便于一处修改
export const CONFIG = {
  // GitHub 仓库默认值（用户可在「设置」页覆盖，存 localStorage）
  defaultOwner: 'HuaYYi',
  defaultRepo: 'Craft',
  defaultBranch: 'main',

  // 仓库内数据文件路径
  categoriesPath: 'data/categories.json',
  materialsPath: 'data/materials.json',

  // 附件限制
  attachmentMaxSizeMB: 25,

  // IndexedDB
  dbName: 'craft-admin',
  dbVersion: 1,

  // GitHub API
  apiBase: 'https://api.github.com',
  rawBase: 'https://raw.githubusercontent.com',
};

// localStorage 中保存的设置键（PAT 不持久化，仅内存）
export const LS_KEYS = {
  owner: 'craft.owner',
  repo: 'craft.repo',
  branch: 'craft.branch',
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
