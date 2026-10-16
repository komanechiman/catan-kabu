// ゲームエンジン：状態(state)を受け取って書き換える純粋なルール関数の集まり。
// Firebase のトランザクション内から呼ばれるので、ここでは通信もDOMも触らない。
// すべての関数は { ok: true } か { ok: false, error: 'メッセージ' } を返し、state をその場で書き換える。
import { STOCKS, FUNDS, CHARACTERS, fmt } from './data.js';

export const RULES = {
  START_CASH: 100000,   // スタート資金
  FEE: 0.01,            // 株の売買手数料
  INTEREST: 0.02,       // 借金の金利（毎ラウンド）
  SHORT_FEE: 0.01,      // 貸株料（毎ラウンド、空売りの借りに対して）
  BORROW_MULT: 2,       // 借入上限 = 純資産 × 2
  SHORT_MULT: 1,        // 空売り上限 = 純資産 × 1
  MAINT: 0.25,          // 維持率。これを切ると追証
  ROBBER_DROP: 0.20,    // 盗賊を置かれた株の下落率
  CASH_TAX_OVER: 50000, // この額をこえる現金はタンス預金として盗賊に狙われる
  CASH_TAX: 0.10,
  BANKRUPT_CASH: 10000, // 破産後の再起資金
  BOOM_ALL: 0.25, BOOM_ONE: 0.60,
  CRASH_ALL: 0.20, CRASH_ONE: 0.45,
  ACTIVE_ALPHA: 0.05,   // アクティブファンドの運用の腕（±この範囲でランダム）
  MAX_OFFERS: 3,
  ALLOWANCE: 1500,
  ROBBER_GIFT: 3000,
  RICH_START: 15000,
  MIN_PRICE: 10,
  MAX_PLAYERS: 4,
  LOG_MAX: 80,
  ROUND_OPTIONS: [10, 15, 20, 30],
  TIMER_OPTIONS: [0, 60, 90, 120, 180],
};

export const STOCK_IDS = STOCKS.map(s => s.id);
export const FUND_IDS = FUNDS.map(f => f.id);
export const ASSET_IDS = [...STOCK_IDS, ...FUND_IDS];
const stockMap = Object.fromEntries(STOCKS.map(s => [s.id, s]));
const fundMap = Object.fromEntries(FUNDS.map(f => [f.id, f]));
const charMap = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));

export const isStock = id => !!stockMap[id];
export const isFund = id => !!fundMap[id];
export const assetInfo = id => stockMap[id] || fundMap[id] || null;
export const charInfo = id => charMap[id] || null;

const ok = () => ({ ok: true });
const err = m => ({ ok: false, error: m });
const R = Math.round;
const die = rng => 1 + Math.floor(rng() * 6);
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const clampPrice = p => Math.max(RULES.MIN_PRICE, R(p));
const toInt = (v, min = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? n : NaN;
};

export const DEFAULT_SETTINGS = { rounds: 15, timer: 0, npc: true, stakeLoser: '', stakeWinner: '' };
const DEFAULT_STATS = {
  trades: 0, fees: 0, interest: 0, dividends: 0, payouts: 0, bankrupt: 0, margin: 0,
  borrowedMax: 0, shorts: 0, offers: 0, peak: 0, realized: 0, realizedShort: 0, dcaTotal: 0, robberTax: 0,
};

// ---------- 状態の作成と正規化 ----------

export function newState(code, hostId, settings = {}, now = Date.now()) {
  const s = {
    code, hostId, createdAt: now, phase: 'lobby', round: 0,
    settings: sanitizeSettings({ ...DEFAULT_SETTINGS, ...settings }),
    order: [], dealer: null, players: {}, stocks: {}, funds: {},
    robber: null, lastRoll: null, offers: {}, log: [], npc: null,
    tradeStartedAt: 0, saved: false, historyId: null, finishedAt: 0,
  };
  for (const st of STOCKS) s.stocks[st.id] = { price: st.start, prev: st.start, history: [st.start] };
  for (const f of FUNDS) s.funds[f.id] = { price: f.start, prev: f.start, history: [f.start] };
  return s;
}

// Firebase は空の配列やオブジェクトを保存しないので、読んだ直後に欠けている入れ物を補う
export function normalize(s) {
  s.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...(s.settings || {}) });
  s.order = s.order || [];
  s.players = s.players || {};
  s.offers = s.offers || {};
  s.log = s.log || [];
  s.stocks = s.stocks || {};
  s.funds = s.funds || {};
  s.round = s.round || 0;
  for (const st of STOCKS) {
    const x = (s.stocks[st.id] = s.stocks[st.id] || { price: st.start, prev: st.start });
    x.history = x.history || [x.price];
  }
  for (const f of FUNDS) {
    const x = (s.funds[f.id] = s.funds[f.id] || { price: f.start, prev: f.start });
    x.history = x.history || [x.price];
  }
  for (const p of Object.values(s.players)) {
    p.long = p.long || {};
    p.short = p.short || {};
    p.avg = p.avg || {};
    p.shortAvg = p.shortAvg || {};
    p.history = p.history || [];
    p.stats = { ...DEFAULT_STATS, ...(p.stats || {}) };
    p.dca = p.dca || null;
    p.done = !!p.done;
    p.cash = p.cash || 0;
    p.debt = p.debt || 0;
  }
  if (s.lastRoll) s.lastRoll.effects = s.lastRoll.effects || [];
  if (s.npc) {
    s.npc.long = s.npc.long || {};
    s.npc.history = s.npc.history || [];
  }
  return s;
}

function sanitizeSettings(st) {
  const out = { ...st };
  out.rounds = RULES.ROUND_OPTIONS.includes(Number(st.rounds)) ? Number(st.rounds) : 15;
  out.timer = RULES.TIMER_OPTIONS.includes(Number(st.timer)) ? Number(st.timer) : 0;
  out.npc = st.npc !== false;
  out.stakeLoser = String(st.stakeLoser || '').slice(0, 40);
  out.stakeWinner = String(st.stakeWinner || '').slice(0, 40);
  return out;
}

export const players = s => s.order.map(id => s.players[id]).filter(Boolean);

function log(s, text) {
  s.log.push({ r: s.round, t: text });
  if (s.log.length > RULES.LOG_MAX) s.log.splice(0, s.log.length - RULES.LOG_MAX);
}

// ---------- ロビー ----------

export function addPlayer(s, { id, name, charId }, now = Date.now()) {
  if (s.players[id]) return ok();
  if (s.phase !== 'lobby') return err('もうゲームが始まってる部屋よ');
  if (Object.keys(s.players).length >= RULES.MAX_PLAYERS) return err('この部屋はもう満員（4人）');
  name = String(name || '').trim().slice(0, 10);
  if (!name) return err('名前を入れて');
  if (Object.values(s.players).some(p => p.name === name)) return err('同じ名前の人がもういる');
  const ch = charMap[charId];
  if (!ch) return err('キャラを選んで');
  if (Object.values(s.players).some(p => p.charId === charId)) return err('そのキャラはもう選ばれてる');
  s.players[id] = {
    id, name, charId,
    cash: RULES.START_CASH + (ch.skill === 'rich_start' ? RULES.RICH_START : 0),
    debt: 0, long: {}, short: {}, avg: {}, shortAvg: {}, history: [],
    stats: { ...DEFAULT_STATS }, done: false, dca: null, joinedAt: now,
  };
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
  // 順番をシャッフル（Fisher–Yates）
  for (let i = s.order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [s.order[i], s.order[j]] = [s.order[j], s.order[i]];
  }
  s.round = 0;
  s.dealer = s.order[0];
  s.phase = 'roll';
  s.robber = null;
  s.lastRoll = null;
  s.offers = {};
  s.log = [];
  for (const p of players(s)) {
    const nw = netWorth(s, p);
    p.history = [nw];
    p.stats.peak = nw;
  }
  if (s.settings.npc) {
    s.npc = { cash: RULES.START_CASH, long: {}, history: [RULES.START_CASH], perRound: R(RULES.START_CASH / s.settings.rounds) };
  } else {
    s.npc = null;
  }
  s.startedAt = now;
  log(s, `🏁 ゲーム開始！ 順番：${players(s).map(p => p.name).join(' → ')}`);
  return ok();
}

// ---------- 評価 ----------

export function priceOf(s, id) {
  const x = s.stocks[id] || s.funds[id];
  return x ? x.price : 0;
}
export function longValue(s, p) {
  let v = 0;
  for (const [id, q] of Object.entries(p.long || {})) v += q * priceOf(s, id);
  return v;
}
export function shortLiab(s, p) {
  let v = 0;
  for (const [id, q] of Object.entries(p.short || {})) v += q * priceOf(s, id);
  return v;
}
export function netWorth(s, p) {
  return p.cash + longValue(s, p) - shortLiab(s, p) - p.debt;
}
export function maintRatio(s, p) {
  const pos = longValue(s, p) + shortLiab(s, p);
  return pos > 0 ? netWorth(s, p) / pos : Infinity;
}
export function borrowLimit(s, p) {
  return Math.max(0, R(RULES.BORROW_MULT * netWorth(s, p) - p.debt));
}
export function shortLimit(s, p) {
  return Math.max(0, R(RULES.SHORT_MULT * netWorth(s, p) - shortLiab(s, p)));
}
export function feeRate(p, id) {
  if (!isStock(id)) return 0;
  return charMap[p.charId]?.skill === 'no_fee' ? 0 : RULES.FEE;
}
export function npcValue(s) {
  if (!s.npc) return 0;
  return R(s.npc.cash + (s.npc.long.index || 0) * s.funds.index.price);
}

// 支払い。現金が足りなければ自動で借金になる（配当の支払いや貸株料など、逃げられない支払い用）
function payCash(p, amount) {
  p.cash -= amount;
  if (p.cash < 0) {
    p.debt += -p.cash;
    p.cash = 0;
  }
}

function addLong(p, id, qty, price) {
  const q0 = p.long[id] || 0;
  p.avg[id] = q0 > 0 ? (q0 * (p.avg[id] || price) + qty * price) / (q0 + qty) : price;
  p.long[id] = q0 + qty;
}
function removeLong(p, id, qty, price) {
  const q0 = p.long[id] || 0;
  p.stats.realized += R((price - (p.avg[id] || price)) * qty);
  if (q0 - qty <= 0) { delete p.long[id]; delete p.avg[id]; }
  else p.long[id] = q0 - qty;
}
function addShort(p, id, qty, price) {
  const q0 = p.short[id] || 0;
  p.shortAvg[id] = q0 > 0 ? (q0 * (p.shortAvg[id] || price) + qty * price) / (q0 + qty) : price;
  p.short[id] = q0 + qty;
}
function removeShort(p, id, qty, price) {
  const q0 = p.short[id] || 0;
  p.stats.realizedShort += R(((p.shortAvg[id] || price) - price) * qty);
  if (q0 - qty <= 0) { delete p.short[id]; delete p.shortAvg[id]; }
  else p.short[id] = q0 - qty;
}

// ---------- サイコロと相場 ----------

export function rollDice(s, pid, rng = Math.random, now = Date.now()) {
  if (s.phase !== 'roll') return err('今はサイコロを振る時間じゃない');
  if (s.dealer !== pid) return err('サイコロを振れるのは親だけ');
  const d1 = die(rng), d2 = die(rng), ev = die(rng);
  const sum = d1 + d2;
  const evType = ev === 1 ? 'boom' : ev === 2 ? 'crash' : ev === 3 ? 'calm' : 'none';
  s.round += 1;
  const roll = { round: s.round, d1, d2, ev, sum, evType, evScope: null, evTarget: null, hit: null, blocked: false, effects: [], dealer: pid, robberTarget: null, alpha: 0 };
  const eff = roll.effects;
  for (const id of STOCK_IDS) s.stocks[id].prev = s.stocks[id].price;
  for (const id of FUND_IDS) s.funds[id].prev = s.funds[id].price;

  if (evType === 'calm') {
    eff.push({ kind: 'calm', text: '🌊 凪（なぎ）！風が止まって、今回はどの株も動かない。利息と信託報酬だけはしっかり取られるわ。' });
  } else {
    if (sum === 7) {
      eff.push({ kind: 'robber', text: '🏴‍☠️ 7が出た！盗賊があらわれた。親が盗賊を置く会社を決める。' });
      for (const p of players(s)) {
        const ch = charMap[p.charId];
        if (ch.skill === 'robber_friend') {
          p.cash += RULES.ROBBER_GIFT;
          eff.push({ kind: 'skill', text: `🦉 ${p.name}は盗賊の友。おすそ分け ${fmt(RULES.ROBBER_GIFT)}G をもらった` });
        } else if (p.cash > RULES.CASH_TAX_OVER) {
          const tax = R((p.cash - RULES.CASH_TAX_OVER) * RULES.CASH_TAX);
          p.cash -= tax;
          p.stats.robberTax += tax;
          eff.push({ kind: 'tax', text: `💰 ${p.name}のタンス預金から ${fmt(tax)}G 盗まれた（現金を5万Gより多く持ってると狙われる）` });
        }
      }
    } else {
      const st = STOCKS.find(x => x.numbers.includes(sum));
      roll.hit = st.id;
      if (s.robber === st.id) {
        roll.blocked = true;
        eff.push({ kind: 'blocked', text: `🚫 ${sum}！ ${st.emoji}${st.name} の番だけど、盗賊が居座っていて上がらない…` });
      } else {
        const price = s.stocks[st.id].price;
        s.stocks[st.id].price = clampPrice(price * (1 + st.hitUp));
        eff.push({ kind: 'hit', text: `🎯 ${sum}！ ${st.emoji}${st.name} が +${R(st.hitUp * 100)}%（${fmt(price)}G → ${fmt(s.stocks[st.id].price)}G）` });
        if (st.div > 0) payDividends(s, st, price, eff);
      }
    }
    // 当たらなかった株は小さくランダムに動く
    for (const st of STOCKS) {
      if (st.id === roll.hit && !roll.blocked) continue;
      const r = (rng() * 2 - 1) * st.drift + (st.driftBias || 0);
      s.stocks[st.id].price = clampPrice(s.stocks[st.id].price * (1 + r));
    }
    if (evType === 'boom') applyEvent(s, roll, rng, +1);
    if (evType === 'crash') applyEvent(s, roll, rng, -1);
  }
  s.lastRoll = roll;
  if (sum === 7 && evType !== 'calm') {
    s.phase = 'robber';
  } else {
    settle(s, rng, now);
  }
  return ok();
}

function payDividends(s, st, price, eff) {
  for (const p of players(s)) {
    const q = p.long[st.id] || 0;
    const sq = p.short[st.id] || 0;
    if (q > 0) {
      const x2 = charMap[p.charId].skill === 'dividend_x2';
      const d = R(price * st.div * q) * (x2 ? 2 : 1);
      p.cash += d;
      p.stats.dividends += d;
      eff.push({ kind: 'div', text: `💎 ${p.name} に配当 ${fmt(d)}G${x2 ? '（ルミの特技で2倍）' : ''}` });
    }
    if (sq > 0) {
      const d = R(price * st.div * sq);
      payCash(p, d);
      eff.push({ kind: 'div', text: `💸 ${p.name} は空売り中なので配当 ${fmt(d)}G を払った` });
    }
  }
}

// 大暴騰(sign=+1) / 大暴落(sign=-1)
function applyEvent(s, roll, rng, sign) {
  const eff = roll.effects;
  const all = rng() < 0.5;
  const targets = all ? STOCK_IDS : [pick(rng, STOCK_IDS)];
  const rate = sign > 0 ? (all ? RULES.BOOM_ALL : RULES.BOOM_ONE) : (all ? RULES.CRASH_ALL : RULES.CRASH_ONE);
  roll.evScope = all ? 'all' : 'one';
  roll.evTarget = all ? null : targets[0];
  const before = {};
  for (const id of targets) before[id] = s.stocks[id].price;
  for (const id of targets) s.stocks[id].price = clampPrice(before[id] * (1 + sign * rate));
  if (sign > 0) {
    eff.push({ kind: 'boom', text: all ? `📈 大暴騰！！ 町じゅうの株が +${R(rate * 100)}%` : `📈 大暴騰！！ ${stockMap[targets[0]].emoji}${stockMap[targets[0]].name} に大ニュース、+${R(rate * 100)}%` });
  } else {
    eff.push({ kind: 'crash', text: all ? `📉 大暴落！！ 町じゅうの株が −${R(rate * 100)}%` : `📉 大暴落！！ ${stockMap[targets[0]].emoji}${stockMap[targets[0]].name} に悪いうわさ、−${R(rate * 100)}%` });
  }
  for (const p of players(s)) {
    const skill = charMap[p.charId].skill;
    if (sign > 0 && skill === 'boom_boost') {
      let gain = 0;
      for (const id of targets) gain += (p.long[id] || 0) * before[id] * rate;
      const bonus = R(gain / 2);
      if (bonus > 0) { p.cash += bonus; eff.push({ kind: 'skill', text: `🧙‍♀️ ${p.name} の追い風！ボーナス ${fmt(bonus)}G` }); }
    }
    if (sign < 0 && skill === 'crash_shield') {
      let loss = 0;
      for (const id of targets) loss += (p.long[id] || 0) * before[id] * rate;
      const comp = R(loss / 2);
      if (comp > 0) { p.cash += comp; eff.push({ kind: 'skill', text: `🧸 ${p.name} の暴落の盾！保険金 ${fmt(comp)}G` }); }
    }
  }
}

export function placeRobber(s, pid, stockId, rng = Math.random, now = Date.now()) {
  if (s.phase !== 'robber') return err('今は盗賊を置く時間じゃない');
  if (s.dealer !== pid) return err('盗賊を置けるのは親だけ');
  if (!isStock(stockId)) return err('盗賊は会社の株にしか置けない');
  if (s.robber === stockId) return err('盗賊は別の会社に動かさないといけない');
  const st = stockMap[stockId];
  s.robber = stockId;
  const before = s.stocks[stockId].price;
  s.stocks[stockId].price = clampPrice(before * (1 - RULES.ROBBER_DROP));
  s.lastRoll.robberTarget = stockId;
  s.lastRoll.effects.push({ kind: 'robber', text: `🏴‍☠️ ${s.players[pid].name} は盗賊を ${st.emoji}${st.name} に置いた。株価 −${R(RULES.ROBBER_DROP * 100)}%（${fmt(before)}G → ${fmt(s.stocks[stockId].price)}G）。次の7まで上がらない` });
  settle(s, rng, now);
  return ok();
}

// ラウンドの後始末：投信の基準価額、つみたて、おこづかい、利息、貸株料、追証、履歴
function settle(s, rng, now) {
  const roll = s.lastRoll;
  const eff = roll.effects;
  // 投信は5銘柄の平均リターン（配当込み）に連動
  let avgRet = 0;
  for (const id of STOCK_IDS) avgRet += s.stocks[id].price / s.stocks[id].prev - 1;
  avgRet /= STOCK_IDS.length;
  if (roll.hit && !roll.blocked) avgRet += stockMap[roll.hit].div / STOCK_IDS.length;
  for (const f of FUNDS) {
    const fs = s.funds[f.id];
    let r = avgRet;
    if (f.kind === 'active') {
      const alpha = (rng() * 2 - 1) * RULES.ACTIVE_ALPHA;
      roll.alpha = alpha;
      r += alpha;
    }
    fs.price = clampPrice(fs.price * (1 + r) * (1 - f.fee));
    if (f.kind === 'monthly') {
      const per = fs.price * f.payout;
      for (const p of players(s)) {
        const q = p.long[f.id] || 0;
        if (q > 0) {
          const d = R(per * q);
          p.cash += d;
          p.stats.payouts += d;
          eff.push({ kind: 'payout', text: `💸 ${p.name} に毎月分配ファンドから分配金 ${fmt(d)}G（そのぶん基準価額は下がる）` });
        }
      }
      fs.price = clampPrice(fs.price * (1 - f.payout));
    }
  }
  {
    const txt = roll.alpha ? `（魔法使いの腕：${roll.alpha > 0 ? '+' : ''}${(roll.alpha * 100).toFixed(1)}%）` : '';
    eff.push({ kind: 'fund', text: `🧺 町の平均 ${(avgRet * 100 >= 0 ? '+' : '')}${(avgRet * 100).toFixed(1)}% → 全部入り ${fmt(s.funds.index.price)}G / おまかせ ${fmt(s.funds.active.price)}G${txt} / 毎月分配 ${fmt(s.funds.monthly.price)}G` });
  }

  for (const p of players(s)) {
    const ch = charMap[p.charId];
    // つみたて（自動買付）
    if (p.dca && p.dca.amount > 0 && assetInfo(p.dca.assetId)) {
      const id = p.dca.assetId;
      const a = assetInfo(id);
      const price = priceOf(s, id);
      const fr = feeRate(p, id);
      const budget = Math.min(p.dca.amount, p.cash);
      const units = Math.floor(budget / (price * (1 + fr)));
      if (units > 0) {
        const notional = units * price;
        const fee = R(notional * fr);
        p.cash -= notional + fee;
        addLong(p, id, units, price);
        p.stats.fees += fee;
        p.stats.dcaTotal += notional;
        p.stats.trades += 1;
        eff.push({ kind: 'dca', text: `🔁 ${p.name} のつみたて：${a.emoji}${a.name} を ${units}口 買った（${fmt(notional)}G）` });
      } else {
        eff.push({ kind: 'dca', text: `🔁 ${p.name} のつみたて：現金が足りなくて今回は買えなかった` });
      }
    }
    if (ch.skill === 'allowance') {
      p.cash += RULES.ALLOWANCE;
      eff.push({ kind: 'skill', text: `🐿️ ${p.name} におこづかい ${fmt(RULES.ALLOWANCE)}G` });
    }
    if (p.debt > 0) {
      const rate = ch.skill === 'half_interest' ? RULES.INTEREST / 2 : RULES.INTEREST;
      const i = R(p.debt * rate);
      p.debt += i;
      p.stats.interest += i;
      eff.push({ kind: 'interest', text: `🏦 ${p.name} の借金に利息 ${fmt(i)}G（借金は ${fmt(p.debt)}G に）` });
    }
    const liab = shortLiab(s, p);
    if (liab > 0) {
      const f = R(liab * RULES.SHORT_FEE);
      payCash(p, f);
      p.stats.fees += f;
      eff.push({ kind: 'fee', text: `📜 ${p.name} の空売りに貸株料 ${fmt(f)}G` });
    }
    checkMargin(s, p, eff);
    const nw = netWorth(s, p);
    p.history[s.round] = nw;
    if (nw > p.stats.peak) p.stats.peak = nw;
    p.done = false;
  }
  if (s.npc) {
    const n = s.npc;
    const price = s.funds.index.price;
    const amt = Math.min(n.perRound, n.cash);
    const units = Math.floor(amt / price);
    if (units > 0) {
      n.cash -= units * price;
      n.long.index = (n.long.index || 0) + units;
    }
    n.history[s.round] = npcValue(s);
  }
  for (const id of STOCK_IDS) s.stocks[id].history[s.round] = s.stocks[id].price;
  for (const id of FUND_IDS) s.funds[id].history[s.round] = s.funds[id].price;
  s.offers = {};
  s.phase = 'trade';
  s.tradeStartedAt = now;
}

function liquidate(s, p, withFee) {
  for (const [id, q] of Object.entries({ ...p.long })) {
    const price = priceOf(s, id);
    const fee = withFee ? R(q * price * feeRate(p, id)) : 0;
    p.cash += q * price - fee;
    p.stats.fees += fee;
    removeLong(p, id, q, price);
  }
  for (const [id, q] of Object.entries({ ...p.short })) {
    const price = priceOf(s, id);
    const fee = withFee ? R(q * price * feeRate(p, id)) : 0;
    payCash(p, q * price + fee);
    p.stats.fees += fee;
    removeShort(p, id, q, price);
  }
  const repay = Math.min(p.cash, p.debt);
  p.cash -= repay;
  p.debt -= repay;
}

function bankrupt(s, p, eff) {
  liquidate(s, p, false);
  p.cash = RULES.BANKRUPT_CASH;
  p.debt = 0;
  p.long = {}; p.short = {}; p.avg = {}; p.shortAvg = {};
  p.dca = null;
  p.stats.bankrupt += 1;
  eff.push({ kind: 'bankrupt', text: `💀 ${p.name} は破産！ 全部なくなって、再起資金 ${fmt(RULES.BANKRUPT_CASH)}G からやり直し…` });
  log(s, `💀 ${p.name} が破産した`);
}

function checkMargin(s, p, eff) {
  const exposure = p.debt + shortLiab(s, p);
  if (exposure <= 0) return;
  const nw = netWorth(s, p);
  if (nw <= 0) { bankrupt(s, p, eff); return; }
  const pos = longValue(s, p) + shortLiab(s, p);
  if (pos > 0 && nw < RULES.MAINT * pos) {
    liquidate(s, p, true);
    p.stats.margin += 1;
    eff.push({ kind: 'margin', text: `⚠️ ${p.name} に追証（おいしょう）！ 維持率が25%を切ったので持ち株と空売りを全部強制決済。借金を返して残りは ${fmt(p.cash)}G` });
    log(s, `⚠️ ${p.name} が追証で強制決済された`);
    if (netWorth(s, p) <= 0) bankrupt(s, p, eff);
  }
}

// ---------- 取引 ----------

function tradeCtx(s, pid) {
  if (s.phase !== 'trade') return [null, err('今は取引の時間じゃない')];
  const p = s.players[pid];
  if (!p) return [null, err('プレイヤーが見つからない')];
  if (p.done) return [null, err('「おしまい」を押したあとは取引できない。「まだやる」で戻れるわ')];
  return [p, null];
}

export function buy(s, pid, id, qty) {
  const [p, e] = tradeCtx(s, pid); if (e) return e;
  const a = assetInfo(id); if (!a) return err('そんな商品はない');
  qty = toInt(qty, 1); if (!qty) return err('数を入れて');
  const price = priceOf(s, id);
  const fee = R(price * qty * feeRate(p, id));
  const cost = price * qty + fee;
  if (cost > p.cash) return err(`お金が足りない（${fmt(cost)}G 必要、現金 ${fmt(p.cash)}G）`);
  p.cash -= cost;
  addLong(p, id, qty, price);
  p.stats.trades += 1;
  p.stats.fees += fee;
  log(s, `🛒 ${p.name} が ${a.emoji}${a.name} を ${qty}${isFund(id) ? '口' : '株'} 買った（${fmt(price)}G）`);
  return ok();
}

export function sell(s, pid, id, qty) {
  const [p, e] = tradeCtx(s, pid); if (e) return e;
  const a = assetInfo(id); if (!a) return err('そんな商品はない');
  qty = toInt(qty, 1); if (!qty) return err('数を入れて');
  const have = p.long[id] || 0;
  if (qty > have) return err(`そんなに持ってない（持ってるのは ${have}）`);
  const price = priceOf(s, id);
  const fee = R(price * qty * feeRate(p, id));
  p.cash += price * qty - fee;
  removeLong(p, id, qty, price);
  p.stats.trades += 1;
  p.stats.fees += fee;
  log(s, `💰 ${p.name} が ${a.emoji}${a.name} を ${qty}${isFund(id) ? '口' : '株'} 売った（${fmt(price)}G）`);
  return ok();
}

export function shortSell(s, pid, id, qty) {
  const [p, e] = tradeCtx(s, pid); if (e) return e;
  if (!isStock(id)) return err('空売りできるのは会社の株だけ');
  qty = toInt(qty, 1); if (!qty) return err('数を入れて');
  if (p.long[id]) return err('持っている株は空売りできない。先に売って');
  const price = priceOf(s, id);
  const liab = price * qty;
  if (liab > shortLimit(s, p)) return err(`空売りの上限をこえてる（純資産と同じ額まで。あと ${fmt(shortLimit(s, p))}G）`);
  const fee = R(liab * feeRate(p, id));
  p.cash += liab - fee;
  addShort(p, id, qty, price);
  p.stats.trades += 1;
  p.stats.shorts += 1;
  p.stats.fees += fee;
  const st = stockMap[id];
  log(s, `🔻 ${p.name} が ${st.emoji}${st.name} を ${qty}株 空売りした（${fmt(price)}G）`);
  return ok();
}

export function cover(s, pid, id, qty) {
  const [p, e] = tradeCtx(s, pid); if (e) return e;
  qty = toInt(qty, 1); if (!qty) return err('数を入れて');
  const have = p.short[id] || 0;
  if (qty > have) return err(`そんなに空売りしてない（空売り中は ${have}）`);
  const price = priceOf(s, id);
  const fee = R(price * qty * feeRate(p, id));
  const cost = price * qty + fee;
  if (cost > p.cash) return err(`お金が足りない（${fmt(cost)}G 必要）。先に借りるか、何か売って`);
  p.cash -= cost;
  removeShort(p, id, qty, price);
  p.stats.trades += 1;
  p.stats.fees += fee;
  const st = stockMap[id];
  log(s, `🔺 ${p.name} が ${st.emoji}${st.name} を ${qty}株 買い戻した（${fmt(price)}G）`);
  return ok();
}

export function borrow(s, pid, amount) {
  const [p, e] = tradeCtx(s, pid); if (e) return e;
  amount = toInt(amount, 1); if (!amount) return err('金額を入れて');
  const limit = borrowLimit(s, p);
  if (amount > limit) return err(`借りられるのはあと ${fmt(limit)}G まで（純資産の2倍まで）`);
  p.cash += amount;
  p.debt += amount;
  if (p.debt > p.stats.borrowedMax) p.stats.borrowedMax = p.debt;
  log(s, `🏦 ${p.name} が銀行から ${fmt(amount)}G 借りた（借金 ${fmt(p.debt)}G）`);
  return ok();
}

export function repay(s, pid, amount) {
  const [p, e] = tradeCtx(s, pid); if (e) return e;
  amount = toInt(amount, 1); if (!amount) return err('金額を入れて');
  amount = Math.min(amount, p.debt, p.cash);
  if (amount <= 0) return err(p.debt <= 0 ? '借金はない' : '返すお金がない');
  p.cash -= amount;
  p.debt -= amount;
  log(s, `🏦 ${p.name} が ${fmt(amount)}G 返した（借金 ${fmt(p.debt)}G）`);
  return ok();
}

export function setDca(s, pid, assetId, amount) {
  const p = s.players[pid]; if (!p) return err('プレイヤーが見つからない');
  if (s.phase === 'end' || s.phase === 'lobby') return err('今は設定できない');
  if (!assetId) { p.dca = null; log(s, `🔁 ${p.name} がつみたてをやめた`); return ok(); }
  const a = assetInfo(assetId); if (!a) return err('そんな商品はない');
  amount = toInt(amount, 1); if (!amount) return err('金額を入れて');
  p.dca = { assetId, amount };
  log(s, `🔁 ${p.name} が ${a.emoji}${a.name} を毎ラウンド ${fmt(amount)}G つみたてることにした`);
  return ok();
}

// ---------- 相対取引（プレイヤー同士） ----------

function normSide(x) {
  x = x || {};
  const cash = toInt(x.cash || 0, 0);
  const qty = toInt(x.qty || 0, 0);
  const asset = x.asset && assetInfo(x.asset) ? x.asset : null;
  if (Number.isNaN(cash) || Number.isNaN(qty)) return null;
  return { cash, asset: qty > 0 ? asset : null, qty: asset ? qty : 0 };
}
function hasSide(p, side) {
  if (side.cash > p.cash) return false;
  if (side.asset && side.qty > (p.long[side.asset] || 0)) return false;
  return true;
}
function describeSide(side) {
  const parts = [];
  if (side.cash > 0) parts.push(`${fmt(side.cash)}G`);
  if (side.asset && side.qty > 0) { const a = assetInfo(side.asset); parts.push(`${a.emoji}${a.name} ${side.qty}${isFund(side.asset) ? '口' : '株'}`); }
  return parts.length ? parts.join(' + ') : 'なし';
}

export function proposeOffer(s, pid, o, now = Date.now()) {
  const [p, e] = tradeCtx(s, pid); if (e) return e;
  const to = s.players[o.to];
  if (!to || o.to === pid) return err('相手を選んで');
  const give = normSide(o.give), get = normSide(o.get);
  if (!give || !get) return err('数がおかしい');
  if (give.cash === 0 && give.qty === 0 && get.cash === 0 && get.qty === 0) return err('あげるものか、もらうものを入れて');
  if (!hasSide(p, give)) return err('あげるぶんを持ってない');
  const mine = Object.values(s.offers).filter(x => x.from === pid && x.status === 'open').length;
  if (mine >= RULES.MAX_OFFERS) return err('提案は同時に3つまで');
  const id = 'o' + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  s.offers[id] = { id, from: pid, to: o.to, give, get, status: 'open', at: now };
  log(s, `🤝 ${p.name} → ${to.name}：「${describeSide(give)} をあげるから ${describeSide(get)} ちょうだい」`);
  return ok();
}

export function acceptOffer(s, pid, offerId) {
  if (s.phase !== 'trade') return err('今は取引の時間じゃない');
  const o = s.offers[offerId];
  if (!o || o.status !== 'open') return err('その提案はもう終わってる');
  if (o.to !== pid) return err('あなた宛ての提案じゃない');
  const from = s.players[o.from], to = s.players[o.to];
  if (!from || !to) return err('相手がいない');
  if (!hasSide(from, o.give)) { o.status = 'failed'; return err('相手がもう持ってないので取引できなかった'); }
  if (!hasSide(to, o.get)) return err('あなたが渡すぶんを持ってない');
  // 移動（手数料なし。株の取得単価は今の値段で記録）
  from.cash -= o.give.cash; to.cash += o.give.cash;
  to.cash -= o.get.cash; from.cash += o.get.cash;
  if (o.give.asset) { const pr = priceOf(s, o.give.asset); removeLong(from, o.give.asset, o.give.qty, pr); addLong(to, o.give.asset, o.give.qty, pr); }
  if (o.get.asset) { const pr = priceOf(s, o.get.asset); removeLong(to, o.get.asset, o.get.qty, pr); addLong(from, o.get.asset, o.get.qty, pr); }
  o.status = 'accepted';
  from.stats.offers += 1; to.stats.offers += 1;
  from.stats.trades += 1; to.stats.trades += 1;
  log(s, `✅ ${to.name} が ${from.name} の提案を受けた！`);
  return ok();
}

export function declineOffer(s, pid, offerId) {
  const o = s.offers[offerId];
  if (!o || o.status !== 'open') return err('その提案はもう終わってる');
  if (o.to !== pid) return err('あなた宛ての提案じゃない');
  o.status = 'declined';
  log(s, `❌ ${s.players[pid]?.name} が ${s.players[o.from]?.name} の提案をことわった`);
  return ok();
}

export function cancelOffer(s, pid, offerId) {
  const o = s.offers[offerId];
  if (!o || o.status !== 'open') return err('その提案はもう終わってる');
  if (o.from !== pid) return err('自分の提案だけ取り消せる');
  o.status = 'cancelled';
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
  s.offers = {};
}

export function finish(s, now = Date.now()) {
  for (const p of players(s)) {
    // 空売りは全部買い戻し、借金は返せるだけ返す（評価は純資産なので結果は変わらない）
    for (const [id, q] of Object.entries({ ...p.short })) {
      const price = priceOf(s, id);
      payCash(p, q * price);
      removeShort(p, id, q, price);
    }
    const repay = Math.min(p.cash, p.debt);
    p.cash -= repay; p.debt -= repay;
    p.final = netWorth(s, p);
    p.done = false;
  }
  s.phase = 'end';
  s.finishedAt = now;
  s.offers = {};
  const rk = ranking(s);
  s.results = rk.map(r => r.id);
  const t = titles(s);
  for (const r of rk) s.players[r.id].title = t[r.id].title;
  log(s, `🏆 ゲーム終了！ 優勝は ${s.players[rk[0].id].name}`);
}

export function ranking(s) {
  const arr = players(s).map(p => ({ id: p.id, nw: netWorth(s, p) }));
  arr.sort((a, b) => b.nw - a.nw);
  return arr.map((x, i) => ({ ...x, rank: i + 1 }));
}

export function titles(s) {
  const rk = ranking(s);
  const ps = rk.map(r => s.players[r.id]);
  const out = {};
  const assign = (p, title, why) => { if (p && !out[p.id]) out[p.id] = { title, why }; };
  const maxBy = fn => ps.reduce((b, p) => (fn(p) > fn(b) ? p : b), ps[0]);
  if (ps.length) assign(ps[0], 'ランタン通りの大富豪', '純資産1位');
  for (const p of ps) {
    if (p.stats.bankrupt > 0) assign(p, p === ps[0] ? '不死鳥' : 'レバレッジの犠牲者', `破産 ${p.stats.bankrupt} 回`);
  }
  let m;
  m = maxBy(p => p.stats.realizedShort); if (m && m.stats.realizedShort > 0) assign(m, '空売りの魔女', `空売りで ${fmt(m.stats.realizedShort)}G もうけた`);
  m = maxBy(p => p.stats.dcaTotal); if (m && m.stats.dcaTotal > 0) assign(m, 'つみたての達人', `つみたて合計 ${fmt(m.stats.dcaTotal)}G`);
  m = maxBy(p => p.stats.dividends + p.stats.payouts); if (m && m.stats.dividends + m.stats.payouts > 0) assign(m, '配当長者', `配当・分配金 ${fmt(m.stats.dividends + m.stats.payouts)}G`);
  m = maxBy(p => p.stats.interest); if (m && m.stats.interest > 0) assign(m, '銀行のお得意さま', `利息を ${fmt(m.stats.interest)}G 払った`);
  m = maxBy(p => p.stats.trades); if (m && m.stats.trades > 0) assign(m, '取引マシン', `取引 ${m.stats.trades} 回`);
  for (const p of ps) if (p.stats.borrowedMax === 0 && p.stats.shorts === 0) assign(p, '堅実な商人', '借金も空売りもしなかった');
  if (ps.length > 1) assign(ps[ps.length - 1], '次はきっと勝てる', '最下位');
  for (const p of ps) assign(p, '石畳の商人', '');
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
