// エンジンの動作テスト（ルーレット版）。実行: node --test test/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/engine.js';
import { COMPANIES, WHEEL, LUCKY_AMOUNT, RESCUE_AMOUNT } from '../js/data.js';

// 決まった順番で値を返す疑似乱数
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}
// ルーレットでマス seg に止める乱数値
const segv = seg => (seg + 0.5) / WHEEL.length;
const segOf = type => WHEEL.findIndex(w => w.type === type);
const coSeg = co => WHEEL.findIndex(w => w.co === co);
// 止まるマス、ジッター、号外の種類、ドリフト5社ぶん（0.5=動かない）
const rngFor = (seg, extra = 0.5) => seq([segv(seg), 0.5, extra, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);

function setup(n = 2, settings = {}) {
  const s = E.newState('TEST', 'p1', { rounds: 5, ...settings }, 1000);
  const chars = ['lumi', 'mimi', 'baron', 'holo'];
  for (let i = 1; i <= n; i++) assert.ok(E.addPlayer(s, { id: 'p' + i, name: 'P' + i, charId: chars[i - 1] }).ok);
  assert.ok(E.startGame(s, 'p1', () => 0.5, 1000).ok);
  return s;
}
function assertNoUndefined(obj, path = '') {
  if (obj === undefined) assert.fail('undefined at ' + path);
  if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) assertNoUndefined(v, path + '.' + k);
}

test('ロビー：参加・満員・同名・同キャラ・ホスト以外はスタート不可', () => {
  const s = E.newState('ABCD', 'p1', {}, 0);
  assert.ok(E.addPlayer(s, { id: 'p1', name: 'たろう', charId: 'lumi' }).ok);
  assert.equal(E.addPlayer(s, { id: 'p2', name: 'たろう', charId: 'mimi' }).ok, false);
  assert.equal(E.addPlayer(s, { id: 'p2', name: 'はなこ', charId: 'lumi' }).ok, false);
  assert.ok(E.addPlayer(s, { id: 'p2', name: 'はなこ', charId: 'mimi' }).ok);
  assert.ok(E.addPlayer(s, { id: 'p3', name: 'c', charId: 'baron' }).ok);
  assert.ok(E.addPlayer(s, { id: 'p4', name: 'd', charId: 'holo' }).ok);
  assert.equal(E.addPlayer(s, { id: 'p5', name: 'e', charId: 'pon' }).ok, false);
  assert.equal(E.startGame(s, 'p2').ok, false);
  assertNoUndefined(s);
});

test('スタート：1ラウンド目、最初の人の番、ルーレット待ち', () => {
  const s = setup(3);
  assert.equal(s.phase, 'spin');
  assert.equal(s.round, 1);
  assert.equal(s.turn, s.order[0]);
  assert.equal(E.spin(s, s.order[1]).ok, false, '番じゃない人は回せない');
});

test('会社のマス：ニュースカードが引かれて株価が動き、売り買いタイムになる', () => {
  const s = setup(2);
  const seg = coSeg('fish');
  const before = s.prices.fish.price;
  const r = E.spin(s, s.turn, rngFor(seg), 2000);
  assert.ok(r.ok, r.error);
  const L = s.lastSpin;
  assert.equal(L.seg, seg);
  assert.equal(L.type, 'co');
  assert.equal(L.co, 'fish');
  assert.ok(L.card && typeof L.card.t === 'string');
  assert.equal(s.prices.fish.price, Math.max(5, Math.round(before * (1 + L.card.p / 100))));
  assert.equal(s.phase, 'trade');
  assert.equal(s.turn, s.order[0], '回した人がそのまま売り買いする');
  assert.equal(Object.keys(L.moves).length, 4, 'ほかの4社は小さく動く');
  for (const v of Object.values(L.moves)) assert.ok(Math.abs(v) <= 0.031);
  assert.equal(L.ranks.length, 2);
  assert.equal(Object.keys(L.before).length, 2);
  assertNoUndefined(s);
});

test('盗賊のマス：回した人が行き先を選ぶまで止まる → 選んだ会社が −25%', () => {
  const s = setup(2);
  const seg = segOf('robber');
  assert.ok(E.spin(s, s.turn, rngFor(seg), 2000).ok);
  assert.equal(s.phase, 'robber');
  assert.equal(E.buy(s, s.turn, 'fish', 1).ok, false, '盗賊を置くまで買えない');
  assert.equal(E.placeRobber(s, s.order[1], 'fish').ok, false, '番じゃない人は置けない');
  const before = s.prices.fish.price;
  assert.ok(E.placeRobber(s, s.turn, 'fish', 2000).ok);
  assert.equal(s.robber, 'fish');
  assert.equal(s.prices.fish.price, Math.max(5, Math.round(before * 0.75)));
  assert.equal(s.lastSpin.robberTarget, 'fish');
  assert.equal(s.lastSpin.moves.fish, undefined, '盗賊に襲われた会社はドリフト表示から外す');
  assert.equal(s.phase, 'trade');
});

test('ラッキー：回した人に 100G', () => {
  const s = setup(2);
  const p = s.players[s.turn];
  const cash = p.cash;
  assert.ok(E.spin(s, s.turn, rngFor(segOf('lucky')), 2000).ok);
  assert.equal(p.cash, cash + LUCKY_AMOUNT);
  assert.equal(s.lastSpin.lucky, LUCKY_AMOUNT);
  assert.equal(s.phase, 'trade');
});

test('おたすけ：ビリの人に 150G', () => {
  const s = setup(2);
  const [a, b] = s.order;
  s.players[b].cash = 500; // b がビリ
  assert.ok(E.spin(s, a, rngFor(segOf('rescue')), 2000).ok);
  assert.equal(s.players[b].cash, 500 + RESCUE_AMOUNT);
  assert.equal(s.players[a].cash, 1000);
  assert.equal(s.lastSpin.rescue.id, b);
});

test('号外：町じゅうの株が +25% か −25%', () => {
  const s = setup(2);
  const before = COMPANIES.map(c => s.prices[c.id].price);
  assert.ok(E.spin(s, s.turn, rngFor(segOf('extra'), 0.1), 2000).ok); // 0.1 → boom
  assert.equal(s.lastSpin.extra, 'boom');
  COMPANIES.forEach((c, i) => assert.equal(s.prices[c.id].price, Math.round(before[i] * 1.25)));
});

test('配当カード：持っている人だけがお金をもらう', () => {
  const s = setup(2);
  const [a, b] = s.order;
  s.players[a].shares.lantern = 10;
  const lantern = COMPANIES.find(c => c.id === 'lantern');
  const divIdx = lantern.cards.findIndex(c => c.div);
  s.decks.lantern = [divIdx, ...s.decks.lantern.filter(i => i !== divIdx)];
  const cashA = s.players[a].cash, cashB = s.players[b].cash;
  const price = s.prices.lantern.price;
  assert.ok(E.spin(s, a, rngFor(coSeg('lantern')), 2000).ok);
  assert.equal(s.lastSpin.card.div, lantern.cards[divIdx].div);
  assert.equal(s.players[a].cash, cashA + 10 * lantern.cards[divIdx].div);
  assert.equal(s.players[b].cash, cashB);
  assert.equal(s.prices.lantern.price, price, '配当カードでは株価は動かない');
});

test('売り買いは自分の番だけ。次の人へ → 順番が回り、全員回したらラウンドが進む', () => {
  const s = setup(2);
  const [a, b] = s.order;
  assert.ok(E.spin(s, a, rngFor(coSeg('cobble')), 2000).ok);
  assert.equal(E.buy(s, b, 'lantern', 1).ok, false, '番じゃない人は買えない');
  const price = s.prices.lantern.price;
  const cash0 = s.players[a].cash;
  assert.ok(E.buy(s, a, 'lantern', 3).ok);
  assert.equal(s.players[a].cash, cash0 - price * 3);
  assert.equal(s.players[a].shares.lantern, 3);
  assert.equal(E.sell(s, a, 'lantern', 4).ok, false);
  assert.ok(E.sell(s, a, 'lantern', 1).ok);
  assert.equal(s.players[a].shares.lantern, 2);
  assert.equal(E.buy(s, a, 'dragon', 100000).ok, false);
  assert.equal(E.buy(s, a, 'dragon', 0).ok, false);
  assert.equal(E.buy(s, a, 'nope', 1).ok, false);
  assert.equal(E.endTurn(s, b).ok, false, '番じゃない人は終われない');
  assert.ok(E.endTurn(s, a, 3000).ok);
  assert.equal(s.turn, b);
  assert.equal(s.phase, 'spin');
  assert.equal(s.round, 1);
  assert.equal(E.buy(s, a, 'lantern', 1).ok, false, '番が終わったら買えない');
  assert.ok(E.spin(s, b, rngFor(coSeg('herb')), 4000).ok);
  assert.ok(E.endTurn(s, b, 5000).ok);
  assert.equal(s.round, 2, '全員が回したら次のラウンド');
  assert.equal(s.turn, a);
  assert.equal(s.players[a].history.length, 2, 'ラウンドの終わりにお金を記録');
  assertNoUndefined(s);
});

test('飛ばす：部屋を作った人だけ。盗賊待ちなら自動で置く', () => {
  const s = setup(2);
  const [a, b] = s.order;
  assert.equal(E.skipTurn(s, a === 'p1' ? b : a).ok, false, 'ホスト以外は飛ばせない');
  assert.ok(E.skipTurn(s, 'p1', 2000).ok);
  assert.equal(s.turn, b);
  assert.ok(E.spin(s, b, rngFor(segOf('robber')), 3000).ok);
  assert.equal(s.phase, 'robber');
  assert.ok(E.skipTurn(s, 'p1', 4000).ok);
  assert.ok(s.robber, '盗賊が自動で置かれる');
  assert.equal(s.phase, 'trade');
});

test('ゲーム終了：規定ラウンドで end になり、順位と称号がつく', () => {
  const s = setup(3, { rounds: 5 });
  let guard = 0;
  while (s.phase !== 'end' && guard++ < 200) {
    if (s.phase === 'spin') assert.ok(E.spin(s, s.turn, Math.random, 1000).ok);
    else if (s.phase === 'robber') assert.ok(E.placeRobber(s, s.turn, E.CO_IDS[guard % 5], 1000).ok);
    else if (s.phase === 'trade') {
      const p = s.players[s.turn];
      if (p.cash >= s.prices.dragon.price) E.buy(s, p.id, 'dragon', 1);
      assert.ok(E.endTurn(s, p.id, 1000).ok);
    }
  }
  assert.equal(s.phase, 'end');
  assert.equal(s.round, 5);
  assert.equal(s.spinNo, 15);
  assert.equal(s.results.length, 3);
  for (const id of s.order) {
    assert.ok(s.players[id].title);
    assert.equal(s.players[id].history.length, 6);
  }
  assertNoUndefined(s);
});

test('normalize：Firebase が落とした空オブジェクトを補う', () => {
  const s = E.normalize({ code: 'X', players: { a: { id: 'a', name: 'a', charId: 'lumi', cash: 5 } }, order: ['a'] });
  assert.deepEqual(s.players.a.shares, {});
  assert.equal(s.players.a.stats.trades, 0);
  assert.equal(s.prices.lantern.price, 120);
  assert.deepEqual(s.decks.dragon, []);
  assert.equal(E.netWorth(s, s.players.a), 5);
});

test('resetToLobby：同じメンバーでロビーに戻る', () => {
  const s = setup(2);
  E.spin(s, s.turn, rngFor(coSeg('lantern')), 2000);
  const names = s.order.map(id => s.players[id].name).sort();
  assert.equal(E.resetToLobby(s, 'p2').ok, false);
  assert.ok(E.resetToLobby(s, 'p1').ok);
  assert.equal(s.phase, 'lobby');
  assert.deepEqual(s.order.map(id => s.players[id].name).sort(), names);
  assert.equal(s.players.p1.cash, E.RULES.START_CASH);
});

test('データ：ルーレットは20マス。会社のマスの数は当たりやすさの順。カードは各社8枚以上', () => {
  assert.equal(WHEEL.length, 20);
  const count = id => WHEEL.filter(w => w.co === id).length;
  assert.deepEqual(COMPANIES.map(c => count(c.id)), [5, 4, 3, 2, 1]);
  assert.equal(WHEEL.filter(w => w.type === 'robber').length, 2);
  for (const t of ['extra', 'lucky', 'rescue']) assert.equal(WHEEL.filter(w => w.type === t).length, 1);
  for (const c of COMPANIES) {
    assert.ok(c.cards.length >= 8, c.id);
    for (const card of c.cards) assert.ok(card.t && typeof card.p === 'number');
  }
});
