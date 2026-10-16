// エンジンの動作テスト。実行: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/engine.js';
import { STOCKS, FUNDS } from '../js/data.js';

// 決まった順番で値を返す疑似乱数（テストを再現可能にする）
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}
// サイコロの目 d を出すための乱数値
const face = d => (d - 1) / 6 + 0.01;

function setup(n = 2, settings = {}) {
  const s = E.newState('TEST', 'p1', { rounds: 10, ...settings }, 1000);
  const chars = ['lumi', 'mimi', 'baron', 'holo'];
  for (let i = 1; i <= n; i++) assert.ok(E.addPlayer(s, { id: 'p' + i, name: 'P' + i, charId: chars[i - 1] }).ok);
  assert.ok(E.startGame(s, 'p1', () => 0, 1000).ok);
  // シャッフルを固定化（rng=0 で順番は入れ替わる）ので、親を明示
  return s;
}

// Firebase に保存できない undefined が混ざっていないか
function assertNoUndefined(obj, path = '') {
  if (obj === undefined) assert.fail('undefined at ' + path);
  if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) assertNoUndefined(v, path + '.' + k);
}

test('ロビー：参加・満員・同名・同キャラ', () => {
  const s = E.newState('ABCD', 'p1', {}, 0);
  assert.ok(E.addPlayer(s, { id: 'p1', name: 'たろう', charId: 'lumi' }).ok);
  assert.equal(E.addPlayer(s, { id: 'p2', name: 'たろう', charId: 'mimi' }).ok, false);
  assert.equal(E.addPlayer(s, { id: 'p2', name: 'はなこ', charId: 'lumi' }).ok, false);
  assert.ok(E.addPlayer(s, { id: 'p2', name: 'はなこ', charId: 'mimi' }).ok);
  assert.ok(E.addPlayer(s, { id: 'p3', name: 'c', charId: 'baron' }).ok);
  assert.ok(E.addPlayer(s, { id: 'p4', name: 'd', charId: 'holo' }).ok);
  assert.equal(E.addPlayer(s, { id: 'p5', name: 'e', charId: 'pon' }).ok, false);
  assert.equal(s.players.p1.cash, E.RULES.START_CASH);
  assert.equal(E.startGame(s, 'p2').ok, false, 'ホスト以外はスタートできない');
  assertNoUndefined(s);
});

test('じいやはへそくり付きでスタート', () => {
  const s = E.newState('ABCD', 'p1', {}, 0);
  E.addPlayer(s, { id: 'p1', name: 'a', charId: 'jiiya' });
  assert.equal(s.players.p1.cash, E.RULES.START_CASH + E.RULES.RICH_START);
});

test('サイコロ：当たった株が上がり配当が出る', () => {
  const s = setup(2);
  const dealer = s.dealer;
  // 親がランタン工房(6・8)を10株買えるように、まず取引フェーズが必要 → 先に1ラウンド回す
  // ここでは直接持たせる
  s.players[dealer].long.lantern = 10;
  s.players[dealer].avg.lantern = 1200;
  s.players[dealer].cash -= 12000;
  const before = s.stocks.lantern.price;
  // d1=3,d2=3 → 6（ゾロ目だがイベントダイスは別）, ev=4(なし), drift用は 0.5(=変動0), alpha 0.5
  const rng = seq([face(3), face(3), face(4), 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  const r = E.rollDice(s, dealer, rng, 2000);
  assert.ok(r.ok, r.error);
  assert.equal(s.round, 1);
  assert.equal(s.phase, 'trade');
  assert.equal(s.lastRoll.sum, 6);
  assert.equal(s.lastRoll.hit, 'lantern');
  assert.equal(s.stocks.lantern.price, Math.round(before * 1.08));
  const p = s.players[dealer];
  // 配当 3% × 1200 × 10 = 360（ルミなら2倍）
  const x2 = p.charId === 'lumi' ? 2 : 1;
  assert.equal(p.stats.dividends, 360 * x2);
  assert.equal(p.history.length, 2);
  assertNoUndefined(s);
});

test('7が出たら盗賊フェーズ → 置いた株が20%下がる', () => {
  const s = setup(2);
  const dealer = s.dealer;
  s.players[dealer].cash = 80000; // タンス預金 → 超過分3万の10%が盗まれる（ホロ以外）
  const rng = seq([face(3), face(4), face(5), 0.5]);
  assert.ok(E.rollDice(s, dealer, rng, 2000).ok);
  assert.equal(s.phase, 'robber');
  const p = s.players[dealer];
  if (p.charId === 'holo') assert.equal(p.cash, 80000 + E.RULES.ROBBER_GIFT);
  else assert.equal(p.cash, 77000);
  const before = s.stocks.fish.price;
  assert.equal(E.placeRobber(s, 'nobody', 'fish').ok, false);
  assert.ok(E.placeRobber(s, dealer, 'fish', seq([0.5]), 2000).ok);
  assert.equal(s.robber, 'fish');
  assert.equal(s.stocks.fish.price, Math.round(before * 0.8));
  assert.equal(s.phase, 'trade');
  // 次に3か11が出ても魚の塔は上がらない
  E.setDone(s, s.order[0], true); E.setDone(s, s.order[1], true);
  assert.equal(s.phase, 'roll');
  const before2 = s.stocks.fish.price;
  const rng2 = seq([face(1), face(2), face(4), 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  assert.ok(E.rollDice(s, s.dealer, rng2, 3000).ok);
  assert.equal(s.lastRoll.sum, 3);
  assert.equal(s.lastRoll.blocked, true);
  // ブロックされた株もドリフトはする（rng=0.5 → 変動0）
  assert.equal(s.stocks.fish.price, before2);
});

test('凪：株は動かないが利息は取られる', () => {
  const s = setup(2);
  const p = s.players[s.dealer];
  p.debt = 10000; p.cash += 10000;
  const prices = STOCKS.map(st => s.stocks[st.id].price);
  const rng = seq([face(3), face(3), face(3), 0.5]);
  assert.ok(E.rollDice(s, s.dealer, rng, 2000).ok);
  assert.deepEqual(STOCKS.map(st => s.stocks[st.id].price), prices);
  const rate = p.charId === 'baron' ? 0.01 : 0.02;
  assert.equal(p.debt, 10000 + 10000 * rate);
  // 投信は信託報酬ぶんだけ下がる
  assert.ok(s.funds.index.price < 1000 || s.funds.index.price === 999);
  assert.ok(s.funds.active.price <= 1000);
});

test('取引：買う・売る・手数料・上限', () => {
  const s = setup(2);
  E.rollDice(s, s.dealer, seq([face(3), face(3), face(4), 0.5]), 2000);
  const pid = s.order[0];
  const p = s.players[pid];
  const price = s.stocks.cobble.price;
  const cash0 = p.cash;
  assert.ok(E.buy(s, pid, 'cobble', 10).ok);
  const fee = p.charId === 'mimi' ? 0 : Math.round(price * 10 * 0.01);
  assert.equal(p.cash, cash0 - price * 10 - fee);
  assert.equal(p.long.cobble, 10);
  assert.equal(E.sell(s, pid, 'cobble', 11).ok, false);
  assert.ok(E.sell(s, pid, 'cobble', 10).ok);
  assert.equal(p.long.cobble, undefined);
  assert.equal(E.buy(s, pid, 'lantern', 1000000).ok, false, 'お金が足りない');
  assert.equal(E.buy(s, pid, 'lantern', 0).ok, false);
  assert.equal(E.buy(s, pid, 'lantern', -5).ok, false);
  assert.equal(E.buy(s, pid, 'lantern', 'abc').ok, false);
  // 投信は手数料なし
  const c1 = p.cash;
  assert.ok(E.buy(s, pid, 'index', 3).ok);
  assert.equal(p.cash, c1 - s.funds.index.price * 3);
  assertNoUndefined(s);
});

test('信用：借入上限・返済・空売り上限', () => {
  const s = setup(2);
  E.rollDice(s, s.dealer, seq([face(3), face(3), face(4), 0.5]), 2000);
  const pid = s.order[0];
  const p = s.players[pid];
  const nw = E.netWorth(s, p);
  assert.equal(E.borrow(s, pid, nw * 2 + 1).ok, false);
  assert.ok(E.borrow(s, pid, nw * 2).ok);
  assert.equal(p.debt, nw * 2);
  assert.equal(E.borrow(s, pid, 1).ok, false);
  assert.ok(E.repay(s, pid, 5000).ok);
  assert.equal(p.debt, nw * 2 - 5000);
  // 空売り
  const limit = E.shortLimit(s, p);
  const price = s.stocks.dragon.price;
  const tooMany = Math.floor(limit / price) + 1;
  assert.equal(E.shortSell(s, pid, 'dragon', tooMany).ok, false);
  assert.ok(E.shortSell(s, pid, 'dragon', 10).ok);
  assert.equal(p.short.dragon, 10);
  assert.equal(E.shortSell(s, pid, 'index', 1).ok, false, '投信は空売りできない');
  assert.ok(E.cover(s, pid, 'dragon', 10).ok);
  assert.equal(p.short.dragon, undefined);
});

test('追証：レバレッジ3倍で暴落すると強制決済', () => {
  const s = setup(2);
  E.rollDice(s, s.dealer, seq([face(3), face(3), face(4), 0.5]), 2000);
  const pid = s.order[0];
  const p = s.players[pid];
  p.charId = 'mimi'; // 手数料なしで計算を単純に
  const nw = E.netWorth(s, p);
  assert.ok(E.borrow(s, pid, nw * 2).ok);
  const price = s.stocks.lantern.price;
  const qty = Math.floor(p.cash / price);
  assert.ok(E.buy(s, pid, 'lantern', qty).ok);
  // 維持率 ≒ 33%
  assert.ok(E.maintRatio(s, p) > 0.25);
  E.setDone(s, s.order[0], true); E.setDone(s, s.order[1], true);
  // 全体 −20% の大暴落（ev=2, scope=all は rng<0.5）。出目は 4+5=9 → 石畳が当たる
  const rng = seq([face(4), face(5), face(2), 0.5, 0.5, 0.5, 0.5, 0.3, 0.5]);
  assert.ok(E.rollDice(s, s.dealer, rng, 3000).ok);
  assert.equal(s.lastRoll.evType, 'crash');
  assert.equal(p.stats.margin + p.stats.bankrupt >= 1, true, '追証か破産になる');
  assert.equal(Object.keys(p.long).length, 0, '持ち株は全部売られる');
  assert.ok(p.cash >= 0);
  assertNoUndefined(s);
});

test('破産：純資産がマイナスになると再起資金からやり直し', () => {
  const s = setup(2);
  E.rollDice(s, s.dealer, seq([face(3), face(3), face(4), 0.5]), 2000);
  const pid = s.order[0];
  const p = s.players[pid];
  p.charId = 'mimi';
  // 空売りした株が暴騰して純資産マイナス
  const price = s.stocks.dragon.price;
  const qty = Math.floor(E.shortLimit(s, p) / price);
  assert.ok(E.shortSell(s, pid, 'dragon', qty).ok);
  // 手で株価を5倍にしてから決済処理を通す
  s.stocks.dragon.price = price * 5;
  E.setDone(s, s.order[0], true); E.setDone(s, s.order[1], true);
  const rng = seq([face(3), face(3), face(4), 0.5]);
  E.rollDice(s, s.dealer, rng, 3000);
  assert.equal(p.stats.bankrupt, 1);
  assert.equal(p.cash, E.RULES.BANKRUPT_CASH);
  assert.equal(p.debt, 0);
  assert.deepEqual(p.short, {});
});

test('相対取引：提案→承諾で株とお金が動く', () => {
  const s = setup(2);
  E.rollDice(s, s.dealer, seq([face(3), face(3), face(4), 0.5]), 2000);
  const [a, b] = s.order;
  assert.ok(E.buy(s, a, 'herb', 5).ok);
  const cashA = s.players[a].cash, cashB = s.players[b].cash;
  assert.equal(E.proposeOffer(s, a, { to: a, give: {}, get: {} }).ok, false);
  assert.equal(E.proposeOffer(s, a, { to: b, give: { asset: 'herb', qty: 6 }, get: { cash: 100 } }).ok, false, '持ってない数');
  assert.ok(E.proposeOffer(s, a, { to: b, give: { asset: 'herb', qty: 5 }, get: { cash: 4000 } }, 5000).ok);
  const id = Object.keys(s.offers)[0];
  assert.equal(E.acceptOffer(s, a, id).ok, false, '自分では受けられない');
  assert.ok(E.acceptOffer(s, b, id).ok);
  assert.equal(s.players[b].long.herb, 5);
  assert.equal(s.players[a].long.herb, undefined);
  assert.equal(s.players[a].cash, cashA + 4000);
  assert.equal(s.players[b].cash, cashB - 4000);
  assert.equal(s.offers[id].status, 'accepted');
  assertNoUndefined(s);
});

test('つみたて：毎ラウンド自動で買う。つみたてくんも動く', () => {
  const s = setup(2, { npc: true });
  const pid = s.order[0];
  E.rollDice(s, s.dealer, seq([face(3), face(3), face(4), 0.5]), 2000);
  assert.ok(E.setDca(s, pid, 'index', 5000).ok);
  E.setDone(s, s.order[0], true); E.setDone(s, s.order[1], true);
  E.rollDice(s, s.dealer, seq([face(2), face(3), face(4), 0.5]), 3000);
  const p = s.players[pid];
  assert.ok((p.long.index || 0) >= 4, 'だいたい5口買える');
  assert.ok(p.stats.dcaTotal > 0);
  assert.ok(s.npc.long.index > 0);
  assert.equal(s.npc.history.length, 3);
});

test('毎月分配ファンド：分配金が出て基準価額が下がる', () => {
  const s = setup(2);
  E.rollDice(s, s.dealer, seq([face(3), face(3), face(4), 0.5]), 2000);
  const pid = s.order[0];
  const p = s.players[pid];
  assert.ok(E.buy(s, pid, 'monthly', 10).ok);
  const nav = s.funds.monthly.price;
  E.setDone(s, s.order[0], true); E.setDone(s, s.order[1], true);
  E.rollDice(s, s.dealer, seq([face(3), face(3), face(3), 0.5]), 3000); // 凪
  assert.ok(p.stats.payouts > 0);
  assert.ok(s.funds.monthly.price < nav * 0.97, '分配のぶん下がる');
});

test('ゲーム終了：規定ラウンドで end になり称号がつく', () => {
  const s = setup(3, { rounds: 10 });
  let round = 0;
  let guard = 0;
  while (s.phase !== 'end' && guard++ < 200) {
    if (s.phase === 'roll') {
      const r = E.rollDice(s, s.dealer, Math.random, 1000 + round);
      assert.ok(r.ok, r.error);
      round++;
    } else if (s.phase === 'robber') {
      const target = E.STOCK_IDS.find(id => id !== s.robber);
      assert.ok(E.placeRobber(s, s.dealer, target, Math.random, 1000).ok);
    } else if (s.phase === 'trade') {
      for (const id of s.order) E.setDone(s, id, true, 2000);
    }
  }
  assert.equal(s.phase, 'end');
  assert.equal(s.round, 10);
  assert.equal(s.results.length, 3);
  for (const id of s.order) {
    assert.ok(s.players[id].title);
    assert.equal(s.players[id].history.length, 11);
    assert.equal(s.players[id].debt, 0);
  }
  assertNoUndefined(s);
});

test('normalize：Firebase が落とした空オブジェクトを補う', () => {
  const s = E.normalize({ code: 'X', players: { a: { id: 'a', name: 'a', charId: 'lumi', cash: 5 } }, order: ['a'] });
  assert.deepEqual(s.players.a.long, {});
  assert.equal(s.players.a.stats.trades, 0);
  assert.equal(s.stocks.lantern.price, 1200);
  assert.equal(s.funds.index.price, 1000);
  assert.equal(E.netWorth(s, s.players.a), 5);
});

test('resetToLobby：同じメンバーでロビーに戻る', () => {
  const s = setup(2);
  E.rollDice(s, s.dealer, seq([face(3), face(3), face(4), 0.5]), 2000);
  const names = s.order.map(id => s.players[id].name).sort();
  assert.equal(E.resetToLobby(s, 'p2').ok, false);
  assert.ok(E.resetToLobby(s, 'p1').ok);
  assert.equal(s.phase, 'lobby');
  assert.equal(s.round, 0);
  assert.deepEqual(s.order.map(id => s.players[id].name).sort(), names);
  assert.equal(s.players.p1.cash, E.RULES.START_CASH + (s.players.p1.charId === 'jiiya' ? E.RULES.RICH_START : 0));
});

test('データ：数字チップは2〜12（7以外）を全部ちょうど1回ずつ使う', () => {
  const nums = STOCKS.flatMap(s => s.numbers).sort((a, b) => a - b);
  assert.deepEqual(nums, [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
  assert.equal(FUNDS.length, 3);
});
