# 🐱 发财猫模型管理器

[![Version](https://img.shields.io/badge/version-1.2.0-brightgreen.svg)](https://github.com/pjl914335852-ux/openclaw-model-manager/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

通过 Telegram Bot 管理你的 OpenClaw 模型和 API 密钥。

## ✨ 最新更新（2026-03-06）

### 🚀 v1.2.0 - 系统监控功能

1. **💻 系统监控**
   - 从 Telegram 查看服务器状态
   - CPU、内存、磁盘使用情况
   - 系统运行时间和负载
   - 机器人进程信息
   - 无需 SSH 登录

**使用方法：**
- 发送 `/system` 命令
- 或点击主菜单的 "💻 系统监控" 按钮

---

## 📋 历史更新（2026-03-05）

### 🎉 v1.1.0 - 重大功能更新

1. **⏰ 定时任务管理**
   - 自动读取 OpenClaw 现有的 cron 任务
   - 为每个任务单独选择模型
   - 智能缓存，流畅丝滑
   - 支持删除任务（二次确认）

2. **🛡️ 删除二次确认**
   - Provider 删除需要确认
   - 模型删除需要确认
   - 定时任务删除需要确认
   - 防止误操作

3. **📦 Provider 模板**
   - 支持 DeepSeek（2个模型）
   - 支持 OpenAI（4个模型）
   - 支持 Anthropic（4个模型，含最新 Claude Opus 4.6）
   - 支持 Google（4个模型）
   - 选择模板后自动添加所有模型

4. **⚡ 性能优化**
   - 定时任务缓存 5 分钟
   - 超时时间增加到 15 秒
   - 添加刷新按钮
   - 大幅提升响应速度

## 功能

- 🔑 **密钥管理**：添加/修改/删除 API Provider 和密钥
- 🤖 **模型管理**：管理模型列表、设置默认模型
- ⏰ **定时任务**：管理 OpenClaw cron 任务，为每个任务选择模型
- 🔄 **远程重启**：修改配置后一键重启 OpenClaw 生效
- 📋 **配置查看**：查看当前配置概览
- 🔒 **安全**：首次 `/start` 自动绑定你的 Telegram ID，只有你能管理

## 安装前提

- ✅ 已安装 [OpenClaw](https://openclaw.ai)（有 `~/.openclaw/openclaw.json`）
- ✅ 在 [@BotFather](https://t.me/BotFather) 创建一个新的 Telegram Bot
- ✅ Node.js 16+

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/pjl914335852-ux/openclaw-model-manager/master/install.sh | bash
```

或者手动安装：

```bash
# 1. 下载安装脚本
wget https://raw.githubusercontent.com/pjl914335852-ux/openclaw-model-manager/master/install.sh

# 2. 运行安装
chmod +x install.sh
./install.sh
```

安装过程中会要求你输入 Bot Token。

## 🔄 如何更新

如果你已经安装过旧版本，更新到最新版：

```bash
cd ~/model-manager
git pull origin master
pm2 restart model-manager
# 或 sudo systemctl restart model-manager
```

**重要提示：** 更新后需要重启服务才能生效！

## 使用

安装完成后，向你的 Bot 发送 `/start`，首次使用会自动绑定你的 Telegram ID。

### 命令

- `/start` - 打开主菜单
- `/model` - 同 `/start`
- `/models` - 同 `/start`

### 界面操作

通过按钮操作：

- **密钥管理**：添加/修改/删除 Provider 和 API Key
- **模型管理**：添加/删除模型、设置默认模型
- **查看配置**：查看当前 OpenClaw 配置
- **重启生效**：修改配置后重启 OpenClaw

## 手动启动

如果没有使用 systemd 或 PM2，可以手动启动：

```bash
cd ~/model-manager
BOT_TOKEN='你的Bot Token' node server.js
```

## 环境变量

- `BOT_TOKEN` - Telegram Bot Token（必需）
- `OPENCLAW_CONFIG` - OpenClaw 配置文件路径（可选，默认自动检测）
- `ALLOWED_USERS` - 预设允许的用户 ID 列表，逗号分隔（可选）

示例：

```bash
export BOT_TOKEN='123456:ABC-DEF...'
export ALLOWED_USERS='123456789,987654321'
node server.js
```

## 服务管理

### systemd

```bash
# 查看状态
sudo systemctl status model-manager

# 启动/停止/重启
sudo systemctl start model-manager
sudo systemctl stop model-manager
sudo systemctl restart model-manager

# 查看日志
sudo journalctl -u model-manager -f
```

### PM2

```bash
# 查看状态
pm2 status

# 启动/停止/重启
pm2 start model-manager
pm2 stop model-manager
pm2 restart model-manager

# 查看日志
pm2 logs model-manager
```

## 安全说明

- 首次 `/start` 会自动注册你的 Telegram ID
- 只有注册的用户可以使用 Bot
- 配置文件修改前会自动备份（保留最近 3 个备份）
- 不会泄露你的 API Key（显示时只显示前 20 个字符）

## 故障排查

### Bot 无响应

1. 检查 Bot Token 是否正确
2. 检查服务是否运行：`ps aux | grep server.js`
3. 查看日志：`journalctl -u model-manager -f` 或 `pm2 logs model-manager`

### 找不到 OpenClaw 配置

确保 OpenClaw 已安装，配置文件在以下位置之一：
- `~/.openclaw/openclaw.json`
- `/root/.openclaw/openclaw.json`

或设置环境变量：
```bash
export OPENCLAW_CONFIG=/path/to/openclaw.json
```

## 许可证

MIT License

## 支持

- GitHub Issues: [提交问题](https://github.com/pjl914335852-ux/openclaw-model-manager/issues)
- OpenClaw 文档: https://docs.openclaw.ai
- OpenClaw Discord: https://discord.com/invite/clawd
