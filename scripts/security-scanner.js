#!/usr/bin/env node
// Apple Security Updates Scanner
// 抓取 Apple 安全公告页面，提取 CVE 信息和 release notes 摘要

const fs = require('fs');
const path = require('path');
const { fetchWithRetry, mdCell } = require('./utils');

const APPLE_SECURITY_URL = 'https://support.apple.com/en-us/100100';

// 列表页日期格式实测为英式 "28 Sep 2026"（不是美式 "Sep 28, 2026"）。
// 2026-10-15 抓取线上页面复跑：旧正则 259/259 全 null。
const LIST_DATE_RE = /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\b/;

// 详情页日期格式是另一套：全月名 "Released September 28, 2026"。
const DETAIL_DATE_RE = /Released\s+([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/;

// 版本号提取：平台名优先（macOS 要吃掉 "Tahoe"/"Sequoia" 这类代号，否则取到代号后的版本反而对，
// 但 regex 会先撞上代号前的空位），取不到再退回「标题里最后一个版本号」。
// 实测线上 235 条含版本号的条目：平台名命中 221，退回通用补齐到 235。
const PLATFORM_VERSION_RE = /(?:iOS|iPadOS|macOS(?:\s+[A-Z][a-z]+)?|watchOS|tvOS|visionOS|Safari|Xcode)\s+(\d+(?:\.\d+)*)/i;

function extractVersion(title) {
  const m = title.match(PLATFORM_VERSION_RE);
  if (m) return m[1];
  // 退回通用：取最后一个版本号。AirPlay SDK 那种 "2.7.1 and 3.6.0.126" 会取到后者，
  // 属可接受的次要误差（该条本来就没有单一版本号）。
  const all = [...title.matchAll(/\d+(?:\.\d+)*/g)];
  return all.length ? all[all.length - 1][0] : null;
}

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

    // 提取日期（英式 "28 Sep 2026"）
    const dateMatch = row.match(LIST_DATE_RE);
    const dateStr = dateMatch ? dateMatch[1] : null;

    // 提取版本号（从标题中）
    const version = extractVersion(title);

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
  // Apple 已从 /en-us/HT<digits> 换成 /en-us/<digits> 形式的公告 ID，
  // 两种都接受，避免备用路径永远匹配不到。
  if (entries.length === 0) {
    console.log('  Table parsing failed, trying link extraction...');
    const linkRegex = /<a[^>]+href="(https:\/\/support\.apple\.com\/en-us\/(?:HT\d+|\d+)[^"]*)"[^>]*>((?:iOS|iPadOS|macOS|watchOS|tvOS|visionOS|Safari)\s+[\d.]+[^<]*)<\/a>/gi;
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

      const version = extractVersion(title);

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
    console.warn(`  Detail fetch failed: ${err.message}`);
    return null;
  }
}

/** 解码常见 HTML 实体（剥标签后残留的 &amp;/&lt;/&gt;/&quot;/&#39; 等） */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
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
  // 描述捕获到行尾或下一个标签边界；先剥标签再解码实体，避免 [^<]+ 在含 < 的文本处截断
  const impactRegex = /(?:<li|<p|<td)[^>]*>[^<]*Impact[:\s]+([^<]+(?:<[^>]+>[^<]*)*)/gi;
  let impactMatch;
  while ((impactMatch = impactRegex.exec(html)) !== null) {
    const desc = decodeEntities(impactMatch[1].replace(/<[^>]+>/g, '')).trim();
    if (desc.length > 5 && desc.length < 500) {
      descriptions.push(desc);
    }
  }

  // 定位「版本」标题（h2）：跳过页面顶部的 "About Apple security updates"，
  // 取其后第一个真正的版本小节。旧实现取全页第一个 gb-paragraph，
  // 实测抓到的永远是免责声明（"For our customers' protection, Apple doesn't disclose..."），
  // 已实际写进 data/security.json。
  const versionSection = findVersionSection(html);

  let summary = null;
  if (versionSection) {
    // 摘要取「该版本小节的首个 Available for 段落」，这是真正有信息量的正文
    const avail = versionSection.body.match(
      /<p[^>]*class="[^"]*gb-paragraph[^"]*"[^>]*>((?:Available for|Impact):[\s\S]*?)<\/p>/i
    );
    if (avail) summary = decodeEntities(avail[1].replace(/<[^>]+>/g, '')).trim().slice(0, 500);
  }

  return {
    cves: cves.slice(0, 50), // 限制数量
    cveCount: cves.length,
    descriptions: [...new Set(descriptions)].slice(0, 10),
    summary,
    // 详情页的发布日期是另一套格式（"Released September 28, 2026"），列表页解析不出时用它兜底
    detailDate: versionSection && versionSection.date ? versionSection.date : null
  };
}

/**
 * 从详情页定位版本小节，返回 { title, date, body }。
 * Apple 详情页结构：<h2 class="gb-header">iOS 26.7.1 and iPadOS 26.7.1</h2>
 *                  <div class="note gb-note"><p>Released September 28, 2026</p></div>
 *                  <h3 class="gb-header">CoreGraphics</h3> ...
 * 页面第一个 h2 是 "About Apple security updates"，必须跳过。
 */
function findVersionSection(html) {
  const h2Regex = /<h2[^>]*class="[^"]*gb-header[^"]*"[^>]*>([\s\S]*?)<\/h2>/gi;
  let m;
  while ((m = h2Regex.exec(html)) !== null) {
    const title = m[1].replace(/<[^>]+>/g, '').trim();
    if (/^About\b/i.test(title)) continue;

    const body = html.slice(m.index + m[0].length);
    const dateMatch = body.match(DETAIL_DATE_RE);
    return { title, date: dateMatch ? dateMatch[1] : null, body };
  }
  return null;
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

    // 版本段比较。Apple 公告里的版本号可能是只有 major 的 "27"，
    // 而本地 updates.json 是 "27.0.1"；旧的 seg2（直接切两段）让 "27" vs "27.0"
    // 永远不相等，导致 seg2 无法衔接这两种写法。
    // 规则：短的一方按位补齐后前缀匹配（"27" → 匹配 "27.0.1"；"16.5" 不匹配 "16.51"）。
    const seg2 = (v) => v.split('.').slice(0, 2).join('.');
    const versionPrefixMatch = (local, announced) => {
      const a = local.split('.');
      const b = announced.split('.');
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    };

    for (const [key, platform] of Object.entries(data.platforms)) {
      if (!platform.updates || platform.updates.length === 0) continue;

      // 遍历该平台的全部版本，而不是只看 updates[0]。
      // Apple 一次会发多条（实测 iOS 有 27.1 + 27.0.1），只看首条会让第二条永远匹配不上。
      for (const u of platform.updates) {
        if (!u || !u.version) continue;

        // 优先精确的 major.minor 比较，退回到前缀比较（处理公告只写 major 的情况）
        const matchedEntry = securityEntries.find(e =>
          e.platform === platform.name &&
          e.version &&
          (seg2(u.version) === seg2(e.version) || versionPrefixMatch(u.version, e.version))
        );

        if (matchedEntry) {
          matches.push({
            platform: platform.name,
            version: u.version,
            build: u.build,
            securityUrl: matchedEntry.url,
            securityTitle: matchedEntry.title,
            cveCount: matchedEntry.cveCount
          });
          break; // 每个平台只报最新一个匹配到的版本
        }
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
    // 表解析与备用链接解析都没命中 —— 大概率是 Apple 改版。
    // 保留上一次的有效 security.json / SECURITY_STATUS.md 不覆盖（写空文件会清掉历史数据）。
    // 用固定标记串报警，workflow 可 grep 到；但退出码保持 0，
    // 否则一次页面改版会阻断后面的 RSS 生成与提交步骤。
    console.warn('No security entries found — table and link parsing both failed (Apple page changed?).');
    console.warn('Keeping previous security.json / SECURITY_STATUS.md untouched.');
    await sendDegradedAlert('列表页零条目：表格解析与备用链接解析都没命中');
    console.log('');
    console.log('=== SECURITY SCAN DEGRADED ===');
    return;
  }

  // 先做本地匹配，再只对「被匹配到的」条目抓详情。
  // 旧实现固定抓前 3 条（slice(0,3)）并把 cveCount 回填到 entries[i] ——
  // i 恰好与 slice 下标对齐纯属巧合；且任何不在前 3 的匹配版本 cveCount 恒为 0，
  // 使这个模块最有价值的输出（"你正在跑的版本修了哪些 CVE"）拿不到。
  const matches = matchWithLocalData(entries, dataDir);

  // 需要详情的条目：被匹配到的那些（按 url 去重），外加列表最新的 3 条（保持原有展示行为）
  const detailUrls = [...new Set([
    ...entries.slice(0, 3).map(e => e.url),
    ...matches.map(m => m.securityUrl),
  ])];
  const detailResults = await Promise.allSettled(
    detailUrls.map(url => fetchSecurityDetail(url))
  );

  const detailByUrl = new Map();
  for (let i = 0; i < detailUrls.length; i++) {
    const result = detailResults[i];
    if (result.status === 'fulfilled' && result.value) {
      detailByUrl.set(detailUrls[i], result.value);
    }
  }

  // CVE 数量回填到原始 entries 列表（按 url 查表，不再依赖下标对齐）
  for (const entry of entries) {
    const d = detailByUrl.get(entry.url);
    if (d) {
      entry.cveCount = d.cveCount;
      entry.date = entry.date || d.detailDate; // 列表页解析不出时用详情页日期兜底
    }
  }

  // 展示用的详情：列表最新的 3 条
  const recentEntries = entries.slice(0, 3);
  const details = recentEntries
    .map(e => (detailByUrl.has(e.url) ? { ...e, ...detailByUrl.get(e.url) } : null))
    .filter(Boolean);

  // 重新匹配：此时 cveCount 才回填完。第一次匹配只用来确定「该抓哪些详情页」。
  const finalMatches = matchWithLocalData(entries, dataDir);

  // 输出结果
  const output = {
    lastScanned: new Date().toISOString(),
    totalEntries: entries.length,
    recentDetails: details,
    localMatches: finalMatches,
    // 落盘全部条目：旧实现只写 recentDetails(3条) + localMatches，
    // 259 条解析结果从不保存，导致字段解析错（如 date 全 null）没有任何事后诊断手段。
    entries
  };

  // 护栏：解析结果明显异常时拒绝覆盖，避免把好数据写坏。
  // 触发条件：条目数骤降 >50%，或绝大多数条目的日期解析失败。
  const outputFile = path.join(dataDir, 'security.json');
  const degraded = detectDegraded(entries, outputFile);
  if (degraded) {
    console.warn('');
    console.warn(`DEGRADED: ${degraded}`);
    console.warn('Keeping previous security.json / SECURITY_STATUS.md untouched.');
    await sendDegradedAlert(degraded);
    console.log('');
    console.log('=== SECURITY SCAN DEGRADED ===');
    return;
  }

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
  if (finalMatches.length > 0) {
    console.log(`Matched with local updates: ${finalMatches.length}`);
    for (const m of finalMatches) {
      console.log(`  ${m.platform} ${m.version}: ${m.cveCount} CVEs → ${m.securityUrl}`);
    }
  }
}

/**
 * 解析结果异常检测。返回 null 表示正常，返回字符串表示降级原因。
 * 目的是把「静默产出垃圾数据」变成「下一次运行就报出来」——
 * 旧的 date 正则在真实页面上 259/259 全 null，却因为没有任何自检而飘了很久。
 */
function detectDegraded(entries, outputFile) {
  if (entries.length === 0) return 'no entries parsed';

  // 日期解析失败率：列表页与详情页的日期格式是两套，任一改版都会整批失效
  const noDate = entries.filter(e => !e.date).length;
  if (noDate / entries.length > 0.9) {
    return `${noDate}/${entries.length} entries have no date (Apple changed the date format?)`;
  }

  // 条目数骤降：与上一份比对，掉一半以上多半是页面改版而非真的没有更新
  try {
    if (fs.existsSync(outputFile)) {
      const prev = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      if (prev.totalEntries > 20 && entries.length < prev.totalEntries * 0.5) {
        return `entry count dropped ${prev.totalEntries} → ${entries.length} (page changed?)`;
      }
    }
  } catch {
    // 上一份读不出来就不比较，不影响本次写入
  }

  return null;
}

/**
 * DEGRADED 告警：只写 Step Summary 等于没告警（没人主动去看），这里补一条 Telegram。
 * 刻意做成「失败也不影响主流程」的旁路：解析器坏了不应该让整个工作流挂掉。
 */
async function sendDegradedAlert(reason) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('Telegram not configured, DEGRADED alert only in logs.');
    return;
  }
  const text = `⚠️ <b>Apple 安全公告解析降级</b>\n\n${String(reason).replace(/[<>&]/g, '')}\n\n`
    + `已保留上一次的有效数据，未覆盖 <code>data/security.json</code>。\n`
    + `<a href="https://support.apple.com/en-us/100100">查看 Apple 公告页</a>`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(15000),
    });
    console.log(res.ok ? 'DEGRADED alert sent to Telegram.' : `DEGRADED alert failed: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`DEGRADED alert failed: ${err.message}`);
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
        md += `\n**摘要**: ${mdCell(entry.summary)}\n`;
      }

      if (entry.cves && entry.cves.length > 0) {
        md += `\n**CVE 列表**:\n`;
        const displayCves = entry.cves.slice(0, 10);
        for (const cve of displayCves) {
          md += `- ${mdCell(cve)}\n`;
        }
        if (entry.cves.length > 10) {
          md += `- ... 还有 ${entry.cves.length - 10} 个\n`;
        }
      }

      if (entry.descriptions && entry.descriptions.length > 0) {
        md += `\n**影响描述**:\n`;
        for (const desc of entry.descriptions.slice(0, 5)) {
          md += `- ${mdCell(desc)}\n`;
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

// 供测试直接引用（本文件作为脚本运行时下面的 main() 才会执行）
module.exports = {
  extractVersion,
  parseSecurityPage,
  parseDetailPage,
  findVersionSection,
  decodeEntities,
  generateSecurityMarkdown,
  detectDegraded,
  sendDegradedAlert,
  matchWithLocalData,
  LIST_DATE_RE,
  DETAIL_DATE_RE,
  PLATFORM_VERSION_RE,
};

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
