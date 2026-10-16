// ブラウザ動作テスト（ルーレット版）：Firebase を test/firebase-stub.js に差し替えて、
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
  await c.addInitScript(() => { window.__fastSpin = true; }); // ルーレットの回転を短縮
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  await B.fill('[data-bind="name"]', 'むすめ');
  await click(B, '[data-act="pickChar"][data-id="mimi"]');
  await click(B, '[data-act="join"]');
  await B.waitForSelector('.plist');
  await A.waitForFunction(() => document.querySelectorAll('.plist li').length === 2);
  await B.waitForFunction(() => document.querySelectorAll('.plist li').length === 2);
  await shot(A, 'lobby');

  // --- 設定してスタート ---
  await A.selectOption('select[data-key="rounds"]', '5');
  await A.fill('input[data-key="stakeLoser"]', '皿洗い1週間');
  await A.locator('input[data-key="stakeLoser"]').dispatchEvent('change');
  await B.waitForFunction(() => document.querySelector('input[data-key="stakeLoser"]')?.value === '皿洗い1週間');
  await click(A, '[data-act="start"]');
  await A.waitForSelector('.wheelwrap');
  await B.waitForSelector('.wheelwrap');
  await shot(A, 'wheel');

  const pages = { A, B };
  // 「回す！」ボタンが出ているページ（＝番の人）を探す
  const turnPage = async () => {
    for (let i = 0; i < 60; i++) {
      for (const [k, p] of Object.entries(pages)) if (await p.locator('[data-act="spin"]').count()) return [k, p];
      await sleep(100);
    }
    return [null, null];
  };
  let sawRobber = false, sawTypes = new Set();
  // 回す → 全員の端末で回転が終わって結果が出る → 盗賊なら置く → 全員 OK
  const spinAndClose = async (p) => {
    await p.click('[data-act="spin"]');
    for (const q of Object.values(pages)) await q.waitForSelector('.modal.spinm', { timeout: 8000 });
    const txt = await A.locator('.modal.spinm').textContent();
    if (/盗賊/.test(txt)) sawTypes.add('robber'); if (/号外/.test(txt)) sawTypes.add('extra'); if (/ラッキー/.test(txt)) sawTypes.add('lucky'); if (/おたすけ/.test(txt)) sawTypes.add('rescue'); if (/ニュース/.test(txt)) sawTypes.add('co');
    for (const q of Object.values(pages)) {
      if (await q.locator('.modal.spinm [data-act="robber"]').count()) {
        sawRobber = true;
        await shot(q, 'robber');
        await q.locator('.modal.spinm [data-act="robber"]').nth(3).click();
      }
    }
    for (const q of Object.values(pages)) await q.waitForSelector('.modal.spinm [data-act="closeSpin"]', { timeout: 8000 });
    await shot(p, 'result');
    for (const q of Object.values(pages)) await q.click('.modal.spinm [data-act="closeSpin"]');
    await p.waitForSelector('[data-act="endTurn"]');
  };

  // --- 最初の番：買って、売って、次の人へ ---
  let [, tp] = await turnPage();
  assert(tp, 'someone has the spin button');
  const other = tp === A ? B : A;
  assert((await other.locator('[data-act="spin"]').count()) === 0, 'only the turn player can spin');
  await spinAndClose(tp);
  await shot(tp, 'market-turn');
  await shot(other, 'market-wait');
  assert((await tp.locator('.score .srow').count()) === 2, 'scoreboard shows both players');
  // 番じゃない人は買えない（シートは開くがボタンが無効）
  await other.click('.co[data-id="lantern"]');
  await other.waitForSelector('.sheet');
  assert(await other.locator('[data-act="buy"]').isDisabled(), 'buy disabled for non-turn player');
  await other.click('.sheet .iconbtn[data-act="closeSheet"]');
  // 番の人は買える
  await tp.click('.co[data-id="lantern"]');
  await tp.waitForSelector('.sheet');
  await tp.click('[data-act="qty"][data-d="5"]');
  await shot(tp, 'sheet');
  await tp.click('[data-act="buy"]');
  await tp.waitForFunction(() => /持ってる：6株/.test(document.querySelector('.sheet .mypos')?.textContent || ''));
  await tp.click('[data-act="qtyMax"][data-n="6"]');
  await tp.click('[data-act="sell"]');
  await tp.waitForFunction(() => /持ってる：0株/.test(document.querySelector('.sheet .mypos')?.textContent || ''));
  await tp.click('[data-act="qtyMax"]');
  await tp.click('[data-act="buy"]');
  await tp.waitForFunction(() => !/持ってる：0株/.test(document.querySelector('.sheet .mypos')?.textContent || ''));
  await tp.click('.sheet .iconbtn[data-act="closeSheet"]');
  await tp.click('[data-act="tab"][data-tab="news"]');
  await shot(tp, 'news-tab');
  await tp.click('[data-act="tab"][data-tab="market"]');
  await tp.click('[data-act="endTurn"]');

  // --- 残りの番を回す ---
  let turns = 1;
  while (true) {
    await sleep(150);
    if ((await A.locator('.winner').count()) || (await B.locator('.winner').count())) break;
    const [, p] = await turnPage();
    assert(p, 'turn player found at turn ' + (turns + 1));
    await spinAndClose(p);
    // 2回に1回は竜の山を1株買う
    if (turns % 2 === 0) {
      await p.click('.co[data-id="dragon"]');
      await p.waitForSelector('.sheet');
      if (!(await p.locator('[data-act="buy"]').isDisabled())) await p.click('[data-act="buy"]');
      await sleep(100);
      await p.click('.sheet .iconbtn[data-act="closeSheet"]');
    }
    if (turns === 4) { await p.click('[data-act="tab"][data-tab="chart"]'); await shot(p, 'chart'); await p.click('[data-act="tab"][data-tab="market"]'); }
    await p.click('[data-act="endTurn"]');
    turns++;
    assert(turns <= 12, 'too many turns');
  }
  assert(turns === 10, 'played 10 turns (5 rounds x 2), got ' + turns);
  await A.waitForSelector('.winner');
  await B.waitForSelector('.winner');
  await shot(A, 'result-final');
  assert(/皿洗い1週間/.test(await A.textContent('body')), 'stake shown');

  // 成績
  await A.click('[data-act="menu"]');
  await shot(A, 'menu');
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

  // あそびかた・レッスン（部屋に入っていない別のスマホ）
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

  if (errors.length) throw new Error('ブラウザのエラー:\n' + errors.join('\n'));
  console.log(`OK: smoke test passed (${turns} turns, robber seen: ${sawRobber}, types: ${[...sawTypes].join(',')}, ${shots} screenshots in ${outDir})`);
} catch (e) {
  console.error('SMOKE FAILED:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  try { for (const p of ctx.pages()) await p.screenshot({ path: path.join(outDir, `fail-${ctx.pages().indexOf(p)}.png`) }); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
