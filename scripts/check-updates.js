#!/usr/bin/env node
// Apple Update Checker - GitHub Actions Script
// 检查苹果系统更新并保存到仓库

const fs = require('fs');
const path = require('path');

// Apple OTA feed URLs
const ALL_FEEDS = {
  ios: {
    name: 'iOS',
    url: 'https://mesu.apple.com/assets/com_apple_MobileAsset_SoftwareUpdate/com_apple_MobileAsset_SoftwareUpdate.xml'
  },
  macos: {
    name: 'macOS',
    url: 'https://mesu.apple.com/assets/com_apple_MobileAsset_SFRSoftwareUpdate/com_apple_MobileAsset_SFRSoftwareUpdate.xml'
  },
  watchos: {
    name: 'watchOS',
    url: 'https://mesu.apple.com/assets/com_apple_MobileAsset_WatchSoftwareUpdate/com_apple_MobileAsset_WatchSoftwareUpdate.xml'
  },
  tvos: {
    name: 'tvOS',
    url: 'https://mesu.apple.com/assets/com_apple_MobileAsset_TVSoftwareUpdate/com_apple_MobileAsset_TVSoftwareUpdate.xml'
  },
  visionos: {
    name: 'visionOS',
    url: 'https://mesu.apple.com/assets/com_apple_MobileAsset_VisionSoftwareUpdate/com_apple_MobileAsset_VisionSoftwareUpdate.xml'
  }
};

// 平台过滤（环境变量 PLATFORMS，逗号分隔，如 "ios,macos"）
const PLATFORM_FILTER = process.env.PLATFORMS
  ? process.env.PLATFORMS.split(',').map(p => p.trim().toLowerCase()).filter(Boolean)
  : null;

const FEEDS = PLATFORM_FILTER
  ? Object.fromEntries(
      Object.entries(ALL_FEEDS).filter(([key]) => PLATFORM_FILTER.includes(key))
    )
  : ALL_FEEDS;

// 重试配置
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (err) {
      console.error(`  Attempt ${i + 1}/${retries} failed: ${err.message}`);
      if (i < retries - 1) await sleep(RETRY_DELAY_MS * (i + 1));
      else throw err;
    }
  }
}

// ─── 新增功能函数 ──────────────────────────────────────────────

/**
 * 更新类型分类
 */
function classifyUpdate(version, build, title) {
  if (title && /Rapid Security Response/i.test(title)) return 'security-response';
  // RSR build 以小写字母结尾，排除 beta 后缀（如 23B5046f）
  if (build && /[a-z]$/.test(build)) return 'security-response';
  if (version) {
    const parts = version.split('.');
    if (parts.length === 1) return 'major';
    if (parts.length === 2) return 'major';
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
 */
function generateFirmwareUrls(update) {
  const urls = {};

  // Apple OTA 固件直接下载链接
  if (update._baseUrl && update._relativePath) {
    urls.apple = update._baseUrl + update._relativePath;
  }

  // IPSW.me 深度链接
  if (update.platform === 'iOS' && update.version) {
    urls.ipswme = `https://ipsw.me/download/iPhone/${update.version}`;
  } else if (update.platform === 'macOS' && update.version) {
    urls.ipswme = `https://ipsw.me/download/mac/${update.version}`;
  }

  return urls;
}

/**
 * XProtect 版本检测
 */
async function fetchXProtectVersion() {
  console.log('Fetching XProtect version...');

  try {
    const response = await fetchWithRetry(
      'https://gdmf.apple.com/v2/pmv',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'SoftwareUpdate (unknown version) CFNetwork/1408.0.4 Darwin/22.5.0'
        },
        body: JSON.stringify({
          ClientUUID: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
          AudienceID: '00000000-0000-0000-0000-000000000000',
          ProductType: 'Mac',
          HWModelStr: 'J137AP',
          ProductVersion: '14.5',
          Build: '23F79'
        })
      }
    );

    const buffer = await response.arrayBuffer();
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

    // 从 binary plist 中提取 XProtect 版本
    const versionMatch = text.match(/XProtect[\s\S]{0,200}?(\d{4,8})/i)
      || text.match(/com\.apple\.XProtect[\s\S]{0,100}(\d{4,})/i);

    if (versionMatch) {
      const version = versionMatch[1];
      const dateStr = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8) || '01'}`;
      console.log(`  XProtect version: ${version} (${dateStr})`);
      return { version, date: dateStr };
    }

    console.log('  XProtect version not found in response');
    return null;
  } catch (err) {
    console.error(`  XProtect fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * 检查 XProtect 是否有新版本
 */
async function checkXProtectUpdate(dataDir) {
  const xp = await fetchXProtectVersion();
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
  const xpDir = dataDir;
  if (!fs.existsSync(xpDir)) fs.mkdirSync(xpDir, { recursive: true });
  fs.writeFileSync(prevFile, JSON.stringify({ version: xp.version, date: xp.date, checkedAt: new Date().toISOString() }, null, 2));

  // 检测变更
  if (prevVersion && prevVersion !== xp.version) {
    return {
      platform: 'XProtect',
      version: xp.version,
      build: xp.version,
      postingDate: new Date().toISOString(),
      _updateType: 'xprotect',
      title: `XProtect ${xp.version} (${xp.date})`
    };
  }
  return null;
}

/**
 * 计算更新间隔统计
 */
function computeIntervalStats(data) {
  const stats = {};

  for (const [key, platform] of Object.entries(data.platforms)) {
    if (platform.updates.length < 2) {
      if (platform.updates.length === 1 && platform.updates[0].postingDate) {
        const daysSince = Math.floor(
          (Date.now() - new Date(platform.updates[0].postingDate).getTime()) / 86400000
        );
        stats[key] = { daysSinceLast: daysSince };
      }
      continue;
    }

    const sorted = [...platform.updates]
      .filter(u => u.postingDate)
      .sort((a, b) => new Date(b.postingDate) - new Date(a.postingDate));

    if (sorted.length < 2) continue;

    const intervals = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const diff = new Date(sorted[i].postingDate) - new Date(sorted[i + 1].postingDate);
      intervals.push(Math.round(diff / 86400000));
    }

    stats[key] = {
      avgDays: Math.round(intervals.reduce((s, d) => s + d, 0) / intervals.length),
      daysSinceLast: Math.floor((Date.now() - new Date(sorted[0].postingDate).getTime()) / 86400000),
      history: intervals
    };
  }

  return stats;
}

// ─── 原有函数（增强） ──────────────────────────────────────────

async function fetchFeed(platform) {
  const config = FEEDS[platform];
  console.log(`Fetching ${config.name} updates...`);

  try {
    const response = await fetchWithRetry(config.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });

    const xml = await response.text();
    return parseXML(xml, config.name);
  } catch (error) {
    console.error(`Error fetching ${config.name}: ${error.message}`);
    return [];
  }
}

/**
 * 解析 Apple OTA XML（增强版，提取更多字段）
 */
function parseXML(xml, platformName) {
  const updates = [];

  const assetsMatch = xml.match(/<key>Assets<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!assetsMatch) {
    console.warn(`  No Assets array found for ${platformName}`);
    return [];
  }

  const assetsXml = assetsMatch[1];
  const dictRegex = /<dict>([\s\S]*?)<\/dict>/g;
  let match;

  while ((match = dictRegex.exec(assetsXml)) !== null) {
    const block = match[1];
    const update = { platform: platformName };

    // 基本字段
    const versionMatch = block.match(/<key>OSVersion<\/key>\s*<string>([^<]+)<\/string>/);
    if (versionMatch) update.version = versionMatch[1];

    const buildMatch = block.match(/<key>Build<\/key>\s*<string>([^<]+)<\/string>/);
    if (buildMatch) update.build = buildMatch[1];

    const dateMatch = block.match(/<key>PostingDate<\/key>\s*<date>([^<]+)<\/date>/);
    if (dateMatch) update.postingDate = dateMatch[1];

    const sizeMatch = block.match(/<key>DownloadSize<\/key>\s*<integer>([^<]+)<\/integer>/);
    if (sizeMatch) update.downloadSize = parseInt(sizeMatch[1]);

    const titleMatch = block.match(/<key>HumanReadableUpdateName<\/key>\s*<string>([^<]+)<\/string>/);
    if (titleMatch) update.title = titleMatch[1];

    // 新增字段：固件下载链接
    const baseUrlMatch = block.match(/<key>__BaseURL<\/key>\s*<string>([^<]+)<\/string>/);
    if (baseUrlMatch) update._baseUrl = baseUrlMatch[1];

    const relPathMatch = block.match(/<key>__RelativePath<\/key>\s*<string>([^<]+)<\/string>/);
    if (relPathMatch) update._relativePath = relPathMatch[1];

    // 新增字段：更新元数据
    const rtkMatch = block.match(/<key>RealTimeKernelConfig<\/key>/);
    if (rtkMatch) update._hasRTK = true;

    const prereqMatch = block.match(/<key>PrerequisiteBuild<\/key>\s*<string>([^<]+)<\/string>/);
    if (prereqMatch) update._prerequisiteBuild = prereqMatch[1];

    const docIdMatch = block.match(/<key>SUDocumentationID<\/key>\s*<string>([^<]+)<\/string>/);
    if (docIdMatch) update._documentationId = docIdMatch[1];

    const pvExtraMatch = block.match(/<key>ProductVersionExtra<\/key>\s*<string>([^<]+)<\/string>/);
    if (pvExtraMatch) update._productVersionExtra = pvExtraMatch[1];

    // 分类
    update._updateType = classifyUpdate(update.version, update.build, update.title);

    // 固件链接
    update._firmwareUrls = generateFirmwareUrls(update);

    if (update.version) {
      updates.push(update);
    }
  }

  // 去重并取最新5个
  const unique = [];
  const seen = new Set();
  for (const u of updates) {
    const key = `${u.version}-${u.build}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(u);
    }
  }
  return unique.slice(0, 5);
}

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
    msg += `📱 <b>${u.platform}</b> ${u.version}`;
    if (u.build) msg += ` (${u.build})`;
    if (u.downloadSize) msg += ` [${formatSize(u.downloadSize)}]`;
    msg += `\n`;
    if (u.postingDate) {
      msg += `📅 发布日期: ${new Date(u.postingDate).toLocaleDateString('zh-CN')}\n`;
    }

    // 固件下载链接
    if (u._firmwareUrls) {
      if (u._firmwareUrls.apple) {
        msg += `⬇️ <a href="${u._firmwareUrls.apple}">Apple 官方固件下载</a>\n`;
      }
    }

    msg += `\n`;
  }

  // 更新间隔统计
  if (intervalStats) {
    const statEntries = Object.entries(intervalStats).filter(([, s]) => s.daysSinceLast != null);
    if (statEntries.length > 0) {
      msg += `📊 <b>更新间隔统计</b>\n`;
      for (const [platform, s] of statEntries) {
        const icon = FEEDS[platform]?.name ? '📱' : '🛡️';
        const name = FEEDS[platform]?.name || platform;
        msg += `${icon} ${name}: 距上次更新 ${s.daysSinceLast} 天`;
        if (s.avgDays) msg += `，平均每 ${s.avgDays} 天更新一次`;
        msg += `\n`;
      }
      msg += `\n`;
    }
  }

  // Telegram 消息长度限制 4096 字符，超出则截断
  const MAX_TG_LEN = 4000;
  if (msg.length > MAX_TG_LEN) {
    msg = msg.slice(0, MAX_TG_LEN - 30) + '\n\n... (内容过长已截断)';
  }
  msg += `🔗 <a href="https://github.com/xinming7/apple-update-checker/blob/main/UPDATE_STATUS.md">查看详细信息</a>`;
  return msg;
}

function formatSize(bytes) {
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
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
  for (const u of updates) {
    try {
      const res = await fetch(`${hubUrl}/api/projects/ios-update-check/updates`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${hubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: u.version,
          title: `${u.platform} ${u.version} (${u.build})`,
          body: u.postingDate
            ? `发布日期: ${new Date(u.postingDate).toLocaleDateString('zh-CN')}`
            : '',
          status: 'changed',
          extra: { platform: u.platform, build: u.build, downloadSize: u.downloadSize, updateType: u._updateType },
        }),
      });
      const result = await res.json();
      console.log(`Update Hub: ${u.platform} ${u.version} → ${result.recorded ? 'OK' : result.error}`);
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
    console.log(`Platform filter: ${PLATFORM_FILTER.join(', ')}`);
  }
  console.log('');

  // 确保 data 目录存在（XProtect 和主流程都需要）
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 并行获取所有平台 + XProtect
  const fetchTasks = Object.keys(FEEDS).map(platform => fetchFeed(platform));
  const xpTask = checkXProtectUpdate(dataDir);

  const results = await Promise.allSettled([...fetchTasks, xpTask]);

  const allUpdates = results
    .slice(0, fetchTasks.length)
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // 构建输出
  const output = {
    lastChecked: new Date().toISOString(),
    platforms: {}
  };

  for (const platform of Object.keys(FEEDS)) {
    const updates = allUpdates.filter(u => u.platform === FEEDS[platform].name);
    output.platforms[platform] = {
      name: FEEDS[platform].name,
      updates: updates
    };
  }

  // XProtect 结果
  const xpResult = results[results.length - 1];
  if (xpResult.status === 'fulfilled' && xpResult.value) {
    output.xprotect = {
      name: 'XProtect',
      version: xpResult.value.version,
      date: xpResult.value.date,
      lastChecked: new Date().toISOString()
    };
  }

  // 检测变更
  const newUpdates = detectChanges(output, dataDir);
  // XProtect 更新也加入新版本列表
  if (xpResult.status === 'fulfilled' && xpResult.value) {
    if (!newUpdates) {
      // 首次运行，不算新版本
    } else {
      newUpdates.push(xpResult.value);
    }
  }

  // 计算更新间隔统计
  const intervalStats = computeIntervalStats(output);
  output._intervalStats = intervalStats;

  const outputFile = path.join(dataDir, 'updates.json');
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
      console.log(`${platform.name}: ${latest.version} (${latest.build}) ${type}`);
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
      const date = latest.postingDate ? new Date(latest.postingDate).toLocaleDateString('zh-CN') : '-';
      const typeLabel = latest._updateType === 'major' ? '🟢 大版本'
        : latest._updateType === 'security-response' ? '🔴 RSR'
        : latest._updateType === 'security' ? '🟡 安全'
        : '🔵 小版本';
      const size = latest.downloadSize ? formatSize(latest.downloadSize) : '-';
      const stat = intervalStats[key];
      const daysAgo = stat?.daysSinceLast != null ? `${stat.daysSinceLast}天` : '-';
      md += `| ${platform.name} | ${latest.version} | ${latest.build} | ${typeLabel} | ${size} | ${date} | ${daysAgo} |\n`;
    } else {
      md += `| ${platform.name} | - | - | - | - | - | - |\n`;
    }
  }

  // XProtect 状态
  if (data.xprotect) {
    md += `| 🛡️ XProtect | ${data.xprotect.version} | ${data.xprotect.version} | 安全 | - | ${data.xprotect.date} | - |\n`;
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
  md += `\n## ⬇️ 固件下载\n\n`;
  for (const [key, platform] of Object.entries(data.platforms)) {
    const latest = platform.updates[0];
    if (latest && latest._firmwareUrls) {
      md += `### ${platform.name} ${latest.version}\n\n`;
      if (latest._firmwareUrls.apple) {
        md += `- [Apple 官方固件](${latest._firmwareUrls.apple})\n`;
      }
      if (latest._firmwareUrls.ipswme) {
        md += `- [IPSW.me](${latest._firmwareUrls.ipswme})\n`;
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
        md += `- ${typeIcon} ${u.version} (${u.build})`;
        if (u.downloadSize) md += ` [${formatSize(u.downloadSize)}]`;
        if (u.postingDate) md += ` - ${new Date(u.postingDate).toLocaleDateString('zh-CN')}`;
        if (u._firmwareUrls?.apple) md += ` [下载](${u._firmwareUrls.apple})`;
        md += `\n`;
      }
      md += `\n`;
    }
  }

  md += `---\n*此文件由 GitHub Actions 自动更新*\n`;
  return md;
}

main().catch(console.error);
