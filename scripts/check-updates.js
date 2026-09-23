#!/usr/bin/env node
// Apple Update Checker - GitHub Actions Script
// 检查苹果系统更新并保存到仓库

const fs = require('fs');
const path = require('path');

// Apple OTA feed URLs
const FEEDS = {
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
  }
};

async function fetchFeed(platform) {
  const config = FEEDS[platform];
  console.log(`Fetching ${config.name} updates...`);

  try {
    const response = await fetch(config.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();
    return parseXML(xml, config.name);
  } catch (error) {
    console.error(`Error fetching ${config.name}:`, error.message);
    return [];
  }
}

function parseXML(xml, platformName) {
  const updates = [];
  const assetBlocks = xml.match(/<dict>[\s\S]*?<\/dict>/g) || [];

  for (const block of assetBlocks) {
    const update = { platform: platformName };

    const versionMatch = block.match(/<key>OSVersion<\/key>\s*<string>([^<]+)<\/string>/);
    if (versionMatch) update.version = versionMatch[1];

    const buildMatch = block.match(/<key>Build<\/key>\s*<string>([^<]+)<\/string>/);
    if (buildMatch) update.build = buildMatch[1];

    const dateMatch = block.match(/<key>PostingDate<\/key>\s*<date>([^<]+)<\/date>/);
    if (dateMatch) update.postingDate = dateMatch[1];

    const sizeMatch = block.match(/<key>DownloadSize<\/key>\s*<integer>([^<]+)<\/integer>/);
    if (sizeMatch) update.downloadSize = parseInt(sizeMatch[1]);

    if (update.version) {
      updates.push(update);
    }
  }

  // 去重并取最新3个
  const unique = [];
  const seen = new Set();
  for (const u of updates) {
    const key = `${u.version}-${u.build}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(u);
    }
  }
  return unique.slice(0, 3);
}

async function main() {
  console.log('=== Apple Update Checker ===');
  console.log('Time:', new Date().toISOString());
  console.log('');

  // 并行获取所有平台
  const results = await Promise.allSettled(
    Object.keys(FEEDS).map(platform => fetchFeed(platform))
  );

  const allUpdates = results
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

  // 保存到 data 目录
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

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
      console.log(`${platform.name}: ${latest.version} (${latest.build})`);
    } else {
      console.log(`${platform.name}: No data`);
    }
  }
}

function generateMarkdown(data) {
  const lastChecked = new Date(data.lastChecked).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  let md = `# Apple 系统更新状态\n\n`;
  md += `> 最后检查: ${lastChecked}\n\n`;
  md += `| 平台 | 最新版本 | Build | 发布日期 |\n`;
  md += `|------|----------|-------|----------|\n`;

  for (const [key, platform] of Object.entries(data.platforms)) {
    const latest = platform.updates[0];
    if (latest) {
      const date = latest.postingDate ? new Date(latest.postingDate).toLocaleDateString('zh-CN') : '-';
      md += `| ${platform.name} | ${latest.version} | ${latest.build} | ${date} |\n`;
    } else {
      md += `| ${platform.name} | - | - | - |\n`;
    }
  }

  md += `\n## 历史记录\n\n`;
  for (const [key, platform] of Object.entries(data.platforms)) {
    if (platform.updates.length > 0) {
      md += `### ${platform.name}\n\n`;
      for (const u of platform.updates) {
        md += `- ${u.version} (${u.build})`;
        if (u.postingDate) md += ` - ${new Date(u.postingDate).toLocaleDateString('zh-CN')}`;
        md += `\n`;
      }
      md += `\n`;
    }
  }

  md += `---\n*此文件由 GitHub Actions 自动更新*\n`;
  return md;
}

main().catch(console.error);
