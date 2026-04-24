import React, { useEffect, useState } from 'react';
import type {
  AppSettings,
  LLMConfig,
  FileRecord,
  FileStats,
  FileCategory,
  SkillItem,
} from '@shared/types';

interface Props {
  onClose: () => void;
  onSave: (s: AppSettings) => void;
  /** 复用技能：父组件负责关闭设置 + 新建会话 + 发送预设 prompt */
  onReuseSkill?: (skillId: string) => void;
}

const DEFAULT_LLM: LLMConfig = {
  name: 'new-llm',
  type: 'native_oai',
  apikey: '',
  apibase: '',
  model: '',
};

const LOCAL_MODEL_PRESETS: Record<string, { apibase: string; label: string }> = {
  ollama: { apibase: 'http://localhost:11434/v1', label: 'Ollama' },
  lmstudio: { apibase: 'http://localhost:1234/v1', label: 'LM Studio' },
  vllm: { apibase: 'http://localhost:8000/v1', label: 'vLLM' },
};

/** 文件分类信息 */
const CATEGORY_INFO: Record<FileCategory, { icon: string; label: string; color: string }> = {
  document: { icon: '📄', label: '文档', color: '#3b82f6' },
  spreadsheet: { icon: '📊', label: '表格', color: '#10b981' },
  image: { icon: '🖼️', label: '图片', color: '#f59e0b' },
  code: { icon: '💻', label: '代码', color: '#6366f1' },
  ppt: { icon: '📽️', label: 'PPT', color: '#8b5cf6' },
  pdf: { icon: '📑', label: 'PDF', color: '#ef4444' },
  other: { icon: '📁', label: '其他', color: '#9ca3af' },
};

/** 旧分类到新分类的映射（兼容历史数据） */
const OLD_CATEGORY_MAP: Record<string, FileCategory> = {
  script: 'code',
  output: 'document',  // 默认文档，会根据路径重新推断
  temp: 'other',
  cache: 'other',
  artifact: 'code',
  log: 'document',
};

/** 获取实际分类（兼容旧数据，根据路径智能推断） */
function getActualCategory(category: string, filePath?: string): FileCategory {
  // 如果是新分类，直接返回
  if (CATEGORY_INFO[category as FileCategory]) {
    return category as FileCategory;
  }
  
  // 对于旧分类，如果提供了文件路径，尝试根据路径重新推断
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const filePathLower = filePath.toLowerCase();
    
    // output 目录下的文件根据扩展名判断
    if (filePathLower.includes('outputs/') || filePathLower.includes('output/')) {
      if (['xlsx', 'xls', 'csv', 'tsv', 'json'].includes(ext)) return 'spreadsheet';
      if (['txt', 'md', 'html', 'log'].includes(ext)) return 'document';
      if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
      if (ext === 'pdf') return 'pdf';
      if (['ppt', 'pptx'].includes(ext)) return 'ppt';
      if (['js', 'ts', 'py', 'json', 'xml', 'yaml', 'yml'].includes(ext)) return 'code';
      return 'document';
    }
    
    // scripts 目录 -> 代码
    if (filePathLower.includes('scripts/')) {
      return 'code';
    }
    
    // artifacts 目录 -> 代码
    if (filePathLower.includes('artifacts/')) {
      return 'code';
    }
    
    // temp/cache 目录 -> 根据扩展名
    if (filePathLower.includes('temp/') || filePathLower.includes('cache/')) {
      if (['xlsx', 'xls', 'csv', 'json'].includes(ext)) return 'spreadsheet';
      if (['txt', 'md', 'log'].includes(ext)) return 'document';
      if (['js', 'ts', 'py', 'sh'].includes(ext)) return 'code';
      return 'other';
    }
    
    // log 目录 -> 文档
    if (filePathLower.includes('logs/') || filePathLower.includes('log/') || ext === 'log') {
      return 'document';
    }
  }
  
  // 无法推断时使用默认映射
  return OLD_CATEGORY_MAP[category] || 'other';
}

export const SettingsPanel: React.FC<Props> = ({ onClose, onSave, onReuseSkill }) => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [fileStats, setFileStats] = useState<FileStats | null>(null);
  const [xagentDir, setXagentDir] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'llm' | 'files' | 'skills'>('llm');
  const [selectedCategory, setSelectedCategory] = useState<FileCategory | 'all'>('all');
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [memoryDirPath, setMemoryDirPath] = useState<string>('');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillDetailContent, setSkillDetailContent] = useState<string>('');
  const [skillBusyId, setSkillBusyId] = useState<string | null>(null);
  const [skillToast, setSkillToast] = useState<string>('');

  // 加载设置
  useEffect(() => {
    window.xagent.getSettings().then(setSettings);
  }, []);

  // 文件列表轮询刷新（仅在文件 Tab 时）
  useEffect(() => {
    if (activeTab !== 'files') return;

    const fetchFiles = async () => {
      const data = await window.xagent.listGeneratedFiles();
      setFiles(data.files);
      setFileStats(data.stats);
      setXagentDir(data.xagentDir);
    };

    fetchFiles();
    const timer = setInterval(fetchFiles, 3000); // 每3秒刷新
    return () => clearInterval(timer);
  }, [activeTab]);

  // 技能列表（仅在 skills Tab 时加载）
  useEffect(() => {
    if (activeTab !== 'skills') return;
    let aborted = false;
    const fetchSkills = async () => {
      const data = await window.xagent.listSkills();
      if (aborted) return;
      setSkills(data.skills);
      setMemoryDirPath(data.memoryDir);
      setSelectedSkillId((cur) => {
        if (cur && data.skills.some((s) => s.id === cur)) return cur;
        return data.skills[0]?.id || null;
      });
    };
    fetchSkills();
    return () => { aborted = true; };
  }, [activeTab]);

  // 加载技能详情
  useEffect(() => {
    if (activeTab !== 'skills' || !selectedSkillId) {
      setSkillDetailContent('');
      return;
    }
    let aborted = false;
    window.xagent.readSkill(selectedSkillId).then((r) => {
      if (aborted) return;
      setSkillDetailContent(r.content || '');
    });
    return () => { aborted = true; };
  }, [selectedSkillId, activeTab]);

  // 自动消失的 toast
  useEffect(() => {
    if (!skillToast) return;
    const t = setTimeout(() => setSkillToast(''), 4000);
    return () => clearTimeout(t);
  }, [skillToast]);

  if (!settings) return null;

  const updateLLM = (idx: number, patch: Partial<LLMConfig>) => {
    const ll = [...settings.llms];
    ll[idx] = { ...ll[idx], ...patch };
    setSettings({ ...settings, llms: ll });
  };
  const removeLLM = (idx: number) => {
    const ll = settings.llms.filter((_, i) => i !== idx);
    setSettings({ ...settings, llms: ll });
  };
  const addLLM = () => {
    setSettings({
      ...settings,
      llms: [...settings.llms, { ...DEFAULT_LLM, name: `llm-${settings.llms.length + 1}` }],
    });
  };

  // ─── 技能操作 ─────────────────────────────────────────────
  const handleReuseSkill = (id: string) => {
    if (!onReuseSkill) {
      setSkillToast('当前环境未注入复用回调');
      return;
    }
    onReuseSkill(id);
    onClose();
  };

  const handleExportSkill = async (id: string, name: string) => {
    setSkillBusyId(id);
    try {
      const r = await window.xagent.exportSkill(id);
      if (r.ok && r.path) {
        setSkillToast(`✅ 已导出 "${name}" 到：${r.path}（${r.files?.length || 0} 个文件）`);
      } else if (r.message === '已取消') {
        // 取消导出不提示
      } else {
        setSkillToast(`❌ 导出失败：${r.message || '未知错误'}`);
      }
    } catch (e: any) {
      setSkillToast(`❌ 导出异常：${e?.message || e}`);
    } finally {
      setSkillBusyId(null);
    }
  };

  const handleOpenSkillFile = (id: string) => {
    window.xagent.openSkillInExplorer(id);
  };

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: '8px 16px',
    background: active ? 'var(--bg-tertiary)' : 'transparent',
    border: 'none',
    borderBottom: active ? '2px solid var(--accent)' : 'none',
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
    cursor: 'pointer',
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: activeTab === 'skills' ? 900 : 700 }}
      >
        <div className="modal-header">
          <h2>设置</h2>
          <button className="btn small" onClick={onClose}>✕</button>
        </div>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
          <button
            className={`tab-btn ${activeTab === 'llm' ? 'active' : ''}`}
            onClick={() => setActiveTab('llm')}
            style={tabBtnStyle(activeTab === 'llm')}
          >
            LLM 配置
          </button>
          <button
            className={`tab-btn ${activeTab === 'files' ? 'active' : ''}`}
            onClick={() => setActiveTab('files')}
            style={tabBtnStyle(activeTab === 'files')}
          >
            文件管理
          </button>
          <button
            className={`tab-btn ${activeTab === 'skills' ? 'active' : ''}`}
            onClick={() => setActiveTab('skills')}
            style={tabBtnStyle(activeTab === 'skills')}
          >
            🧠 技能管理
          </button>
        </div>

        {/* LLM 配置 Tab */}
        {activeTab === 'llm' && (
          <div className="modal-body">
          <div className="flex-row">
            <div className="form-group">
              <label>工作目录 (cwd)</label>
              <input
                value={settings.cwd || ''}
                placeholder="./workdir"
                onChange={(e) => setSettings({ ...settings, cwd: e.target.value })}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                相对路径基于用户数据目录
              </small>
            </div>
            <div className="form-group">
              <label>记忆目录 (memory_dir)</label>
              <input
                value={settings.memory_dir || ''}
                placeholder="./memory（或填绝对路径指向项目内，如 D:\\proj\\XAgent\\memory）"
                onChange={(e) => setSettings({ ...settings, memory_dir: e.target.value })}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                独立于 cwd，切换工作目录不丢失长期记忆
              </small>
            </div>
          </div>
          <div className="flex-row">
            <div className="form-group">
              <label>语言</label>
              <select
                value={settings.lang || 'zh'}
                onChange={(e) => setSettings({ ...settings, lang: e.target.value as any })}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </div>
            <div className="form-group">
              <label>当前 LLM</label>
              <select
                value={settings.active_llm || ''}
                onChange={(e) => setSettings({ ...settings, active_llm: e.target.value })}
              >
                {settings.llms.map((l) => (
                  <option key={l.name} value={l.name}>{l.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>系统提示词覆盖（留空使用默认）</label>
            <textarea
              rows={4}
              value={settings.system_prompt_override || ''}
              onChange={(e) => setSettings({ ...settings, system_prompt_override: e.target.value })}
            />
          </div>

          <h3 style={{ marginTop: 24, marginBottom: 10, fontSize: 14 }}>LLM 配置</h3>
          {settings.llms.map((llm, idx) => (
            <div className="llm-config-card" key={idx}>
              <div className="card-header">
                <span className="card-title">[{llm.type}] {llm.name}</span>
                <button className="btn danger small" onClick={() => removeLLM(idx)}>删除</button>
              </div>
              <div className="flex-row">
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label>名称</label>
                  <input value={llm.name} onChange={(e) => updateLLM(idx, { name: e.target.value })} />
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label>类型</label>
                  <select value={llm.type} onChange={(e) => updateLLM(idx, { type: e.target.value as any })}>
                    <option value="native_oai">native_oai (OpenAI 兼容)</option>
                    <option value="native_claude">native_claude (Anthropic)</option>
                    <option value="local">local (本地模型)</option>
                    <option value="mixin">mixin (故障转移)</option>
                  </select>
                </div>
              </div>
              {llm.type === 'local' && (
                <>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>本地服务预设</label>
                    <select
                      value=""
                      onChange={(e) => {
                        const preset = LOCAL_MODEL_PRESETS[e.target.value];
                        if (preset) updateLLM(idx, { apibase: preset.apibase });
                      }}
                    >
                      <option value="">-- 选择预设或手动填写 --</option>
                      {Object.entries(LOCAL_MODEL_PRESETS).map(([key, { label }]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-row">
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>API Base URL</label>
                      <input
                        value={llm.apibase}
                        placeholder="http://localhost:11434/v1"
                        onChange={(e) => updateLLM(idx, { apibase: e.target.value })}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>模型名</label>
                      <input
                        value={llm.model}
                        placeholder="llama3 / qwen2.5 等"
                        onChange={(e) => updateLLM(idx, { model: e.target.value })}
                      />
                    </div>
                  </div>
                  <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    本地模型无需 API Key，确保本地服务已启动（如 Ollama、LM Studio）
                  </small>
                </>
              )}
              {llm.type !== 'mixin' && llm.type !== 'local' && (
                <>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>API Key</label>
                    <input type="password" value={llm.apikey} onChange={(e) => updateLLM(idx, { apikey: e.target.value })} />
                  </div>
                  <div className="flex-row">
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>API Base</label>
                      <input value={llm.apibase} onChange={(e) => updateLLM(idx, { apibase: e.target.value })} />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>Model</label>
                      <input value={llm.model} onChange={(e) => updateLLM(idx, { model: e.target.value })} />
                    </div>
                  </div>
                </>
              )}
              {llm.type === 'mixin' && (
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label>子会话（逗号分隔 name 列表）</label>
                  <input
                    value={(llm.llm_nos || []).join(',')}
                    onChange={(e) => updateLLM(idx, { llm_nos: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                  />
                </div>
              )}
            </div>
          ))}
          <button className="btn" onClick={addLLM}>+ 添加 LLM</button>
          <div className="modal-footer" style={{ marginTop: 16 }}>
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" onClick={() => { onSave(settings); onClose(); }}>保存</button>
          </div>
        </div>
      )}

      {/* 文件管理 Tab */}
      {activeTab === 'files' && (
        <div className="modal-body" style={{ padding: 0 }}>
          {/* 顶部统计信息 */}
          <div style={{ padding: '12px 16px', background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>生成文件目录：</strong> {xagentDir}
            </div>
            {fileStats && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                共 {fileStats.totalFiles} 个文件，总大小 {(fileStats.totalSize / 1024).toFixed(1)} KB
                <button
                  className="btn small"
                  style={{ marginLeft: 12, fontSize: 11 }}
                  onClick={() => window.xagent.openXagentDir()}
                >
                  打开目录
                </button>
              </div>
            )}
          </div>

          {/* 左右分栏布局 */}
          <div className="file-panel-container">
            {/* 左侧分类导航 */}
            <div className="file-category-nav">
              <div
                className={`category-item ${selectedCategory === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedCategory('all')}
              >
                <span className="category-icon">📦</span>
                <span className="category-label">全部</span>
                <span className="category-badge">{files.length}</span>
              </div>
              {(Object.keys(CATEGORY_INFO) as FileCategory[]).map((cat) => {
                const count = files.filter(f => getActualCategory(f.category, f.path) === cat).length;
                const info = CATEGORY_INFO[cat];
                return (
                  <div
                    key={cat}
                    className={`category-item ${selectedCategory === cat ? 'active' : ''}`}
                    onClick={() => setSelectedCategory(cat)}
                  >
                    <span className="category-icon">{info.icon}</span>
                    <span className="category-label">{info.label}</span>
                    {count > 0 && <span className="category-badge">{count}</span>}
                  </div>
                );
              })}
            </div>

            {/* 右侧文件列表 */}
            <div className="file-list-panel">
              {(() => {
                const displayFiles = selectedCategory === 'all'
                  ? files
                  : files.filter(f => getActualCategory(f.category, f.path) === selectedCategory);

                if (displayFiles.length === 0) {
                  return (
                    <div className="file-empty-state">
                      <span style={{ fontSize: 32, opacity: 0.5 }}>
                        {selectedCategory === 'all' ? '📭' : CATEGORY_INFO[selectedCategory as FileCategory]?.icon || '📁'}
                      </span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                        {selectedCategory === 'all' ? '暂无生成文件' : '该分类下无文件'}
                      </span>
                    </div>
                  );
                }

                return (
                  <div className="file-list">
                    {displayFiles.map((f, i) => {
                      const catType = getActualCategory(f.category, f.path);
                      const info = CATEGORY_INFO[catType];
                      return (
                        <div key={i} className="file-item">
                          <span className="file-icon">{info.icon}</span>
                          <div className="file-info">
                            <span className="file-name">{f.path}</span>
                            <span className="file-meta">
                              {info.label} · {formatFileSize(f.size || 0)} · {formatTime(f.createdAt)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* 技能管理 Tab */}
      {activeTab === 'skills' && (
        <div className="modal-body" style={{ padding: 0 }}>
          {/* 顶部信息 */}
          <div style={{ padding: '12px 16px', background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>记忆目录：</strong> {memoryDirPath || '(未配置)'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              共 {skills.length} 个技能（来源：long-term memory L3 SOP / Utils）
              <span style={{ marginLeft: 12, opacity: 0.8 }}>
                复用 = 自动新建对话并由 LLM 介绍如何使用；导出 = 生成 Anthropic Agent Skills 标准目录包。
              </span>
            </div>
          </div>

          {/* toast */}
          {skillToast && (
            <div style={{
              padding: '8px 16px',
              background: 'var(--bg-secondary)',
              borderBottom: '1px solid var(--border)',
              fontSize: 12,
              color: 'var(--text-primary)',
            }}>
              {skillToast}
            </div>
          )}

          {/* 左右分栏：左列表，右详情 */}
          <div style={{ display: 'flex', minHeight: 420, maxHeight: 520 }}>
            {/* 左侧技能列表 */}
            <div style={{
              width: 360,
              borderRight: '1px solid var(--border)',
              overflowY: 'auto',
              padding: '8px',
            }}>
              {skills.length === 0 && (
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', height: 200, gap: 8,
                  color: 'var(--text-muted)', fontSize: 12,
                }}>
                  <span style={{ fontSize: 32, opacity: 0.5 }}>🧠</span>
                  <span>暂无沉淀的技能</span>
                  <span style={{ fontSize: 11, opacity: 0.7, textAlign: 'center', maxWidth: 280 }}>
                    完成长任务后，让 Agent 调用 <code>start_long_term_update</code> 工具，
                    在 memory 目录新建 <code>*.md</code> / <code>*.py</code>，即可在此处看到对应技能。
                  </span>
                </div>
              )}
              {skills.map((s) => (
                <SkillCard
                  key={s.id}
                  skill={s}
                  active={s.id === selectedSkillId}
                  busy={skillBusyId === s.id}
                  onSelect={() => setSelectedSkillId(s.id)}
                  onReuse={() => handleReuseSkill(s.id)}
                  onExport={() => handleExportSkill(s.id, s.name)}
                  onOpen={() => handleOpenSkillFile(s.id)}
                />
              ))}
            </div>

            {/* 右侧技能详情 */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
              {(() => {
                const cur = skills.find((s) => s.id === selectedSkillId);
                if (!cur) {
                  return (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      height: '100%', color: 'var(--text-muted)', fontSize: 12,
                    }}>
                      选择左侧技能查看详情
                    </div>
                  );
                }
                return (
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                      {cur.type === 'py' ? '🐍' : '📘'} {cur.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                      {cur.relPath} · {formatFileSize(cur.size)} · 更新于 {formatTime(cur.updatedAt)}
                      {cur.accessCount > 0 && <> · 访问 {cur.accessCount} 次</>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
                      {cur.description}
                    </div>
                    {cur.attachments.length > 0 && (
                      <div style={{ marginBottom: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                        <strong>关联脚本：</strong>
                        {cur.attachments.map((a) => (
                          <span key={a.fileName} style={{
                            display: 'inline-block',
                            marginLeft: 6,
                            padding: '1px 6px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 4,
                          }}>
                            {a.fileName}
                          </span>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                      <button className="btn primary small" onClick={() => handleReuseSkill(cur.id)}>
                        ▶ 复用
                      </button>
                      <button
                        className="btn small"
                        onClick={() => handleExportSkill(cur.id, cur.name)}
                        disabled={skillBusyId === cur.id}
                      >
                        {skillBusyId === cur.id ? '导出中…' : '📦 导出 SKILL 包'}
                      </button>
                      <button className="btn small" onClick={() => handleOpenSkillFile(cur.id)}>
                        📂 打开文件
                      </button>
                    </div>
                    <pre style={{
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: 10,
                      fontSize: 11,
                      lineHeight: 1.45,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: 'var(--text-primary)',
                      maxHeight: 320,
                      overflow: 'auto',
                      margin: 0,
                    }}>
                      {skillDetailContent || '(加载中…)'}
                    </pre>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  </div>
  );
};

/** 单个技能卡片 */
interface SkillCardProps {
  skill: SkillItem;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onReuse: () => void;
  onExport: () => void;
  onOpen: () => void;
}

const SkillCard: React.FC<SkillCardProps> = ({
  skill, active, busy, onSelect, onReuse, onExport, onOpen,
}) => {
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <div
      onClick={onSelect}
      style={{
        padding: '10px 12px',
        marginBottom: 6,
        borderRadius: 6,
        border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
        background: active ? 'var(--bg-tertiary)' : 'transparent',
        cursor: 'pointer',
        transition: 'background 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14 }}>{skill.type === 'py' ? '🐍' : '📘'}</span>
        <span style={{
          flex: 1,
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {skill.name}
        </span>
        {skill.accessCount > 0 && (
          <span style={{
            fontSize: 10,
            color: 'var(--text-muted)',
            padding: '1px 6px',
            background: 'var(--bg-secondary)',
            borderRadius: 8,
          }}>
            {skill.accessCount}
          </span>
        )}
      </div>
      <div style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        marginTop: 4,
        lineHeight: 1.4,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical' as any,
        overflow: 'hidden',
      }}>
        {skill.description}
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
        <button
          className="btn primary small"
          style={{ fontSize: 11, padding: '2px 8px' }}
          onClick={stop(onReuse)}
          title="开新会话由 LLM 介绍并按需执行此技能"
        >
          ▶ 复用
        </button>
        <button
          className="btn small"
          style={{ fontSize: 11, padding: '2px 8px' }}
          onClick={stop(onExport)}
          disabled={busy}
          title="导出为 Anthropic Agent Skills 兼容目录包"
        >
          {busy ? '导出中…' : '📦 导出'}
        </button>
        <button
          className="btn small"
          style={{ fontSize: 11, padding: '2px 8px' }}
          onClick={stop(onOpen)}
          title="在文件管理器中显示"
        >
          📂
        </button>
      </div>
    </div>
  );
};

/** 格式化文件大小 */
function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 格式化时间 */
function formatTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffHour < 24) return `${diffHour} 小时前`;
    if (diffDay < 7) return `${diffDay} 天前`;
    return date.toLocaleDateString('zh-CN');
  } catch {
    return dateStr;
  }
}
