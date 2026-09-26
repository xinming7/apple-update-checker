#!/usr/bin/env node
// Apple Update Checker - GitHub Actions Script
// 检查苹果系统更新并保存到仓库
//
// 数据源架构（2026-09 修复）：
//   主源  gdmf.apple.com/v2/pmv（GET JSON）：全平台版本 / Build / 发布日期 / RSR 标记
//   辅助  mesu.apple.com OTA feed（XML plist）：补充固件下载链接与大小（仅 iOS/watchOS/tvOS 有）
// 旧版脚本直接解析 mesu XML，存在三个问题：正则无法处理嵌套结构、
// feed 无日期字段、watchOS/tvOS/macOS/visionOS 的 URL 已失效（403）。

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// 平台定义
const ALL_PLATFORMS = {
  ios: { name: 'iOS' },
  macos: { name: 'macOS' },
  watchos: { name: 'watchOS' },
  tvos: { name: 'tvOS' },
  visionos: { name: 'visionOS' }
};

// Apple OTA mesu feeds（仅用于补充固件下载链接/大小）
// 注意：watchOS/tvOS 路径带 watch/tv 前缀；macOS/visionOS 无公开 XML feed
const MESU_FEEDS = {
  ios: 'https://mesu.apple.com/assets/com_apple_MobileAsset_SoftwareUpdate/com_apple_MobileAsset_SoftwareUpdate.xml',
  watchos: 'https://mesu.apple.com/assets/watch/com_apple_MobileAsset_SoftwareUpdate/com_apple_MobileAsset_SoftwareUpdate.xml',
  tvos: 'https://mesu.apple.com/assets/tv/com_apple_MobileAsset_SoftwareUpdate/com_apple_MobileAsset_SoftwareUpdate.xml'
};

// Apple 官方待推送软件版本目录（JSON）
const PMV_URL = 'https://gdmf.apple.com/v2/pmv';

// 平台过滤（环境变量 PLATFORMS，逗号分隔，如 "ios,macos"）
const PLATFORM_FILTER = process.env.PLATFORMS
  ? process.env.PLATFORMS.split(',').map(p => p.trim().toLowerCase()).filter(Boolean)
  : null;

const PLATFORM_KEYS = Object.keys(ALL_PLATFORMS).filter(
  key => !PLATFORM_FILTER || PLATFORM_FILTER.includes(key)
);

// 重试配置
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 使用 curl 获取数据（Node.js fetch/undici 和 native https 均无法信任
 * Apple CDN 证书链，curl 使用系统证书库可正常工作）
 */
function curlGet(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const headers = Object.entries(options.headers || {})
        .map(([k, v]) => `-H '${k}: ${v}'`)
        .join(' ');
      const method = options.method || 'GET';
      const body = options.body ? `-d '${String(options.body).replace(/'/g, "'\\''")}'` : '';
      const cmd = `curl -sSk --connect-timeout 15 --max-time 30 -X ${method} ${headers} ${body} '${urlStr}'`;
      const stdout = execSync(cmd, {
        encoding: 'utf-8',
        timeout: FETCH_TIMEOUT_MS + 5000,
        maxBuffer: 5 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (!stdout || !stdout.trim()) {
        reject(new Error('curl returned empty response'));
        return;
      }
      resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(JSON.parse(stdout)),
        text: () => Promise.resolve(stdout),
      });
    } catch (err) {
      const stderr = err.stderr ? String(err.stderr).trim() : '';
      reject(new Error(`curl failed (exit ${err.status || '?'}): ${stderr || err.message}`));
    }
  });
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      let response;
      try {
        response = await curlGet(url, options);
      } catch (curlErr) {
        console.error(`  curl failed: ${curlErr.message}, trying fetch...`);
        response = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
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

// ─── 通用工具 ──────────────────────────────────────────────────

/**
 * HTML 转义（Telegram parse_mode=HTML、链接属性都需要）
 */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 统一按北京时间显示日期，避免不同输出渠道日期差一天
 */
function fmtDate(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/** Markdown 单元格安全化：转义竖线与换行（外部数据进表格前调用） */
function mdCell(v) {
  return String(v == null ? '-' : v).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim() || '-';
}

function formatSize(bytes) {
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * 版本号归一化：mesu OTA feed 的 OSVersion 带 "9.9." 打码前缀
 * （如 "9.9.27.0" 实为 27.0，可与 SUDocumentationID=iOS27Long 交叉验证）
 */
function normalizeVersion(v) {
  const m = String(v).match(/^9\.9\.(.+)$/);
  return m ? m[1] : String(v);
}

/** 从固件 URL 中提取打包日期（如 .../031-31206-20150812-.../） */
function extractDateFromUrl(url) {
  const m = url && String(url).match(/-(20[0-3]\d[01]\d[0-3]\d)-/);
  if (!m) return undefined;
  const s = m[1];
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return Number.isNaN(new Date(iso).getTime()) ? undefined : iso;
}

function semverKey(v) {
  return String(v).split('.').map(n => parseInt(n, 10) || 0);
}

/** 版本号降序比较（同版本按 build 降序） */
function compareUpdatesDesc(a, b) {
  const va = semverKey(a.version), vb = semverKey(b.version);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] || 0) - (va[i] || 0);
    if (d !== 0) return d;
  }
  return String(b.build || '').localeCompare(String(a.build || ''));
}

/**
 * HTML 消息安全截断：避免把标签/属性拦腰切断导致 Telegram 解析失败
 */
function truncateHtmlMessage(msg, maxLen = 4096) {
  if (msg.length <= maxLen) return msg;
  let cut = msg.slice(0, maxLen - 30);
  cut = cut.replace(/<[^>]*$/, '');            // 去掉被截断的半个标签
  cut = cut.replace(/<a\s[^>]*>[^<]*$/i, '');  // 去掉没有闭合的 <a> 文本
  cut = cut.replace(/&[#a-zA-Z0-9]*$/, '');    // 去掉被截断的半个 HTML 实体
  return cut + '\n\n... (内容过长已截断)';
}

// ─── 更新分类 ──────────────────────────────────────────────────

/**
 * 更新类型分类
 * - security-response: RSR（标题含 Rapid Security Response、版本形如 "16.5 (a)"、
 *   或 gdmf 的 ProductVersionExtra 形如 "(a)"）
 * - major: 纯主版本（"20"）或 x.0（"20.0"）
 * - minor: 其余（x.y / x.y.z）
 */
function classifyUpdate(version, build, title, versionExtra) {
  if (title && /Rapid Security Response/i.test(title)) return 'security-response';
  if (versionExtra && /\(\s*[a-z]\s*\)/i.test(String(versionExtra))) return 'security-response';
  if (version && /\(\s*[a-z]\s*\)\s*$/i.test(String(version).trim())) return 'security-response';
  if (version) {
    const parts = String(version).split('.');
    if (parts.length === 1) return 'major';
    if (parts.length === 2 && parts[1] === '0') return 'major';
  }
  return 'minor';
}

function updateTypeLabel(type) {
  const labels = {
    'major': '🟢 大版本更新',
    'minor': '🔵 小版本更新',
    'security-response': '🔴 安全响应 (RSR)',
    'security': '🟡 安全补丁',
    'xprotect': '🛡️ XProtect 更新'
  };
  return labels[type] || '📦 更新';
}

/**
 * 生成固件下载链接
 * （IPSW.me 无法在缺少具体机型的情况下构造版本深链，故只保留 Apple 官方 OTA 链接）
 */
function generateFirmwareUrls(update) {
  const urls = {};
  if (update._baseUrl && update._relativePath) {
    urls.apple = update._baseUrl + update._relativePath;
  }
  return urls;
}

// ─── 数据源 1：gdmf/pmv（主源） ────────────────────────────────

/** 按设备前缀判断平台（pmv 的 iOS 桶混装 iPhone/iPad/Watch/AppleTV/HomePod） */
function classifyDevice(dev) {
  const d = String(dev || '');
  if (/^Watch/.test(d)) return 'watchos';
  if (/^AppleTV|^AudioAccessory/.test(d)) return 'tvos';
  if (/^RealityDevice/.test(d)) return 'visionos';
  if (/^Mac|^J\d|^VMA|^VMM|^X\d/.test(d)) return 'macos';
  return 'ios'; // iPhone / iPad / iPod
}

/** 取资产条目中占比最高的平台家族，避免混合设备列表误判 */
function platformKeyOf(entry) {
  const counts = {};
  for (const dev of entry.SupportedDevices || []) {
    const k = classifyDevice(dev);
    counts[k] = (counts[k] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

function toUpdate(platformKey, entry, extraSuffix) {
  const name = ALL_PLATFORMS[platformKey].name;
  const extra = entry.ProductVersionExtra ? String(entry.ProductVersionExtra) : '';
  const version = String(entry.ProductVersion);
  const build = entry.Build != null ? String(entry.Build) : undefined;
  return {
    platform: name,
    version,
    build,
    postingDate: entry.PostingDate != null ? String(entry.PostingDate) : undefined,
    title: `${name} ${version}${extraSuffix || extra}`,
    _updateType: classifyUpdate(version, build, `${name} ${version}${extra}`, extra),
    _firmwareUrls: {}
  };
}

/**
 * 解析 gdmf/pmv JSON，按平台汇总最新版本（纯函数，便于测试）
 * 返回 { ios: [updates], ... }
 */
function parsePmvData(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid pmv response');

  const buckets = { ios: [], macos: [], watchos: [], tvos: [], visionos: [] };
  const push = (key, entry, extraSuffix) => {
    if (!key || !PLATFORM_KEYS.includes(key)) return;
    if (!entry || !entry.ProductVersion || !entry.Build) return;
    buckets[key].push(toUpdate(key, entry, extraSuffix));
  };

  // 公共发布渠道（含各在维护版本线）
  for (const [group, entries] of Object.entries(data.PublicAssetSets || {})) {
    for (const entry of entries || []) {
      const key = group === 'macOS' ? 'macos' : group === 'visionOS' ? 'visionos' : platformKeyOf(entry);
      push(key, entry);
    }
  }

  // 快速安全响应（RSR）：ProductVersionExtra 形如 "(a)"
  for (const [group, entries] of Object.entries(data.PublicBackgroundSecurityImprovements || {})) {
    for (const entry of entries || []) {
      const key = group === 'macOS' ? 'macos' : group === 'visionOS' ? 'visionos' : platformKeyOf(entry);
      const extra = entry.ProductVersionExtra ? ` ${entry.ProductVersionExtra}` : '';
      push(key, entry, extra);
    }
  }

  // 去重 + 排序 + 截取
  const result = {};
  for (const [key, updates] of Object.entries(buckets)) {
    updates.sort(compareUpdatesDesc);
    const unique = [];
    const seen = new Set();
    for (const u of updates) {
      const id = `${u.version}-${u.build}-${u.title}`;
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(u);
      }
    }
    result[key] = unique.slice(0, 5);
    if (result[key].length > 0) {
      console.log(`  ${ALL_PLATFORMS[key].name}: ${result[key].map(u => `${u.version} (${u.build})`).join(', ')}`);
    }
  }
  return result;
}

/**
 * 抓取 gdmf/pmv JSON，按平台汇总最新版本
 * 返回 { ios: [updates], ... }
 */
async function fetchPmvUpdates() {
  console.log('Fetching gdmf/pmv catalog...');
  const response = await fetchWithRetry(PMV_URL, {
    headers: {
      'User-Agent': 'SoftwareUpdate (unknown version) CFNetwork/1408.0.4 Darwin/22.5.0',
      'Accept': 'application/json'
    }
  });
  const raw = await response.json();
  return { raw, updates: parsePmvData(raw) };
}

// ─── 数据源 2：mesu OTA feed（辅助：固件链接/大小） ─────────────

/**
 * 极简 XML plist 解析器。
 * 正则无法处理 <dict>/<array> 嵌套（Assets 里每个资产都有 SupportedDevices 等嵌套数组），
 * 这里用 token 递归下降解析，避免字段被截断。
 */
function plistUnescape(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[ent] ?? m;
  });
}

function parsePlist(xml) {
  const cleaned = String(xml)
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/</g, '&lt;'));

  const tokens = cleaned.match(/<[^>]+>|[^<]+/g) || [];
  let pos = 0;

  const nextTag = () => {
    while (pos < tokens.length && !/^</.test(tokens[pos])) pos++; // 跳过空白文本
    return tokens[pos++];
  };

  const parseTextUntil = (closeTag) => {
    let text = '';
    while (pos < tokens.length && tokens[pos] !== closeTag) text += tokens[pos++];
    if (pos < tokens.length) pos++; // 消费闭合标签
    return plistUnescape(text);
  };

  const selfClosingTag = (t) => /\/>$/.test(t);

  const parseValue = (tag) => {
    const selfClosing = selfClosingTag(tag);
    const name = (tag.match(/^<\s*([A-Za-z]+)/) || [, ''])[1];

    if (name === 'true') { if (!selfClosing) parseTextUntil('</true>'); return true; }
    if (name === 'false') { if (!selfClosing) parseTextUntil('</false>'); return false; }

    if (name === 'dict') {
      const obj = {};
      if (selfClosing) return obj;
      for (;;) {
        const t = nextTag();
        if (t == null || /^<\s*\/dict/.test(t)) break;
        if (/^<\s*key/.test(t)) {
          const key = selfClosingTag(t) ? '' : parseTextUntil('</key>');
          const vTag = nextTag();
          if (vTag == null || /^<\s*\//.test(vTag)) break;
          obj[key] = parseValue(vTag);
        }
      }
      return obj;
    }

    if (name === 'array') {
      const arr = [];
      if (selfClosing) return arr;
      for (;;) {
        const t = nextTag();
        if (t == null || /^<\s*\/array/.test(t)) break;
        if (/^<\s*\//.test(t)) break;
        arr.push(parseValue(t));
      }
      return arr;
    }

    // string / integer / real / date / data
    return selfClosing ? '' : parseTextUntil(`</${name}>`);
  };

  // 顶层：<plist ...><dict>...</dict></plist>
  for (;;) {
    const t = nextTag();
    if (t == null) return null;
    if (/^<\s*plist/.test(t)) {
      if (selfClosingTag(t)) return {};
      const inner = nextTag();
      return inner == null ? null : parseValue(inner);
    }
    return parseValue(t);
  }
}

/**
 * 解析 mesu OTA plist，提取固件下载链接与大小
 */
function parseMesuXML(xml, platformKey) {
  let root = null;
  try {
    root = parsePlist(xml);
  } catch (err) {
    console.warn(`  plist parse failed for ${platformKey}: ${err.message}`);
    return [];
  }

  const assets = root && Array.isArray(root.Assets) ? root.Assets : [];
  if (!assets.length) {
    console.warn(`  No Assets array found for ${platformKey}`);
    return [];
  }

  const updates = [];
  const num = (v) => {
    if (v == null) return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };

  for (const asset of assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) continue;

    // 过滤非用户可见资产：恢复盘元数据 / 预发布种子 / 哨兵
    const docId = asset.SUDocumentationID != null ? String(asset.SUDocumentationID) : '';
    if (docId.startsWith('TetheredUpdateInfo')) continue;
    if (docId === 'PreRelease') continue;

    const build = asset.Build != null ? String(asset.Build) : undefined;
    if (build && /^99Z/.test(build)) continue;

    const rawVersion = asset.OSVersion != null ? String(asset.OSVersion) : null;
    if (!rawVersion) continue;
    const version = normalizeVersion(rawVersion);
    if (/^99(\.0)?$/.test(version)) continue;

    const realUpdateSize = asset.RealUpdateAttributes && typeof asset.RealUpdateAttributes === 'object'
      ? asset.RealUpdateAttributes.RealUpdateDownloadSize
      : undefined;

    const update = {
      platform: ALL_PLATFORMS[platformKey].name,
      version,
      build,
      postingDate: asset.PostingDate != null
        ? String(asset.PostingDate)
        : extractDateFromUrl(asset.__BaseURL),
      downloadSize: num(asset._DownloadSize ?? asset.DownloadSize ?? realUpdateSize),
      _baseUrl: asset.__BaseURL != null ? String(asset.__BaseURL) : undefined,
      _relativePath: asset.__RelativePath != null ? String(asset.__RelativePath) : undefined
    };

    update._firmwareUrls = generateFirmwareUrls(update);
    updates.push(update);
  }

  return updates;
}

/**
 * 抓取 mesu feed（辅助数据源）；失败返回 null，不影响主流程
 */
async function fetchMesuUpdates(platformKey) {
  const url = MESU_FEEDS[platformKey];
  if (!url) return null;
  try {
    const response = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    const xml = await response.text();
    return parseMesuXML(xml, platformKey);
  } catch (error) {
    console.warn(`  mesu enrichment failed for ${platformKey}: ${error.message}`);
    return null;
  }
}

/**
 * 用 mesu 数据补充固件下载链接与大小
 */
function enrichWithMesu(updatesByPlatform, mesuByPlatform) {
  for (const [key, mesuList] of Object.entries(mesuByPlatform)) {
    if (!mesuList) continue;
    const index = new Map(mesuList.map(u => [`${u.version}-${u.build}`, u]));
    for (const u of updatesByPlatform[key] || []) {
      const m = index.get(`${u.version}-${u.build}`);
      if (m) {
        if (m._firmwareUrls && m._firmwareUrls.apple) u._firmwareUrls = m._firmwareUrls;
        if (m.downloadSize) u.downloadSize = m.downloadSize;
      }
    }
  }
}

// ─── XProtect ─────────────────────────────────────────────────

/**
 * XProtect 版本检测。
 *
 * 历史实现 POST gdmf/v2/pmv 并用正则在响应里捞数字——该端点现为 GET JSON 且不含
 * XProtect 数据，旧逻辑必然失败。当前 gdmf/pmv 与 mesu 都不提供 XProtect 版本，
 * 需接入 Pallas（gdmf/v2/assets + XProtectPlistConfigData 的 AssetAudience）。
 * 这里保留检测入口：若将来 pmv 响应出现 XProtect 字段即可自动生效。
 */
async function fetchXProtectVersion(rawData) {
  console.log('Checking XProtect version...');
  try {
    // 复用主流程抓取的 pmv 原始数据；没有才单独抓一次
    let data = rawData;
    if (!data) {
      const response = await fetchWithRetry(PMV_URL, {
        headers: {
          'User-Agent': 'SoftwareUpdate (unknown version) CFNetwork/1408.0.4 Darwin/22.5.0',
          'Accept': 'application/json'
        }
      });
      data = await response.json();
    }
    const hit = findXProtectEntry(data);
    if (hit) {
      console.log(`  XProtect version: ${hit.version}${hit.date ? ` (${hit.date})` : ''}`);
      return hit;
    }
    console.log('  XProtect 数据暂不可用（gdmf/pmv 不含 XProtect，需接入 Pallas），跳过');
    return null;
  } catch (err) {
    console.error(`  XProtect fetch failed: ${err.message}`);
    return null;
  }
}

/** 递归查找响应中的 XProtect 版本字段 */
function findXProtectEntry(node, depth = 0) {
  if (depth > 6 || node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findXProtectEntry(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/xprotect/i.test(k)) {
        const version = String(v && typeof v === 'object' ? (v.version || v.ProductVersion || '') : v);
        const m = version.match(/(\d{4,8})/);
        if (m) {
          const raw = m[1];
          let date = null;
          if (/^\d{8}$/.test(raw)) {
            const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
            if (!Number.isNaN(new Date(iso).getTime())) date = iso;
          }
          return { version: raw, date };
        }
      }
      const hit = findXProtectEntry(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 检查 XProtect 是否有新版本
 */
async function checkXProtectUpdate(dataDir, rawData) {
  const xp = await fetchXProtectVersion(rawData);
  if (!xp) return null;

  const prevFile = path.join(dataDir, 'xprotect.json');
  let prevVersion = null;

  if (fs.existsSync(prevFile)) {
    try {
      prevVersion = JSON.parse(fs.readFileSync(prevFile, 'utf-8')).version;
    } catch (err) {
      console.warn(`  Failed to parse xprotect.json: ${err.message}`);
    }
  }

  // 保存当前版本
  fs.writeFileSync(prevFile, JSON.stringify({ version: xp.version, date: xp.date, checkedAt: new Date().toISOString() }, null, 2));

  // 检测变更
  if (prevVersion && prevVersion !== xp.version) {
    return {
      platform: 'XProtect',
      version: xp.version,
      build: xp.version,
      postingDate: new Date().toISOString(),
      _updateType: 'xprotect',
      title: `XProtect ${xp.version}${xp.date ? ` (${xp.date})` : ''}`
    };
  }
  return null;
}

/**
 * 计算更新间隔统计
 */
function computeIntervalStats(data) {
  const stats = {};
  const dateOf = (u) => u.postingDate || u.firstSeen;

  for (const [key, platform] of Object.entries(data.platforms)) {
    if (platform.updates.length < 2) {
      const only = platform.updates[0];
      if (only && dateOf(only)) {
        const daysSince = Math.floor(
          (Date.now() - new Date(dateOf(only)).getTime()) / 86400000
        );
        stats[key] = { daysSinceLast: daysSince };
      }
      continue;
    }

    const sorted = [...platform.updates]
      .filter(u => dateOf(u))
      .sort((a, b) => new Date(dateOf(b)) - new Date(dateOf(a)));

    if (sorted.length < 2) continue;

    const intervals = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const diff = new Date(dateOf(sorted[i])) - new Date(dateOf(sorted[i + 1]));
      intervals.push(Math.round(diff / 86400000));
    }

    stats[key] = {
      avgDays: Math.round(intervals.reduce((s, d) => s + d, 0) / intervals.length),
      daysSinceLast: Math.floor((Date.now() - new Date(dateOf(sorted[0])).getTime()) / 86400000),
      history: intervals
    };
  }

  return stats;
}

// ─── 变更检测与通知 ────────────────────────────────────────────

/**
 * 读取上次检查数据，检测是否有新版本
 */
function detectChanges(current, dataDir) {
  const prevFile = path.join(dataDir, 'updates.json');
  if (!fs.existsSync(prevFile)) {
    console.log('No previous data found, skipping change detection.');
    return null;
  }

  try {
    const prev = JSON.parse(fs.readFileSync(prevFile, 'utf-8'));
    const newUpdates = [];

    for (const [key, platform] of Object.entries(current.platforms)) {
      const prevPlatform = prev.platforms?.[key];
      if (!prevPlatform) {
        for (const u of platform.updates) newUpdates.push(u);
        continue;
      }

      const prevVersions = new Set(
        prevPlatform.updates.map(u => `${u.version}-${u.build}`)
      );

      for (const u of platform.updates) {
        if (!prevVersions.has(`${u.version}-${u.build}`)) {
          newUpdates.push(u);
        }
      }
    }

    return newUpdates;
  } catch (err) {
    console.error('Error reading previous data:', err.message);
    return null;
  }
}

/**
 * 通过 Telegram Bot 发送通知
 */
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('Telegram not configured, skipping notification.');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      })
    });
    const result = await response.json();
    if (result.ok) {
      console.log('Telegram notification sent successfully.');
    } else {
      console.error('Telegram API error:', result.description);
    }
  } catch (err) {
    console.error('Failed to send Telegram notification:', err.message);
  }
}

/**
 * 格式化新版本消息（增强版）
 */
function formatTelegramMessage(newUpdates, intervalStats) {
  let msg = `🍎 <b>Apple 系统更新通知</b>\n\n`;
  msg += `检测到 <b>${newUpdates.length}</b> 个新版本：\n\n`;

  for (const u of newUpdates) {
    const typeLabel = updateTypeLabel(u._updateType);
    msg += `${typeLabel}\n`;
    msg += `📱 <b>${escapeHtml(u.platform)}</b> ${escapeHtml(u.version)}`;
    if (u.build) msg += ` (${escapeHtml(u.build)})`;
    if (u.downloadSize) msg += ` [${formatSize(u.downloadSize)}]`;
    msg += `\n`;
    if (u.postingDate) {
      msg += `📅 发布日期: ${fmtDate(u.postingDate)}\n`;
    }

    // 固件下载链接
    if (u._firmwareUrls && u._firmwareUrls.apple) {
      msg += `⬇️ <a href="${escapeHtml(u._firmwareUrls.apple)}">Apple 官方固件下载</a>\n`;
    }

    msg += `\n`;
  }

  // 更新间隔统计
  if (intervalStats) {
    const statEntries = Object.entries(intervalStats).filter(([, s]) => s.daysSinceLast != null);
    if (statEntries.length > 0) {
      msg += `📊 <b>更新间隔统计</b>\n`;
      for (const [platform, s] of statEntries) {
        const icon = ALL_PLATFORMS[platform]?.name ? '📱' : '🛡️';
        const name = ALL_PLATFORMS[platform]?.name || platform;
        msg += `${icon} ${escapeHtml(name)}: 距上次更新 ${s.daysSinceLast} 天`;
        if (s.avgDays) msg += `，平均每 ${s.avgDays} 天更新一次`;
        msg += `\n`;
      }
      msg += `\n`;
    }
  }

  const repoUrl = process.env.REPO_URL || `https://github.com/${process.env.GITHUB_REPOSITORY || 'OWNER/REPO'}`;
  msg += `🔗 <a href="${repoUrl}/blob/main/UPDATE_STATUS.md">查看详细信息</a>\n\n`;

  // 标签
  const tags = new Set(['#苹果系统更新', '#更新同步平台']);
  for (const u of newUpdates) {
    if (u.platform) tags.add(`#${u.platform}更新`);
    if (u._updateType === 'security-response') tags.add('#安全响应');
    if (u._updateType === 'xprotect') tags.add('#XProtect');
  }
  msg += [...tags].join(' ');

  // 截断放在最后，确保链接和标签都已追加
  return truncateHtmlMessage(msg);
}

/**
 * 同步到 Update Hub
 */
async function reportToUpdateHub(updates) {
  const hubUrl = process.env.UPDATE_HUB_URL;
  const hubToken = process.env.UPDATE_HUB_TOKEN;
  if (!hubUrl || !hubToken) {
    console.log('Update Hub not configured, skipping.');
    return;
  }
  const PROJECT = 'ios-update-check';
  const headers = {
    'Authorization': `Bearer ${hubToken}`,
    'Content-Type': 'application/json',
  };
  const registerProject = () => fetch(`${hubUrl}/api/projects`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({ name: PROJECT, label: 'Apple 系统更新', type: 'version', icon: '🍎' }),
  });

  for (const u of updates) {
    try {
      const payload = {
        version: u.version,
        title: `${u.platform} ${u.version}${u.build ? ` (${u.build})` : ''}`,
        body: u.postingDate ? `发布日期: ${fmtDate(u.postingDate)}` : '',
        status: 'changed',
        extra: { platform: u.platform, build: u.build, downloadSize: u.downloadSize, updateType: u._updateType },
      };
      const post = () => fetch(`${hubUrl}/api/projects/${PROJECT}/updates`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        body: JSON.stringify(payload),
      });
      let res = await post();
      if (res.status === 404) {
        // 项目未注册：自动注册后重试一次，避免上报静默丢失
        await registerProject();
        res = await post();
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json().catch(() => ({}));
      console.log(`Update Hub: ${u.platform} ${u.version} → ${result.recorded ? 'OK' : result.error || 'unknown'}`);
    } catch (err) {
      console.error(`Update Hub report failed: ${err.message}`);
    }
  }
}

// ─── 主函数 ──────────────────────────────────────────────────

async function main() {
  console.log('=== Apple Update Checker ===');
  console.log('Time:', new Date().toISOString());
  if (PLATFORM_FILTER) {
    console.log(`Platform filter: ${PLATFORM_KEYS.join(', ')}`);
  }
  console.log('');

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const outputFile = path.join(dataDir, 'updates.json');
  let prevData = null;
  if (fs.existsSync(outputFile)) {
    try {
      prevData = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    } catch (err) {
      console.warn(`Failed to parse previous updates.json: ${err.message}`);
    }
  }

  // 主源：gdmf/pmv（含版本/Build/发布日期/RSR）
  let updatesByPlatform = null;
  let pmvRaw = null;
  let pmvError = null;
  try {
    const pmv = await fetchPmvUpdates();
    updatesByPlatform = pmv.updates;
    pmvRaw = pmv.raw;
  } catch (err) {
    pmvError = err;
    console.error(`ERROR: fetch gdmf/pmv failed: ${err.message}`);
    updatesByPlatform = Object.fromEntries(PLATFORM_KEYS.map(k => [k, []]));
  }

  // 辅助源：mesu feed（固件链接/大小，失败不影响主流程）
  const mesuResults = await Promise.allSettled(
    PLATFORM_KEYS.map(k => fetchMesuUpdates(k))
  );
  const mesuByPlatform = {};
  PLATFORM_KEYS.forEach((k, i) => {
    mesuByPlatform[k] = mesuResults[i].status === 'fulfilled' ? mesuResults[i].value : null;
  });
  enrichWithMesu(updatesByPlatform, mesuByPlatform);

  // XProtect
  const xpResult = await checkXProtectUpdate(dataDir, pmvRaw).catch(() => null);

  // 构建输出
  const now = new Date().toISOString();
  const output = {
    lastChecked: now,
    platforms: {}
  };

  for (const key of PLATFORM_KEYS) {
    const updates = updatesByPlatform[key] || [];

    // 继承 firstSeen（首次发现时间）
    const prevPlatform = prevData?.platforms?.[key];
    const prevSeen = new Map(
      (prevPlatform?.updates || []).map(u => [`${u.version}-${u.build}`, u.firstSeen])
    );
    for (const u of updates) {
      u.firstSeen = prevSeen.get(`${u.version}-${u.build}`) || now;
    }

    output.platforms[key] = {
      name: ALL_PLATFORMS[key].name,
      updates,
      ...(pmvError ? { _fetchError: true } : {})
    };
  }

  // PLATFORMS 过滤时保留其余平台的历史数据，避免数据丢失 / 下次误报为"新更新"
  if (prevData && prevData.platforms) {
    for (const [key, val] of Object.entries(prevData.platforms)) {
      if (!output.platforms[key]) {
        output.platforms[key] = val;
      }
    }
  }

  // XProtect 结果
  if (xpResult) {
    output.xprotect = {
      name: 'XProtect',
      version: xpResult.version,
      date: xpResult.date,
      lastChecked: now
    };
  } else if (prevData && prevData.xprotect) {
    // 检测不可用时保留旧的 XProtect 记录
    output.xprotect = prevData.xprotect;
  }

  // 检测变更
  const newUpdates = detectChanges(output, dataDir);
  if (xpResult && newUpdates) {
    newUpdates.push(xpResult);
  }

  // 计算更新间隔统计
  const intervalStats = computeIntervalStats(output);
  output._intervalStats = intervalStats;

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`Saved to ${outputFile}`);

  // 生成 Markdown 报告
  const markdown = generateMarkdown(output);
  const readmePath = path.join(__dirname, '..', 'UPDATE_STATUS.md');
  fs.writeFileSync(readmePath, markdown);
  console.log(`Updated ${readmePath}`);

  console.log('');
  console.log('=== Summary ===');
  for (const [key, platform] of Object.entries(output.platforms)) {
    const latest = platform.updates[0];
    if (latest) {
      const type = updateTypeLabel(latest._updateType || 'minor');
      console.log(`${platform.name}: ${latest.version}${latest.build ? ` (${latest.build})` : ''} ${type}`);
    } else if (platform._fetchError) {
      console.log(`${platform.name}: FETCH FAILED`);
    } else {
      console.log(`${platform.name}: No data`);
    }
  }

  // 输出新版本信息供 workflow 读取，并发送 Telegram 通知
  if (newUpdates && newUpdates.length > 0) {
    console.log('');
    console.log('=== NEW UPDATES DETECTED ===');
    for (const u of newUpdates) {
      console.log(`NEW: ${u.platform} ${u.version} (${u.build})`);
    }
    await sendTelegramMessage(formatTelegramMessage(newUpdates, intervalStats));
    // 只在有新版本时同步到 Update Hub
    await reportToUpdateHub(newUpdates);
  }
}

function generateMarkdown(data) {
  const lastChecked = new Date(data.lastChecked).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  let md = `# Apple 系统更新状态\n\n`;
  md += `> 最后检查: ${lastChecked}\n\n`;

  // 主表（增强版）
  md += `| 平台 | 最新版本 | Build | 类型 | 大小 | 发布日期 | 距今 |\n`;
  md += `|------|----------|-------|------|------|----------|------|\n`;

  const intervalStats = data._intervalStats || {};

  for (const [key, platform] of Object.entries(data.platforms)) {
    const latest = platform.updates[0];
    if (latest) {
      const date = fmtDate(latest.postingDate || latest.firstSeen);
      const typeLabel = latest._updateType === 'major' ? '🟢 大版本'
        : latest._updateType === 'security-response' ? '🔴 RSR'
        : latest._updateType === 'security' ? '🟡 安全'
        : '🔵 小版本';
      const size = latest.downloadSize ? formatSize(latest.downloadSize) : '-';
      const stat = intervalStats[key];
      const daysAgo = stat?.daysSinceLast != null ? `${stat.daysSinceLast}天` : '-';
      md += `| ${mdCell(platform.name)} | ${mdCell(latest.version)} | ${mdCell(latest.build)} | ${typeLabel} | ${size} | ${mdCell(date)} | ${daysAgo} |\n`;
    } else if (platform._fetchError) {
      md += `| ${platform.name} | ⚠️ 抓取失败 | - | - | - | - | - |\n`;
    } else {
      md += `| ${platform.name} | - | - | - | - | - | - |\n`;
    }
  }

  // XProtect 状态
  if (data.xprotect) {
    md += `| 🛡️ XProtect | ${data.xprotect.version} | ${data.xprotect.version} | 安全 | - | ${data.xprotect.date || '-'} | - |\n`;
  }

  // 更新间隔统计
  const statsEntries = Object.entries(intervalStats).filter(([, s]) => s.avgDays);
  if (statsEntries.length > 0) {
    md += `\n## 📊 更新间隔统计\n\n`;
    md += `| 平台 | 平均间隔 | 距上次更新 | 历史间隔 |\n`;
    md += `|------|----------|------------|----------|\n`;
    for (const [key, s] of statsEntries) {
      const name = data.platforms[key]?.name || key;
      const history = s.history ? s.history.slice(0, 5).map(d => `${d}天`).join(' → ') : '-';
      md += `| ${name} | ${s.avgDays}天 | ${s.daysSinceLast}天 | ${history} |\n`;
    }
  }

  // 固件下载链接
  const withLinks = Object.entries(data.platforms).filter(([, p]) =>
    p.updates[0] && p.updates[0]._firmwareUrls && Object.keys(p.updates[0]._firmwareUrls).length > 0
  );
  if (withLinks.length > 0) {
    md += `\n## ⬇️ 固件下载\n\n`;
    for (const [key, platform] of withLinks) {
      const latest = platform.updates[0];
      md += `### ${platform.name} ${latest.version}\n\n`;
      if (latest._firmwareUrls.apple) {
        md += `- [Apple 官方固件](${latest._firmwareUrls.apple})\n`;
      }
      md += `\n`;
    }
  }

  // 历史记录
  md += `\n## 历史记录\n\n`;
  for (const [key, platform] of Object.entries(data.platforms)) {
    if (platform.updates.length > 0) {
      md += `### ${platform.name}\n\n`;
      for (const u of platform.updates) {
        const typeIcon = u._updateType === 'major' ? '🟢'
          : u._updateType === 'security-response' ? '🔴'
          : u._updateType === 'security' ? '🟡' : '🔵';
        md += `- ${typeIcon} ${u.version}${u.build ? ` (${u.build})` : ''}`;
        if (u.downloadSize) md += ` [${formatSize(u.downloadSize)}]`;
        if (u.postingDate || u.firstSeen) md += ` - ${fmtDate(u.postingDate || u.firstSeen)}`;
        if (u._firmwareUrls?.apple) md += ` [下载](${u._firmwareUrls.apple})`;
        md += `\n`;
      }
      md += `\n`;
    }
  }

  md += `---\n*此文件由 GitHub Actions 自动更新*\n`;
  return md;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
