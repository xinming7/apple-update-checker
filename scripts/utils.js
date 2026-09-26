#!/usr/bin/env node
// Shared utilities for apple-update-checker scripts

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的 fetch。
 * 当 options.curlFallback 为 true 时，优先用 curl（系统证书库）请求，fetch 作 fallback。
 * 适用于 Apple CDN 等 Node.js undici 无法信任证书链的场景。
 */
async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  const { curlFallback, ...fetchOptions } = options || {};

  const doFetch = (u, opts) => fetch(u, {
    ...opts,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  for (let i = 0; i < retries; i++) {
    try {
      let response;
      if (curlFallback) {
        try {
          response = curlGet(url, fetchOptions);
        } catch (curlErr) {
          console.error(`  curl failed: ${curlErr.message}, trying fetch...`);
          response = await doFetch(url, fetchOptions);
        }
      } else {
        response = await doFetch(url, fetchOptions);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (err) {
      console.error(`  Attempt ${i + 1}/${retries} failed: ${err.message}`);
      if (i < retries - 1) await sleep(RETRY_DELAY_MS * (i + 1));
      else throw err;
    }
  }
}

/**
 * curl 获取（execFileSync 数组参数，防 shell 注入）
 * 仅在 curlFallback 模式下被 fetchWithRetry 内部调用
 */
let execFileSync;
function curlGet(urlStr, options = {}) {
  if (!execFileSync) execFileSync = require('child_process').execFileSync;
  const args = ['-sSk', '--connect-timeout', '15', '--max-time', '30'];
  const method = options.method || 'GET';
  args.push('-X', method);
  for (const [k, v] of Object.entries(options.headers || {})) {
    args.push('-H', `${k}: ${v}`);
  }
  if (options.body) args.push('-d', String(options.body));
  args.push(urlStr);

  const stdout = execFileSync('curl', args, {
    encoding: 'utf-8',
    timeout: FETCH_TIMEOUT_MS + 5000,
    maxBuffer: 5 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!stdout || !stdout.trim()) {
    throw new Error('curl returned empty response');
  }
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(JSON.parse(stdout)),
    text: () => Promise.resolve(stdout),
  };
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
