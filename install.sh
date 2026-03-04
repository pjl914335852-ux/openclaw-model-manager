#!/bin/bash
# ============================================
# 🐱 发财猫模型管理器 - 一键安装脚本
# 安装后你可以通过 Telegram bot 管理 OpenClaw 的模型和密钥
# ============================================

set -e

INSTALL_DIR="$HOME/model-manager"
SERVICE_NAME="model-manager"
REPO_URL="https://raw.githubusercontent.com/placeholder/model-manager/main"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}🐱 发财猫模型管理器 - 一键安装${NC}"
echo "==========================================="
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ 未找到 Node.js，请先安装 Node.js 16+${NC}"
    echo "  安装命令: curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash - && sudo apt-get install -y nodejs"
    exit 1
fi

NODE_VER=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 16 ]; then
    echo -e "${RED}❌ Node.js 版本过低 (当前: $(node --version))，需要 v16+${NC}"
    exit 1
fi

# 检查 OpenClaw
OPENCLAW_CONFIG=""
for p in "$HOME/.openclaw/openclaw.json" "/root/.openclaw/openclaw.json"; do
    if [ -f "$p" ]; then
        OPENCLAW_CONFIG="$p"
        break
    fi
done

if [ -z "$OPENCLAW_CONFIG" ]; then
    echo -e "${RED}❌ 未找到 OpenClaw 配置文件${NC}"
    echo -e "${YELLOW}请先安装并配置 OpenClaw：https://openclaw.ai${NC}"
    exit 1
fi

echo -e "${GREEN}✅ 找到 OpenClaw 配置: $OPENCLAW_CONFIG${NC}"

# 获取 Bot Token
echo ""
echo -e "${YELLOW}请先去 @BotFather 创建一个 Telegram Bot，获取 Token${NC}"
echo ""
read -p "📌 请输入你的 Bot Token: " BOT_TOKEN

if [ -z "$BOT_TOKEN" ]; then
    echo -e "${RED}❌ Bot Token 不能为空${NC}"
    exit 1
fi

# 验证 token
echo -n "🔍 验证 Token..."
BOT_INFO=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getMe")
BOT_OK=$(echo "$BOT_INFO" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).ok?'yes':'no')}catch{console.log('no')}})" 2>/dev/null || echo "no")

if [ "$BOT_OK" != "yes" ]; then
    echo -e " ${RED}❌ Token 无效${NC}"
    exit 1
fi

BOT_USERNAME=$(echo "$BOT_INFO" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).result.username)}catch{console.log('unknown')}})" 2>/dev/null || echo "unknown")
echo -e " ${GREEN}✅ @${BOT_USERNAME}${NC}"

# 创建安装目录
mkdir -p "$INSTALL_DIR"

# 下载 server.js
echo ""
echo "📦 安装文件..."

# 尝试从服务器下载，失败则用内嵌版本
if command -v curl &> /dev/null && curl -sf "${REPO_URL}/server.js" -o "$INSTALL_DIR/server.js.tmp" 2>/dev/null; then
    mv "$INSTALL_DIR/server.js.tmp" "$INSTALL_DIR/server.js"
else
    # 内嵌最小版本（不含密钥，纯功能代码）
    cat > "$INSTALL_DIR/server.js" << 'SERVEREOF'
#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function getConfig() {
  const botToken = process.env.MODEL_MANAGER_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!botToken) { console.error('❌ 未设置 BOT_TOKEN'); process.exit(1); }
  const candidates = [process.env.OPENCLAW_CONFIG, path.join(os.homedir(), '.openclaw', 'openclaw.json'), '/root/.openclaw/openclaw.json'].filter(Boolean);
  let openclaw_config = null;
  for (const p of candidates) { if (fs.existsSync(p)) { openclaw_config = p; break; } }
  if (!openclaw_config) { console.error('❌ 未找到 OpenClaw 配置文件'); process.exit(1); }
  console.log(`✅ 配置文件: ${openclaw_config}`);
  const allowedUsers = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',').map(id => parseInt(id.trim())).filter(Boolean) : [];
  return { botToken, openclaw_config, allowedUsers };
}

const CONFIG = getConfig();
const registeredFile = path.join(path.dirname(CONFIG.openclaw_config), '.model-manager-users.json');
let dynamicUsers = [];
try { if (fs.existsSync(registeredFile)) dynamicUsers = JSON.parse(fs.readFileSync(registeredFile, 'utf8')); } catch(e) {}
function isAllowed(userId) { return CONFIG.allowedUsers.length > 0 ? CONFIG.allowedUsers.includes(userId) : dynamicUsers.includes(userId); }
function registerUser(userId) { if (!dynamicUsers.includes(userId)) { dynamicUsers.push(userId); try { fs.writeFileSync(registeredFile, JSON.stringify(dynamicUsers)); } catch(e) {} } }

const sessions = {};
let offset = 0;

function tgApi(method, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname: 'api.telegram.org', path: `/bot${CONFIG.botToken}/${method}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

const sendMsg = (chatId, text, extra = {}) => tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
const editMsg = (chatId, msgId, text, extra = {}) => tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', ...extra });
const answerCb = (id, text = '') => tgApi('answerCallbackQuery', { callback_query_id: id, text });
const loadCfg = () => JSON.parse(fs.readFileSync(CONFIG.openclaw_config, 'utf8'));
function saveCfg(config) { const bak = CONFIG.openclaw_config + '.bak.' + Date.now(); fs.copyFileSync(CONFIG.openclaw_config, bak); fs.writeFileSync(CONFIG.openclaw_config, JSON.stringify(config, null, 2)); }
function restart() { try { execSync('openclaw gateway restart', { timeout: 8000 }); return true; } catch(e) { try { execSync('kill -USR1 $(pgrep -f "openclaw")', { timeout: 3000 }); return true; } catch { return false; } } }

const mainMenu = () => ({ inline_keyboard: [[{ text: '🔑 密钥管理', callback_data: 'menu_keys' }, { text: '🤖 模型管理', callback_data: 'menu_models' }], [{ text: '👁 查看配置', callback_data: 'view_config' }], [{ text: '🔄 重启生效', callback_data: 'restart' }]] });
function keysMenu(cfg) { const btns = Object.entries(cfg.models?.providers || {}).map(([n]) => [{ text: `✏️ 改Key: ${n}`, callback_data: `edit_key_${n}` }, { text: `❌ 删 ${n}`, callback_data: `del_provider_${n}` }]); return { inline_keyboard: [...btns, [{ text: '➕ 添加Provider', callback_data: 'add_provider' }], [{ text: '◀ 返回', callback_data: 'main_menu' }]] }; }
function modelsMenu(cfg) { const all = []; for (const [pn, p] of Object.entries(cfg.models?.providers || {})) for (const m of (p.models||[])) all.push({ key: `${pn}|${m.id}`, label: `${pn}/${m.id}` }); return { inline_keyboard: [...all.map(m => [{ text: `❌ ${m.label}`, callback_data: `del_model_${m.key}` }]), [{ text: '➕ 添加模型', callback_data: 'add_model' }], [{ text: '🎯 设默认', callback_data: 'set_default' }], [{ text: '◀ 返回', callback_data: 'main_menu' }]] }; }

async function handleCallback(chatId, userId, msgId, data, cbId) {
  if (!isAllowed(userId)) { await answerCb(cbId, '❌ 无权限'); return; }
  await answerCb(cbId);
  const cfg = loadCfg();
  if (data === 'main_menu') { await editMsg(chatId, msgId, '🐱 <b>发财猫模型管理器</b>\n\n选择操作：', { reply_markup: mainMenu() }); }
  else if (data === 'menu_keys') { const list = Object.entries(cfg.models?.providers || {}).map(([n, p]) => `• <code>${n}</code>\n  URL: <code>${p.baseUrl||'官方'}</code>\n  Key: <code>${(p.apiKey||'').slice(0,25)}...</code>`).join('\n\n'); await editMsg(chatId, msgId, `🔑 <b>密钥管理</b>\n\n${list||'暂无'}`, { reply_markup: keysMenu(cfg) }); }
  else if (data === 'menu_models') { let ml = ''; for (const [pn, p] of Object.entries(cfg.models?.providers||{})) for (const m of (p.models||[])) ml += `• <code>${pn}/${m.id}</code>\n`; const def = cfg.agents?.defaults?.model?.primary||'未设置'; await editMsg(chatId, msgId, `🤖 <b>模型管理</b>\n\n默认：<code>${def}</code>\n\n${ml||'暂无'}`, { reply_markup: modelsMenu(cfg) }); }
  else if (data === 'view_config') { let t = '📋 <b>当前配置</b>\n\n默认模型：<code>' + (cfg.agents?.defaults?.model?.primary||'未设置') + '</code>\n\n<b>Providers：</b>\n'; for (const [n, p] of Object.entries(cfg.models?.providers||{})) t += `\n<b>${n}</b>\n  URL: <code>${p.baseUrl||'官方'}</code>\n  Key: <code>${(p.apiKey||'').slice(0,20)}...</code>\n  模型: <code>${(p.models||[]).map(m=>m.id).join(', ')||'无'}</code>\n`; await editMsg(chatId, msgId, t, { reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'main_menu' }]] } }); }
  else if (data === 'restart') { await editMsg(chatId, msgId, '🔄 重启中...', {}); const ok = restart(); await editMsg(chatId, msgId, ok ? '✅ 重启成功！' : '⚠️ 已发信号', { reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'main_menu' }]] } }); }
  else if (data.startsWith('del_provider_')) { const n = data.replace('del_provider_', ''); delete cfg.models.providers[n]; saveCfg(cfg); await editMsg(chatId, msgId, `✅ 已删除 <code>${n}</code>`, { reply_markup: { inline_keyboard: [[{ text: '◀', callback_data: 'menu_keys' }, { text: '🔄 重启', callback_data: 'restart' }]] } }); }
  else if (data.startsWith('del_model_')) { const [pn, mid] = data.replace('del_model_', '').split('|'); if (cfg.models?.providers?.[pn]) { cfg.models.providers[pn].models = (cfg.models.providers[pn].models||[]).filter(m=>m.id!==mid); saveCfg(cfg); } await editMsg(chatId, msgId, `✅ 已删除 <code>${pn}/${mid}</code>`, { reply_markup: { inline_keyboard: [[{ text: '◀', callback_data: 'menu_models' }, { text: '🔄', callback_data: 'restart' }]] } }); }
  else if (data === 'add_provider') { sessions[userId] = { step: 'add_provider_name' }; await editMsg(chatId, msgId, '➕ <b>添加 Provider</b>\n\n发送 Provider 名称：', { reply_markup: { inline_keyboard: [[{ text: '取消', callback_data: 'main_menu' }]] } }); }
  else if (data === 'add_model') { const ps = Object.keys(cfg.models?.providers||{}); await editMsg(chatId, msgId, '➕ 选择 Provider：', { reply_markup: { inline_keyboard: [...ps.map(p=>[{ text: p, callback_data: `add_model_to_${p}` }]), [{ text: '取消', callback_data: 'main_menu' }]] } }); }
  else if (data.startsWith('add_model_to_')) { const pn = data.replace('add_model_to_', ''); sessions[userId] = { step: 'add_model_id', provName: pn }; await editMsg(chatId, msgId, `➕ 向 <code>${pn}</code> 添加模型\n\n发送模型 ID：`, { reply_markup: { inline_keyboard: [[{ text: '取消', callback_data: 'main_menu' }]] } }); }
  else if (data === 'set_default') { const all = []; for (const [pn, p] of Object.entries(cfg.models?.providers||{})) for (const m of (p.models||[])) all.push(`${pn}/${m.id}`); await editMsg(chatId, msgId, '🎯 选择默认模型：', { reply_markup: { inline_keyboard: [...all.map(m=>[{ text: m, callback_data: `set_def_${m}` }]), [{ text: '取消', callback_data: 'main_menu' }]] } }); }
  else if (data.startsWith('set_def_')) { const m = data.replace('set_def_', ''); if (!cfg.agents) cfg.agents = {}; if (!cfg.agents.defaults) cfg.agents.defaults = {}; cfg.agents.defaults.model = { primary: m, fallbacks: [] }; saveCfg(cfg); await editMsg(chatId, msgId, `✅ 默认模型: <code>${m}</code>`, { reply_markup: { inline_keyboard: [[{ text: '◀', callback_data: 'main_menu' }, { text: '🔄', callback_data: 'restart' }]] } }); }
  else if (data.startsWith('edit_key_')) { const pn = data.replace('edit_key_', ''); sessions[userId] = { step: 'edit_key', provName: pn }; await editMsg(chatId, msgId, `🔑 发送 <code>${pn}</code> 的新 Key：`, { reply_markup: { inline_keyboard: [[{ text: '取消', callback_data: 'main_menu' }]] } }); }
}

async function handleText(chatId, userId, text) {
  const s = sessions[userId];
  if (text === '/start' || text === '/model' || text === '/models') {
    if (CONFIG.allowedUsers.length === 0) { registerUser(userId); console.log(`[注册] 用户 ${userId}`); }
    if (!isAllowed(userId)) { await sendMsg(chatId, '❌ 无权限'); return; }
    sessions[userId] = null;
    await sendMsg(chatId, '🐱 <b>发财猫模型管理器</b>\n\n选择操作：', { reply_markup: mainMenu() });
    return;
  }
  if (!isAllowed(userId) || !s) return;
  const cfg = loadCfg();
  if (s.step === 'add_provider_name') { sessions[userId] = { step: 'add_provider_url', provName: text.trim() }; await sendMsg(chatId, `名称：<code>${text.trim()}</code>\n\n请发送 Base URL：`); }
  else if (s.step === 'add_provider_url') { sessions[userId] = { ...s, step: 'add_provider_key', url: text.trim() }; await sendMsg(chatId, `URL：<code>${text.trim()}</code>\n\n请发送 API Key：`); }
  else if (s.step === 'add_provider_key') { const { provName, url } = s; if (!cfg.models) cfg.models = { mode: 'merge', providers: {} }; if (!cfg.models.providers) cfg.models.providers = {}; cfg.models.providers[provName] = { baseUrl: url, apiKey: text.trim(), api: 'openai-completions', models: [] }; saveCfg(cfg); sessions[userId] = null; await sendMsg(chatId, `✅ <code>${provName}</code> 已添加！`, { reply_markup: { inline_keyboard: [[{ text: '➕ 添加模型', callback_data: `add_model_to_${provName}` }, { text: '🔄 重启', callback_data: 'restart' }]] } }); }
  else if (s.step === 'add_model_id') { const { provName } = s; const mid = text.trim(); if (!cfg.models.providers[provName].models) cfg.models.providers[provName].models = []; cfg.models.providers[provName].models.push({ id: mid, name: mid, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }); saveCfg(cfg); sessions[userId] = null; await sendMsg(chatId, `✅ <code>${provName}/${mid}</code> 已添加！`, { reply_markup: { inline_keyboard: [[{ text: '◀ 模型管理', callback_data: 'menu_models' }, { text: '🔄 重启', callback_data: 'restart' }]] } }); }
  else if (s.step === 'edit_key') { const { provName } = s; cfg.models.providers[provName].apiKey = text.trim(); saveCfg(cfg); sessions[userId] = null; await sendMsg(chatId, `✅ <code>${provName}</code> Key 已更新！`, { reply_markup: { inline_keyboard: [[{ text: '◀', callback_data: 'menu_keys' }, { text: '🔄', callback_data: 'restart' }]] } }); }
}

async function poll() {
  while (true) {
    try {
      const res = await tgApi('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      if (res.ok && res.result?.length) {
        for (const u of res.result) {
          offset = u.update_id + 1;
          if (u.callback_query) { const cb = u.callback_query; handleCallback(cb.message.chat.id, cb.from.id, cb.message.message_id, cb.data, cb.id).catch(console.error); }
          else if (u.message?.text) { handleText(u.message.chat.id, u.message.from.id, u.message.text).catch(console.error); }
        }
      }
    } catch(e) { console.error('Poll error:', e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
}

console.log('🐱 发财猫模型管理器启动中...');
poll();
SERVEREOF
fi

echo -e "${GREEN}✅ 程序文件已就绪${NC}"

# 创建启动脚本
cat > "$INSTALL_DIR/start.sh" << EOF
#!/bin/bash
export BOT_TOKEN="${BOT_TOKEN}"
cd "$INSTALL_DIR"
exec node server.js
EOF
chmod +x "$INSTALL_DIR/start.sh"

# 尝试配置 systemd 服务（如果有权限）
SERVICE_OK=false
if command -v systemctl &> /dev/null && [ "$(id -u)" = "0" ]; then
    cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=发财猫模型管理器
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/server.js
Environment=BOT_TOKEN=${BOT_TOKEN}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME" 2>/dev/null
    systemctl start "$SERVICE_NAME"
    SERVICE_OK=true
    echo -e "${GREEN}✅ systemd 服务已启动${NC}"
elif command -v pm2 &> /dev/null; then
    cd "$INSTALL_DIR"
    BOT_TOKEN="$BOT_TOKEN" pm2 start server.js --name "$SERVICE_NAME" 2>/dev/null
    pm2 save 2>/dev/null
    SERVICE_OK=true
    echo -e "${GREEN}✅ PM2 服务已启动${NC}"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  🐱 发财猫模型管理器 安装完成！       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Bot：${BLUE}@${BOT_USERNAME}${NC}"
echo -e "  配置：${BLUE}$OPENCLAW_CONFIG${NC}"
echo ""
if [ "$SERVICE_OK" = false ]; then
    echo -e "${YELLOW}📌 手动启动方式：${NC}"
    echo -e "  cd $INSTALL_DIR && BOT_TOKEN='$BOT_TOKEN' node server.js"
    echo ""
fi
echo -e "  ✅ 打开 Telegram，向 @${BOT_USERNAME} 发送 /start"
echo -e "  ${YELLOW}⚠️  首次 /start 会自动注册你的 Telegram ID${NC}"
echo ""
