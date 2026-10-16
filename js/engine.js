// ゲームエンジン（ルーレット版）：状態(state)を受け取って書き換える純粋なルール関数の集まり。
// Firebase のトランザクション内から呼ばれるので、ここでは通信もDOMも触らない。
// すべての関数は { ok: true } か { ok: false, error: 'メッセージ' } を返し、state をその場で書き換える。
//
// 進行は人生ゲーム式の順番制：
//   自分の番 → ルーレットを回す（spin）→ ニュース（盗賊なら行き先を選ぶ robber）→ 買う/売る（trade）→ 次の人
//   全員が1回ずつ回したら1ラウンド。決めたラウンド数が終わったら結果。
import { COMPANIES, CHARACTERS, WHEEL, EXTRAS, LUCKY_AMOUNT, RESCUE_AMOUNT, fmt } from './data.js';

export const RULES = {
  START_CASH: 1000,     // スタートのお金
  DRIFT: 0.03,          // ニュースがない会社の小さな動き（±3%）
  ROBBER_DROP: 0.25,    // 盗賊におそわれた会社の下落率
  MIN_PRICE: 5,
  MAX_PLAYERS: 4,
  LOG_MAX: 80,
  ROUND_OPTIONS: [5, 8, 10, 12, 15],
};

export const CO_IDS = COMPANIES.map(c => c.id);
const coMap = Object.fromEntries(COMPANIES.map(c => [c.id, c]));
const charMap = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));
export const coInfo = id => coMap[id] || null;
export const charInfo = id => charMap[id] || null;

const ok = () => ({ ok: true });
const err = m => ({ ok: false, error: m });
const R = Math.round;
const clampPrice = p => Math.max(RULES.MIN_PRICE, R(p));
const toInt = (v, min = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? n : NaN;
};

export const DEFAULT_SETTINGS = { rounds: 8, stakeLoser: '', stakeWinner: '' };
const DEFAULT_STATS = { trades: 0, peak: 0, bestGain: 0, worstLoss: 0, dragonMax: 0, sells: 0, lucky: 0 };

// ---------- 状態の作成と正規化 ----------

export function newState(code, hostId, settings = {}, now = Date.now()) {
  const s = {
    code, hostId, createdAt: now, phase: 'lobby', round: 0, turnIdx: 0, turn: null, spinNo: 0,
    settings: sanitizeSettings({ ...DEFAULT_SETTINGS, ...settings }),
    order: [], players: {}, prices: {}, decks: {},
    robber: null, lastSpin: null, log: [], saved: false, finishedAt: 0,
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
  s.turnIdx = s.turnIdx || 0;
  s.spinNo = s.spinNo || 0;
  for (const c of COMPANIES) {
    const x = (s.prices[c.id] = s.prices[c.id] || { price: c.start, prev: c.start });
    x.history = x.history || [x.price];
    s.decks[c.id] = s.decks[c.id] || [];
  }
  for (const p of Object.values(s.players)) {
    p.shares = p.shares || {};
    p.history = p.history || [];
    p.stats = { ...DEFAULT_STATS, ...(p.stats || {}) };
    p.cash = p.cash || 0;
  }
  if (s.lastSpin) {
    const L = s.lastSpin;
    L.moves = L.moves || {}; L.ranks = L.ranks || []; L.divs = L.divs || []; L.before = L.before || {};
  }
  return s;
}

function sanitizeSettings(st) {
  return {
    rounds: RULES.ROUND_OPTIONS.includes(Number(st.rounds)) ? Number(st.rounds) : 8,
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
  s.players[id] = { id, name, charId, cash: RULES.START_CASH, shares: {}, history: [], stats: { ...DEFAULT_STATS }, joinedAt: now };
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
  s.round = 1;
  s.turnIdx = 0;
  s.turn = s.order[0];
  s.spinNo = 0;
  s.phase = 'spin';
  s.robber = null;
  s.lastSpin = null;
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

// ---------- ルーレット ----------

function drawCard(s, coId, rng) {
  const c = coMap[coId];
  if (!s.decks[coId] || !s.decks[coId].length) s.decks[coId] = shuffle(c.cards.map((_, i) => i), rng);
  const idx = s.decks[coId].shift();
  return { idx, ...c.cards[idx] };
}

export function spin(s, pid, rng = Math.random, now = Date.now()) {
  if (s.phase !== 'spin') return err('今はルーレットの時間じゃない');
  if (s.turn !== pid) return err('ルーレットを回せるのは番の人だけ');
  const seg = Math.floor(rng() * WHEEL.length);
  const jitter = 0.15 + rng() * 0.7; // マスの端ぎりぎりに止まらないように
  const w = WHEEL[seg];
  const p = s.players[pid];
  s.spinNo += 1;
  const before = {};
  for (const x of players(s)) before[x.id] = netWorth(s, x);
  const L = { id: s.spinNo, round: s.round, by: pid, seg, jitter, type: w.type, co: w.co || null, card: null, divs: [], extra: null, lucky: 0, rescue: null, robberTarget: null, moves: {}, before, ranks: [] };
  for (const id of CO_IDS) s.prices[id].prev = s.prices[id].price;

  if (w.type === 'co') {
    const c = coMap[w.co];
    const card = drawCard(s, c.id, rng);
    L.card = { t: card.t, p: card.p, div: card.div || 0 };
    if (card.p) s.prices[c.id].price = clampPrice(s.prices[c.id].price * (1 + card.p / 100));
    if (card.div) {
      for (const x of players(s)) {
        const q = x.shares[c.id] || 0;
        if (q > 0) { const d = q * card.div; x.cash += d; L.divs.push({ id: x.id, amount: d }); }
      }
    }
    log(s, `${c.emoji} ${c.short}：${card.t}${card.p ? `（${card.p > 0 ? '+' : ''}${card.p}%）` : card.div ? `（1株 ${card.div}G）` : ''}`);
  } else if (w.type === 'extra') {
    const kind = rng() < 0.5 ? 'boom' : 'crash';
    const ex = EXTRAS[kind];
    L.extra = kind;
    for (const id of CO_IDS) s.prices[id].price = clampPrice(s.prices[id].price * (1 + ex.p / 100));
    log(s, `${ex.emoji} ${ex.t}（${ex.p > 0 ? '+' : ''}${ex.p}%）`);
  } else if (w.type === 'lucky') {
    p.cash += LUCKY_AMOUNT;
    p.stats.lucky += 1;
    L.lucky = LUCKY_AMOUNT;
    log(s, `🎁 ラッキー！ ${p.name} に ${fmt(LUCKY_AMOUNT)}G`);
  } else if (w.type === 'rescue') {
    const rk = ranking(s);
    const last = s.players[rk[rk.length - 1].id];
    last.cash += RESCUE_AMOUNT;
    L.rescue = { id: last.id, amount: RESCUE_AMOUNT };
    log(s, `🍀 おたすけ！ ビリの ${last.name} に ${fmt(RESCUE_AMOUNT)}G`);
  } else if (w.type === 'robber') {
    log(s, `🏴‍☠️ 盗賊があらわれた！ ${p.name} が行き先を決める`);
  }
  // ニュースがなかった会社は小さく動く
  for (const c of COMPANIES) {
    if (w.type === 'co' && c.id === w.co) continue;
    const r = (rng() * 2 - 1) * RULES.DRIFT;
    const b = s.prices[c.id].price;
    s.prices[c.id].price = clampPrice(b * (1 + r));
    L.moves[c.id] = s.prices[c.id].price / b - 1;
  }
  s.lastSpin = L;
  if (w.type === 'robber') s.phase = 'robber';
  else settleSpin(s, now);
  return ok();
}

export function placeRobber(s, pid, coId, now = Date.now()) {
  if (s.phase !== 'robber') return err('今は盗賊を置く時間じゃない');
  if (s.turn !== pid) return err('盗賊を置けるのは番の人だけ');
  const c = coMap[coId];
  if (!c) return err('そんな会社はない');
  s.robber = coId;
  const before = s.prices[coId].price;
  s.prices[coId].price = clampPrice(before * (1 - RULES.ROBBER_DROP));
  s.lastSpin.robberTarget = coId;
  delete s.lastSpin.moves[coId];
  log(s, `🏴‍☠️ ${s.players[pid].name} が盗賊を ${c.emoji}${c.short} に送りこんだ（−${R(RULES.ROBBER_DROP * 100)}%）`);
  settleSpin(s, now);
  return ok();
}

// 回した後の後始末：順位の記録。売り買いタイムへ
function settleSpin(s, now) {
  const prevRank = {};
  if (s.lastSpin && s.lastSpin.before) {
    const prev = Object.entries(s.lastSpin.before).map(([id, nw]) => ({ id, nw })).sort((a, b) => b.nw - a.nw);
    prev.forEach((x, i) => { prevRank[x.id] = i + 1; });
  }
  const rk = ranking(s);
  s.lastSpin.ranks = rk.map(r => ({ id: r.id, nw: r.nw, rank: r.rank, delta: prevRank[r.id] ? prevRank[r.id] - r.rank : 0 }));
  for (const p of players(s)) {
    const nw = netWorth(s, p);
    if (nw > p.stats.peak) p.stats.peak = nw;
    const gain = nw - (s.lastSpin.before[p.id] ?? nw);
    if (gain > p.stats.bestGain) p.stats.bestGain = gain;
    if (gain < p.stats.worstLoss) p.stats.worstLoss = gain;
  }
  s.phase = 'trade';
  s.tradeStartedAt = now;
}

// ---------- 売り買い（自分の番だけ） ----------

function tradeCtx(s, pid) {
  if (s.phase !== 'trade') return [null, err('今は売り買いの時間じゃない')];
  if (s.turn !== pid) return [null, err('自分の番になったら売り買いできる')];
  const p = s.players[pid];
  if (!p) return [null, err('プレイヤーが見つからない')];
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
  if (id === 'dragon' && p.shares[id] > p.stats.dragonMax) p.stats.dragonMax = p.shares[id];
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

// ---------- 手番の進行 ----------

export function endTurn(s, pid, now = Date.now()) {
  if (s.phase !== 'trade') return err('今はその時間じゃない');
  if (s.turn !== pid) return err('自分の番じゃない');
  nextTurn(s, now);
  return ok();
}

// 部屋を作った人が、動かない人の番を飛ばす
export function skipTurn(s, pid, now = Date.now()) {
  if (s.hostId !== pid) return err('飛ばせるのは部屋を作った人だけ');
  if (s.phase === 'robber') {
    // 盗賊の行き先が決まらないときは、いちばん高い株に置く
    const top = CO_IDS.reduce((b, id) => (priceOf(s, id) > priceOf(s, b) ? id : b), CO_IDS[0]);
    return placeRobber(s, s.turn, top, now);
  }
  if (s.phase !== 'spin' && s.phase !== 'trade') return err('今はその時間じゃない');
  log(s, `⏭ ${s.players[s.turn]?.name} の番を飛ばした`);
  nextTurn(s, now);
  return ok();
}

function nextTurn(s, now) {
  s.turnIdx += 1;
  if (s.turnIdx >= s.order.length) {
    // 1ラウンド終了：みんなのお金を記録
    for (const p of players(s)) p.history[s.round] = netWorth(s, p);
    for (const id of CO_IDS) s.prices[id].history[s.round] = s.prices[id].price;
    if (s.round >= s.settings.rounds) { finish(s, now); return; }
    s.round += 1;
    s.turnIdx = 0;
  }
  s.turn = s.order[s.turnIdx];
  s.phase = 'spin';
}

export function finish(s, now = Date.now()) {
  for (const p of players(s)) p.final = netWorth(s, p);
  s.phase = 'end';
  s.turn = null;
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
  m = maxBy(p => p.stats.lucky); if (m && m.stats.lucky >= 2) assign(m, '幸運の持ち主');
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
