# Memory Management SOP (L0)

XAgent 的记忆分为四级：

- **L1 Insight** (`memory/global_mem_insight.txt`)：极简索引，首轮注入进 system prompt
- **L2 Facts** (`memory/global_mem.txt`)：长期稳定的环境事实、凭证位置、用户偏好
- **L3 SOP/Utils** (`memory/*.md` / `memory/*.py`)：复杂任务经验、可复用脚本
- **L4 Raw Sessions** (`memory/L4_raw_sessions/`)：原始会话存档（自动归档，Agent 一般不读）

## 写入原则

1. **最小化更新**：先 `file_read` 查看现有内容，判断是否已存在
2. **提取验证信息**：只记录"行动验证成功的信息"，禁止未验证内容
3. **分层写入**：
   - 环境事实 → L2 `file_patch`，同步更新 L1
   - 复杂经验 → L3 新建 SOP 文件（只记核心要点，避免冗余）
4. **Memory 下文件只能 `file_patch`**（除非新建）

## 禁止

- 临时变量、推理过程、未验证信息、通用常识
- 你可以轻松复现的细节

## 何时调用 start_long_term_update

- 完成 15+ 轮的任务后
- 发现新的"被坑多次重试"的核心要点
- 用户反馈了重要偏好
