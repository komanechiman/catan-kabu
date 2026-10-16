// ゲームエンジン（シンプル版）：状態(state)を受け取って書き換える純粋なルール関数の集まり。
// Firebase のトランザクション内から呼ばれるので、ここでは通信もDOMも触らない。
// すべての関数は { ok: true } か { ok: false, error: 'メッセージ' } を返し、state をその場で書き換える。
import { COMPANIES, CHARACTERS, EXTRAS, fmt } from './data.js';

export const RULES = {
  START_CASH: 1000,     // スタートのお金
  DRIFT: 0.05,          // ニュースがない会社の小さな動き（±5%）
  ROBBER_DROP: 0.25,    // 盗賊におそわれた会社の下落率
  MIN_PRICE: 5,
  MAX_PLAYERS: 4,
  LOG_MAX: 60,
  ROUND_OPTIONS: [8, 10, 12, 15],
};

export const CO_IDS = COMPANIES.map(c => c.id);
const coMap = Object.fromEntries(COMPANIES.map(c => [c.id, c]));
const charMap = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));
export const coInfo = id => coMap[id] || null;
export const charInfo = id => charMap[id] || null;

const ok = () => ({ ok: true });
const err = m => ({ ok: false, error: m });
const R = Math.round;
const die = rng => 1 + Math.floor(rng() * 6);
const clampPrice = p => Math.max(RULES.MIN_PRICE, R(p));
const toInt = (v, min = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? n : NaN;
};

export const DEFAULT_SETTINGS = { rounds: 10, stakeLoser: '', stakeWinner: '' };
const DEFAULT_STATS = { trades: 0, peak: 0, bestGain: 0, worstLoss: 0, dragonMax: 0, sells: 0 };

// ---------- 状態の作成と正規化 ----------

export function newState(code, hostId, settings = {}, now = Date.now()) {
  const s = {
    code, hostId, createdAt: now, phase: 'lobby', round: 0,
    settings: sanitizeSettings({ ...DEFAULT_SETTINGS, ...settings }),
    order: [], dealer: null, players: {}, prices: {}, decks: {},
    robber: null, lastRoll: null, log: [], saved: false, finishedAt: 0,
  };
  for (const c of COMPANIES) s.prices[c.id] = { price: c.start, prev: c.start, history: [c.start] };
  return s;
}

// Firebase は空の配列やオブジェクトを保存しないので、読んだ直後に欠けている入れ物を補う
export function normalize(s) {
  s.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...(s.settings || {}) });
  s.order = s.order || [];
  s.players = s.players || {};
  s.log = s.log || [];
  s.prices = s.prices || {};
  s.decks = s.decks || {};
  s.round = s.round || 0;
  for (const c of COMPANIES) {
    const x = (s.prices[c.id] = s.prices[c.id] || { price: c.start, prev: c.start });
    x.history = x.history || [x.price];
    s.decks[c.id] = s.decks[c.id] || [];
  }
  for (const p of Object.values(s.players)) {
    p.shares = p.shares || {};
    p.history = p.history || [];
    p.stats = { ...DEFAULT_STATS, ...(p.stats || {}) };
    p.done = !!p.done;
    p.cash = p.cash || 0;
  }
  if (s.lastRoll) { s.lastRoll.moves = s.lastRoll.moves || {}; s.lastRoll.ranks = s.lastRoll.ranks || []; s.lastRoll.divs = s.lastRoll.divs || []; }
  return s;
}

function sanitizeSettings(st) {
  return {
    rounds: RULES.ROUND_OPTIONS.includes(Number(st.rounds)) ? Number(st.rounds) : 10,
    stakeLoser: String(st.stakeLoser || '').slice(0, 40),
    stakeWinner: String(st.stakeWinner || '').slice(0, 40),
  };
}

export const players = s => s.order.map(id => s.players[id]).filter(Boolean);

function log(s, text) {
  s.log.push({ r: s.round, t: text });
  if (s.log.length > RULES.LOG_MAX) s.log.splice(0, s.log.length - RULES.LOG_MAX);
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- ロビー ----------

export function addPlayer(s, { id, name, charId }, now = Date.now()) {
  if (s.players[id]) return ok();
  if (s.phase !== 'lobby') return err('もうゲームが始まってる部屋よ');
  if (Object.keys(s.players).length >= RULES.MAX_PLAYERS) return err('この部屋はもう満員（4人）');
  name = String(name || '').trim().slice(0, 10);
  if (!name) return err('名前を入れて');
  if (Object.values(s.players).some(p => p.name === name)) return err('同じ名前の人がもういる');
  if (!charMap[charId]) return err('キャラを選んで');
  if (Object.values(s.players).some(p => p.charId === charId)) return err('そのキャラはもう選ばれてる');
  s.players[id] = { id, name, charId, cash: RULES.START_CASH, shares: {}, history: [], stats: { ...DEFAULT_STATS }, done: false, joinedAt: now };
  s.order.push(id);
  return ok();
}

export function removePlayer(s, id) {
  if (s.phase !== 'lobby') return err('ゲーム中は抜けられない');
  if (!s.players[id]) return ok();
  delete s.players[id];
  s.order = s.order.filter(x => x !== id);
  if (s.hostId === id) s.hostId = s.order[0] || null;
  return ok();
}

export function updateSettings(s, pid, patch) {
  if (s.hostId !== pid) return err('設定を変えられるのは部屋を作った人だけ');
  if (s.phase !== 'lobby') return err('ゲーム中は設定を変えられない');
  s.settings = sanitizeSettings({ ...s.settings, ...patch });
  return ok();
}

export function startGame(s, pid, rng = Math.random, now = Date.now()) {
  if (s.hostId !== pid) return err('スタートできるのは部屋を作った人だけ');
  if (s.phase !== 'lobby') return err('もう始まってる');
  if (s.order.length < 1) return err('プレイヤーがいない');
  shuffle(s.order, rng);
  s.round = 0;
  s.dealer = s.order[0];
  s.phase = 'roll';
  s.robber = null;
  s.lastRoll = null;
  s.log = [];
  for (const c of COMPANIES) {
    s.prices[c.id] = { price: c.start, prev: c.start, history: [c.start] };
    s.decks[c.id] = shuffle(c.cards.map((_, i) => i), rng);
  }
  for (const p of players(s)) {
    p.cash = RULES.START_CASH;
    p.shares = {};
    p.stats = { ...DEFAULT_STATS, peak: RULES.START_CASH };
    p.history = [RULES.START_CASH];
    p.done = false;
  }
  s.startedAt = now;
  log(s, `🏁 ゲーム開始！ 順番：${players(s).map(p => p.name).join(' → ')}`);
  return ok();
}

// ---------- 評価 ----------

export const priceOf = (s, id) => (s.prices[id] ? s.prices[id].price : 0);
export function sharesValue(s, p) {
  let v = 0;
  for (const [id, q] of Object.entries(p.shares || {})) v += q * priceOf(s, id);
  return v;
}
export const netWorth = (s, p) => p.cash + sharesValue(s, p);

export function ranking(s) {
  const arr = players(s).map(p => ({ id: p.id, nw: netWorth(s, p) }));
  arr.sort((a, b) => b.nw - a.nw);
  return arr.map((x, i) => ({ ...x, rank: i + 1 }));
}

// ---------- サイコロとニュース ----------

function drawCard(s, coId, rng) {
  const c = coMap[coId];
  if (!s.decks[coId] || !s.decks[coId].length) s.decks[coId] = shuffle(c.cards.map((_, i) => i), rng);
  const idx = s.decks[coId].shift();
  return { idx, ...c.cards[idx] };
}

export function rollDice(s, pid, rng = Math.random, now = Date.now()) {
  if (s.phase !== 'roll') return err('今はサイコロの時間じゃない');
  if (s.dealer !== pid) return err('サイコロを振れるのは親だけ');
  const d1 = die(rng), d2 = die(rng);
  const sum = d1 + d2;
  s.round += 1;
  const roll = { round: s.round, d1, d2, sum, dealer: pid, co: null, card: null, moves: {}, divs: [], extra: null, robberTarget: null, ranks: [] };
  for (const id of CO_IDS) s.prices[id].prev = s.prices[id].price;

  if (sum !== 7) {
    const c = COMPANIES.find(x => x.numbers.includes(sum));
    roll.co = c.id;
    const card = drawCard(s, c.id, rng);
    roll.card = { t: card.t, p: card.p, div: card.div || 0 };
    if (card.p) s.prices[c.id].price = clampPrice(s.prices[c.id].price * (1 + card.p / 100));
    if (card.div) {
      for (const p of players(s)) {
        const q = p.shares[c.id] || 0;
        if (q > 0) { const d = q * card.div; p.cash += d; roll.divs.push({ id: p.id, amount: d }); }
      }
    }
    log(s, `${c.emoji} ${c.short}：${card.t}${card.p ? `（${card.p > 0 ? '+' : ''}${card.p}%）` : card.div ? `（1株 ${card.div}G）` : ''}`);
  }
  // ニュースがない会社は小さく動く
  for (const c of COMPANIES) {
    if (c.id === roll.co) continue;
    const r = (rng() * 2 - 1) * RULES.DRIFT;
    const before = s.prices[c.id].price;
    s.prices[c.id].price = clampPrice(before * (1 + r));
    roll.moves[c.id] = s.prices[c.id].price / before - 1;
  }
  // ゾロ目は号外
  if (d1 === d2) {
    const kind = rng() < 0.5 ? 'boom' : 'crash';
    const ex = EXTRAS[kind];
    roll.extra = kind;
    for (const id of CO_IDS) s.prices[id].price = clampPrice(s.prices[id].price * (1 + ex.p / 100));
    log(s, `${ex.emoji} ${ex.t}（${ex.p > 0 ? '+' : ''}${ex.p}%）`);
  }
  s.lastRoll = roll;
  if (sum === 7) {
    s.phase = 'robber';
    log(s, `🏴‍☠️ 7！ 盗賊があらわれた`);
  } else {
    settle(s, now);
  }
  return ok();
}

export function placeRobber(s, pid, coId, now = Date.now()) {
  if (s.phase !== 'robber') return err('今は盗賊を置く時間じゃない');
  if (s.dealer !== pid) return err('盗賊を置けるのは親だけ');
  const c = coMap[coId];
  if (!c) return err('そんな会社はない');
  s.robber = coId;
  const before = s.prices[coId].price;
  s.prices[coId].price = clampPrice(before * (1 - RULES.ROBBER_DROP));
  s.lastRoll.robberTarget = coId;
  log(s, `🏴‍☠️ ${s.players[pid].name} が盗賊を ${c.emoji}${c.short} に送りこんだ（−${R(RULES.ROBBER_DROP * 100)}%）`);
  settle(s, now);
  return ok();
}

// ラウンドの後始末：記録と順位
function settle(s, now) {
  const prevRankOf = {};
  for (const p of players(s)) {
    const prev = p.history.length ? p.history[p.history.length - 1] : RULES.START_CASH;
    prevRankOf[p.id] = 0;
    const nw = netWorth(s, p);
    p.history[s.round] = nw;
    if (nw > p.stats.peak) p.stats.peak = nw;
    const gain = nw - prev;
    if (gain > p.stats.bestGain) p.stats.bestGain = gain;
    if (gain < p.stats.worstLoss) p.stats.worstLoss = gain;
    const dq = p.shares.dragon || 0;
    if (dq > p.stats.dragonMax) p.stats.dragonMax = dq;
    p.done = false;
  }
  // 前ラウンドの順位は履歴から計算
  if (s.round > 1) {
    const prevList = players(s).map(p => ({ id: p.id, nw: p.history[s.round - 1] || 0 })).sort((a, b) => b.nw - a.nw);
    prevList.forEach((x, i) => { prevRankOf[x.id] = i + 1; });
  }
  const rk = ranking(s);
  s.lastRoll.ranks = rk.map(r => ({ id: r.id, nw: r.nw, rank: r.rank, delta: prevRankOf[r.id] ? prevRankOf[r.id] - r.rank : 0 }));
  for (const id of CO_IDS) s.prices[id].history[s.round] = s.prices[id].price;
  s.phase = 'trade';
  s.tradeStartedAt = now;
}

// ---------- 売り買い ----------

function tradeCtx(s, pid) {
  if (s.phase !== 'trade') return [null, err('今は売り買いの時間じゃない')];
  const p = s.players[pid];
  if (!p) return [null, err('プレイヤーが見つからない')];
  if (p.done) return [null, err('「おしまい」を押したあとは売り買いできない。「まだやる」で戻れるわ')];
  return [p, null];
}

export function buy(s, pid, id, qty) {
  const [p, e] = tradeCtx(s, pid); if (e) return e;
  const c = coMap[id]; if (!c) return err('そんな会社はない');
  qty = toInt(qty, 1); if (!qty) return err('数を入れて');
  const cost = priceOf(s, id) * qty;
  if (cost > p.cash) return err(`お金が足りない（${fmt(cost)}G 必要、持ってるのは ${fmt(p.cash)}G）`);
  p.cash -= cost;
  p.shares[id] = (p.shares[id] || 0) + qty;
  p.stats.trades += 1;
  log(s, `🛒 ${p.name} が ${c.emoji}${c.short} を ${qty}株 買った（${fmt(priceOf(s, id))}G）`);
  return ok();
}

export function sell(s, pid, id, qty) {
  const [p, e] = tradeCtx(s, pid); if (e) return e;
  const c = coMap[id]; if (!c) return err('そんな会社はない');
  qty = toInt(qty, 1); if (!qty) return err('数を入れて');
  const have = p.shares[id] || 0;
  if (qty > have) return err(`そんなに持ってない（持ってるのは ${have}株）`);
  p.cash += priceOf(s, id) * qty;
  if (have - qty <= 0) delete p.shares[id]; else p.shares[id] = have - qty;
  p.stats.trades += 1;
  p.stats.sells += 1;
  log(s, `💰 ${p.name} が ${c.emoji}${c.short} を ${qty}株 売った（${fmt(priceOf(s, id))}G）`);
  return ok();
}

// ---------- ラウンド進行 ----------

export function setDone(s, pid, done, now = Date.now()) {
  if (s.phase !== 'trade') return err('今はその時間じゃない');
  const p = s.players[pid]; if (!p) return err('プレイヤーが見つからない');
  p.done = !!done;
  if (players(s).every(x => x.done)) advanceRound(s, now);
  return ok();
}

export function forceAdvance(s, pid, now = Date.now()) {
  if (s.phase !== 'trade') return err('今はその時間じゃない');
  if (s.hostId !== pid) return err('進められるのは部屋を作った人だけ');
  advanceRound(s, now);
  return ok();
}

function advanceRound(s, now) {
  if (s.round >= s.settings.rounds) { finish(s, now); return; }
  s.phase = 'roll';
  s.dealer = s.order[s.round % s.order.length];
  for (const p of players(s)) p.done = false;
}

export function finish(s, now = Date.now()) {
  for (const p of players(s)) { p.final = netWorth(s, p); p.done = false; }
  s.phase = 'end';
  s.finishedAt = now;
  const rk = ranking(s);
  s.results = rk.map(r => r.id);
  const t = titles(s);
  for (const r of rk) s.players[r.id].title = t[r.id].title;
  log(s, `🏆 ゲーム終了！ 優勝は ${s.players[rk[0].id].name}`);
}

export function titles(s) {
  const rk = ranking(s);
  const ps = rk.map(r => s.players[r.id]);
  const out = {};
  const assign = (p, title) => { if (p && !out[p.id]) out[p.id] = { title }; };
  const maxBy = fn => ps.reduce((b, p) => (fn(p) > fn(b) ? p : b), ps[0]);
  if (ps.length) assign(ps[0], 'ランタン通りの大富豪');
  let m;
  m = maxBy(p => p.stats.dragonMax); if (m && m.stats.dragonMax >= 5) assign(m, '竜の山の大ばくち打ち');
  m = maxBy(p => p.stats.bestGain); if (m && m.stats.bestGain > 0) assign(m, '一発逆転の人');
  m = maxBy(p => -p.stats.worstLoss); if (m && m.stats.worstLoss < 0) assign(m, '嵐にのまれた船長');
  m = maxBy(p => p.stats.trades); if (m && m.stats.trades > 0) assign(m, '売り買いマシン');
  for (const p of ps) if (p.stats.sells === 0 && p.stats.trades > 0) assign(p, 'ガチホの達人');
  if (ps.length > 1) assign(ps[ps.length - 1], '次はきっと勝てる');
  for (const p of ps) assign(p, '石畳の商人');
  return out;
}

export function resetToLobby(s, pid) {
  if (s.hostId !== pid) return err('部屋を作った人だけ');
  const keep = players(s).map(p => ({ id: p.id, name: p.name, charId: p.charId }));
  const fresh = newState(s.code, s.hostId, s.settings, Date.now());
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, fresh);
  for (const k of keep) addPlayer(s, k);
  return ok();
}
