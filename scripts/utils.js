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
          console.warn(`  curl failed: ${curlErr.message}, trying fetch...`);
          response = await doFetch(url, fetchOptions);
        }
      } else {
        response = await doFetch(url, fetchOptions);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (err) {
      console.warn(`  Attempt ${i + 1}/${retries} failed: ${err.message}`);
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

  try {
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
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    throw new Error(`curl failed (exit ${err.status || '?'}): ${stderr || err.message}`);
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

/** XML 安全转义（RSS feed 等 XML 输出用） */
function escapeXml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function mdCell(v) {
  return String(v == null ? '-' : v).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim() || '-';
}

function formatSize(bytes) {
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** 纯文本标签（RSS feed 等非 emoji 场景） */
function updateTypeLabelPlain(type) {
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
 * HTML 消息安全截断：避免把标签/属性/实体拦腰切断导致 Telegram 解析失败。
 *
 * 单次 slice + 几个 replace 不够：切片点可能落在标签内部（`<a href="...`），
 * 也可能落在实体内部（`&am`），还可能在成对标签中间切开子标签。
 * 做法：按字符扫描 [0, limit)，把「被切断的标签/实体」丢掉，
 * 再对剩下的片段做一次标签配对——配不上的开标签与多余的闭标签一并移除，
 * 保证输出标签自平衡。
 */
function truncateHtmlMessage(msg, maxLen = 4096) {
  if (msg.length <= maxLen) return msg;

  const TAIL = '\n\n... (内容过长已截断)';
  const limit = maxLen - TAIL.length;

  // 逐个 token 收集：[0, limit) 内的完整标签、完整实体、纯文本；切断的一律丢弃
  const tokens = [];
  let i = 0;
  while (i < limit) {
    if (msg[i] === '<') {
      const close = msg.indexOf('>', i);
      if (close === -1 || close >= limit) break; // 标签被拦腰切断，丢弃
      tokens.push({ type: 'tag', text: msg.slice(i, close + 1) });
      i = close + 1;
      continue;
    }
    if (msg[i] === '&') {
      const semi = msg.indexOf(';', i);
      // 实体最长 32 字符；越界或不是合法实体就当普通文本
      if (semi !== -1 && semi - i <= 32 && /^&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+)$/.test(msg.slice(i, semi + 1))) {
        tokens.push({ type: 'text', text: msg.slice(i, semi + 1) });
        i = semi + 1;
        continue;
      }
      tokens.push({ type: 'text', text: '&' }); // 被切断的实体，降级为字面量
      i++;
      continue;
    }
    // 合并连续纯文本
    let j = i;
    while (j < limit && msg[j] !== '<' && msg[j] !== '&') j++;
    tokens.push({ type: 'text', text: msg.slice(i, j) });
    i = j;
  }

  // 标签配对：丢弃配不上的开标签与多余的闭标签
  const stack = [];
  const drop = new Set();
  tokens.forEach((t, idx) => {
    if (t.type !== 'tag') return;
    const m = t.text.match(/^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/);
    if (!m) { drop.add(idx); return; }
    const [, slash, name] = m;
    const lower = name.toLowerCase();
    const selfClosing = /\/>$/.test(t.text) || /^(br|hr|img|input)$/.test(lower);
    if (selfClosing && !slash) return;
    if (slash) {
      const at = stack.lastIndexOf(lower);
      if (at === -1) drop.add(idx);        // 多余闭标签
      else stack.splice(at, 1);
    } else {
      stack.push({ idx, name: lower });
    }
  });
  for (const { idx } of stack) drop.add(idx); // 未闭合的开标签

  const out = tokens.filter((_, idx) => !drop.has(idx)).map(t => t.text).join('');

  // 极端情况：limit 内几乎全是未闭合标签（正文在 limit 之外），
  // 配对后会把正文也一起丢掉，只剩截断提示 —— 那等于消息内容全没了。
  // 这时退化成「剥掉全部标签的纯文本切片」，至少保住正文。
  if (out.replace(/<[^>]*>/g, '').trim() === '') {
    const plain = msg.slice(0, limit)
      .replace(/<[^>]*>/g, '')      // 完整标签
      .replace(/<[^>]*$/, '')       // 被切了一半的开标签
      .replace(/&[^;\s]{0,32};?$/, ''); // 被切了一半的实体
    if (plain.trim() !== '') return plain + TAIL;
  }

  return out + TAIL;
}

module.exports = {
  sleep,
  fetchWithRetry,
  escapeHtml,
  escapeXml,
  mdCell,
  formatSize,
  updateTypeLabelPlain,
  updateTypeLabelTg,
  fmtDate,
  truncateHtmlMessage,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  FETCH_TIMEOUT_MS,
};
