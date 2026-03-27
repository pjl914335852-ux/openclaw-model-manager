#!/usr/bin/env node
/**
 * 发财猫模型管理器 - 零 Token Telegram Bot
 * 支持多用户独立使用，自动检测各自的 OpenClaw 配置
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

// ===== 配置：从环境变量读取，或使用默认值 =====
function getConfig() {
  const botToken = process.env.MODEL_MANAGER_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!botToken) {
    console.error('❌ 未设置 BOT_TOKEN 环境变量！');
    console.error('请运行: export BOT_TOKEN=你的机器人token');
    process.exit(1);
  }

  // 自动查找 OpenClaw 配置路径
  const candidates = [
    process.env.OPENCLAW_CONFIG,
    path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    '/root/.openclaw/openclaw.json',
  ].filter(Boolean);

  let openclaw_config = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { openclaw_config = p; break; }
  }

  if (!openclaw_config) {
    console.error('❌ 未找到 OpenClaw 配置文件！');
    console.error('请确保 OpenClaw 已安装，或设置 OPENCLAW_CONFIG 环境变量');
    process.exit(1);
  }

  console.log(`✅ 使用配置文件: ${openclaw_config}`);

  // 允许的用户列表：从环境变量读取，或首次消息自动注册
  const allowedUsers = process.env.ALLOWED_USERS
    ? process.env.ALLOWED_USERS.split(',').map(id => parseInt(id.trim())).filter(Boolean)
    : [];

  return { botToken, openclaw_config, allowedUsers };
}

const CONFIG = getConfig();

// 首次使用：自动记住第一个 /start 的用户（如果没有预设）
const registeredFile = path.join(path.dirname(CONFIG.openclaw_config), '.model-manager-users.json');
let dynamicUsers = [];
try {
  if (fs.existsSync(registeredFile)) {
    dynamicUsers = JSON.parse(fs.readFileSync(registeredFile, 'utf8'));
  }
} catch(e) {}

function isAllowed(userId) {
  if (CONFIG.allowedUsers.length > 0) return CONFIG.allowedUsers.includes(userId);
  return dynamicUsers.includes(userId);
}

function registerUser(userId) {
  if (!dynamicUsers.includes(userId)) {
    dynamicUsers.push(userId);
    try { fs.writeFileSync(registeredFile, JSON.stringify(dynamicUsers)); } catch(e) {}
  }
}

const sessions = {};
const cronCache = {}; // 缓存 cron 任务，key: userId, value: { jobs: [], timestamp: number }
const codeJobs = {}; // key: userId, value: active job
const codeJobIndex = {}; // key: jobId, value: job data
const CODE_JOB_TTL = 30 * 60 * 1000;
const CODE_JOB_TIMEOUT = 20 * 60 * 1000;
const CODE_REPOS = {
  root: '/root',
  manager: '/root/model-manager',
  openclaw: '/root/openclaw-trading-scout',
  orchestrator: '/root/openclaw-strategy-orchestrator',
  nofx: '/root/nofx',
};
let offset = 0;

function tgApi(method, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${CONFIG.botToken}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendMsg(chatId, text, extra = {}) {
  return tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}
async function editMsg(chatId, messageId, text, extra = {}) {
  const res = await tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });
  if (!res.ok) console.error('[editMsg ERROR]', JSON.stringify(res));
  return res;
}
function answerCallback(id, text = '') {
  return tgApi('answerCallbackQuery', { callback_query_id: id, text });
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function splitTelegramHtml(text, limit = 3500) {
  const input = String(text || '');
  if (input.length <= limit) return [input];
  const chunks = [];
  let remaining = input;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n\n', limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendLongMsg(chatId, text, extra = {}) {
  const parts = splitTelegramHtml(text);
  const results = [];
  for (let i = 0; i < parts.length; i++) {
    const payload = i === 0 ? extra : {};
    results.push(await sendMsg(chatId, parts[i], payload));
  }
  return results;
}

function getCodeRepoEntries() {
  return Object.entries(CODE_REPOS)
    .filter(([, repoPath]) => fs.existsSync(repoPath))
    .map(([key, repoPath]) => `${key}: <code>${escapeHtml(repoPath)}</code>`);
}

function makeCodeJobId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function parseCodeCommand(text) {
  const raw = text.replace(/^\/code\s*/, '').trim();
  if (!raw) return { repoKey: '', taskText: '' };
  const firstSpace = raw.indexOf(' ');
  if (firstSpace === -1) return { repoKey: raw, taskText: '' };
  return {
    repoKey: raw.slice(0, firstSpace).trim(),
    taskText: raw.slice(firstSpace + 1).trim(),
  };
}

function getCodeJob(jobId) {
  const job = codeJobIndex[jobId];
  if (!job) return null;
  if (job.finishedAt && (Date.now() - job.finishedAt > CODE_JOB_TTL)) {
    delete codeJobIndex[jobId];
    if (codeJobs[job.userId]?.jobId === jobId) delete codeJobs[job.userId];
    return null;
  }
  return job;
}

function cleanupCodeJob(job) {
  if (!job) return;
  if (codeJobs[job.userId]?.jobId === job.jobId) delete codeJobs[job.userId];
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    delete codeJobIndex[job.jobId];
  }, CODE_JOB_TTL);
}

function appendJobTail(job, field, text, maxLen = 4000) {
  job[field] = ((job[field] || '') + text).slice(-maxLen);
}

function getElapsedText(job) {
  const end = job.finishedAt || Date.now();
  const secs = Math.max(1, Math.floor((end - job.startedAt) / 1000));
  if (secs < 60) return `${secs}秒`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}分${rem}秒` : `${mins}分`;
}

function renderCodeJobKeyboard(job) {
  if (job.status === 'running' || job.status === 'queued') {
    return {
      inline_keyboard: [
        [
          { text: '🔄 刷新', callback_data: `code_refresh_${job.jobId}` },
          { text: '⛔ 停止', callback_data: `code_cancel_${job.jobId}` }
        ]
      ]
    };
  }
  return {
    inline_keyboard: [
      [
        { text: '📋 状态', callback_data: `code_status_${job.jobId}` },
        { text: '🧾 Diff', callback_data: `code_showdiff_${job.jobId}` }
      ],
      [
        { text: '🔁 重跑', callback_data: `code_rerun_${job.jobId}` }
      ]
    ]
  };
}

function renderCodeJob(job) {
  const statusMap = {
    queued: '⏳ 排队中',
    running: '🤖 执行中',
    succeeded: '✅ 已完成',
    failed: '❌ 失败',
    canceled: '⛔ 已停止',
  };
  let text = `🤖 <b>Claude 代码任务</b>\n\n`;
  text += `任务ID：<code>${job.jobId}</code>\n`;
  text += `仓库：<b>${escapeHtml(job.repoKey)}</b>\n`;
  text += `路径：<code>${escapeHtml(job.repoPath)}</code>\n`;
  text += `状态：${statusMap[job.status] || escapeHtml(job.status)}\n`;
  text += `耗时：${getElapsedText(job)}\n\n`;
  text += `<b>需求</b>\n<pre>${escapeHtml(job.taskText.slice(0, 1200))}</pre>`;

  const tail = (job.stderrTail || job.stdoutTail || '').trim();
  if (tail) {
    text += `\n\n<b>最近输出</b>\n<pre>${escapeHtml(tail.slice(-1200))}</pre>`;
  }

  if (job.git?.diffStat) {
    text += `\n\n<b>变更摘要</b>\n<pre>${escapeHtml(job.git.diffStat.slice(0, 1200))}</pre>`;
  }

  if (job.exitCode !== null && job.exitCode !== undefined) {
    text += `\n\n退出码：<code>${job.exitCode}</code>`;
  }

  return text;
}

function runReadOnlyCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => { stdout += buf.toString(); });
    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.on('error', (error) => resolve({ ok: false, stdout, stderr: stderr + error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function collectGitSummary(repoPath) {
  const [branch, statusShort, diffStat, diffNameOnly, diffPatch] = await Promise.all([
    runReadOnlyCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoPath),
    runReadOnlyCommand('git', ['status', '--short'], repoPath),
    runReadOnlyCommand('git', ['diff', '--stat'], repoPath),
    runReadOnlyCommand('git', ['diff', '--name-only'], repoPath),
    runReadOnlyCommand('git', ['diff', '--unified=1'], repoPath),
  ]);

  return {
    branch: branch.stdout || 'unknown',
    statusShort: statusShort.stdout || '',
    diffStat: diffStat.stdout || '',
    diffNameOnly: diffNameOnly.stdout || '',
    diffPatch: (diffPatch.stdout || '').slice(0, 12000),
  };
}

function buildDiffSummary(job) {
  const git = job.git || {};
  let text = `🧾 <b>代码变更</b>\n\n`;
  text += `任务ID：<code>${job.jobId}</code>\n`;
  text += `仓库：<b>${escapeHtml(job.repoKey)}</b>\n`;
  text += `分支：<code>${escapeHtml(git.branch || 'unknown')}</code>\n\n`;

  if (git.diffNameOnly) {
    text += `<b>修改文件</b>\n<pre>${escapeHtml(git.diffNameOnly)}</pre>\n\n`;
  }

  if (git.diffStat) {
    text += `<b>Diff Stat</b>\n<pre>${escapeHtml(git.diffStat)}</pre>`;
  } else if (git.statusShort) {
    text += `<b>工作区状态</b>\n<pre>${escapeHtml(git.statusShort)}</pre>`;
  } else {
    text += `没有检测到工作区变更。`;
  }

  if (git.diffPatch) {
    text += `\n\n<b>Patch 预览（截断）</b>\n<pre>${escapeHtml(git.diffPatch)}</pre>`;
  }

  return text;
}

function getCodeJobStatusLabel(status) {
  return {
    queued: '排队中',
    running: '执行中',
    succeeded: '已完成',
    failed: '失败',
    canceled: '已停止',
  }[status] || status;
}

async function updateCodeJobMessage(job, force = false) {
  if (!job.progressMessageId) return;
  const now = Date.now();
  if (!force && job.lastProgressAt && now - job.lastProgressAt < 3000) return;
  job.lastProgressAt = now;
  await editMsg(job.chatId, job.progressMessageId, renderCodeJob(job), { reply_markup: renderCodeJobKeyboard(job) });
}

async function finalizeCodeJob(job) {
  job.finishedAt = Date.now();
  job.git = await collectGitSummary(job.repoPath);
  await updateCodeJobMessage(job, true);

  let summary = `📦 <b>任务结果</b>\n\n`;
  summary += `任务ID：<code>${job.jobId}</code>\n`;
  summary += `仓库：<b>${escapeHtml(job.repoKey)}</b>\n`;
  summary += `状态：<b>${escapeHtml(getCodeJobStatusLabel(job.status))}</b>\n`;
  summary += `耗时：${getElapsedText(job)}\n`;
  summary += `分支：<code>${escapeHtml(job.git.branch || 'unknown')}</code>\n`;
  if (job.git.diffStat) {
    summary += `\n<b>Diff Stat</b>\n<pre>${escapeHtml(job.git.diffStat.slice(0, 2500))}</pre>`;
  } else if (job.git.statusShort) {
    summary += `\n<b>工作区状态</b>\n<pre>${escapeHtml(job.git.statusShort.slice(0, 2500))}</pre>`;
  } else {
    summary += `\n没有检测到工作区变更。`;
  }

  if (job.status === 'failed' && job.stderrTail) {
    summary += `\n\n<b>错误输出</b>\n<pre>${escapeHtml(job.stderrTail.slice(-2000))}</pre>`;
  }

  await sendLongMsg(job.chatId, summary, { reply_markup: renderCodeJobKeyboard(job) });
  cleanupCodeJob(job);
}

function buildClaudePrompt(job) {
  return [
    '你正在服务器上的目标仓库中直接工作。',
    '完成下面的编码任务。',
    '修改代码后，请在最终输出里简要说明：改了哪些文件、做了什么验证、是否还有阻塞。',
    '',
    `仓库键名: ${job.repoKey}`,
    `任务: ${job.taskText}`,
  ].join('\n');
}

function startCodeJob(job) {
  const args = [
    '--print',
    '--output-format', 'text',
    '--permission-mode', 'auto',
    buildClaudePrompt(job),
  ];

  job.status = 'running';
  job.startedAt = Date.now();
  job.stdoutTail = '';
  job.stderrTail = '';
  job.exitCode = null;
  job.child = spawn('claude', args, {
    cwd: job.repoPath,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  job.timeoutTimer = setTimeout(() => {
    if (job.status === 'running' && job.child) {
      job.stderrTail = `${job.stderrTail || ''}\n[timeout] Claude 任务超时，已终止。`;
      job.child.kill('SIGTERM');
    }
  }, CODE_JOB_TIMEOUT);

  job.child.stdout.on('data', (buf) => {
    appendJobTail(job, 'stdoutTail', buf.toString());
    updateCodeJobMessage(job).catch(console.error);
  });

  job.child.stderr.on('data', (buf) => {
    appendJobTail(job, 'stderrTail', buf.toString());
    updateCodeJobMessage(job).catch(console.error);
  });

  job.child.on('error', async (error) => {
    appendJobTail(job, 'stderrTail', `\n${error.message}`);
    job.status = 'failed';
    job.exitCode = -1;
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    await finalizeCodeJob(job);
  });

  job.child.on('close', async (code, signal) => {
    job.exitCode = code;
    job.signal = signal;
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    if (job.status !== 'canceled') {
      job.status = code === 0 ? 'succeeded' : 'failed';
    }
    await finalizeCodeJob(job);
  });
}

async function handleCodeCallback(chatId, userId, msgId, data) {
  const parts = data.split('_');
  const action = parts[1];
  const jobId = parts.slice(2).join('_');
  const job = getCodeJob(jobId);

  if (!job || job.userId !== userId) {
    await editMsg(chatId, msgId, '❌ 任务不存在或已过期');
    return;
  }

  if (action === 'refresh' || action === 'status') {
    if (msgId === job.progressMessageId) {
      await updateCodeJobMessage(job, true);
    } else {
      await sendLongMsg(chatId, renderCodeJob(job), { reply_markup: renderCodeJobKeyboard(job) });
    }
    return;
  }

  if (action === 'cancel') {
    if (job.status === 'running' && job.child) {
      job.status = 'canceled';
      appendJobTail(job, 'stderrTail', '\n[user] 已从 Telegram 请求停止任务。');
      job.child.kill('SIGTERM');
      await updateCodeJobMessage(job, true);
    } else {
      await editMsg(chatId, msgId, renderCodeJob(job), { reply_markup: renderCodeJobKeyboard(job) });
    }
    return;
  }

  if (action === 'showdiff') {
    await sendLongMsg(chatId, buildDiffSummary(job), { reply_markup: renderCodeJobKeyboard(job) });
    return;
  }

  if (action === 'rerun') {
    if (codeJobs[userId] && codeJobs[userId].status === 'running') {
      await sendMsg(chatId, '⚠️ 当前已有运行中的代码任务，请先等待完成或停止。');
      return;
    }

    const newJob = {
      jobId: makeCodeJobId(),
      userId,
      chatId,
      repoKey: job.repoKey,
      repoPath: job.repoPath,
      taskText: job.taskText,
      status: 'queued',
      startedAt: Date.now(),
      finishedAt: null,
      progressMessageId: null,
      stdoutTail: '',
      stderrTail: '',
      exitCode: null,
      git: null,
    };
    codeJobs[userId] = newJob;
    codeJobIndex[newJob.jobId] = newJob;
    const sent = await sendMsg(chatId, renderCodeJob(newJob), { reply_markup: renderCodeJobKeyboard(newJob) });
    newJob.progressMessageId = sent.result?.message_id;
    startCodeJob(newJob);
    return;
  }
}
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG.openclaw_config, 'utf8'));
}
function saveConfig(config) {
  // 备份后写入
  const backupPath = CONFIG.openclaw_config + '.bak.' + Date.now();
  fs.copyFileSync(CONFIG.openclaw_config, backupPath);
  fs.writeFileSync(CONFIG.openclaw_config, JSON.stringify(config, null, 2));
  // 只保留最近3个备份
  try {
    const dir = path.dirname(CONFIG.openclaw_config);
    const base = path.basename(CONFIG.openclaw_config);
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.bak.'))
      .sort().reverse();
    backups.slice(3).forEach(f => {
      try { fs.unlinkSync(path.join(dir, f)); } catch(e) {}
    });
  } catch(e) {}
  // 自动重启 Gateway 让配置生效
  try { restartGateway(); } catch(e) {}
}
function restartGateway() {
  try {
    // 先检查网关是否在运行
    const statusOut = execSync('openclaw gateway status 2>/dev/null || echo "stopped"', { encoding: 'utf8', timeout: 5000 });
    const isRunning = !statusOut.includes('stopped') && !statusOut.includes('inactive') && !statusOut.includes('failed');
    if (isRunning) {
      execSync('openclaw gateway restart', { timeout: 10000 });
    } else {
      execSync('openclaw gateway start', { timeout: 10000 });
    }
    return true;
  } catch (e) {
    // 兜底：先 start 再 restart
    try { execSync('openclaw gateway start 2>/dev/null || openclaw gateway restart', { timeout: 10000 }); return true; }
    catch { return false; }
  }
}

// Provider 模板
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
  'openai': {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }
    ]
  },
  'anthropic': {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    api: 'anthropic-messages',
    models: [
      { id: 'claude-opus-4-6-20260205', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6-20260205', name: 'Claude Sonnet 4.6' },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' }
    ]
  },
  'google': {
    name: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'google-ai',
    models: [
      { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash' },
      { id: 'gemini-exp-1206', name: 'Gemini Exp 1206' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' }
    ]
  }
};

function mainMenu() {
  return { inline_keyboard: [
    [{ text: '🔌 渠道管理', callback_data: 'menu_channels' }, { text: '⏰ 定时任务', callback_data: 'menu_cron' }],
    [{ text: '🎯 默认模型', callback_data: 'set_default' }, { text: '💻 系统监控', callback_data: 'system_monitor' }],
    [{ text: '👁 查看配置', callback_data: 'view_config' }, { text: '🔄 重启生效', callback_data: 'restart' }],
  ]};
}

// 渠道列表菜单（合并原密钥管理+模型管理）
function channelsMenu(config) {
  const providers = config.models?.providers || {};
  const buttons = Object.entries(providers).map(([name, p]) => {
    const modelCount = (p.models || []).length;
    return [{ text: `🔌 ${name}  (${modelCount}个模型)`, callback_data: `channel_detail_${name}` }];
  });
  return { inline_keyboard: [
    ...buttons,
    [{ text: '➕ 添加渠道', callback_data: 'add_provider' }],
    [{ text: '◀ 返回', callback_data: 'main_menu' }],
  ]};
}

// 单个渠道详情菜单
function channelDetailMenu(config, provName) {
  const prov = config.models?.providers?.[provName] || {};
  const models = prov.models || [];
  const modelButtons = models.map(m => [
    { text: `📦 ${m.id}`, callback_data: `noop` },
    { text: `❌ 删除`, callback_data: `dm_${provName}__${m.id}` },
  ]);
  return { inline_keyboard: [
    [{ text: `🔑 修改 API Key`, callback_data: `edit_key_${provName}` }],
    [{ text: `➕ 添加模型`, callback_data: `add_model_to_${provName}` }],
    ...modelButtons,
    [{ text: `🗑️ 删除整个渠道`, callback_data: `del_provider_${provName}` }],
    [{ text: '◀ 返回渠道列表', callback_data: 'menu_channels' }],
  ]};
}

// 保留旧函数名兼容（部分地方还在用）
function keysMenu(config) { return channelsMenu(config); }
function modelsMenu(config) { return channelsMenu(config); }

function cronEditMenu(jobId) {
  return { inline_keyboard: [
    [{ text: '🤖 选择模型', callback_data: `cron_select_model_${jobId}` }],
    [{ text: '🗑️ 删除任务', callback_data: `del_cron_${jobId}` }],
    [{ text: '◀ 返回', callback_data: 'menu_cron' }],
  ]};
}

// 获取 OpenClaw cron 任务列表（带缓存）
function getOpenClawCronJobs(userId, forceRefresh = false) {
  const now = Date.now();
  const cache = cronCache[userId];
  
  // 如果有缓存且未过期（5分钟内），且不是强制刷新，返回缓存
  if (!forceRefresh && cache && (now - cache.timestamp < 300000)) {
    console.log('[Cron] 使用缓存，任务数:', cache.jobs.length);
    return cache.jobs;
  }
  
  try {
    console.log('[Cron] 正在获取任务列表...');
    const output = execSync('openclaw cron list --json 2>/dev/null', { encoding: 'utf8', timeout: 15000 });
    const data = JSON.parse(output);
    const jobs = data.jobs || [];
    
    // 更新缓存
    cronCache[userId] = { jobs, timestamp: now };
    console.log('[Cron] 获取成功，任务数:', jobs.length);
    
    return jobs;
  } catch (e) {
    console.error('[Cron] 获取任务失败:', e.message);
    // 如果获取失败但有缓存，返回缓存
    if (cache) {
      console.log('[Cron] 获取失败，使用旧缓存');
      return cache.jobs;
    }
    return [];
  }
}

// 更新 cron 任务的模型
function updateCronJobModel(jobId, model) {
  try {
    const cmd = `openclaw cron edit ${jobId} --model "${model}"`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    console.log('[Cron] 更新模型成功:', output);
    return true;
  } catch (e) {
    console.error('更新 cron 任务模型失败:', e.message);
    return false;
  }
}

// 删除 cron 任务
function deleteCronJob(jobId) {
  try {
    execSync(`openclaw cron remove ${jobId}`, { timeout: 15000 });
    return true;
  } catch (e) {
    console.error('删除 cron 任务失败:', e.message);
    return false;
  }
}

async function handleCallback(chatId, userId, msgId, data, cbId) {
  if (!isAllowed(userId)) { await answerCallback(cbId, '❌ 无权限'); return; }
  await answerCallback(cbId);
  const config = loadConfig();

  if (data.startsWith('code_')) {
    await handleCodeCallback(chatId, userId, msgId, data, cbId);

  } else if (data === 'main_menu') {
    await editMsg(chatId, msgId, '🐱 <b>发财猫模型管理器</b>\n\n选择操作：', { reply_markup: mainMenu() });

  } else if (data === 'menu_channels' || data === 'menu_channels' || data === 'menu_channels') {
    const providers = config.models?.providers || {};
    const count = Object.keys(providers).length;
    const def = config.agents?.defaults?.model?.primary || '未设置';
    await editMsg(chatId, msgId,
      `🔌 <b>渠道管理</b>\n\n共 ${count} 个渠道\n默认模型：<code>${def}</code>\n\n点击渠道查看详情和操作`,
      { reply_markup: channelsMenu(config) });

  } else if (data.startsWith('channel_detail_')) {
    const provName = data.slice('channel_detail_'.length);
    const prov = config.models?.providers?.[provName] || {};
    const models = (prov.models || []).map(m => `• <code>${m.id}</code>`).join('\n') || '暂无模型';
    const keyPreview = prov.apiKey ? `<code>${prov.apiKey.slice(0,20)}...</code>` : '未设置';
    const baseUrl = prov.baseUrl || '官方默认';
    await editMsg(chatId, msgId,
      `🔌 <b>${provName}</b>\n\nURL: <code>${baseUrl}</code>\nKey: ${keyPreview}\n\n模型列表：\n${models}`,
      { reply_markup: channelDetailMenu(config, provName) });

  } else if (data === 'noop') {
    await answerCallback(cbId);

  } else if (data === 'menu_cron' || data === 'cron_refresh') {
    const forceRefresh = data === 'cron_refresh';
    const jobs = getOpenClawCronJobs(userId, forceRefresh);
    
    let text = '⏰ <b>定时任务管理</b>\n\n';
    if (jobs.length === 0) {
      text += '暂无定时任务\n\n';
      text += '💡 提示：点击"🔄 刷新"重新获取任务列表';
    } else {
      text += `共 ${jobs.length} 个任务\n\n`;
      jobs.forEach((job) => {
        const status = job.enabled !== false ? '✅' : '❌';
        const modelText = job.payload?.model || '默认模型';
        const scheduleText = job.schedule?.expr || '未设置';
        text += `${status} <b>${job.name || job.id}</b>\n`;
        text += `   模型: <code>${modelText}</code>\n`;
        text += `   时间: <code>${scheduleText}</code>\n\n`;
      });
    }
    
    const buttons = jobs.map((job) => [{ 
      text: `⚙️ ${job.name || job.id}`, 
      callback_data: `edit_cron_${job.id}` 
    }]);
    buttons.push([{ text: '🔄 刷新任务列表', callback_data: 'cron_refresh' }]);
    buttons.push([{ text: '◀ 返回', callback_data: 'main_menu' }]);
    
    await editMsg(chatId, msgId, text, { reply_markup: { inline_keyboard: buttons } });

  } else if (data.startsWith('edit_cron_')) {
    const jobId = data.replace('edit_cron_', '');
    const jobs = getOpenClawCronJobs(userId, false); // 使用缓存
    const job = jobs.find(j => j.id === jobId);
    
    if (!job) {
      await editMsg(chatId, msgId, '❌ 任务不存在或已被删除\n\n请返回刷新任务列表', { 
        reply_markup: { inline_keyboard: [[{ text: '🔄 刷新', callback_data: 'cron_refresh' }]] } 
      });
      return;
    }
    
    const status = job.enabled !== false ? '✅ 已启用' : '❌ 已禁用';
    const modelText = job.payload?.model || '默认模型';
    const scheduleText = job.schedule?.expr || '未设置';
    const nextRun = job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString('zh-CN') : '未知';
    
    let text = `⚙️ <b>编辑定时任务</b>\n\n`;
    text += `名称: <b>${job.name || job.id}</b>\n`;
    text += `时间: <code>${scheduleText}</code>\n`;
    text += `模型: <code>${modelText}</code>\n`;
    text += `状态: ${status}\n`;
    text += `下次运行: ${nextRun}\n`;
    
    await editMsg(chatId, msgId, text, { reply_markup: cronEditMenu(jobId) });

  } else if (data.startsWith('cron_select_model_')) {
    const jobId = data.replace('cron_select_model_', '');
    const providers = config.models?.providers || {};
    const allModels = [];
    for (const [provName, prov] of Object.entries(providers)) {
      for (const m of (prov.models||[])) allModels.push(`${provName}/${m.id}`);
    }
    // 用短索引避免 callback_data 超过 64 字节限制
    const shortJobId = jobId.split('-')[0]; // 取 UUID 前8位
    const buttons = allModels.map((m, i) => [{
      text: m,
      callback_data: `csm_${shortJobId}_${i}`
    }]);
    // 把完整映射存到临时缓存
    if (!global.modelSelectCache) global.modelSelectCache = {};
    global.modelSelectCache[shortJobId] = { jobId, models: allModels };
    buttons.push([{ text: '◀ 返回', callback_data: `edit_cron_${jobId}` }]);
    await editMsg(chatId, msgId, '🤖 选择模型：', { reply_markup: { inline_keyboard: buttons } });

  } else if (data.startsWith('csm_')) {
    // csm_<shortJobId>_<index>
    const parts = data.split('_');
    const shortJobId = parts[1];
    const idx = parseInt(parts[2]);
    const cache = global.modelSelectCache?.[shortJobId];
    if (!cache) {
      await answerCallback(cbId, '❌ 缓存过期，请重新选择');
      return;
    }
    const { jobId, models } = cache;
    const modelId = models[idx];
    const success = updateCronJobModel(jobId, modelId);
    
    if (success) {
      // 清除缓存，强制下次刷新
      delete cronCache[userId];
      
      await editMsg(chatId, msgId, `✅ 已设置模型: <code>${modelId}</code>\n\n记得重启 Gateway 生效！`, {
        reply_markup: { inline_keyboard: [
          [{ text: '◀ 返回', callback_data: `edit_cron_${jobId}` }],
          [{ text: '🔄 重启', callback_data: 'restart' }]
        ]}
      });
    } else {
      await editMsg(chatId, msgId, `❌ 设置失败，请检查日志`, {
        reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: `edit_cron_${jobId}` }]] }
      });
    }

  } else if (data.startsWith('del_cron_')) {
    const jobId = data.replace('del_cron_', '');
    const jobs = getOpenClawCronJobs(userId, false); // 使用缓存
    const job = jobs.find(j => j.id === jobId);
    
    if (!job) {
      await editMsg(chatId, msgId, '❌ 任务不存在', { 
        reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'menu_cron' }]] } 
      });
      return;
    }
    
    // 二次确认
    await editMsg(chatId, msgId, `⚠️ <b>确认删除定时任务？</b>\n\n名称: <b>${job.name || job.id}</b>\n时间: <code>${job.schedule?.expr || '未设置'}</code>\n\n⚠️ 删除后无法恢复！`, {
      reply_markup: { inline_keyboard: [
        [{ text: '✅ 确认删除', callback_data: `confirm_del_cron_${jobId}` }],
        [{ text: '❌ 取消', callback_data: `edit_cron_${jobId}` }]
      ]}
    });

  } else if (data.startsWith('confirm_del_cron_')) {
    const jobId = data.replace('confirm_del_cron_', '');
    const success = deleteCronJob(jobId);
    
    if (success) {
      // 清除缓存，强制下次刷新
      delete cronCache[userId];
      
      await editMsg(chatId, msgId, `✅ 定时任务已删除`, {
        reply_markup: { inline_keyboard: [[{ text: '◀ 返回任务列表', callback_data: 'cron_refresh' }]] }
      });
    } else {
      await editMsg(chatId, msgId, `❌ 删除失败，请检查日志`, {
        reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: `edit_cron_${jobId}` }]] }
      });
    }

  } else if (data === 'view_config') {
    const providers = config.models?.providers || {};
    let text = '📋 <b>当前配置概览</b>\n\n';
    text += `默认模型：<code>${config.agents?.defaults?.model?.primary || '未设置'}</code>\n\n`;
    text += '<b>Providers：</b>\n';
    for (const [name, p] of Object.entries(providers)) {
      text += `\n<b>${name}</b>\n`;
      text += `  URL: <code>${p.baseUrl || '官方'}</code>\n`;
      text += `  Key: <code>${(p.apiKey||'').slice(0,20)}...</code>\n`;
      text += `  模型: <code>${(p.models||[]).map(m=>m.id).join(', ')||'无'}</code>\n`;
    }
    await editMsg(chatId, msgId, text, { reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'main_menu' }]] } });

  } else if (data === 'restart') {
    await editMsg(chatId, msgId, '🔄 正在重启 OpenClaw...', {});
    const ok = restartGateway();
    await editMsg(chatId, msgId, ok ? '✅ 重启成功，新配置已生效！' : '⚠️ 已发送重启信号', {
      reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'main_menu' }]] }
    });

  } else if (data.startsWith('del_provider_')) {
    const provName = data.replace('del_provider_', '');
    // 二次确认
    await editMsg(chatId, msgId, `⚠️ <b>确认删除 Provider？</b>\n\n名称：<code>${provName}</code>\n\n⚠️ 这将删除该 Provider 的所有配置和模型！`, {
      reply_markup: { inline_keyboard: [
        [{ text: '✅ 确认删除', callback_data: `confirm_del_provider_${provName}` }],
        [{ text: '❌ 取消', callback_data: 'menu_channels' }]
      ]}
    });

  } else if (data.startsWith('confirm_del_provider_')) {
    const provName = data.replace('confirm_del_provider_', '');
    delete config.models.providers[provName];
    // 清理 agents.defaults.models 里该 provider 的所有模型
    if (config.agents?.defaults?.models) {
      Object.keys(config.agents.defaults.models).forEach(k => {
        if (k.startsWith(provName + '/')) delete config.agents.defaults.models[k];
      });
    }
    // 清理 channels.modelByChannel 里引用该 provider 的配置
    if (config.channels?.modelByChannel) {
      Object.keys(config.channels.modelByChannel).forEach(ch => {
        Object.keys(config.channels.modelByChannel[ch]).forEach(id => {
          if (config.channels.modelByChannel[ch][id]?.startsWith(provName + '/')) {
            delete config.channels.modelByChannel[ch][id];
          }
        });
      });
    }
    saveConfig(config);
    // 同步清理 agents/main/agent/models.json 缓存
    try {
      const agentModelsPath = path.join(path.dirname(CONFIG.openclaw_config), 'agents', 'main', 'agent', 'models.json');
      if (fs.existsSync(agentModelsPath)) {
        const am = JSON.parse(fs.readFileSync(agentModelsPath, 'utf8'));
        if (am.providers?.[provName]) delete am.providers[provName];
        if (am.usage) {
          Object.keys(am.usage).forEach(k => { if (k.startsWith(provName + '/')) delete am.usage[k]; });
        }
        fs.writeFileSync(agentModelsPath, JSON.stringify(am, null, 2));
      }
    } catch(e) { console.error('同步 models.json 失败:', e.message); }
    await editMsg(chatId, msgId, `✅ 已删除 Provider: <code>${provName}</code>\n记得重启生效`, {
      reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'menu_channels' }, { text: '🔄 重启', callback_data: 'restart' }]] }
    });

  } else if (data.startsWith('dm_')) {
    const parts = data.replace('dm_', '').split('__');
    const provName = parts[0], modelId = parts.slice(1).join('__');
    // 二次确认
    await editMsg(chatId, msgId, `⚠️ <b>确认删除模型？</b>\n\n模型：<code>${provName}/${modelId}</code>\n\n⚠️ 删除后无法恢复！`, {
      reply_markup: { inline_keyboard: [
        [{ text: '✅ 确认删除', callback_data: `cdm_${provName}__${modelId}` }],
        [{ text: '❌ 取消', callback_data: 'menu_channels' }]
      ]}
    });

  } else if (data.startsWith('cdm_')) {
    const parts = data.replace('cdm_', '').split('__');
    const provName = parts[0], modelId = parts.slice(1).join('__');
    if (config.models?.providers?.[provName]) {
      config.models.providers[provName].models = (config.models.providers[provName].models||[]).filter(m => m.id !== modelId);
      if (config.agents?.defaults?.models) delete config.agents.defaults.models[`${provName}/${modelId}`];
      // 清理 channels.modelByChannel 里引用该模型的配置
      if (config.channels?.modelByChannel) {
        Object.keys(config.channels.modelByChannel).forEach(ch => {
          Object.keys(config.channels.modelByChannel[ch]).forEach(id => {
            if (config.channels.modelByChannel[ch][id] === `${provName}/${modelId}`) {
              delete config.channels.modelByChannel[ch][id];
            }
          });
        });
      }
      saveConfig(config);
      // 同步清理 agents/main/agent/models.json 缓存
      try {
        const agentModelsPath = path.join(path.dirname(CONFIG.openclaw_config), 'agents', 'main', 'agent', 'models.json');
        if (fs.existsSync(agentModelsPath)) {
          const am = JSON.parse(fs.readFileSync(agentModelsPath, 'utf8'));
          if (am.providers?.[provName]?.models) {
            am.providers[provName].models = am.providers[provName].models.filter(m => m.id !== modelId);
          }
          if (am.usage) delete am.usage[`${provName}/${modelId}`];
          fs.writeFileSync(agentModelsPath, JSON.stringify(am, null, 2));
        }
      } catch(e) { console.error('同步 models.json 失败:', e.message); }
      // 同步更新 cron/jobs.json 里引用该模型的任务
      try {
        const cronPath = path.join(path.dirname(CONFIG.openclaw_config), 'cron', 'jobs.json');
        if (fs.existsSync(cronPath)) {
          let cronRaw = fs.readFileSync(cronPath, 'utf8');
          const oldModel = `${provName}/${modelId}`;
          if (cronRaw.includes(oldModel)) {
            // 找该 provider 下第一个可用模型替换
            const fallback = config.models?.providers?.[provName]?.models?.[0]?.id;
            if (fallback) {
              cronRaw = cronRaw.split(oldModel).join(`${provName}/${fallback}`);
              fs.writeFileSync(cronPath, cronRaw);
            }
          }
        }
      } catch(e) { console.error('同步 cron/jobs.json 失败:', e.message); }
    }
    await editMsg(chatId, msgId, `✅ 已删除模型: <code>${provName}/${modelId}</code>\n记得重启生效`, {
      reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'menu_channels' }, { text: '🔄 重启', callback_data: 'restart' }]] }
    });

  } else if (data === 'add_provider') {
    // 显示 Provider 模板选择
    const buttons = Object.entries(PROVIDER_TEMPLATES).map(([id, tpl]) => [
      { text: `📦 ${tpl.name}`, callback_data: `add_provider_template_${id}` }
    ]);
    buttons.push([{ text: '🔧 自定义配置', callback_data: 'add_provider_custom' }]);
    buttons.push([{ text: '❌ 取消', callback_data: 'menu_channels' }]);
    await editMsg(chatId, msgId, '➕ <b>添加新 Provider</b>\n\n选择 Provider 类型：', {
      reply_markup: { inline_keyboard: buttons }
    });

  } else if (data.startsWith('add_provider_template_')) {
    const templateId = data.replace('add_provider_template_', '');
    const template = PROVIDER_TEMPLATES[templateId];
    if (!template) {
      await editMsg(chatId, msgId, '❌ 无效的模板', { reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'add_provider' }]] } });
      return;
    }
    
    // 显示模板信息
    let text = `📦 <b>${template.name}</b>\n\n`;
    text += `🔗 Base URL: <code>${template.baseUrl}</code>\n`;
    text += `🔌 API 类型: ${template.api}\n\n`;
    text += `📋 <b>支持的模型：</b>\n`;
    template.models.forEach((m, i) => {
      text += `${i+1}. ${m.name}\n   ID: <code>${m.id}</code>\n`;
    });
    text += `\n请发送 ${template.name} 的 API Key：`;
    
    sessions[userId] = { 
      step: 'add_provider_template_key', 
      templateId,
      provName: templateId 
    };
    await editMsg(chatId, msgId, text, {
      reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'menu_channels' }]] }
    });

  } else if (data === 'add_provider_custom') {
    sessions[userId] = { step: 'add_provider_name' };
    await editMsg(chatId, msgId, '🔧 <b>自定义 Provider</b>\n\n请发送 Provider 名称（如：my-relay）：', {
      reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'menu_channels' }]] }
    });

  } else if (data === 'add_model') {
    const providers = Object.keys(config.models?.providers || {});
    await editMsg(chatId, msgId, '➕ <b>添加模型</b>\n\n选择 Provider：', {
      reply_markup: { inline_keyboard: [
        ...providers.map(p => [{ text: p, callback_data: `add_model_to_${p}` }]),
        [{ text: '取消', callback_data: 'main_menu' }]
      ]}
    });

  } else if (data.startsWith('add_model_to_')) {
    const provName = data.replace('add_model_to_', '');
    sessions[userId] = { step: 'add_model_id', provName };
    await editMsg(chatId, msgId, `➕ 向 <code>${provName}</code> 添加模型\n\n请发送模型 ID：`, {
      reply_markup: { inline_keyboard: [[{ text: '取消', callback_data: 'main_menu' }]] }
    });

  } else if (data === 'set_default') {
    const providers = config.models?.providers || {};
    const allModels = [];
    for (const [provName, prov] of Object.entries(providers)) {
      for (const m of (prov.models||[])) allModels.push(`${provName}/${m.id}`);
    }
    await editMsg(chatId, msgId, '🎯 <b>设置默认模型</b>\n\n选择：', {
      reply_markup: { inline_keyboard: [
        ...allModels.map(m => [{ text: m, callback_data: `set_def_${m}` }]),
        [{ text: '取消', callback_data: 'main_menu' }]
      ]}
    });

  } else if (data.startsWith('set_def_')) {
    const model = data.replace('set_def_', '');
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    config.agents.defaults.model = { primary: model, fallbacks: [] };
    saveConfig(config);
    await editMsg(chatId, msgId, `✅ 默认模型已设为：<code>${model}</code>\n\nGateway 正在重启，约5秒后生效`, {
      reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'main_menu' }]] }
    });

  } else if (data.startsWith('edit_key_')) {
    const provName = data.replace('edit_key_', '');
    sessions[userId] = { step: 'edit_key', provName };
    await editMsg(chatId, msgId, `🔑 修改 <code>${provName}</code> 的 API Key\n\n请发送新的 Key：`, {
      reply_markup: { inline_keyboard: [[{ text: '取消', callback_data: 'main_menu' }]] }
    });
  } else if (data === 'system_monitor') {
    await handleSystemCommand(chatId, msgId);
  }
}

// 系统监控命令
async function handleSystemCommand(chatId, msgId = null) {
  try {
    // Get system info
    const memInfo = execSync('free -h | grep Mem').toString().trim().split(/\s+/);
    const diskInfo = execSync('df -h / | tail -1').toString().trim().split(/\s+/);
    const uptimeInfo = execSync('uptime').toString().trim();
    const cpuInfo = execSync('top -bn1 | grep "Cpu(s)"').toString().trim();
    
    // Parse data
    const memTotal = memInfo[1];
    const memUsed = memInfo[2];
    const memFree = memInfo[3];
    const memAvail = memInfo[6];
    
    const diskSize = diskInfo[1];
    const diskUsed = diskInfo[2];
    const diskAvail = diskInfo[3];
    const diskUse = diskInfo[4];
    
    // Parse uptime
    const uptimeMatch = uptimeInfo.match(/up\s+(.+?),\s+\d+\s+user/);
    const uptime = uptimeMatch ? uptimeMatch[1] : 'unknown';
    
    // Parse load average
    const loadMatch = uptimeInfo.match(/load average:\s+([\d.]+),\s+([\d.]+),\s+([\d.]+)/);
    const load1 = loadMatch ? loadMatch[1] : '0';
    const load5 = loadMatch ? loadMatch[2] : '0';
    const load15 = loadMatch ? loadMatch[3] : '0';
    
    // Parse CPU
    const cpuMatch = cpuInfo.match(/([\d.]+)\s+us,\s+([\d.]+)\s+sy/);
    const cpuUser = cpuMatch ? cpuMatch[1] : '0';
    const cpuSys = cpuMatch ? cpuMatch[2] : '0';
    const cpuTotal = (parseFloat(cpuUser) + parseFloat(cpuSys)).toFixed(1);
    
    // Get bot process info
    const botPid = process.pid;
    const botMem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    
    const systemText = `
💻 <b>系统监控</b>

⏰ <b>运行时间:</b> ${uptime}

<b>📊 CPU 使用率:</b>
• 总计: ${cpuTotal}%
• 用户: ${cpuUser}%
• 系统: ${cpuSys}%
• 负载: ${load1} / ${load5} / ${load15}

<b>🧠 内存使用:</b>
• 总计: ${memTotal}
• 已用: ${memUsed}
• 可用: ${memAvail}
• 空闲: ${memFree}

<b>💾 磁盘使用:</b>
• 总计: ${diskSize}
• 已用: ${diskUsed} (${diskUse})
• 可用: ${diskAvail}

<b>🤖 机器人进程:</b>
• PID: ${botPid}
• 内存: ${botMem} MB

💡 系统运行正常
    `.trim();
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 刷新', callback_data: 'system_monitor' },
          { text: '◀ 返回', callback_data: 'main_menu' }
        ]
      ]
    };
    
    if (msgId) {
      await editMsg(chatId, msgId, systemText, { reply_markup: keyboard });
    } else {
      await sendMsg(chatId, systemText, { reply_markup: keyboard });
    }
  } catch (error) {
    const errorText = '❌ 获取系统信息失败';
    if (msgId) {
      await editMsg(chatId, msgId, errorText);
    } else {
      await sendMsg(chatId, errorText);
    }
  }
}

async function handleText(chatId, userId, text) {
  const session = sessions[userId];

  if (text === '/start' || text === '/model' || text === '/models') {
    // 首次 /start 自动注册：只允许第一个用户注册，之后锁定
    if (CONFIG.allowedUsers.length === 0 && dynamicUsers.length === 0) {
      registerUser(userId);
      console.log(`[注册] 用户 ${userId} 已自动注册为 owner`);
    }

    if (!isAllowed(userId)) {
      await sendMsg(chatId, '❌ 你没有权限使用此机器人。');
      return;
    }
    sessions[userId] = null;
    await sendMsg(chatId, '🐱 <b>发财猫模型管理器</b>\n\n选择操作：', { reply_markup: mainMenu() });
    return;
  }
  
  if (text === '/system') {
    if (!isAllowed(userId)) {
      await sendMsg(chatId, '❌ 你没有权限使用此机器人。');
      return;
    }
    await handleSystemCommand(chatId);
    return;
  }

  if (text === '/code' || text.startsWith('/code ')) {
    if (!isAllowed(userId)) {
      await sendMsg(chatId, '❌ 你没有权限使用此机器人。');
      return;
    }

    const { repoKey, taskText } = parseCodeCommand(text);
    if (!repoKey || !taskText) {
      const repoLines = getCodeRepoEntries();
      let help = '🤖 <b>Claude 代码命令</b>\n\n';
      help += '用法：<code>/code &lt;repo&gt; &lt;task&gt;</code>\n';
      help += '示例：<code>/code root 修复 server.js 里的消息分段问题</code>';
      if (repoLines.length) {
        help += `\n\n<b>可用仓库</b>\n${repoLines.join('\n')}`;
      }
      await sendLongMsg(chatId, help);
      return;
    }

    const repoPath = CODE_REPOS[repoKey];
    if (!repoPath || !fs.existsSync(repoPath)) {
      await sendMsg(chatId, `❌ 仓库 <code>${escapeHtml(repoKey)}</code> 不在白名单中，或目录不存在。`);
      return;
    }

    const currentJob = codeJobs[userId];
    if (currentJob && (currentJob.status === 'queued' || currentJob.status === 'running')) {
      await sendMsg(chatId, `⚠️ 你已有运行中的任务：<code>${currentJob.jobId}</code>`, {
        reply_markup: renderCodeJobKeyboard(currentJob)
      });
      return;
    }

    const job = {
      jobId: makeCodeJobId(),
      userId,
      chatId,
      repoKey,
      repoPath,
      taskText,
      status: 'queued',
      startedAt: Date.now(),
      finishedAt: null,
      progressMessageId: null,
      stdoutTail: '',
      stderrTail: '',
      exitCode: null,
      git: null,
    };

    codeJobs[userId] = job;
    codeJobIndex[job.jobId] = job;

    const sent = await sendMsg(chatId, renderCodeJob(job), { reply_markup: renderCodeJobKeyboard(job) });
    job.progressMessageId = sent.result?.message_id;
    startCodeJob(job);
    return;
  }

  if (!isAllowed(userId)) return;
  if (!session) return;
  const config = loadConfig();

  if (session.step === 'add_provider_name') {
    sessions[userId] = { step: 'add_provider_url', provName: text.trim() };
    await sendMsg(chatId, `名称：<code>${text.trim()}</code>\n\n请发送 Base URL（如：https://web.gaoqianba.com/v1）：`);

  } else if (session.step === 'add_provider_url') {
    sessions[userId] = { ...session, step: 'add_provider_key', url: text.trim() };
    await sendMsg(chatId, `URL：<code>${text.trim()}</code>\n\n请发送 API Key：`);

  } else if (session.step === 'add_provider_template_key') {
    const { templateId, provName } = session;
    const template = PROVIDER_TEMPLATES[templateId];
    if (!template) {
      await sendMsg(chatId, '❌ 无效的模板');
      sessions[userId] = null;
      return;
    }
    
    // 使用模板创建 Provider
    if (!config.models) config.models = { mode: 'merge', providers: {} };
    if (!config.models.providers) config.models.providers = {};
    
    config.models.providers[provName] = {
      baseUrl: template.baseUrl,
      apiKey: text.trim(),
      api: template.api,
      models: template.models.map(m => ({
        id: m.id,
        name: m.name,
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192
      }))
    };
    
    // 添加到 agents.defaults.models
    if (!config.agents?.defaults?.models) {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      config.agents.defaults.models = {};
    }
    template.models.forEach(m => {
      config.agents.defaults.models[`${provName}/${m.id}`] = {};
    });
    
    saveConfig(config);
    sessions[userId] = null;
    
    let text = `✅ <b>Provider ${provName} 已添加！</b>\n\n`;
    text += `已自动添加 ${template.models.length} 个模型：\n`;
    template.models.forEach(m => {
      text += `• <code>${provName}/${m.id}</code>\n`;
    });
    text += `\n记得重启生效！`;
    
    await sendMsg(chatId, text, {
      reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'menu_channels' }, { text: '🔄 重启', callback_data: 'restart' }]] }
    });

  } else if (session.step === 'add_provider_key') {
    const { provName, url } = session;
    if (!config.models) config.models = { mode: 'merge', providers: {} };
    if (!config.models.providers) config.models.providers = {};
    config.models.providers[provName] = { baseUrl: url, apiKey: text.trim(), api: 'openai-completions', models: [] };
    saveConfig(config);
    sessions[userId] = null;
    await sendMsg(chatId, `✅ Provider <code>${provName}</code> 已添加！`, {
      reply_markup: { inline_keyboard: [[{ text: '➕ 添加模型', callback_data: `add_model_to_${provName}` }, { text: '🔄 重启', callback_data: 'restart' }]] }
    });

  } else if (session.step === 'add_model_id') {
    const { provName } = session;
    const modelId = text.trim();
    if (!config.models.providers[provName].models) config.models.providers[provName].models = [];
    config.models.providers[provName].models.push({
      id: modelId, name: modelId, reasoning: false, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192
    });
    if (!config.agents?.defaults?.models) { if (!config.agents) config.agents = {}; if (!config.agents.defaults) config.agents.defaults = {}; config.agents.defaults.models = {}; }
    config.agents.defaults.models[`${provName}/${modelId}`] = {};
    saveConfig(config);
    sessions[userId] = null;
    await sendMsg(chatId, `✅ 模型 <code>${provName}/${modelId}</code> 已添加！`, {
      reply_markup: { inline_keyboard: [[{ text: '◀ 模型管理', callback_data: 'menu_channels' }, { text: '🔄 重启', callback_data: 'restart' }]] }
    });

  } else if (session.step === 'edit_key') {
    const { provName } = session;
    config.models.providers[provName].apiKey = text.trim();
    saveConfig(config);
    sessions[userId] = null;
    await sendMsg(chatId, `✅ <code>${provName}</code> 的 Key 已更新！`, {
      reply_markup: { inline_keyboard: [[{ text: '◀ 返回', callback_data: 'menu_channels' }, { text: '🔄 重启', callback_data: 'restart' }]] }
    });
  }
}

// Long polling
async function poll() {
  while (true) {
    try {
      const res = await tgApi('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      if (res.ok && res.result?.length) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          if (update.callback_query) {
            const cb = update.callback_query;
            console.log('[DEBUG] callback:', cb.from.id, cb.data);
            handleCallback(cb.message.chat.id, cb.from.id, cb.message.message_id, cb.data, cb.id).catch(console.error);
          } else if (update.message?.text) {
            handleText(update.message.chat.id, update.message.from.id, update.message.text).catch(console.error);
          }
        }
      }
    } catch (e) {
      console.error('Poll error:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

console.log('🐱 发财猫模型管理器启动中...');
console.log(`📁 配置文件: ${CONFIG.openclaw_config}`);
poll();
