#!/usr/bin/env node
// Apple Security Updates Scanner
// 抓取 Apple 安全公告页面，提取 CVE 信息和 release notes 摘要

const fs = require('fs');
const path = require('path');
const { fetchWithRetry, mdCell } = require('./utils');

const APPLE_SECURITY_URL = 'https://support.apple.com/en-us/100100';

/**
 * 从 Apple 安全公告页面提取更新条目
 * Apple 页面使用 JSON-LD 结构化数据，每个更新是一个 <tr> 或嵌入的 JSON
 */
async function fetchSecurityUpdates() {
  console.log('Fetching Apple Security Updates page...');

  const response = await fetchWithRetry(APPLE_SECURITY_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8'
    }
  });

  const html = await response.text();
  return parseSecurityPage(html);
}

function parseSecurityPage(html) {
  const entries = [];

  // 提取表格中的安全更新条目
  // Apple 安全页面格式: 每行有产品名、发布日期、链接
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];

    // 提取链接和标题
    const linkMatch = row.match(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/);
    if (!linkMatch) continue;

    const href = linkMatch[1];
    const title = linkMatch[2].trim();

    // 只处理 Apple 安全更新链接
    if (!href.includes('support.apple.com') || !title) continue;

    // 提取日期
    const dateMatch = row.match(/(\w+ \d{1,2},\s*\d{4})/);
    const dateStr = dateMatch ? dateMatch[1] : null;

    // 提取版本号（从标题中）
    const versionMatch = title.match(/([\d]+\.[\d]+(?:\.[\d]+)?)/);
    const version = versionMatch ? versionMatch[1] : null;

    // 识别平台
    let platform = 'Unknown';
    if (/iPadOS/i.test(title)) platform = 'iOS';
    else if (/iOS|iPhone/i.test(title)) platform = 'iOS';
    else if (/macOS|Mac/i.test(title)) platform = 'macOS';
    else if (/watchOS/i.test(title)) platform = 'watchOS';
    else if (/tvOS|Apple TV/i.test(title)) platform = 'tvOS';
    else if (/visionOS/i.test(title)) platform = 'visionOS';
    else if (/Safari/i.test(title)) platform = 'Safari';
    else if (/Xcode/i.test(title)) platform = 'Xcode';

    // CVE 数量需从详情页获取，标题中一般不含 CVE
    const cveCount = 0;

    const fullUrl = href.startsWith('http') ? href : `https://support.apple.com${href}`;

    entries.push({
      title,
      platform,
      version,
      date: dateStr,
      url: fullUrl,
      cveCount
    });
  }

  // 备用方案：提取 <a> 标签中的安全更新链接
  if (entries.length === 0) {
    console.log('  Table parsing failed, trying link extraction...');
    const linkRegex = /<a[^>]+href="(https:\/\/support\.apple\.com\/[^"]*HT\d+[^"]*)"[^>]*>([^<]*(?:iOS|macOS|watchOS|tvOS|visionOS|Safari)[^<]*)<\/a>/gi;
    let linkMatch;

    while ((linkMatch = linkRegex.exec(html)) !== null) {
      const url = linkMatch[1];
      const title = linkMatch[2].trim();

      let platform = 'Unknown';
      if (/iOS/i.test(title)) platform = 'iOS';
      else if (/macOS/i.test(title)) platform = 'macOS';
      else if (/watchOS/i.test(title)) platform = 'watchOS';
      else if (/tvOS/i.test(title)) platform = 'tvOS';
      else if (/visionOS/i.test(title)) platform = 'visionOS';
      else if (/Safari/i.test(title)) platform = 'Safari';

      const versionMatch = title.match(/([\d]+\.[\d]+(?:\.[\d]+)?)/);
      const version = versionMatch ? versionMatch[1] : null;

      entries.push({
        title,
        platform,
        version,
        date: null,
        url,
        cveCount: 0
      });
    }
  }

  console.log(`  Found ${entries.length} security update entries`);
  return entries;
}

/**
 * 获取单个安全公告的详细信息（CVE 列表）
 */
async function fetchSecurityDetail(url) {
  console.log(`  Fetching detail: ${url}`);

  try {
    const response = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const html = await response.text();
    return parseDetailPage(html);
  } catch (err) {
    console.error(`  Detail fetch failed: ${err.message}`);
    return null;
  }
}

function parseDetailPage(html) {
  const cves = [];
  const descriptions = [];

  // 提取 CVE 编号
  const cveRegex = /CVE-\d{4}-\d{4,}/g;
  let cveMatch;
  const seen = new Set();

  while ((cveMatch = cveRegex.exec(html)) !== null) {
    const cve = cveMatch[0].toUpperCase();
    if (!seen.has(cve)) {
      seen.add(cve);
      cves.push(cve);
    }
  }

  // 提取描述段落（影响说明）— 只匹配紧跟版本信息或安全公告正文中的 Impact
  const impactRegex = /(?:<li|<p|<td)[^>]*>[^<]*Impact[:\s]+([^<]+)/gi;
  let impactMatch;
  while ((impactMatch = impactRegex.exec(html)) !== null) {
    const desc = impactMatch[1].trim();
    if (desc.length > 5 && desc.length < 500) {
      descriptions.push(desc);
    }
  }

  // 提取 release notes 摘要
  const summaryMatch = html.match(/<p[^>]*class="[^"]*gb-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    || html.match(/About this update[\s\S]*?<p>([\s\S]*?)<\/p>/i);

  let summary = null;
  if (summaryMatch) {
    summary = summaryMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 500);
  }

  return {
    cves: cves.slice(0, 50), // 限制数量
    cveCount: cves.length,
    descriptions: [...new Set(descriptions)].slice(0, 10),
    summary
  };
}

/**
 * 与本地 updates.json 匹配，补充 CVE 信息
 */
function matchWithLocalData(securityEntries, dataDir) {
  const updatesFile = path.join(dataDir, 'updates.json');
  if (!fs.existsSync(updatesFile)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(updatesFile, 'utf-8'));
    const matches = [];

    for (const [key, platform] of Object.entries(data.platforms)) {
      if (!platform.updates || platform.updates.length === 0) continue;

      const latest = platform.updates[0];
      if (!latest || !latest.version) continue;

      // 在安全公告中查找匹配的版本（按 major.minor 段精确比较，避免 "16.51" 误配 "16.5"）
      const seg2 = (v) => v.split('.').slice(0, 2).join('.');
      const matchedEntry = securityEntries.find(e =>
        e.platform === platform.name &&
        e.version &&
        seg2(latest.version) === seg2(e.version)
      );

      if (matchedEntry) {
        matches.push({
          platform: platform.name,
          version: latest.version,
          build: latest.build,
          securityUrl: matchedEntry.url,
          securityTitle: matchedEntry.title,
          cveCount: matchedEntry.cveCount
        });
      }
    }

    return matches;
  } catch (err) {
    console.error('Error matching with local data:', err.message);
    return [];
  }
}

async function main() {
  console.log('=== Apple Security Updates Scanner ===');
  console.log('Time:', new Date().toISOString());
  console.log('');

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 获取安全公告列表
  const entries = await fetchSecurityUpdates();

  if (entries.length === 0) {
    console.warn('No security entries found — possible HTML parse failure or Apple page changed.');
    // 输出空结果但不阻断 workflow（后续步骤仍需运行）
    const outputFile = path.join(dataDir, 'security.json');
    fs.writeFileSync(outputFile, JSON.stringify({ lastScanned: new Date().toISOString(), totalEntries: 0, recentDetails: [], localMatches: [] }, null, 2));
    return;
  }

  // 获取最近 3 个条目的详细信息（并行请求）
  const recentEntries = entries.slice(0, 3);
  const detailResults = await Promise.allSettled(
    recentEntries.map(entry => fetchSecurityDetail(entry.url))
  );

  const details = [];
  for (let i = 0; i < recentEntries.length; i++) {
    const result = detailResults[i];
    if (result.status === 'fulfilled' && result.value) {
      const detail = result.value;
      // CVE 数量回填到原始 entries 列表中
      entries[i].cveCount = detail.cveCount;
      details.push({
        ...recentEntries[i],
        ...detail
      });
    }
  }

  // 与本地数据匹配
  const matches = matchWithLocalData(entries, dataDir);

  // 输出结果
  const output = {
    lastScanned: new Date().toISOString(),
    totalEntries: entries.length,
    recentDetails: details,
    localMatches: matches
  };

  const outputFile = path.join(dataDir, 'security.json');
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outputFile}`);

  // 生成 Markdown 报告
  const markdown = generateSecurityMarkdown(output);
  const mdFile = path.join(__dirname, '..', 'SECURITY_STATUS.md');
  fs.writeFileSync(mdFile, markdown);
  console.log(`Updated ${mdFile}`);

  // 输出摘要
  console.log('\n=== Summary ===');
  console.log(`Total security entries: ${entries.length}`);
  for (const d of details) {
    console.log(`  ${d.platform} ${d.version}: ${d.cveCount} CVEs`);
  }
  if (matches.length > 0) {
    console.log(`Matched with local updates: ${matches.length}`);
    for (const m of matches) {
      console.log(`  ${m.platform} ${m.version}: ${m.cveCount} CVEs → ${m.securityUrl}`);
    }
  }
}

function generateSecurityMarkdown(data) {
  const lastScanned = new Date(data.lastScanned).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  let md = `# Apple 安全更新追踪\n\n`;
  md += `> 最后扫描: ${lastScanned}\n\n`;
  md += `> 数据来源: [Apple Security Updates](https://support.apple.com/en-us/100100)\n\n`;

  // 本地版本匹配的安全信息
  if (data.localMatches && data.localMatches.length > 0) {
    md += `## 🔒 当前版本安全信息\n\n`;
    md += `| 平台 | 版本 | CVE 数量 | 安全公告 |\n`;
    md += `|------|------|----------|----------|\n`;
    for (const m of data.localMatches) {
      md += `| ${mdCell(m.platform)} | ${mdCell(m.version)} | ${m.cveCount} | [查看](${m.securityUrl}) |\n`;
    }
    md += `\n`;
  }

  // 最近安全公告详情
  if (data.recentDetails && data.recentDetails.length > 0) {
    md += `## 📋 最近安全公告详情\n\n`;
    for (const entry of data.recentDetails) {
      md += `### ${mdCell(entry.title)}\n\n`;
      md += `- **平台**: ${mdCell(entry.platform)}\n`;
      if (entry.version) md += `- **版本**: ${mdCell(entry.version)}\n`;
      if (entry.date) md += `- **发布日期**: ${mdCell(entry.date)}\n`;
      md += `- **CVE 数量**: ${entry.cveCount}\n`;
      md += `- **详情**: [${entry.url}](${entry.url})\n`;

      if (entry.summary) {
        md += `\n**摘要**: ${entry.summary}\n`;
      }

      if (entry.cves && entry.cves.length > 0) {
        md += `\n**CVE 列表**:\n`;
        const displayCves = entry.cves.slice(0, 10);
        for (const cve of displayCves) {
          md += `- ${cve}\n`;
        }
        if (entry.cves.length > 10) {
          md += `- ... 还有 ${entry.cves.length - 10} 个\n`;
        }
      }

      if (entry.descriptions && entry.descriptions.length > 0) {
        md += `\n**影响描述**:\n`;
        for (const desc of entry.descriptions.slice(0, 5)) {
          md += `- ${desc}\n`;
        }
      }

      md += `\n`;
    }
  }

  // 所有安全公告列表
  md += `## 📚 完整安全公告索引\n\n`;
  md += `共 ${data.totalEntries} 条记录\n\n`;

  md += `---\n*此文件由 GitHub Actions 自动更新*\n`;
  return md;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
