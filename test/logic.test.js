/**
 * 非平凡逻辑的回归测试（零依赖，用 node 内置 test runner）。
 *
 * 跑法: node --test test/
 *
 * 只覆盖「分支/循环/解析」这类坏了不容易被发现的东西：
 * truncateHtmlMessage 的标签配平、security-scanner 的 URL 正则、
 * detectChanges 的误报防护、computeIntervalStats 的历史积累。
 * 纯字符串拼接的渲染函数不在此列。
 */
const test = require('node:test');
const assert = require('node:assert');

const { truncateHtmlMessage } = require('../scripts/utils');

// ─── truncateHtmlMessage ──────────────────────────────────────

/** 校验输出标签自平衡且不超长 */
function assertBalanced(out, maxLen = 4096) {
  assert.ok(out.length <= maxLen, `超过 ${maxLen}: ${out.length}`);
  const stack = [];
  for (const m of out.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g)) {
    const [, slash, name] = m;
    const lower = name.toLowerCase();
    if (slash) {
      assert.strictEqual(stack.pop(), lower, `闭合标签不匹配: ${m[0]}`);
    } else if (!/^(br|hr|img|input)$/.test(lower)) {
      stack.push(lower);
    }
  }
  assert.deepStrictEqual(stack, [], '存在未闭合标签');
}

test('truncateHtmlMessage: 未超限时原样返回', () => {
  const s = '<b>hello</b>';
  assert.strictEqual(truncateHtmlMessage(s), s);
});

test('truncateHtmlMessage: 恰好等于上限时原样返回', () => {
  const s = 'x'.repeat(4096);
  assert.strictEqual(truncateHtmlMessage(s), s);
});

test('truncateHtmlMessage: 标签被拦腰切断时丢弃该标签', () => {
  const out = truncateHtmlMessage(`${'x'.repeat(4070)}<a href="http://very-long-u`);
  assertBalanced(out);
  assert.ok(!out.includes('<a'), '残缺的 <a 开标签应被丢弃');
});

test('truncateHtmlMessage: 实体被切断时降级为字面量', () => {
  const out = truncateHtmlMessage(`${'x'.repeat(4070)}&am`);
  assertBalanced(out);
  assert.ok(out.length <= 4096);
});

test('truncateHtmlMessage: 遗留的未闭合开标签会被移除', () => {
  // <b> 后紧跟 <a>，两者都没闭合，截断后都不该留下
  const out = truncateHtmlMessage(`<b><a href="http://x">${'y'.repeat(4200)}`);
  assertBalanced(out);
});

test('truncateHtmlMessage: 多余的闭标签会被移除', () => {
  const out = truncateHtmlMessage(`${'a'.repeat(4000)}</b></i>${'z'.repeat(200)}`);
  assertBalanced(out);
});

test('truncateHtmlMessage: 极端标签堆叠不产生残缺标签', () => {
  // limit 内几乎全是未闭合标签，正文在 limit 之外。
  // 配对会把标签丢掉，此时绝不能留下残缺的 '<' 或半个实体。
  const out = truncateHtmlMessage(`${'<b><i><u>'.repeat(900)}x`);
  assert.ok(out.length <= 4096);
  assert.ok(!/<[^>]*$/.test(out.replace(/\n\n\.\.\. \(内容过长已截断\)$/, '') + '>'),
    `留下残缺标签: ${JSON.stringify(out)}`);
  // 输出要么保住正文，要么就只有截断提示，不能是半截标签
  const body = out.replace(/\n\n\.\.\. \(内容过长已截断\)$/, '');
  assert.ok(body === '' || body.includes('x'), `输出异常: ${JSON.stringify(out)}`);
});

test('truncateHtmlMessage: 正文在 limit 内、后缀标签超限时正文必须保住', () => {
  // 正文全在 limit 内，后面跟一大串开标签（都在 limit 内但没闭合）
  const body = 'x'.repeat(1000);
  const out = truncateHtmlMessage(`${body}${'<b>'.repeat(2000)}`);
  assert.ok(out.includes(body), 'limit 内的正文不应被丢掉');
});

test('truncateHtmlMessage: 正文长度接近上限时保留大部分内容', () => {
  const out = truncateHtmlMessage(`${'x'.repeat(4100)}`);
  assertBalanced(out);
  assert.ok(out.length > 4000, `保留过少: ${out.length}`);
});

test('truncateHtmlMessage: 自闭合标签不参与配平', () => {
  const out = truncateHtmlMessage(`${'x'.repeat(4100)}<br/><b>z</b>`);
  assertBalanced(out);
});

test('truncateHtmlMessage: 真实长消息（含 a/b 嵌套）保持配平', () => {
  const out = truncateHtmlMessage('<b><a href="http://x">link</a></b> '.repeat(300));
  assertBalanced(out);
});

// ─── security-scanner URL 正则 ────────────────────────────────

// 与 scripts/security-scanner.js 的备用方案保持一致
const LINK_RE = /<a[^>]+href="(https:\/\/support\.apple\.com\/en-us\/(?:HT\d+|\d+)[^"]*)"[^>]*>((?:iOS|iPadOS|macOS|watchOS|tvOS|visionOS|Safari)\s+[\d.]+[^<]*)<\/a>/gi;

test('security-scanner: 备用正则匹配现代数字 ID 公告 URL', () => {
  const html = '<a href="https://support.apple.com/en-us/149226">iOS 27.0.1</a>';
  LINK_RE.lastIndex = 0;
  const m = LINK_RE.exec(html);
  assert.ok(m, '应匹配 https://support.apple.com/en-us/149226');
  assert.strictEqual(m[1], 'https://support.apple.com/en-us/149226');
});

test('security-scanner: 备用正则仍兼容旧 HT 形式', () => {
  const html = '<a href="https://support.apple.com/en-us/HT213938">macOS 13.5</a>';
  LINK_RE.lastIndex = 0;
  assert.ok(LINK_RE.exec(html), '旧的 HT<digits> 形式也要能匹配');
});

test('security-scanner: 正则不误吞无关链接', () => {
  const html = '<a href="https://support.apple.com/en-us/guide/foo">XProtect</a>';
  LINK_RE.lastIndex = 0;
  assert.strictEqual(LINK_RE.exec(html), null);
});

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── 平台图标映射 ─────────────────────────────────────────────

function loadPlatformIcon() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-updates.js'), 'utf-8');
  const map = src.match(/const ALL_PLATFORMS = \{[\s\S]*?\n\};/);
  const fn = src.match(/function platformIcon\(name\) \{[\s\S]*?\n\}/);
  assert.ok(map && fn, '找不到 ALL_PLATFORMS / platformIcon');
  return new Function(`${map[0]}\n${fn[0]}\nreturn { ALL_PLATFORMS, platformIcon };`)();
}

const { ALL_PLATFORMS, platformIcon } = loadPlatformIcon();

test('platformIcon: 五个平台各有独立图标', () => {
  const icons = Object.values(ALL_PLATFORMS).map(p => p.icon);
  assert.strictEqual(icons.length, 5);
  assert.strictEqual(new Set(icons).size, 5, `图标有重复: ${icons.join(' ')}`);
  for (const p of Object.values(ALL_PLATFORMS)) {
    assert.ok(p.icon, `${p.name} 缺图标`);
  }
});

test('platformIcon: 按显示名取到正确图标', () => {
  for (const [key, p] of Object.entries(ALL_PLATFORMS)) {
    assert.strictEqual(platformIcon(p.name), p.icon, `${key} 图标不匹配`);
  }
});

test('platformIcon: XProtect 用盾牌，未知平台回落手机', () => {
  assert.strictEqual(platformIcon('XProtect'), '🛡️');
  assert.strictEqual(platformIcon('unknownOS'), '📱');
});

// ─── detectChanges 误报防护 ───────────────────────────────────

/**
 * 从 check-updates.js 抽出 detectChanges 需要真实模块。
 * 该文件在 require 时会执行主流程，因此这里改为读取源码、
 * 用 Function 构造只取 detectChanges —— 避免跑整条网络流程。
 */
function loadDetectChanges() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-updates.js'), 'utf-8');
  const start = src.indexOf('function detectChanges(');
  assert.ok(start !== -1, '找不到 detectChanges');
  // 从函数头截到下一个顶层 `// ───` 分隔符
  const rest = src.slice(start);
  const end = rest.indexOf('\n// ───');
  const body = end === -1 ? rest : rest.slice(0, end);
  return new Function('fs', 'path', `${body}\nreturn detectChanges;`)(fs, path);
}

const detectChanges = loadDetectChanges();

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auc-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('detectChanges: 无历史文件时返回 null', () => {
  withTmpDir((dir) => {
    assert.strictEqual(detectChanges({ platforms: {} }, dir), null);
  });
});

test('detectChanges: 首次出现的新平台只做种子，不报新版本', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'updates.json'), JSON.stringify({
      platforms: { ios: { name: 'iOS', updates: [{ version: '27.0', build: '1' }] } },
    }));
    const current = {
      platforms: {
        ios: { name: 'iOS', updates: [{ version: '27.0', build: '1' }] },
        // 新平台（如新增 xros）带着一堆历史版本进来
        visionos: { name: 'visionOS', updates: [{ version: '1.0', build: '1' }, { version: '1.1', build: '2' }] },
      },
    };
    const result = detectChanges(current, dir);
    assert.strictEqual(result.updates.length, 0, '新平台不应刷屏式上报');
    assert.ok(result.betaChanges !== undefined);
  });
});

test('detectChanges: 已存在平台的真实新版本会被识别', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'updates.json'), JSON.stringify({
      platforms: { ios: { name: 'iOS', updates: [{ version: '27.0', build: '1' }] } },
    }));
    const current = {
      platforms: { ios: { name: 'iOS', updates: [{ version: '27.0', build: '1' }, { version: '27.1', build: '2' }] } },
    };
    const result = detectChanges(current, dir);
    assert.strictEqual(result.updates.length, 1);
    assert.strictEqual(result.updates[0].version, '27.1');
  });
});

test('detectChanges: 上次抓取失败(_fetchError)的平台跳过比对', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'updates.json'), JSON.stringify({
      platforms: { ios: { name: 'iOS', updates: [], _fetchError: true } },
    }));
    const current = {
      platforms: { ios: { name: 'iOS', updates: [{ version: '27.0', build: '1' }] } },
    };
    const result = detectChanges(current, dir);
    assert.strictEqual(result.updates.length, 0, '恢复抓取后不应把全部版本当新更新');
  });
});

// ─── computeIntervalStats ─────────────────────────────────────

function loadIntervalFns() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-updates.js'), 'utf-8');
  const grab = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `找不到 ${name}`);
    const rest = src.slice(start);
    const end = rest.indexOf('\n}');
    return rest.slice(0, end + 2);
  };
  // updateHistory 依赖 compareUpdatesDesc，后者又依赖 versionToParts；
  // 还要带上模块级常量 HISTORY_LIMIT（不是函数，单独抽）
  const limitMatch = src.match(/const HISTORY_LIMIT = (\d+);/);
  assert.ok(limitMatch, '找不到 HISTORY_LIMIT');
  const code = [
    `const HISTORY_LIMIT = ${limitMatch[1]};`,
    grab('versionToParts'),
    grab('compareUpdatesDesc'),
    grab('computeIntervalStats'),
    grab('updateHistory'),
    'return { computeIntervalStats, updateHistory, compareUpdatesDesc, versionToParts };',
  ].join('\n');
  return new Function(code)();
}

const { computeIntervalStats, updateHistory } = loadIntervalFns();

test('computeIntervalStats: 只有一条时只给 daysSinceLast，不编造 avgDays', () => {
  const now = new Date().toISOString();
  const stats = computeIntervalStats({
    platforms: { ios: { updates: [{ version: '27.0', build: '1', firstSeen: now }] } },
  });
  assert.strictEqual(stats.ios.avgDays, undefined, '历史不足时不应产出 avgDays');
  assert.strictEqual(stats.ios.daysSinceLast, 0);
});

test('computeIntervalStats: 优先用 _history 累积历史算间隔', () => {
  const day = 86400000;
  const mk = (daysAgo, v) => ({
    version: v, build: v, firstSeen: new Date(Date.now() - daysAgo * day).toISOString(),
  });
  const stats = computeIntervalStats({
    platforms: {
      ios: {
        // updates 只有当前版本线（真实情况就是 length 1）
        updates: [mk(0, '27.2')],
        _history: [mk(0, '27.2'), mk(10, '27.1'), mk(30, '27.0')],
      },
    },
  });
  assert.strictEqual(stats.ios.avgDays, 15, '间隔应为 (10 + 20) / 2 = 15');
  assert.deepStrictEqual(stats.ios.history, [10, 20]);
  assert.strictEqual(stats.ios.daysSinceLast, 0);
});

test('computeIntervalStats: 忽略非正间隔（同日多次抓取）', () => {
  const now = Date.now();
  const stats = computeIntervalStats({
    platforms: {
      ios: {
        updates: [],
        _history: [
          { version: 'a', build: 'a', firstSeen: new Date(now).toISOString() },
          { version: 'b', build: 'b', firstSeen: new Date(now).toISOString() },
          { version: 'c', build: 'c', firstSeen: new Date(now - 86400000).toISOString() },
        ],
      },
    },
  });
  // a 与 b 时间戳相同 -> 0 天间隔被剔除；只剩 b 与 c 的 1 天
  assert.deepStrictEqual(stats.ios.history, [1], '同日间隔应被剔除');
  assert.strictEqual(stats.ios.avgDays, 1);
});

test('computeIntervalStats: 全部同日时不给 avgDays', () => {
  const now = Date.now();
  const stats = computeIntervalStats({
    platforms: {
      ios: {
        updates: [],
        _history: [
          { version: 'a', build: 'a', firstSeen: new Date(now).toISOString() },
          { version: 'b', build: 'b', firstSeen: new Date(now).toISOString() },
        ],
      },
    },
  });
  assert.strictEqual(stats.ios.avgDays, undefined, '没有正间隔就不应编造 avgDays');
  assert.strictEqual(stats.ios.daysSinceLast, 0);
});

test('updateHistory: 跨次累积并按 version-build 去重', () => {
  const now = new Date().toISOString();
  const prev = {
    _history: [{ version: '27.0', build: '1', firstSeen: now }],
    updates: [],
  };
  const merged = updateHistory(
    { updates: [{ version: '27.1', build: '2', firstSeen: now }], _history: prev._history },
    now
  );
  assert.strictEqual(merged.length, 2);
  const keys = merged.map(u => `${u.version}-${u.build}`);
  assert.deepStrictEqual(new Set(keys).size, keys.length, '不应有重复项');
  assert.ok(keys.includes('27.0-1') && keys.includes('27.1-2'));
});

test('updateHistory: 超过上限时截断到 HISTORY_LIMIT', () => {
  const now = new Date().toISOString();
  const many = Array.from({ length: 30 }, (_, i) => ({
    version: `1.${i}`, build: `${i}`, firstSeen: new Date(Date.now() - i * 86400000).toISOString(),
  }));
  const merged = updateHistory({ updates: many, _history: [] }, now);
  assert.strictEqual(merged.length, 20, '应截断到 20 条');
});

// ─── security-scanner 解析正则（2026-10-15 用线上真实页面回归）─────────
// 背景：这三个正则原先都是按「想象的 Apple 页面格式」写的，实测全错：
// 日期 259/259 全 null、24 条版本号解析不出、摘要抓到的是免责声明。
// 下面用真实页面的片段做断言，改坏立刻能发现。

const {
  extractVersion, parseSecurityPage, findVersionSection, detectDegraded, LIST_DATE_RE,
  PLATFORM_VERSION_RE,
} = require('../scripts/security-scanner');

test('security-scanner: 列表页日期是英式 "28 Sep 2026"', () => {
  const row = '<td><p class="gb-paragraph">28 Sep 2026</p></td>';
  const m = row.match(LIST_DATE_RE);
  assert.ok(m, '英式日期应当匹配');
  assert.strictEqual(m[1], '28 Sep 2026');
});

test('security-scanner: 美式日期 "Sep 28, 2026" 不再被当作列表页格式', () => {
  // 列表页实测为 0 处美式日期；这个断言锁定格式选择，防止改回旧正则
  assert.strictEqual('Sep 28, 2026'.match(LIST_DATE_RE), null);
});

test('security-scanner: 平台名正则本身锁定（隔离于通用兜底）', () => {
  // extractVersion 有「平台名匹配 → 退回通用匹配」两级，通用兜底会掩盖平台分支的退化。
  // 这里直接断言 PLATFORM_VERSION_RE，改坏它立刻失败。
  const cases = [
    ['iOS 27 and iPadOS 27', '27'],              // 无小数点，旧正则整条返回 null
    ['macOS Tahoe 26.7.1', '26.7.1'],            // 代号必须被吃掉
    ['macOS Sequoia 15.8.1', '15.8.1'],
    ['iOS 26.7.1 and iPadOS 17.7.10', '26.7.1'], // 必须取 iOS 的，不是后面的旧版本
  ];
  for (const [title, want] of cases) {
    const m = title.match(PLATFORM_VERSION_RE);
    assert.ok(m, `平台名未匹配: ${title}`);
    assert.strictEqual(m[1], want, `取错版本: ${title}`);
  }
});

test('security-scanner: 版本号提取覆盖 macOS 代号与 iPadOS 并列', () => {
  const cases = [
    ['iOS 26.7.1 and iPadOS 26.7.1', '26.7.1'],
    ['iOS 27 and iPadOS 27', '27'],           // 旧正则对这类返回 null（实测 24 条）
    ['macOS Tahoe 26.7.1', '26.7.1'],          // 代号必须被吃掉，否则取不到
    ['macOS Sequoia 15.8.1', '15.8.1'],
    ['watchOS 27.0.1', '27.0.1'],
    ['Keynote 15.1', '15.1'],                  // 非平台名，退回通用匹配
    ['GarageBand 10.4.12', '10.4.12'],
  ];
  for (const [title, want] of cases) {
    assert.strictEqual(extractVersion(title), want, `解析错误: ${title}`);
  }
});

test('security-scanner: 解析不出日期时降级为 null 而不是乱取数字', () => {
  const html = '<tr><td><a href="https://support.apple.com/en-us/149226">iOS 26.7.1</a></td></tr>';
  const entries = parseSecurityPage(html);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].date, null);
  assert.strictEqual(entries[0].version, '26.7.1');
});

// ─── detectDegraded 护栏 ──────────────────────────────────────

test('detectDegraded: 日期整批解析失败时判定降级', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ title: `t${i}`, date: null, version: '1.0' }));
  assert.match(detectDegraded(entries, '/nonexistent'), /no date/);
});

test('detectDegraded: 日期正常时不判定降级', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ title: `t${i}`, date: '28 Sep 2026' }));
  assert.strictEqual(detectDegraded(entries, '/nonexistent'), null);
});

test('detectDegraded: 零条目判定降级', () => {
  assert.match(detectDegraded([], '/nonexistent'), /no entries/);
});

// ─── matchWithLocalData 版本衔接（2026-10-15 实测修复）────────────
// 旧实现用 seg2 直接切两段，公告写 "27"、本地写 "27.0.1" 时永不相等，
// 导致 localMatches 恒为空（实测 2026-10-15 线上确为 []）。

const { matchWithLocalData } = require('../scripts/security-scanner');
const fsp = require('node:fs');
const nodePath = require('node:path');

/** 造一个临时 dataDir，写入给定的 updates.json */
function makeDataDir(platforms) {
  const dir = fsp.mkdtempSync(nodePath.join(os.tmpdir(), 'uh-test-'));
  fsp.writeFileSync(nodePath.join(dir, 'updates.json'), JSON.stringify({ platforms }));
  return dir;
}

test('matchWithLocalData: 公告只写 major "27" 时能匹配本地 "27.0.1"', () => {
  const dir = makeDataDir({
    ios: { name: 'iOS', updates: [{ version: '27.0.1', build: '24A1' }] },
  });
  const entries = [{ platform: 'iOS', version: '27', title: 'iOS 27', url: 'u1', cveCount: 126 }];
  const m = matchWithLocalData(entries, dir);
  assert.strictEqual(m.length, 1, '应匹配上');
  assert.strictEqual(m[0].version, '27.0.1');
  assert.strictEqual(m[0].cveCount, 126, 'CVE 数应透传');
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('matchWithLocalData: "16.5" 不应误配 "16.51"', () => {
  const dir = makeDataDir({
    ios: { name: 'iOS', updates: [{ version: '16.51', build: 'b' }] },
  });
  const entries = [{ platform: 'iOS', version: '16.5', title: 't', url: 'u', cveCount: 1 }];
  assert.strictEqual(matchWithLocalData(entries, dir).length, 0, '前缀相同但位数不同不应匹配');
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('matchWithLocalData: 平台有多条更新时遍历全部，不只看第一条', () => {
  const dir = makeDataDir({
    ios: { name: 'iOS', updates: [{ version: '27.1', build: 'a' }, { version: '27.0', build: 'b' }] },
  });
  // 公告里只有 27.0，第一条 27.1 匹配不上，应退到第二条
  const entries = [{ platform: 'iOS', version: '27.0', title: 'iOS 27.0', url: 'u', cveCount: 7 }];
  const m = matchWithLocalData(entries, dir);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].version, '27.0', '应匹配到第二条而不是放弃');
  fsp.rmSync(dir, { recursive: true, force: true });
});

// ─── 健壮性修复回归（2026-10-16）────────────────────────────────
// 三处：摘要/描述解码 HTML 实体、Impact 描述不再被 < 截断、Markdown 渲染裸插套 mdCell

const {
  decodeEntities, parseDetailPage, generateSecurityMarkdown,
} = require('../scripts/security-scanner');

test('decodeEntities: 剥标签后残留的实体被解码', () => {
  assert.strictEqual(decodeEntities('iOS &amp; iPadOS &lt;27&gt;'), 'iOS & iPadOS <27>');
  assert.strictEqual(decodeEntities('&quot;quoted&quot; &apos;s &nbsp;space'), '"quoted" \'s  space');
});

test('parseDetailPage: summary 解码实体而非保留 &amp;', () => {
  const html = [
    '<h2 class="gb-header">iOS 26.7.1 and iPadOS 26.7.1</h2>',
    '<div class="note gb-note"><p>Released September 28, 2026</p></div>',
    '<p class="gb-paragraph">Available for: iPhone 11 &amp; later, iPad Pro 11-inch</p>',
  ].join('\n');
  const r = parseDetailPage(html);
  assert.ok(r.summary, '应抓到 Available for 摘要');
  assert.ok(!r.summary.includes('&amp;'), '实体应已解码');
  assert.ok(r.summary.includes('iPhone 11 & later'), '& 应是真实字符');
});

test('parseDetailPage: Impact 描述含 < 时不截断、实体被解码', () => {
  const html = '<p>Impact: An app may read sensitive data &lt;from&gt; a user&apos;s device</p>';
  const r = parseDetailPage(html);
  assert.strictEqual(r.descriptions.length, 1);
  assert.strictEqual(r.descriptions[0], 'An app may read sensitive data <from> a user\'s device');
});

test('generateSecurityMarkdown: 摘要/描述里的 | 被转义，不破坏表格', () => {
  const data = {
    lastScanned: new Date().toISOString(),
    totalEntries: 1,
    localMatches: [],
    recentDetails: [{
      title: 'iOS 26.7.1', platform: 'iOS', version: '26.7.1',
      date: '28 Sep 2026', cveCount: 1, url: 'https://example.com/x',
      summary: 'a | b', cves: ['CVE-2026-0001'], descriptions: ['x | y\nz'],
    }],
  };
  const md = generateSecurityMarkdown(data);
  assert.ok(md.includes('a \\| b'), '摘要中的 | 应被转义');
  assert.ok(md.includes('x \\| y'), '描述中的 | 应被转义');
  assert.ok(!md.includes('\nz'), '描述中的换行应被压成空格');
});
