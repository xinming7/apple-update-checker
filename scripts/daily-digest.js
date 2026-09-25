#!/usr/bin/env node
// Daily Update Digest - 从 Update Hub 获取当日汇总，通过 Telegram 发送

const HUB_URL = (process.env.UPDATE_HUB_URL || '').replace(/\/+$/, '');
const HUB_TOKEN = process.env.UPDATE_HUB_TOKEN;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const RETRY_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      console.error(`  Attempt ${i + 1}/${retries} failed: ${err.message}`);
      if (i < retries - 1) await sleep(RETRY_DELAY_MS * (i + 1));
      else throw err;
    }
  }
}

async function fetchDigest() {
  const res = await fetchWithRetry(`${HUB_URL}/api/daily-digest`, {
    headers: { 'Authorization': `Bearer ${HUB_TOKEN}` },
  });
  const data = await res.json();
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid daily-digest response');
  }
  return data;
}

function formatMessage(digest) {
  const date = String(digest.date || new Date().toISOString()).slice(0, 10);
  const stats = digest.stats || {};
  const projects = Array.isArray(digest.projects) ? digest.projects : [];
  let msg = `📋 <b>Update Hub 每日汇总</b>\n\n`;
  msg += `📅 ${date}\n`;
  msg += `📊 共 <b>${escapeHtml(digest.total)}</b> 条更新`;

  const parts = [];
  if (stats.changed) parts.push(`🔵 ${stats.changed} 变更`);
  if (stats.errors) parts.push(`🔴 ${stats.errors} 异常`);
  if (stats.ok) parts.push(`🟢 ${stats.ok} 正常`);
  if (parts.length) msg += ` · ${parts.join(' · ')}`;
  msg += '\n\n';

  for (const proj of projects) {
    const updates = Array.isArray(proj.updates) ? proj.updates : [];
    msg += `${escapeHtml(proj.icon)} <b>${escapeHtml(proj.label)}</b> (${escapeHtml(proj.count)} 条)\n`;
    for (const u of updates.slice(0, 5)) {
      const icon = u.status === 'changed' ? '🔵' : u.status === 'error' ? '🔴' : u.status === 'warning' ? '🟡' : '🟢';
      msg += `  ${icon} ${escapeHtml(u.title)}`;
      if (u.version) msg += ` <code>v${escapeHtml(u.version)}</code>`;
      msg += '\n';
      if (u.diff_url) {
        msg += `    <a href="${escapeHtml(u.diff_url)}">查看详情</a>\n`;
      }
    }
    if (updates.length > 5) {
      msg += `  ... 还有 ${updates.length - 5} 条\n`;
    }
    msg += '\n';
  }

  msg += `🔗 <a href="${HUB_URL}/">打开仪表盘</a>\n\n`;

  // 标签
  msg += `#每日汇总 #UpdateHub #更新同步平台`;
  return msg;
}

async function sendTelegram(text) {
  // 截断放在标签追加之后，上限 4096
  const MAX_LEN = 4096;
  if (text.length > MAX_LEN) {
    text = text.slice(0, MAX_LEN - 30) + '\n\n... (内容过长已截断)';
  }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const result = await res.json();
  if (!result.ok) throw new Error(`Telegram: ${result.description}`);
  return result;
}

async function main() {
  if (!HUB_URL || !HUB_TOKEN) {
    console.log('UPDATE_HUB_URL / UPDATE_HUB_TOKEN not configured, skip.');
    return;
  }
  if (!TG_TOKEN || !CHAT_ID) {
    console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured, skip.');
    return;
  }

  const digest = await fetchDigest();
  console.log(`Today: ${digest.total} updates`);

  // 无更新时跳过，不发消息
  if (!digest.total) {
    console.log('No updates today, skip notification.');
    return;
  }

  const msg = formatMessage(digest);
  await sendTelegram(msg);
  console.log('Telegram sent successfully.');
}

main().catch(e => { console.error(e); process.exit(1); });
