#!/usr/bin/env node
// Apple Update Checker - GitHub Actions Script
// 检查苹果系统更新并保存到仓库
//
// 数据源架构：
//   主源  gdmf.apple.com/v2/pmv（GET JSON）：全平台版本 / Build / 发布日期 / RSR 标记
//   辅助  mesu.apple.com OTA feed（XML plist）：补充固件下载链接与大小（仅 iOS/watchOS/tvOS 有）
//   Beta  Apple Developer Docs JSON 端点：提取各平台最新 Beta 版本
// curl fallback：Apple CDN 证书链不被 Node.js fetch/undici 信任，需 curl 使用系统证书库

const fs = require('fs');
const path = require('path');
const {
  sleep, escapeHtml, mdCell, formatSize, updateTypeLabelTg,
  fmtDate, truncateHtmlMessage, FETCH_TIMEOUT_MS, fetchWithRetry
} = require('./utils');

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

// check-updates.js 使用 utils 的 fetchWithRetry，传 { curlFallback: true }
// 因为 Apple CDN (gdmf/mesu) 证书链不被 Node.js fetch 信任，需 curl 系统证书库

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

// updateTypeLabelTg 从 utils.js 导入

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

  // 去重：同版本只保留最新 Build（gdmf iOS 桶混装 iPhone/iPad/iPod 不同 Build）
  const result = {};
  for (const [key, updates] of Object.entries(buckets)) {
    updates.sort(compareUpdatesDesc);

    // 按 version 分组，每组保留最大 Build（降序排列后取第一个）
    const byVersion = new Map();
    for (const u of updates) {
      if (!byVersion.has(u.version)) {
        byVersion.set(u.version, u);
      }
    }
    const deduped = [...byVersion.values()];

    // 过滤旧版本线：只保留最新主版本线
    // RSR 也过滤：只保留比最新正式版更新的 RSR（如正式版已到 27.x，则丢弃 26.x 的 RSR）
    const rsr = deduped.filter(u => u._updateType === 'security-response');
    const nonRsr = deduped.filter(u => u._updateType !== 'security-response');

    let filtered;
    if (nonRsr.length > 0) {
      // 取最新版本的主版本号（如27.0 → 27）
      const latestMajor = semverKey(nonRsr[0].version)[0];
      const latestLine = nonRsr.filter(u => semverKey(u.version)[0] === latestMajor);
      // 过滤掉比最新正式版更旧的 RSR（compareUpdatesDesc(a,b)<0 表示 a 比 b 更新）
      const latestStableVer = nonRsr[0].version;
      const newerRsr = rsr.filter(u => compareUpdatesDesc(u, { version: latestStableVer }) < 0);
      filtered = [...latestLine, ...newerRsr];
    } else {
      filtered = rsr;
    }

    filtered.sort(compareUpdatesDesc);
    result[key] = filtered.slice(0, 5);
    if (result[key].length > 0) {
      console.log(`  ${ALL_PLATFORMS[key].name}: ${result[key].map(u => `${u.version} (${u.build})`).join(', ')}`);
    }
  }
  return result;
}

/**
 * 抓取 gdmf/pmv JSON，按平台汇总最新版本
 */
async function fetchPmvUpdates() {
  console.log('Fetching gdmf/pmv catalog...');
  const response = await fetchWithRetry(PMV_URL, {
    curlFallback: true,
    headers: {
      'User-Agent': 'SoftwareUpdate (unknown version) CFNetwork/1408.0.4 Darwin/22.5.0',
      'Accept': 'application/json'
    }
  });
  const raw = await response.json();
  const updates = parsePmvData(raw);
  return { raw, updates };
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
      curlFallback: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    const xml = await response.text();
    const result = parseMesuXML(xml, platformKey);
    console.log(`  mesu ${ALL_PLATFORMS[platformKey].name}: ${result.length} releases`);
    return result;
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

// ─── Beta 检测：Apple Developer Docs ─────────────────────────

/** 平台 key → Developer Docs 端点 slug */
const DEV_DOCS_SLUGS = {
  ios: 'ios-ipados',
  macos: 'macos',
  watchos: 'watchos',
  tvos: 'tvos',
  visionos: 'visionos'
};

/**
 * 从 Apple Developer Docs 提取各平台的最新 Beta 版本。
 * Developer Docs 的 release-notes JSON 中包含标题如 "iOS & iPadOS 27.2 Beta 2 Release Notes"，
 * 是目前唯一可靠的公开 Beta 数据源。
 * 返回 [ { platform, version, betaNumber }, ... ]
 */
async function fetchBetaFromDevDocs() {
  console.log('Fetching Beta info from Developer Docs...');
  const results = [];

  const tasks = PLATFORM_KEYS.map(async (key) => {
    const slug = DEV_DOCS_SLUGS[key];
    if (!slug) return;
    const url = `https://developer.apple.com/tutorials/data/documentation/${slug}-release-notes.json`;
    try {
      const response = await fetchWithRetry(url, {
        curlFallback: true,
        headers: { 'Accept': 'application/json' }
      });
      const text = await response.text();
      // 匹配 "iOS & iPadOS 27.2 Beta 2 Release Notes" 等标题
      const platformName = ALL_PLATFORMS[key].name;
      // 构建匹配模式：支持 "iOS & iPadOS", "macOS", "watchOS" 等
      // macOS 标题含代号如 "macOS 27.2 Golden Gate Beta 2"，需要跳过中间的代号
      const pattern = new RegExp(
        `(?:iOS\\s*(?:&\\s*iPadOS)?|${platformName})\\s+(\\d+\\.\\d+(?:\\.\\d+)?)\\s+[A-Za-z\\s]*?Beta\\s*(\\d+)?`,
        'gi'
      );
      let best = null;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const version = match[1];
        const betaNum = match[2] ? parseInt(match[2], 10) : 0;
        if (!best || compareUpdatesDesc({ version }, { version: best.version }) < 0 ||
            (version === best.version && betaNum > best.betaNumber)) {
          best = { platform: platformName, version, betaNumber: betaNum };
        }
      }
      if (best) {
        results.push(best);
        console.log(`  ${platformName}: ${best.version} Beta ${best.betaNumber}`);
      }
    } catch (err) {
      console.warn(`  Developer Docs fetch failed for ${key}: ${err.message}`);
    }
  });

  await Promise.allSettled(tasks);
  return results;
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
        curlFallback: true,
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
 * 格式化新版本消息（按平台分组，每组前放平台 tag）
 */
function formatTelegramMessage(newUpdates, intervalStats, betaUpdates) {
  let msg = '';

  // 正式版更新
  if (newUpdates && newUpdates.length > 0) {
    msg += `🍎 <b>Apple 系统更新通知</b>\n\n`;
    msg += `检测到 <b>${newUpdates.length}</b> 个新版本：\n\n`;

    // 按平台分组，保持出现顺序
    const groups = [];
    const groupMap = new Map();
    for (const u of newUpdates) {
      if (!groupMap.has(u.platform)) {
        groupMap.set(u.platform, []);
        groups.push(u.platform);
      }
      groupMap.get(u.platform).push(u);
    }

    // Beta 按平台名索引，方便在各平台组内追加
    const betaByPlatform = new Map();
    if (betaUpdates) {
      for (const b of betaUpdates) {
        betaByPlatform.set(b.platform, b);
      }
    }

    for (const platform of groups) {
      const updates = groupMap.get(platform);
      msg += `#${platform}更新\n\n`;

      for (const u of updates) {
        const typeLabel = updateTypeLabelTg(u._updateType);
        msg += `${typeLabel}\n`;
        msg += `📱 <b>${escapeHtml(u.platform)}</b> ${escapeHtml(u.version)}`;
        if (u.build) msg += ` (${escapeHtml(u.build)})`;
        if (u.downloadSize) msg += ` [${formatSize(u.downloadSize)}]`;
        msg += `\n`;
        if (u.postingDate) {
          msg += `📅 发布日期: ${fmtDate(u.postingDate)}\n`;
        }
        if (u._firmwareUrls && u._firmwareUrls.apple) {
          msg += `⬇️ <a href="${escapeHtml(u._firmwareUrls.apple)}">Apple 官方固件下载</a>\n`;
        }
        msg += `\n`;
      }

      // 该平台有 Beta 版本时追加在正式版之后
      const beta = betaByPlatform.get(platform);
      if (beta) {
        msg += `🧪 <b>Beta 版本</b>\n`;
        msg += `📱 <b>${escapeHtml(beta.platform)}</b> ${escapeHtml(beta.version)}`;
        if (beta.betaNumber) msg += ` Beta ${beta.betaNumber}`;
        msg += `\n\n`;
      }
    }

    // 没有正式版更新但有 Beta 的平台，单独展示
    if (betaUpdates) {
      for (const b of betaUpdates) {
        if (!groups.includes(b.platform)) {
          msg += `#${b.platform}更新\n\n`;
          msg += `🧪 <b>Beta 版本</b>\n`;
          msg += `📱 <b>${escapeHtml(b.platform)}</b> ${escapeHtml(b.version)}`;
          if (b.betaNumber) msg += ` Beta ${b.betaNumber}`;
          msg += `\n\n`;
        }
      }
    }
  } else if (betaUpdates && betaUpdates.length > 0) {
    // 纯 Beta 无正式版更新
    msg += `🍎 <b>Apple Beta 版本检测</b>\n\n`;
    for (const b of betaUpdates) {
      msg += `#${b.platform}更新\n\n`;
      msg += `🧪 <b>Beta 版本</b>\n`;
      msg += `📱 <b>${escapeHtml(b.platform)}</b> ${escapeHtml(b.version)}`;
      if (b.betaNumber) msg += ` Beta ${b.betaNumber}`;
      msg += `\n\n`;
    }
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
  msg += `🔗 <a href="${repoUrl}/blob/main/UPDATE_STATUS.md">查看详细信息</a>`;

  // 截断放在最后
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

  // 并行上报所有更新，避免串行等待
  const results = await Promise.allSettled(updates.map(async (u) => {
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
    return result;
  }));

  // 统计失败数
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    console.error(`Update Hub: ${failed.length}/${updates.length} reports failed`);
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

  // Beta 检测：从 Apple Developer Docs 提取各平台最新 Beta 版本
  const betaUpdates = await fetchBetaFromDevDocs();

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

  // Beta 版本信息持久化
  if (betaUpdates && betaUpdates.length > 0) {
    output.betaUpdates = betaUpdates;
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
      const type = updateTypeLabelTg(latest._updateType || 'minor');
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
    await sendTelegramMessage(formatTelegramMessage(newUpdates, intervalStats, betaUpdates));
    // 只在有新版本时同步到 Update Hub
    await reportToUpdateHub(newUpdates);
  } else if (betaUpdates && betaUpdates.length > 0) {
    // 没有正式版更新但有 beta 版本时，也发送通知
    await sendTelegramMessage(formatTelegramMessage([], intervalStats, betaUpdates));
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

  // Beta 版本状态
  if (data.betaUpdates && data.betaUpdates.length > 0) {
    md += `\n## 🧪 Beta 版本\n\n`;
    md += `| 平台 | Beta 版本 |\n`;
    md += `|------|----------|\n`;
    for (const b of data.betaUpdates) {
      const betaVer = `${b.version}${b.betaNumber ? ` Beta ${b.betaNumber}` : ''}`;
      md += `| ${mdCell(b.platform)} | ${mdCell(betaVer)} |\n`;
    }
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
