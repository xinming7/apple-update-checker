#!/usr/bin/env node
// Shared utilities for apple-update-checker scripts

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (err) {
      console.error(`  Attempt ${i + 1}/${retries} failed: ${err.message}`);
      if (i < retries - 1) await sleep(RETRY_DELAY_MS * (i + 1));
      else throw err;
    }
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mdCell(v) {
  return String(v == null ? '-' : v).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim() || '-';
}

function formatSize(bytes) {
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function updateTypeLabel(type) {
  const labels = {
    'major': '大版本更新',
    'minor': '小版本更新',
    'security-response': '安全响应 (RSR)',
    'security': '安全补丁',
    'xprotect': 'XProtect 更新',
    'beta': 'Beta 版本'
  };
  return labels[type] || '更新';
}

/** 带 emoji 前缀的 Telegram 用标签 */
function updateTypeLabelTg(type) {
  const labels = {
    'major': '🟢 大版本更新',
    'minor': '🔵 小版本更新',
    'security-response': '🔴 安全响应 (RSR)',
    'security': '🟡 安全补丁',
    'xprotect': '🛡️ XProtect 更新',
    'beta': '🧪 Beta 版本'
  };
  return labels[type] || '📦 更新';
}

function fmtDate(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/**
 * HTML 消息安全截断：避免把标签/属性拦腰切断导致 Telegram 解析失败
 */
function truncateHtmlMessage(msg, maxLen = 4096) {
  if (msg.length <= maxLen) return msg;
  let cut = msg.slice(0, maxLen - 30);
  cut = cut.replace(/<[^>]*$/, '');
  cut = cut.replace(/<a\s[^>]*>[^<]*$/i, '');
  cut = cut.replace(/&[#a-zA-Z0-9]*$/, '');
  return cut + '\n\n... (内容过长已截断)';
}

module.exports = {
  sleep,
  fetchWithRetry,
  escapeHtml,
  mdCell,
  formatSize,
  updateTypeLabel,
  updateTypeLabelTg,
  fmtDate,
  truncateHtmlMessage,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  FETCH_TIMEOUT_MS,
};
