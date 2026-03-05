# 发财猫管理器优化说明

## 🎉 优化完成！

### 优化内容

#### 1. ✅ 密钥管理（已有）
- 支持添加/更新/删除 API Key
- 密钥显示时自动隐藏（只显示前25位）
- 支持多个 Provider 的密钥管理

#### 2. ✅ 删除二次确认（新增）
**删除 Provider：**
- 点击"❌ 删 xxx"后会弹出确认对话框
- 显示警告："⚠️ 确认删除 Provider？这将删除该 Provider 的所有配置和模型！"
- 需要点击"✅ 确认删除"才会真正删除

**删除模型：**
- 点击"❌ xxx/xxx"后会弹出确认对话框
- 显示警告："⚠️ 确认删除模型？删除后无法恢复！"
- 需要点击"✅ 确认删除"才会真正删除

#### 3. ✅ 定时任务模型选择（优化）
**功能说明：**
- 自动读取 OpenClaw 现有的 cron 任务（通过 `openclaw cron list --json`）
- 不是让用户创建新任务，而是管理已有任务
- 每个任务可以单独选择使用的模型
- 显示任务的详细信息（名称、时间、模型、状态、下次运行时间）

**使用流程：**
1. 点击"⏰ 定时任务"
2. 查看所有现有的定时任务列表
3. 点击任务进入编辑
4. 点击"🤖 选择模型"
5. 从已配置的模型中选择
6. 重启 Gateway 生效

#### 4. ✅ 添加 Provider 显示所有支持的模型（新增）
**支持的 Provider 模板：**
- 📦 DeepSeek（2个模型）
  - deepseek-chat
  - deepseek-reasoner
  
- 📦 OpenAI（4个模型）
  - gpt-4o
  - gpt-4o-mini
  - gpt-4-turbo
  - gpt-3.5-turbo
  
- 📦 Anthropic（4个模型）
  - claude-opus-4-6-20260205
  - claude-sonnet-4-6-20260205
  - claude-3-5-sonnet-20241022
  - claude-3-5-haiku-20241022
  
- 📦 Google（4个模型）
  - gemini-2.0-flash-exp
  - gemini-exp-1206
  - gemini-1.5-pro
  - gemini-1.5-flash

**添加流程：**
1. 点击"➕ 添加新Provider"
2. 选择 Provider 类型（DeepSeek/OpenAI/Anthropic/Google/自定义）
3. 查看支持的模型列表和详细信息
4. 发送 API Key
5. 自动添加所有模型到配置

---

## 📱 使用方法

### 启动 Bot
```bash
# 使用 PM2 管理
pm2 start /root/model-manager/server.js --name model-manager

# 或直接运行
cd /root/model-manager
node server.js
```

### 主要功能

**1. 密钥管理**
```
/start → 🔑 密钥管理
```
- 查看所有 Provider 的密钥
- 修改 API Key
- 删除 Provider（二次确认）

**2. 模型管理**
```
/start → 🤖 模型管理
```
- 查看所有已配置的模型
- 添加新模型
- 删除模型（二次确认）
- 设置默认模型

**3. 定时任务（优化后）**
```
/start → ⏰ 定时任务
```
- 自动读取 OpenClaw 现有的 cron 任务
- 显示任务详情（名称、时间、模型、状态、下次运行）
- 为每个任务选择模型
- 不支持添加/删除任务（通过 `openclaw cron` 命令管理）

**4. 添加 Provider（优化后）**
```
/start → 🔑 密钥管理 → ➕ 添加新Provider
```
- 选择 Provider 模板（DeepSeek/OpenAI/Anthropic/Google）
- 查看支持的所有模型
- 发送 API Key
- 自动添加所有模型

---

## 🔧 技术细节

### 定时任务集成

**读取任务：**
```javascript
function getOpenClawCronJobs() {
  const output = execSync('openclaw cron list --json 2>/dev/null');
  const data = JSON.parse(output);
  return data.jobs || [];
}
```

**更新模型：**
```javascript
function updateCronJobModel(jobId, model) {
  const cmd = `openclaw cron update ${jobId} --set payload.model="${model}"`;
  execSync(cmd);
}
```

**任务数据结构：**
```json
{
  "id": "c65770cf-48ac-4b39-9507-dd72a6246618",
  "name": "Moltbook 每日评论 - 下午 2:00",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "expr": "0 14 * * *",
    "tz": "Asia/Singapore"
  },
  "payload": {
    "kind": "agentTurn",
    "model": "custom-web-gaoqianba-com/claude-opus-4-5-20251101"
  },
  "state": {
    "nextRunAtMs": 1772690400000
  }
}
```

### Provider 模板定义

```javascript
const PROVIDER_TEMPLATES = {
  'deepseek': {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
    ]
  },
  // ... 其他模板
};
```

### 二次确认流程

```javascript
// 删除 Provider
del_provider_xxx → 显示确认对话框 → confirm_del_provider_xxx → 执行删除

// 删除模型
del_model_xxx → 显示确认对话框 → confirm_del_model_xxx → 执行删除
```

### 文件变更

**修改的文件：**
- `/root/model-manager/server.js` - 主程序

**备份文件：**
- `/root/model-manager/server.js.backup-20260305-112503`

---

## ✅ 测试清单

- [x] 删除 Provider 有二次确认
- [x] 删除模型有二次确认
- [x] 添加 Provider 时显示模板选择
- [x] 选择模板后显示所有支持的模型
- [x] 发送 API Key 后自动添加所有模型
- [x] 定时任务自动读取 OpenClaw 现有任务
- [x] 定时任务可以选择模型
- [x] Bot 正常启动和运行

---

## 📊 对比

### 优化前
```
定时任务:
- 从 config.cron.jobs 读取（不存在）
- 需要手动添加任务
- 功能不完整

添加 Provider:
1. 输入名称
2. 输入 Base URL
3. 输入 API Key
4. 手动添加每个模型

删除操作:
- 直接删除，无确认
```

### 优化后
```
定时任务:
- 从 OpenClaw 读取现有任务 ✨
- 自动显示所有任务
- 可以为每个任务选择模型
- 显示详细信息（下次运行时间等）

添加 Provider:
1. 选择模板（DeepSeek/OpenAI/Anthropic/Google）
2. 查看所有支持的模型
3. 输入 API Key
4. 自动添加所有模型 ✨

删除操作:
- 二次确认，防止误删 ✨
```

---

## 🚀 下一步

可以继续优化的功能：
1. 添加模型成本显示
2. 支持批量操作
3. 导入/导出配置
4. 模型使用统计

---

## 📞 联系方式

- Bot: @gdwwae_bot
- Telegram: @Ee_7t

---

_优化完成时间: 2026-03-05 11:45_
