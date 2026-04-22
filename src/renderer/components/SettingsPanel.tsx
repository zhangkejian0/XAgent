import React, { useEffect, useState } from 'react';
import type { AppSettings, LLMConfig } from '@shared/types';

interface Props {
  onClose: () => void;
  onSave: (s: AppSettings) => void;
}

const DEFAULT_LLM: LLMConfig = {
  name: 'new-llm',
  type: 'native_oai',
  apikey: '',
  apibase: '',
  model: '',
};

export const SettingsPanel: React.FC<Props> = ({ onClose, onSave }) => {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    window.xagent.getSettings().then(setSettings);
  }, []);

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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>设置</h2>
          <button className="btn small" onClick={onClose}>✕</button>
        </div>
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
                    <option value="mixin">mixin (故障转移)</option>
                  </select>
                </div>
              </div>
              {llm.type !== 'mixin' && (
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
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => { onSave(settings); onClose(); }}>保存</button>
        </div>
      </div>
    </div>
  );
};
