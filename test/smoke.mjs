// ブラウザ動作テスト：Firebase を test/firebase-stub.js に差し替えて、
// 2人のプレイヤー（2ページ）で部屋を作る → 参加 → ゲーム → 結果 → レッスン → 成績 まで通す。
// 実行: node test/smoke.mjs   （要: npm install、Chromium は Playwright 同梱のもの）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.SMOKE_OUT || path.join(root, 'test', 'screens');
fs.mkdirSync(outDir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const stub = fs.readFileSync(path.join(root, 'test', 'firebase-stub.js'), 'utf8');
const fakeConfig = `export const firebaseConfig = { apiKey: 'test', databaseURL: 'https://test.local', projectId: 'test', appId: 'test' };`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' });
await ctx.route('https://www.gstatic.com/firebasejs/**', r => r.fulfill({ body: stub, contentType: 'text/javascript' }));
await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
await ctx.route('https://fonts.gstatic.com/**', r => r.fulfill({ body: '', contentType: 'font/woff2' }));
await ctx.route('**/js/firebase-config.js', r => r.fulfill({ body: fakeConfig, contentType: 'text/javascript' }));

const errors = [];
let shots = 0;
const shot = async (page, name) => { await page.screenshot({ path: path.join(outDir, `${String(++shots).padStart(2, '0')}-${name}.png`), fullPage: false }); };
const newPage = async label => {
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`[${label}] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`); });
  return page;
};
const click = (page, sel) => page.locator(sel).first().click();
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };

try {
  // --- A: 部屋を作る ---
  const A = await newPage('A');
  await A.goto(base + '/');
  await A.waitForSelector('[data-act="goJoin"]');
  await shot(A, 'title');
  await click(A, '[data-act="goJoin"][data-mode="create"]');
  await A.fill('[data-bind="name"]', 'パパ');
  await click(A, '[data-act="pickChar"][data-id="lumi"]');
  await shot(A, 'join');
  await click(A, '[data-act="create"]');
  await A.waitForSelector('.codecard .code');
  const code = (await A.locator('.codecard .code').textContent()).trim();
  assert(/^[A-Z0-9]{4}$/.test(code), 'room code ' + code);
  await shot(A, 'lobby-host');

  // --- B: 合言葉で入る ---
  const B = await newPage('B');
  await B.goto(base + '/?code=' + code);
  await B.waitForSelector('[data-act="join"]');
  assert((await B.inputValue('[data-bind="code"]')) === code, 'code prefilled');
  await B.fill('[data-bind="name"]', 'むすめ');
  await click(B, '[data-act="pickChar"][data-id="mimi"]');
  await click(B, '[data-act="join"]');
  await B.waitForSelector('.plist');
  await A.waitForFunction(() => document.querySelectorAll('.plist li').length === 2);
  await B.waitForFunction(() => document.querySelectorAll('.plist li').length === 2);
  assert((await B.locator('.btn.primary.big[data-act="start"]').count()) === 0, 'guest cannot start');
  await shot(B, 'lobby-guest');

  // --- 設定してスタート ---
  await A.selectOption('select[data-key="rounds"]', '10');
  await A.fill('input[data-key="stakeLoser"]', '皿洗い1週間');
  await A.locator('input[data-key="stakeLoser"]').dispatchEvent('change');
  await B.waitForFunction(() => document.querySelector('input[data-key="stakeLoser"]')?.value === '皿洗い1週間');
  await click(A, '[data-act="start"]');
  await A.waitForSelector('.gamebar');
  await B.waitForSelector('.gamebar');

  const pages = { A, B };
  // どちらかのページに「サイコロを振る」が出るまで待つ（他ページの再描画は少し遅れる）
  const dealerPage = async () => {
    for (let i = 0; i < 50; i++) {
      for (const [k, p] of Object.entries(pages)) if (await p.locator('[data-act="roll"]').count()) return [k, p];
      await new Promise(r => setTimeout(r, 100));
    }
    return [null, null];
  };
  const closeRoll = async () => {
    for (const p of Object.values(pages)) {
      await p.waitForSelector('.modal.rollm', { timeout: 5000 });
      // 盗賊フェーズなら親が置く
      if (await p.locator('.modal.rollm [data-act="robber"]').count()) {
        await p.locator('.modal.rollm [data-act="robber"]:not([disabled])').first().click();
      }
    }
    for (const p of Object.values(pages)) {
      await p.waitForSelector('.modal.rollm [data-act="closeRoll"]', { timeout: 5000 });
      await p.click('.modal.rollm [data-act="closeRoll"]');
    }
  };

  // --- R1 ---
  const [dk, dp] = await dealerPage();
  assert(dp, 'someone has the roll button');
  await shot(dp, 'roll-button-' + dk);
  await dp.click('[data-act="roll"]');
  await A.waitForSelector('.modal.rollm');
  await shot(A, 'roll-modal');
  await closeRoll();
  await shot(A, 'market');

  // 買う
  await A.click('.asset[data-id="lantern"]');
  await A.waitForSelector('.sheet');
  await A.click('[data-act="qty"][data-d="10"]');
  await shot(A, 'sheet');
  await A.click('[data-act="buy"]');
  await A.waitForFunction(() => /持ち株 11株/.test(document.querySelector('.sheet .mypos')?.textContent || ''));
  await A.click('.sheet .iconbtn[data-act="closeSheet"]');

  // 自分タブ：借りる（警告 → 実行）、つみたて、提案
  await A.click('[data-act="tab"][data-tab="me"]');
  await A.click('[data-act="borrow"]');
  await A.waitForSelector('.modal');
  await shot(A, 'warn-borrow');
  await A.click('[data-act="warnConfirm"]');
  await A.waitForFunction(() => /借金/.test(document.body.textContent) && !document.querySelector('.modal'));
  await A.waitForFunction(() => document.querySelector('.ratio') !== null);
  await A.selectOption('select[data-bind="dcaAsset"]', 'index');
  await A.fill('input[data-bind="dcaAmount"]', '5000');
  await A.click('[data-act="dcaSet"]');
  await A.waitForFunction(() => /毎ラウンド 5,000G/.test(document.body.textContent));
  await A.selectOption('select[data-bind="offer.to"]', { index: 1 });
  await A.fill('input[data-bind="offer.giveCash"]', '1000');
  await A.selectOption('select[data-bind="offer.giveAsset"]', 'lantern');
  await A.fill('input[data-bind="offer.giveQty"]', '2');
  await A.fill('input[data-bind="offer.getCash"]', '3000');
  await A.click('[data-act="offerPropose"]');
  await B.waitForFunction(() => document.querySelectorAll('.tabs .badge').length > 0);
  await B.click('[data-act="tab"][data-tab="me"]');
  await B.waitForSelector('[data-act="offerAccept"]');
  await shot(B, 'offer-inbox');
  await B.click('[data-act="offerAccept"]');
  await B.waitForFunction(() => /ランタン工房/.test(document.querySelector('.hold')?.textContent || ''));
  await shot(A, 'me-tab');

  // 空売り（B）：警告 → 実行
  await B.click('[data-act="tab"][data-tab="market"]');
  await B.click('.asset[data-id="dragon"]');
  await B.waitForSelector('.sheet [data-act="short"]');
  await B.click('[data-act="short"]');
  await B.waitForSelector('.modal');
  await B.check('input[data-bind="nowarn"]');
  await B.click('[data-act="warnConfirm"]');
  await B.waitForFunction(() => /空売り 1株/.test(document.querySelector('.sheet .mypos')?.textContent || ''));
  await B.click('.sheet .iconbtn[data-act="closeSheet"]');
  await B.click('[data-act="tab"][data-tab="all"]');
  await shot(B, 'all-tab');
  await A.click('[data-act="tab"][data-tab="chart"]');
  await shot(A, 'chart-tab');
  await A.click('[data-act="tab"][data-tab="log"]');
  await shot(A, 'log-tab');

  // 残りのラウンドを回す
  let rounds = 1;
  while (true) {
    for (const p of Object.values(pages)) if (await p.locator('[data-act="done"]').count()) await p.click('[data-act="done"]');
    await A.waitForFunction(() => !!document.querySelector('[data-act="roll"]') || document.body.textContent.includes('サイコロを振るのを待ってる') || document.body.textContent.includes('結果発表'), null, { timeout: 8000 });
    if ((await A.locator('.winner').count()) || (await B.locator('.winner').count())) break;
    const [, p] = await dealerPage();
    assert(p, 'dealer found in round ' + (rounds + 1));
    await p.click('[data-act="roll"]');
    await closeRoll();
    rounds++;
    assert(rounds <= 12, 'too many rounds');
  }
  assert(rounds === 10, 'played 10 rounds, got ' + rounds);
  await A.waitForSelector('.winner');
  await B.waitForSelector('.winner');
  await shot(A, 'result');
  assert(/皿洗い1週間/.test(await A.textContent('body')), 'stake shown');
  assert(/つみたてくん/.test(await A.textContent('body')), 'npc shown');

  // レッスン（B＝むすめ）
  await B.click('[data-act="goLesson"]');
  await B.waitForSelector('.lesson');
  await shot(B, 'lesson-1');
  for (let i = 0; i < 20; i++) {
    const next = B.locator('[data-act="lessonNext"]');
    if (!(await next.count())) break;
    if (await B.locator('[data-act="quizPick"]:not([disabled])').count()) {
      await B.locator('[data-act="quizPick"]').nth(1).click();
    }
    if (await B.locator('[data-act="finalPick"]').count()) {
      await B.click('[data-act="finalPick"][data-id="index"]');
      await shot(B, 'lesson-final');
    }
    if (await next.isDisabled()) continue;
    await next.click();
  }
  await B.waitForFunction(() => /クイズ \d\/\d 正解/.test(document.body.textContent));
  await shot(B, 'lesson-summary');
  await B.click('[data-act="back"]');

  // 成績
  await A.click('[data-act="menu"]');
  await A.click('.modal [data-act="goRecords"]');
  await A.waitForSelector('.rtable');
  await A.click('.gamehead');
  await shot(A, 'records');
  assert(/むすめ → 🧺/.test(await A.textContent('body')), 'lesson choice recorded');
  await A.click('[data-act="back"]');

  // もう一回 → ロビーに戻る
  await A.click('[data-act="again"]');
  await A.waitForSelector('.codecard');
  await B.waitForSelector('.codecard');
  await A.waitForFunction(() => document.querySelectorAll('.plist li').length === 2);

  // 再読み込みしても戻れる
  await B.reload();
  await B.waitForSelector('.codecard');

  if (errors.length) throw new Error('ブラウザのエラー:\n' + errors.join('\n'));
  console.log(`OK: smoke test passed (${rounds} rounds, ${shots} screenshots in ${outDir})`);
} catch (e) {
  console.error('SMOKE FAILED:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  try { for (const p of ctx.pages()) await p.screenshot({ path: path.join(outDir, `fail-${ctx.pages().indexOf(p)}.png`) }); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
