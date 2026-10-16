// エンジンの動作テスト（シンプル版）。実行: node --test test/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/engine.js';
import { COMPANIES } from '../js/data.js';

// 決まった順番で値を返す疑似乱数
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}
const face = d => (d - 1) / 6 + 0.01; // サイコロの目 d を出す乱数値

function setup(n = 2, settings = {}) {
  const s = E.newState('TEST', 'p1', { rounds: 8, ...settings }, 1000);
  const chars = ['lumi', 'mimi', 'baron', 'holo'];
  for (let i = 1; i <= n; i++) assert.ok(E.addPlayer(s, { id: 'p' + i, name: 'P' + i, charId: chars[i - 1] }).ok);
  assert.ok(E.startGame(s, 'p1', () => 0.5, 1000).ok);
  return s;
}
function assertNoUndefined(obj, path = '') {
  if (obj === undefined) assert.fail('undefined at ' + path);
  if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) assertNoUndefined(v, path + '.' + k);
}
function allDone(s) { for (const id of s.order) E.setDone(s, id, true, 2000); }

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
  assert.equal(s.players.p1.cash, E.RULES.START_CASH);
  assertNoUndefined(s);
});

test('サイコロ：出目の会社にニュースカードが引かれて株価が動く', () => {
  const s = setup(2);
  const dealer = s.dealer;
  // 3+3=6 → ランタン工房。他社のドリフトは 0.5 → 変動ゼロ。ゾロ目なので号外（rng 0.5 → crash）
  const rng = seq([face(3), face(3), 0.5, 0.5, 0.5, 0.5, 0.5]);
  const before = s.prices.lantern.price;
  const r = E.rollDice(s, dealer, rng, 2000);
  assert.ok(r.ok, r.error);
  assert.equal(s.round, 1);
  assert.equal(s.phase, 'trade');
  assert.equal(s.lastRoll.sum, 6);
  assert.equal(s.lastRoll.co, 'lantern');
  assert.ok(s.lastRoll.card && typeof s.lastRoll.card.t === 'string');
  assert.equal(s.lastRoll.extra, 'crash');
  const card = s.lastRoll.card;
  const expected = Math.max(5, Math.round(Math.max(5, Math.round(before * (1 + card.p / 100))) * 0.75));
  assert.equal(s.prices.lantern.price, expected);
  // ニュースのない会社は小さく動く（±5%以内）
  for (const c of COMPANIES) if (c.id !== 'lantern') assert.ok(Math.abs(s.lastRoll.moves[c.id]) <= 0.051);
  assert.equal(s.lastRoll.ranks.length, 2);
  assert.equal(s.players[dealer].history.length, 2);
  assertNoUndefined(s);
});

test('ニュースカード：山札は引くたびに減り、なくなったら切り直す', () => {
  const s = setup(1, { rounds: 15 });
  const n = COMPANIES.find(c => c.id === 'cobble').cards.length;
  assert.equal(s.decks.cobble.length, n);
  for (let i = 0; i < n + 1; i++) {
    if (s.phase === 'trade') allDone(s);
    const r = E.rollDice(s, s.dealer, seq([face(4), face(5), 0.5]), 2000 + i); // 9 → 石畳
    assert.ok(r.ok, r.error);
    if (s.phase === 'end') break;
  }
  assert.ok(s.decks.cobble.length < n);
});

test('配当カード：持っている人だけがお金をもらう', () => {
  const s = setup(2);
  const [a, b] = s.order;
  s.players[a].shares.lantern = 10;
  // ランタンの山札の先頭を配当カードにする
  const lantern = COMPANIES.find(c => c.id === 'lantern');
  const divIdx = lantern.cards.findIndex(c => c.div);
  s.decks.lantern = [divIdx, ...s.decks.lantern.filter(i => i !== divIdx)];
  const cashA = s.players[a].cash, cashB = s.players[b].cash;
  const price = s.prices.lantern.price;
  assert.ok(E.rollDice(s, s.dealer, seq([face(2), face(4), 0.5]), 2000).ok); // 6
  assert.equal(s.lastRoll.card.div, lantern.cards[divIdx].div);
  assert.equal(s.players[a].cash, cashA + 10 * lantern.cards[divIdx].div);
  assert.equal(s.players[b].cash, cashB);
  assert.equal(s.prices.lantern.price, price, '配当カードでは株価は動かない');
});

test('7：盗賊フェーズ → 親が置いた会社が25%下がる', () => {
  const s = setup(2);
  const dealer = s.dealer;
  assert.ok(E.rollDice(s, dealer, seq([face(3), face(4), 0.5]), 2000).ok);
  assert.equal(s.phase, 'robber');
  assert.equal(s.lastRoll.co, null);
  const before = s.prices.fish.price;
  assert.equal(E.placeRobber(s, 'nobody', 'fish').ok, false);
  assert.equal(E.placeRobber(s, dealer, 'nope').ok, false);
  assert.ok(E.placeRobber(s, dealer, 'fish', 2000).ok);
  assert.equal(s.robber, 'fish');
  assert.equal(s.prices.fish.price, Math.max(5, Math.round(before * 0.75)));
  assert.equal(s.phase, 'trade');
  assert.equal(s.lastRoll.ranks.length, 2);
});

test('売り買い：買う・売る・お金が足りない・持ってない', () => {
  const s = setup(2);
  E.rollDice(s, s.dealer, seq([face(1), face(2), 0.5]), 2000); // 3 → さかな
  const pid = s.order[0];
  const p = s.players[pid];
  assert.equal(E.buy(s, pid, 'lantern', 1).ok, true);
  const price = s.prices.lantern.price;
  const cash0 = p.cash;
  assert.ok(E.buy(s, pid, 'lantern', 3).ok);
  assert.equal(p.cash, cash0 - price * 3);
  assert.equal(p.shares.lantern, 4);
  assert.equal(E.sell(s, pid, 'lantern', 5).ok, false);
  assert.ok(E.sell(s, pid, 'lantern', 4).ok);
  assert.equal(p.shares.lantern, undefined);
  assert.equal(p.cash, cash0 + price);
  assert.equal(E.buy(s, pid, 'dragon', 100000).ok, false);
  assert.equal(E.buy(s, pid, 'dragon', 0).ok, false);
  assert.equal(E.buy(s, pid, 'dragon', 'x').ok, false);
  assert.equal(E.buy(s, pid, 'nope', 1).ok, false);
  // おしまいを押したら売り買いできない
  assert.ok(E.setDone(s, pid, true).ok);
  assert.equal(E.buy(s, pid, 'dragon', 1).ok, false);
  assert.ok(E.setDone(s, pid, false).ok);
  assert.ok(E.buy(s, pid, 'dragon', 1).ok);
  assertNoUndefined(s);
});

test('ゲーム終了：規定ラウンドで end になり、順位と称号がつく', () => {
  const s = setup(3, { rounds: 8 });
  let guard = 0;
  while (s.phase !== 'end' && guard++ < 100) {
    if (s.phase === 'roll') assert.ok(E.rollDice(s, s.dealer, Math.random, 1000).ok);
    else if (s.phase === 'robber') assert.ok(E.placeRobber(s, s.dealer, E.CO_IDS[guard % 5], 1000).ok);
    else if (s.phase === 'trade') {
      const p = s.players[s.order[0]];
      if (p.cash >= s.prices.dragon.price) E.buy(s, p.id, 'dragon', 1);
      allDone(s);
    }
  }
  assert.equal(s.phase, 'end');
  assert.equal(s.round, 8);
  assert.equal(s.results.length, 3);
  for (const id of s.order) {
    assert.ok(s.players[id].title);
    assert.equal(s.players[id].history.length, 9);
  }
  const rk = E.ranking(s);
  assert.equal(rk[0].id, s.results[0]);
  assertNoUndefined(s);
});

test('順位の変化：ranks に delta が入る', () => {
  const s = setup(2);
  const [a, b] = s.order;
  E.rollDice(s, s.dealer, seq([face(1), face(2), 0.5]), 2000);
  // a が竜の山を全力買い → 次のラウンドで 2・12 を出して大きく動かす
  const price = s.prices.dragon.price;
  E.buy(s, a, 'dragon', Math.floor(s.players[a].cash / price));
  allDone(s);
  E.rollDice(s, s.dealer, seq([face(6), face(6), 0.1]), 3000); // 12 → 竜、ゾロ目 boom
  const ra = s.lastRoll.ranks.find(r => r.id === a), rb = s.lastRoll.ranks.find(r => r.id === b);
  assert.ok(ra && rb);
  assert.equal(ra.delta + rb.delta, 0);
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
  E.rollDice(s, s.dealer, seq([face(2), face(3), 0.5]), 2000);
  const names = s.order.map(id => s.players[id].name).sort();
  assert.equal(E.resetToLobby(s, 'p2').ok, false);
  assert.ok(E.resetToLobby(s, 'p1').ok);
  assert.equal(s.phase, 'lobby');
  assert.deepEqual(s.order.map(id => s.players[id].name).sort(), names);
  assert.equal(s.players.p1.cash, E.RULES.START_CASH);
});

test('データ：数字チップは2〜12（7以外）を全部ちょうど1回ずつ使う。カードは各社8枚以上', () => {
  const nums = COMPANIES.flatMap(c => c.numbers).sort((a, b) => a - b);
  assert.deepEqual(nums, [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
  for (const c of COMPANIES) {
    assert.ok(c.cards.length >= 8, c.id);
    for (const card of c.cards) assert.ok(card.t && (typeof card.p === 'number'));
  }
});
