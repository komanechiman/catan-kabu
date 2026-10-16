// ブラウザ動作テスト（シンプル版）：Firebase を test/firebase-stub.js に差し替えて、
// 2人のプレイヤー（2ページ）で部屋を作る → 参加 → ゲーム → 結果 → 成績 まで通す。
// 実行: node test/smoke.mjs   （要: playwright、Chromium は Playwright 同梱のもの）
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
// 同じコンテキストのページは localStorage を共有する（＝同じ家の2台のスマホのように部屋を共有する）
async function makeContext() {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' });
  await c.route('https://www.gstatic.com/firebasejs/**', r => r.fulfill({ body: stub, contentType: 'text/javascript' }));
  await c.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  await c.route('https://fonts.gstatic.com/**', r => r.fulfill({ body: '', contentType: 'font/woff2' }));
  await c.route('**/js/firebase-config.js', r => r.fulfill({ body: fakeConfig, contentType: 'text/javascript' }));
  return c;
}
const ctx = await makeContext();

const errors = [];
let shots = 0;
const shot = async (page, name) => { await page.screenshot({ path: path.join(outDir, `${String(++shots).padStart(2, '0')}-${name}.png`), animations: 'disabled' }); };
const newPage = async (label, context = ctx) => {
  const page = await context.newPage();
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
  await click(A, '[data-act="create"]');
  await A.waitForSelector('.codecard .code');
  const code = (await A.locator('.codecard .code').textContent()).trim();
  assert(/^[A-Z0-9]{4}$/.test(code), 'room code ' + code);

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
  assert((await B.locator('[data-act="start"]').count()) === 0, 'guest cannot start');
  await shot(A, 'lobby');

  // --- 設定してスタート ---
  await A.selectOption('select[data-key="rounds"]', '8');
  await A.fill('input[data-key="stakeLoser"]', '皿洗い1週間');
  await A.locator('input[data-key="stakeLoser"]').dispatchEvent('change');
  await B.waitForFunction(() => document.querySelector('input[data-key="stakeLoser"]')?.value === '皿洗い1週間');
  await click(A, '[data-act="start"]');
  await A.waitForSelector('.gamebar');
  await B.waitForSelector('.gamebar');

  const pages = { A, B };
  const dealerPage = async () => {
    for (let i = 0; i < 50; i++) {
      for (const [k, p] of Object.entries(pages)) if (await p.locator('[data-act="roll"]').count()) return [k, p];
      await new Promise(r => setTimeout(r, 100));
    }
    return [null, null];
  };
  let sawRobber = false;
  const closeRoll = async () => {
    for (const p of Object.values(pages)) {
      await p.waitForSelector('.modal.rollm', { timeout: 5000 });
      if (await p.locator('.modal.rollm [data-act="robber"]').count()) {
        sawRobber = true;
        await shot(p, 'robber');
        await p.locator('.modal.rollm [data-act="robber"]').nth(3).click();
      }
    }
    for (const p of Object.values(pages)) {
      await p.waitForSelector('.modal.rollm [data-act="closeRoll"]', { timeout: 5000 });
    }
    await shot(A, 'news');
    for (const p of Object.values(pages)) await p.click('.modal.rollm [data-act="closeRoll"]');
  };

  // --- R1 ---
  const [, dp] = await dealerPage();
  assert(dp, 'someone has the roll button');
  await dp.click('[data-act="roll"]');
  await closeRoll();
  await shot(A, 'market');
  assert((await A.locator('.score .srow').count()) === 2, 'scoreboard shows both players');

  // 買う（A）
  await A.click('.co[data-id="lantern"]');
  await A.waitForSelector('.sheet');
  await A.click('[data-act="qty"][data-d="5"]'); // 6株
  await shot(A, 'sheet');
  await A.click('[data-act="buy"]');
  await A.waitForFunction(() => /持ってる：6株/.test(document.querySelector('.sheet .mypos')?.textContent || ''));
  // 売る
  await A.click('[data-act="qtyMax"][data-n="6"]');
  await A.click('[data-act="sell"]');
  await A.waitForFunction(() => /持ってる：0株/.test(document.querySelector('.sheet .mypos')?.textContent || ''));
  await A.click('[data-act="qtyMax"]'); // 全力
  await A.click('[data-act="buy"]');
  await A.waitForFunction(() => !/持ってる：0株/.test(document.querySelector('.sheet .mypos')?.textContent || ''));
  await A.click('.sheet .iconbtn[data-act="closeSheet"]');
  // B は竜の山を全力買い
  await B.click('.co[data-id="dragon"]');
  await B.waitForSelector('.sheet');
  await B.click('[data-act="qtyMax"]');
  await B.click('[data-act="buy"]');
  await B.waitForFunction(() => !/持ってる：0株/.test(document.querySelector('.sheet .mypos')?.textContent || ''));
  await B.click('.sheet .iconbtn[data-act="closeSheet"]');
  await B.waitForFunction(() => /株/.test(document.querySelector('.co[data-id="dragon"] .have')?.textContent || ''));
  await shot(B, 'market-b');
  await A.click('[data-act="tab"][data-tab="chart"]');
  await shot(A, 'chart');
  await A.click('[data-act="tab"][data-tab="news"]');
  await shot(A, 'news-tab');
  await A.click('[data-act="tab"][data-tab="market"]');

  // 残りのラウンド
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
    assert(rounds <= 10, 'too many rounds');
  }
  assert(rounds === 8, 'played 8 rounds, got ' + rounds);
  await A.waitForSelector('.winner');
  await B.waitForSelector('.winner');
  await shot(A, 'result');
  assert(/皿洗い1週間/.test(await A.textContent('body')), 'stake shown');

  // 成績
  await A.click('[data-act="menu"]');
  await A.click('.modal [data-act="goRecords"]');
  await A.waitForSelector('.rtable');
  await A.click('.gamehead');
  await shot(A, 'records');
  await A.click('[data-act="back"]');

  // もう一回 → ロビーに戻る → 再読み込みしても戻れる
  await A.click('[data-act="again"]');
  await A.waitForSelector('.codecard');
  await B.waitForSelector('.codecard');
  await A.waitForFunction(() => document.querySelectorAll('.plist li').length === 2);
  await B.reload();
  await B.waitForSelector('.codecard');

  // あそびかた・レッスン（タイトルから。部屋に入っていない別のスマホ）
  const C = await newPage('C', await makeContext());
  await C.goto(base + '/');
  await C.waitForSelector('[data-act="goHowto"]');
  await C.click('[data-act="goHowto"]');
  await C.waitForSelector('.steps');
  await shot(C, 'howto');
  await C.click('[data-act="goTitle"]');
  await C.click('[data-act="goLesson"]');
  await C.waitForSelector('.lesson');
  for (let i = 0; i < 12; i++) {
    const next = C.locator('[data-act="lessonNext"]');
    if (!(await next.count())) break;
    if (await C.locator('[data-act="quizPick"]:not([disabled])').count()) await C.locator('[data-act="quizPick"]').nth(1).click();
    await next.click();
  }
  await C.waitForFunction(() => /クイズ \d\/\d 正解/.test(document.body.textContent));
  await shot(C, 'lesson');

  if (errors.length) throw new Error('ブラウザのエラー:\n' + errors.join('\n'));
  console.log(`OK: smoke test passed (${rounds} rounds, robber seen: ${sawRobber}, ${shots} screenshots in ${outDir})`);
} catch (e) {
  console.error('SMOKE FAILED:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  try { for (const p of ctx.pages()) await p.screenshot({ path: path.join(outDir, `fail-${ctx.pages().indexOf(p)}.png`) }); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
