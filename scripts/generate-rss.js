#!/usr/bin/env node
// RSS Feed Generator for Apple Update Checker
// 从 data/updates.json 生成 Atom 格式的 RSS Feed

const fs = require('fs');
const path = require('path');
const { updateTypeLabel, formatSize } = require('./utils');

const REPO_URL = process.env.REPO_URL || `https://github.com/${process.env.GITHUB_REPOSITORY || 'OWNER/REPO'}`;
const FEED_TITLE = 'Apple System Updates';
const FEED_SUBTITLE = 'iOS, macOS, watchOS, tvOS, visionOS, XProtect 系统更新追踪';

function escapeXml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function formatDate(isoStr) {
  if (!isoStr) return new Date().toISOString();
  const d = new Date(isoStr);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function generateAtomFeed(data) {
  const now = new Date().toISOString();
  let entries = '';

  for (const [key, platform] of Object.entries(data.platforms || {})) {
    if (!platform.updates || platform.updates.length === 0) continue;

    for (const u of platform.updates) {
      const title = `${u.platform} ${u.version}${u.build ? ` (${u.build})` : ''}`;
      const published = formatDate(u.postingDate || u.firstSeen || data.lastChecked);
      const id = `tag:apple-update-checker,${published.split('T')[0]}:${u.platform}-${u.version}-${u.build}`;

      let content = `<p><strong>${escapeXml(u.platform)}</strong> ${escapeXml(u.version)}${u.build ? ` (${escapeXml(u.build)})` : ''}</p>`;
      content += `<ul>`;
      if (u.postingDate || u.firstSeen) content += `<li>发布日期: ${new Date(u.postingDate || u.firstSeen).toLocaleDateString('zh-CN')}</li>`;
      if (u.downloadSize) content += `<li>大小: ${formatSize(u.downloadSize)}</li>`;
      if (u._updateType) content += `<li>类型: ${updateTypeLabel(u._updateType)}</li>`;
      content += `</ul>`;

      if (u._firmwareUrls && u._firmwareUrls.apple) {
        content += `<p><a href="${escapeXml(u._firmwareUrls.apple)}">Apple 固件下载</a></p>`;
      }

      content += `<p><a href="${REPO_URL}/blob/main/UPDATE_STATUS.md">查看详细信息</a></p>`;

      entries += `  <entry>
    <title>${escapeXml(title)}</title>
    <link href="${REPO_URL}/blob/main/UPDATE_STATUS.md"/>
    <id>${id}</id>
    <published>${published}</published>
    <updated>${published}</updated>
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
    <updated>${published}</updated>
    <summary>XProtect 安全签名更新</summary>
    <content type="html"><![CDATA[${content}]]></content>
    <category term="XProtect" label="XProtect"/>
  </entry>\n`;
  }

  // Beta 版本
  if (data.betaUpdates && data.betaUpdates.length > 0) {
    for (const b of data.betaUpdates) {
      const betaVer = `${b.version}${b.betaNumber ? ` Beta ${b.betaNumber}` : ''}`;
      const title = `${b.platform} ${betaVer}`;
      const published = formatDate(data.lastChecked);
      const id = `tag:apple-update-checker,${published.split('T')[0]}:${b.platform}-beta-${b.version}`;
      const content = `<p><strong>${escapeXml(b.platform)}</strong> ${escapeXml(betaVer)}</p><p>类型: Beta 版本</p>`;

      entries += `  <entry>
    <title>${escapeXml(title)}</title>
    <link href="${REPO_URL}/blob/main/UPDATE_STATUS.md"/>
    <id>${id}</id>
    <published>${published}</published>
    <updated>${published}</updated>
    <summary>${escapeXml(b.platform)} ${escapeXml(betaVer)}</summary>
    <content type="html"><![CDATA[${content}]]></content>
    <category term="${escapeXml(b.platform)}" label="${escapeXml(b.platform)}"/>
  </entry>\n`;
    }
  }

  // <updated> 取所有 entry 中最新的发布日期，避免无更新时每日抖动
  // fallback 用 lastChecked 而非 now，避免每次 Actions 运行都改变 <updated>
  let latestDate = data.lastChecked || now;
  for (const platform of Object.values(data.platforms || {})) {
    for (const u of (platform.updates || [])) {
      const d = u.postingDate || u.firstSeen;
      if (d && d > latestDate) latestDate = d;
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(FEED_TITLE)}</title>
  <subtitle>${escapeXml(FEED_SUBTITLE)}</subtitle>
  <link href="${REPO_URL}/blob/main/feed.xml" rel="self" type="application/atom+xml"/>
  <link href="${REPO_URL}" rel="alternate" type="text/html"/>
  <id>${REPO_URL}</id>
  <updated>${new Date(latestDate).toISOString()}</updated>
  <author>
    <name>Apple Update Checker</name>
  </author>
${entries}</feed>`;
}

async function main() {
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
