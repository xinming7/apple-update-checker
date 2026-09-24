#!/usr/bin/env node
// RSS Feed Generator for Apple Update Checker
// 从 data/updates.json 生成 Atom 格式的 RSS Feed

const fs = require('fs');
const path = require('path');

const REPO_URL = 'https://github.com/xinming7/apple-update-checker';
const FEED_TITLE = 'Apple System Updates';
const FEED_SUBTITLE = 'iOS, macOS, watchOS, tvOS, visionOS, XProtect 系统更新追踪';

function escapeXml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function formatDate(isoStr) {
  if (!isoStr) return new Date().toISOString();
  return new Date(isoStr).toISOString();
}

function generateAtomFeed(data) {
  const now = new Date().toISOString();
  let entries = '';

  for (const [key, platform] of Object.entries(data.platforms || {})) {
    if (!platform.updates || platform.updates.length === 0) continue;

    for (const u of platform.updates) {
      const title = `${u.platform} ${u.version} (${u.build})`;
      const published = formatDate(u.postingDate || data.lastChecked);
      const id = `tag:apple-update-checker,${published.split('T')[0]}:${u.platform}-${u.version}-${u.build}`;

      let content = `<p><strong>${escapeXml(u.platform)}</strong> ${escapeXml(u.version)} (${escapeXml(u.build)})</p>`;
      content += `<ul>`;
      if (u.postingDate) content += `<li>发布日期: ${new Date(u.postingDate).toLocaleDateString('zh-CN')}</li>`;
      if (u.downloadSize) content += `<li>大小: ${formatSize(u.downloadSize)}</li>`;
      if (u._updateType) content += `<li>类型: ${updateTypeLabel(u._updateType)}</li>`;
      content += `</ul>`;

      if (u._firmwareUrls) {
        content += `<p>`;
        if (u._firmwareUrls.apple) content += `<a href="${escapeXml(u._firmwareUrls.apple)}">Apple 固件下载</a> | `;
        if (u._firmwareUrls.ipswme) content += `<a href="${escapeXml(u._firmwareUrls.ipswme)}">IPSW.me</a>`;
        content += `</p>`;
      }

      content += `<p><a href="${REPO_URL}/blob/main/UPDATE_STATUS.md">查看详细信息</a></p>`;

      entries += `  <entry>
    <title>${escapeXml(title)}</title>
    <link href="${REPO_URL}/blob/main/UPDATE_STATUS.md"/>
    <id>${id}</id>
    <published>${published}</published>
    <updated>${now}</updated>
    <summary>${escapeXml(u.platform)} ${escapeXml(u.version)} 更新</summary>
    <content type="html"><![CDATA[${content}]]></content>
    <category term="${escapeXml(u.platform)}" label="${escapeXml(u.platform)}"/>
  </entry>\n`;
    }
  }

  // XProtect
  if (data.xprotect) {
    const xp = data.xprotect;
    const published = formatDate(xp.lastChecked || data.lastChecked);
    const id = `tag:apple-update-checker,${published.split('T')[0]}:XProtect-${xp.version}`;
    const content = `<p><strong>XProtect</strong> 版本 ${escapeXml(xp.version)}</p><p>签名日期: ${escapeXml(xp.date)}</p>`;

    entries += `  <entry>
    <title>XProtect ${escapeXml(xp.version)}</title>
    <link href="${REPO_URL}/blob/main/UPDATE_STATUS.md"/>
    <id>${id}</id>
    <published>${published}</published>
    <updated>${now}</updated>
    <summary>XProtect 安全签名更新</summary>
    <content type="html"><![CDATA[${content}]]></content>
    <category term="XProtect" label="XProtect"/>
  </entry>\n`;
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(FEED_TITLE)}</title>
  <subtitle>${escapeXml(FEED_SUBTITLE)}</subtitle>
  <link href="${REPO_URL}/blob/main/feed.xml" rel="self" type="application/atom+xml"/>
  <link href="${REPO_URL}" rel="alternate" type="text/html"/>
  <id>${REPO_URL}</id>
  <updated>${now}</updated>
  <author>
    <name>Apple Update Checker</name>
  </author>
${entries}</feed>`;
}

function updateTypeLabel(type) {
  const labels = {
    'major': '大版本更新',
    'minor': '小版本更新',
    'security-response': '安全响应 (RSR)',
    'security': '安全补丁',
    'xprotect': 'XProtect 更新'
  };
  return labels[type] || '更新';
}

function formatSize(bytes) {
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function main() {
  console.log('=== RSS Feed Generator ===');

  const dataFile = path.join(__dirname, '..', 'data', 'updates.json');
  if (!fs.existsSync(dataFile)) {
    console.error('No updates.json found. Run check-updates.js first.');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  const feed = generateAtomFeed(data);

  const feedFile = path.join(__dirname, '..', 'feed.xml');
  fs.writeFileSync(feedFile, feed);
  console.log(`Generated: ${feedFile}`);

  // 统计
  let entryCount = 0;
  for (const platform of Object.values(data.platforms || {})) {
    entryCount += (platform.updates || []).length;
  }
  if (data.xprotect) entryCount++;
  console.log(`Total entries: ${entryCount}`);
}

main().catch(console.error);
