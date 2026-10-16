// 画面と通信（シンプル版）。ルール計算は engine.js に任せ、ここでは
//   1. Firebase の部屋(rooms/{code})を購読して state を受け取る
//   2. state から HTML を組み立てて描く
//   3. ボタン操作を engine の関数に変換してトランザクションで送る
// だけをやる。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getDatabase, ref, get, set, onValue, runTransaction, query, orderByChild, limitToLast,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import * as E from './engine.js';
import { COMPANIES, CHARACTERS, EXTRAS, LESSON, QUIZ, TOWN_NAME, fmt, fmtG, pct } from './data.js';

window.__booted = true;

const $app = document.getElementById('app');
const LS_SESSION = 'catan-kabu-session';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let db = null;
let state = null;        // 部屋の最新状態（engine.normalize 済み）
let unsub = null;        // onValue の解除関数
let serverOffset = 0;
let saving = false;

const ui = {
  screen: 'title',       // title | setup | join | records | howto | lesson
  overlay: null,         // 部屋に入っているときに上にかぶせる画面: howto | records
  joinMode: 'create',
  code: '', pid: '', name: '', charId: '',
  tab: 'market',
  sheet: null, qty: 1, sheetAnim: false, modalAnim: false,
  seenRoll: 0,
  modal: null,
  toast: null,
  lesson: { step: 0, answers: {} },
  records: null, recordsLoading: false,
  expanded: {},
};

// ---------- 小道具 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() + serverOffset;
const uid = () => 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const charOf = p => E.charInfo(p.charId) || CHARACTERS[0];
const me = () => (state && state.players[ui.pid]) || null;
const isHost = () => state && state.hostId === ui.pid;
const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const clsChg = v => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const arrow = v => (v > 0 ? '▲' : v < 0 ? '▼' : '－');

function avatar(p, size = '') {
  const c = charOf(p);
  return `<span class="avatar ${size}" style="--c:${c.color}">${c.emoji}</span>`;
}
function toast(text, kind = 'info') {
  ui.toast = { text, kind };
  render();
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { ui.toast = null; render(); }, 3000);
}
function saveSession() {
  try { localStorage.setItem(LS_SESSION, JSON.stringify({ code: ui.code, pid: ui.pid, name: ui.name, charId: ui.charId })); } catch {}
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem(LS_SESSION); } catch {}
}

// ---------- Firebase ----------
const configured = () => firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('YOUR_') && firebaseConfig.databaseURL && !String(firebaseConfig.databaseURL).includes('YOUR_');
const roomRef = code => ref(db, 'rooms/' + code);

function detach() {
  if (unsub) unsub();
  unsub = null;
  state = null;
}

// 部屋を購読する。最初のデータが来たら resolve
function attach(code) {
  detach();
  ui.code = code;
  return new Promise(resolve => {
    let first = true;
    unsub = onValue(roomRef(code), snap => {
      const v = snap.val();
      if (!v) {
        state = null;
        if (first) { first = false; resolve(null); return; }
        toast('部屋がなくなったみたい');
        leaveLocal();
        return;
      }
      state = E.normalize(v);
      if (first) { first = false; resolve(state); }
      onState();
    }, e => {
      toast('読み込みエラー：' + e.message, 'warn');
      if (first) { first = false; resolve(null); }
    });
  });
}

// engine の関数をトランザクションで実行する
async function mutate(fn) {
  if (!db || !ui.code) return false;
  let error = null;
  try {
    const res = await runTransaction(roomRef(ui.code), cur => {
      error = null;
      const base = cur || (state ? JSON.parse(JSON.stringify(state)) : null);
      if (!base) return;
      const s = E.normalize(base);
      const r = fn(s);
      if (!r || !r.ok) { error = (r && r.error) || 'できなかった'; return; }
      return s;
    }, { applyLocally: false });
    if (error) { toast(error, 'warn'); return false; }
    if (!res.committed) { toast('部屋が見つからない', 'warn'); return false; }
    return true;
  } catch (e) {
    toast('通信エラー：' + e.message, 'warn');
    return false;
  }
}

async function createRoom() {
  const name = ui.name.trim();
  if (!name) return toast('名前を入れて', 'warn');
  if (!ui.charId) return toast('キャラを選んで', 'warn');
  let code = '';
  for (let tries = 0; tries < 5; tries++) {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    const snap = await get(roomRef(code)).catch(() => null);
    if (!snap || !snap.exists()) break;
  }
  const pid = uid();
  const s = E.newState(code, pid, {}, now());
  const r = E.addPlayer(s, { id: pid, name, charId: ui.charId }, now());
  if (!r.ok) return toast(r.error, 'warn');
  try {
    await set(roomRef(code), s);
  } catch (e) {
    return toast('部屋を作れなかった：' + e.message + '（Firebase のルール設定を確認）', 'warn');
  }
  ui.pid = pid;
  saveSession();
  await attach(code);
  ui.screen = 'title';
  render();
}

async function joinRoom() {
  const name = ui.name.trim();
  const code = ui.code.trim().toUpperCase();
  if (!name) return toast('名前を入れて', 'warn');
  if (!ui.charId) return toast('キャラを選んで', 'warn');
  if (!/^[A-Z0-9]{4}$/.test(code)) return toast('合言葉は4文字', 'warn');
  const s = await attach(code);
  if (!s) { detach(); ui.code = code; return toast('その合言葉の部屋はない', 'warn'); }
  ui.pid = uid();
  const okk = await mutate(st => E.addPlayer(st, { id: ui.pid, name, charId: ui.charId }, now()));
  if (!okk) { detach(); ui.code = code; ui.pid = ''; render(); return; }
  saveSession();
  render();
}

async function rejoin(sess) {
  ui.code = sess.code; ui.pid = sess.pid; ui.name = sess.name || ''; ui.charId = sess.charId || '';
  const s = await attach(sess.code);
  if (!s) { detach(); clearSession(); ui.screen = 'title'; ui.pid = ''; render(); return; }
  if (!s.players[ui.pid]) {
    if (s.phase === 'lobby' && ui.name && ui.charId) {
      const okk = await mutate(st => E.addPlayer(st, { id: ui.pid, name: ui.name, charId: ui.charId }, now()));
      if (okk) return;
    }
    detach(); clearSession(); ui.pid = ''; ui.screen = 'title'; render(); return;
  }
  if (s.lastRoll) ui.seenRoll = s.phase === 'robber' ? s.lastRoll.round - 1 : s.lastRoll.round;
  render();
}

function leaveLocal() {
  detach();
  clearSession();
  ui.pid = ''; ui.code = ''; ui.overlay = null; ui.modal = null; ui.sheet = null; ui.seenRoll = 0;
  ui.screen = 'title';
  render();
}

async function leaveRoom() {
  if (state && state.phase === 'lobby' && me()) {
    const pid = ui.pid;
    await mutate(s => E.removePlayer(s, pid));
  }
  leaveLocal();
}

async function saveHistory() {
  if (saving || !state || state.phase !== 'end' || state.saved || !isHost()) return;
  saving = true;
  const s = state;
  const hid = 'g' + String(s.finishedAt || now()) + '_' + s.code;
  const rk = E.ranking(s);
  const rec = {
    id: hid, code: s.code, finishedAt: s.finishedAt || now(), rounds: s.settings.rounds,
    stakeLoser: s.settings.stakeLoser || '', stakeWinner: s.settings.stakeWinner || '',
    players: rk.map(r => { const p = s.players[r.id]; return { name: p.name, charId: p.charId, nw: r.nw, rank: r.rank, title: p.title || '', trades: p.stats.trades }; }),
  };
  try {
    await set(ref(db, 'history/' + hid), rec);
    await mutate(st => { st.saved = true; st.historyId = hid; return { ok: true }; });
  } catch (e) {
    console.warn('history save failed', e);
  } finally {
    saving = false;
  }
}

async function loadRecords() {
  if (!db) return;
  ui.recordsLoading = true;
  render();
  try {
    const snap = await get(query(ref(db, 'history'), orderByChild('finishedAt'), limitToLast(60)));
    const v = snap.val() || {};
    ui.records = Object.values(v).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  } catch (e) {
    toast('成績を読めなかった：' + e.message, 'warn');
    ui.records = [];
  }
  ui.recordsLoading = false;
  render();
}

// 状態が更新されたとき
function onState() {
  const s = state;
  if (!s) return;
  if (ui.pid && !s.players[ui.pid] && s.phase === 'lobby' && ui.name && ui.charId && !onState._rejoining) {
    onState._rejoining = true;
    mutate(st => E.addPlayer(st, { id: ui.pid, name: ui.name, charId: ui.charId }, now())).finally(() => { onState._rejoining = false; });
  }
  if (s.lastRoll && s.phase !== 'lobby' && s.phase !== 'end' && s.lastRoll.round > ui.seenRoll && (!ui.modal || ui.modal.type === 'roll')) {
    ui.modalAnim = true;
    ui.modal = { type: 'roll' };
    ui.sheet = null;
  }
  if (s.phase === 'end') {
    ui.sheet = null;
    if (ui.modal && ui.modal.type === 'roll') ui.modal = null;
    if (!s.saved && isHost()) saveHistory();
  }
  if (s.phase === 'lobby' && ui.modal && ui.modal.type === 'roll') ui.modal = null;
  render();
}

// ---------- 画面 ----------
let rendering = false, renderQueued = false;
function render() {
  if (rendering) { renderQueued = true; return; }
  rendering = true;
  try { doRender(); } finally { rendering = false; }
  if (renderQueued) { renderQueued = false; render(); }
}
function doRender() {
  const ae = document.activeElement;
  const bind = ae && ae.dataset ? ae.dataset.bind : null;
  const selStart = ae && typeof ae.selectionStart === 'number' ? ae.selectionStart : null;
  let html;
  if (!configured()) html = setupScreen();
  else if (ui.overlay) html = overlayScreen();
  else if (state && me()) {
    if (state.phase === 'lobby') html = lobbyScreen();
    else if (state.phase === 'end') html = endScreen();
    else html = gameScreen();
  } else if (state && state.phase === 'lobby' && !me()) html = lobbyScreen();
  else html = screenByName();
  html += modalHtml() + toastHtml();
  $app.innerHTML = html;
  ui.sheetAnim = false;
  ui.modalAnim = false;
  if (bind) {
    const el = $app.querySelector(`[data-bind="${bind}"]`);
    if (el) { el.focus({ preventScroll: true }); if (selStart !== null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selStart); } catch {} } }
  }
}

function screenByName() {
  switch (ui.screen) {
    case 'join': return joinScreen();
    case 'records': return recordsScreen(true);
    case 'howto': return howtoScreen(true);
    case 'lesson': return lessonScreen();
    default: return titleScreen();
  }
}
function overlayScreen() {
  switch (ui.overlay) {
    case 'howto': return howtoScreen(false);
    case 'records': return recordsScreen(false);
    default: ui.overlay = null; return '';
  }
}
function topbar(title, backAct = 'back', right = '') {
  return `<header class="top"><button class="iconbtn" data-act="${backAct}" aria-label="戻る">‹</button><h2>${title}</h2><div class="top-right">${right}</div></header>`;
}

function setupScreen() {
  return `<div class="screen center">
    <div class="hero small"><div class="lantern">🏮</div><h1>カタン株</h1></div>
    <div class="card">
      <h3>まだ Firebase の設定がされていないわ</h3>
      <p>README.md の手順で Firebase プロジェクトを作って、<code>js/firebase-config.js</code> に設定を貼り付けてね。</p>
    </div></div>`;
}

function titleScreen() {
  return `<div class="screen title-screen">
    <div class="hero">
      <div class="arch"><div class="lantern big">🏮</div></div>
      <h1>カタン株</h1>
      <p class="tagline">〜 ${esc(TOWN_NAME)}の大富豪 〜</p>
    </div>
    <div class="stack">
      <button class="btn primary big" data-act="goJoin" data-mode="create">🏠 部屋を作る</button>
      <button class="btn big" data-act="goJoin" data-mode="join">🔑 合言葉で入る</button>
      <div class="row2">
        <button class="btn ghost" data-act="goHowto">📖 あそびかた</button>
        <button class="btn ghost" data-act="goRecords">📊 成績</button>
      </div>
    </div>
    <p class="foot">2〜4人・1ゲーム 20〜30分</p>
    <button class="btn ghost tiny" data-act="goLesson">🎒 おまけ：こどもNISAのはなし</button>
  </div>`;
}

function charGrid() {
  return `<div class="chargrid">${CHARACTERS.map(c => `
    <button class="charcard ${ui.charId === c.id ? 'sel' : ''}" data-act="pickChar" data-id="${c.id}" style="--c:${c.color}">
      <span class="avatar lg" style="--c:${c.color}">${c.emoji}</span>
      <b>${esc(c.name)}</b><small>${esc(c.title)}</small>
    </button>`).join('')}</div>`;
}

function joinScreen() {
  const create = ui.joinMode === 'create';
  return `<div class="screen">
    ${topbar(create ? '部屋を作る' : '合言葉で入る', 'goTitle')}
    <main>
      ${create ? '' : `<label class="field"><span>合言葉（4文字）</span><input data-bind="code" class="code-input" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="ABCD" value="${esc(ui.code)}"></label>`}
      <label class="field"><span>名前</span><input data-bind="name" maxlength="10" autocomplete="off" placeholder="なまえ" value="${esc(ui.name)}"></label>
      <div class="field"><span>キャラ</span>${charGrid()}</div>
      <button class="btn primary big" data-act="${create ? 'create' : 'join'}">${create ? '部屋を作る' : '入る'}</button>
    </main></div>`;
}

function lobbyScreen() {
  const s = state;
  const ps = E.players(s);
  const host = isHost();
  const st = s.settings;
  const url = location.origin + location.pathname + '?code=' + s.code;
  return `<div class="screen">
    ${topbar('ロビー', 'leaveConfirm')}
    <main>
      <div class="card codecard">
        <small>合言葉</small>
        <div class="code">${esc(s.code)}</div>
        <p>みんなは「合言葉で入る」でこの4文字を入れてね</p>
        <div class="row2"><button class="btn sm" data-act="share" data-url="${esc(url)}">🔗 リンクを送る</button><button class="btn sm" data-act="copy" data-text="${esc(url)}">📋 コピー</button></div>
      </div>
      <div class="card">
        <h3>メンバー（${ps.length}/4）</h3>
        <ul class="plist">${ps.map(p => `<li>${avatar(p)}<div><b>${esc(p.name)}</b>${p.id === s.hostId ? ' 👑' : ''}${p.id === ui.pid ? ' <small>(あなた)</small>' : ''}<br><small>${esc(charOf(p).title)}</small></div></li>`).join('')}</ul>
      </div>
      <div class="card">
        <h3>設定 ${host ? '' : '<small>（部屋を作った人が決める）</small>'}</h3>
        <label class="setrow"><span>ラウンド数</span><select data-act="setting" data-key="rounds" ${host ? '' : 'disabled'}>${E.RULES.ROUND_OPTIONS.map(o => `<option value="${o}" ${o === st.rounds ? 'selected' : ''}>${o}ラウンド</option>`).join('')}</select></label>
        <p class="hint">1ラウンド 2分くらい。${st.rounds}ラウンドなら約${st.rounds * 2}分。</p>
        <label class="setrow col"><span>😈 負けた人のおねがい</span><input data-act="setting" data-key="stakeLoser" maxlength="40" placeholder="例：皿洗い1週間" value="${esc(st.stakeLoser)}" ${host ? '' : 'disabled'}></label>
        <label class="setrow col"><span>👑 勝った人のごほうび</span><input data-act="setting" data-key="stakeWinner" maxlength="40" placeholder="例：夕ごはんを決める" value="${esc(st.stakeWinner)}" ${host ? '' : 'disabled'}></label>
      </div>
      ${host ? `<button class="btn primary big" data-act="start">🎲 ゲームスタート</button>` : `<p class="waiting">👑 ${esc(s.players[s.hostId]?.name || '')} がスタートするのを待ってる…</p>`}
      <button class="btn ghost" data-act="goHowto">📖 あそびかた</button>
    </main></div>`;
}

// ---- ゲーム画面 ----
function scoreboard(s) {
  const rk = E.ranking(s);
  const deltas = {};
  if (s.lastRoll) for (const r of s.lastRoll.ranks) deltas[r.id] = r.delta;
  return `<div class="score">${rk.map(r => {
    const p = s.players[r.id];
    const d = deltas[r.id] || 0;
    return `<div class="srow ${r.id === ui.pid ? 'me' : ''}"><span class="srank">${r.rank}</span>${avatar(p, 'sm')}<span class="sname">${esc(p.name)}${r.id === s.dealer && s.phase !== 'trade' ? ' 🎲' : ''}${p.done && s.phase === 'trade' ? ' ✓' : ''}</span><span class="snw">${fmtG(r.nw)}</span><span class="sdelta ${clsChg(d)}">${d > 0 ? '▲' : d < 0 ? '▼' : ''}</span></div>`;
  }).join('')}</div>`;
}

function gameScreen() {
  const s = state;
  const p = me();
  const phaseLabel = s.phase === 'roll' ? '🎲 サイコロ' : s.phase === 'robber' ? '🏴‍☠️ 盗賊' : '🛒 売り買いタイム';
  const tabs = [['market', '市場'], ['chart', 'グラフ'], ['news', 'ニュース']];
  let body;
  switch (ui.tab) {
    case 'chart': body = `<div class="card">${chartSVG(s)}</div>`; break;
    case 'news': body = newsTab(s); break;
    default: body = marketTab(s, p);
  }
  return `<div class="screen game">
    <header class="gamebar">
      <div class="round">R<b>${s.round}</b>/${s.settings.rounds}</div>
      <div class="phase">${phaseLabel}</div>
      <div class="mine">💰 ${fmtG(p.cash)}</div>
      <button class="iconbtn" data-act="menu" aria-label="メニュー">☰</button>
    </header>
    ${scoreboard(s)}
    ${phaseStrip(s, p)}
    <nav class="tabs three">${tabs.map(([k, l]) => `<button class="${ui.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</nav>
    <main class="tabbody">${body}</main>
    ${ui.sheet ? sheetHtml(s, p) : ''}
  </div>`;
}

function phaseStrip(s, p) {
  const dealer = s.players[s.dealer];
  const dn = dealer ? esc(dealer.name) : '';
  if (s.phase === 'roll') {
    if (s.dealer === ui.pid) return `<div class="strip roll"><button class="btn primary big" data-act="roll">🎲 サイコロを振る</button></div>`;
    return `<div class="strip wait">🎲 ${dn} がサイコロを振るのを待ってる…</div>`;
  }
  if (s.phase === 'robber') {
    if (s.dealer === ui.pid) return `<div class="strip robber"><div>🏴‍☠️ 盗賊をどの会社に送る？（−25%）</div><div class="choices">${COMPANIES.map(c => `<button class="btn sm" data-act="robber" data-id="${c.id}">${c.emoji}${esc(c.short)}</button>`).join('')}</div></div>`;
    return `<div class="strip wait">🏴‍☠️ ${dn} が盗賊の行き先を考え中…</div>`;
  }
  const ps = E.players(s);
  const btn = p.done
    ? `<button class="btn" data-act="undone">↩️ まだやる</button>`
    : `<button class="btn primary" data-act="done">✅ おしまい</button>`;
  const waiting = ps.filter(x => !x.done).length;
  const force = isHost() && waiting > 0 && p.done ? `<button class="btn ghost sm" data-act="forceNext">⏭ 待たずに進める</button>` : '';
  return `<div class="strip trade"><div class="stat">${p.done ? `あと ${waiting} 人を待ってる…` : '買う？売る？決まったら →'}</div>${btn}${force}</div>`;
}

function marketTab(s, p) {
  const rows = COMPANIES.map(c => {
    const x = s.prices[c.id];
    const chg = x.prev ? x.price / x.prev - 1 : 0;
    const q = p.shares[c.id] || 0;
    const news = s.lastRoll && s.lastRoll.co === c.id;
    return `<button class="card co ${news ? 'news' : ''}" data-act="sheet" data-id="${c.id}" style="--c:${c.color}">
      <span class="emoji">${c.emoji}</span>
      <div class="co-name"><b>${esc(c.short)}${s.robber === c.id ? ' 🏴‍☠️' : ''}</b><small>${esc(c.mood)}</small></div>
      <div class="price"><b>${fmt(x.price)}G</b><small class="${clsChg(chg)}">${arrow(chg)} ${pct(chg)}</small></div>
      <div class="have">${q ? `<b>${q}</b>株<small>${fmtG(q * x.price)}</small>` : '<small>なし</small>'}</div>
    </button>`;
  }).join('');
  return `<section>${rows}</section><p class="hint">会社をタップすると買ったり売ったりできる</p>`;
}

function sheetHtml(s, p) {
  const id = ui.sheet;
  const c = E.coInfo(id);
  if (!c) { ui.sheet = null; return ''; }
  const x = s.prices[id];
  const price = x.price;
  const q = p.shares[id] || 0;
  const qty = Math.max(1, Math.floor(Number(ui.qty) || 1));
  const canTrade = s.phase === 'trade' && !p.done;
  const maxBuy = Math.floor(p.cash / price);
  const chg = x.prev ? price / x.prev - 1 : 0;
  return `<div class="sheet-bg" data-act="closeSheet"></div><div class="sheet ${ui.sheetAnim ? 'anim' : ''}" style="--c:${c.color}">
    <div class="sheet-head"><span class="emoji">${c.emoji}</span><div><b>${esc(c.name)}</b><small>${esc(c.mood)}・出目 ${c.numbers.join('・')}</small></div><div class="price"><b>${fmt(price)}G</b><small class="${clsChg(chg)}">${arrow(chg)} ${pct(chg)}</small></div><button class="iconbtn" data-act="closeSheet">✕</button></div>
    <div class="mypos"><span>持ってる：<b>${q}株</b>（${fmtG(q * price)}）</span><span>さいふ：<b>${fmtG(p.cash)}</b></span></div>
    <div class="qty">
      <button class="btn sm" data-act="qty" data-d="-5">−5</button><button class="btn sm" data-act="qty" data-d="-1">−1</button>
      <input type="number" inputmode="numeric" min="1" data-bind="qty" data-rerender="1" value="${qty}">
      <button class="btn sm" data-act="qty" data-d="1">+1</button><button class="btn sm" data-act="qty" data-d="5">+5</button>
    </div>
    <div class="actions">
      <div class="actrow"><button class="btn buy" data-act="buy" ${canTrade && qty <= maxBuy ? '' : 'disabled'}>買う <small>−${fmtG(price * qty)}</small></button><button class="btn ghost sm" data-act="qtyMax" data-n="${maxBuy}">全力 ${maxBuy}株</button></div>
      <div class="actrow"><button class="btn sell" data-act="sell" ${canTrade && q >= qty ? '' : 'disabled'}>売る <small>+${fmtG(price * qty)}</small></button><button class="btn ghost sm" data-act="qtyMax" data-n="${q}">全部 ${q}株</button></div>
    </div>
    ${!canTrade ? `<p class="hint">${s.phase !== 'trade' ? '売り買いタイムになったら買える' : '「まだやる」を押すと買える'}</p>` : ''}
  </div>`;
}

function newsTab(s) {
  const logs = [...s.log].reverse().map(l => `<li><small>R${l.r}</small> ${esc(l.t)}</li>`).join('');
  return `<div class="card"><ul class="loglist">${logs || '<li>まだ何もない</li>'}</ul></div>`;
}

function diceHtml(r) {
  return `<div class="dice"><span class="die">${DIE[r.d1]}</span><span class="die">${DIE[r.d2]}</span><span class="sum">= ${r.sum}</span></div>`;
}

function chartSVG(s, h = 230) {
  const W = 360, L = 44, Rr = 10, T = 12, B = 26;
  const series = E.players(s).map(p => ({ name: p.name, color: charOf(p).color, data: p.history, emoji: charOf(p).emoji }));
  const rounds = Math.max(1, s.settings.rounds);
  let min = Infinity, max = -Infinity;
  for (const se of series) for (const v of se.data) { if (v < min) min = v; if (v > max) max = v; }
  if (!isFinite(min)) { min = 0; max = E.RULES.START_CASH; }
  const START = E.RULES.START_CASH;
  min = Math.min(min, START * 0.9); max = Math.max(max, START * 1.1);
  const pad = (max - min) * 0.08 || 10;
  min -= pad; max += pad;
  const x = i => L + (W - L - Rr) * (i / rounds);
  const y = v => T + (h - T - B) * (1 - (v - min) / (max - min));
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4;
    g += `<line x1="${L}" x2="${W - Rr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 4}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${fmt(v)}</text>`;
  }
  g += `<line x1="${L}" x2="${W - Rr}" y1="${y(START).toFixed(1)}" y2="${y(START).toFixed(1)}" class="startline"/>`;
  const step = Math.max(1, Math.ceil(rounds / 6));
  for (let i = 0; i <= rounds; i += step) g += `<text x="${x(i).toFixed(1)}" y="${h - 8}" class="axis" text-anchor="middle">${i}</text>`;
  let lines = '';
  for (const se of series) {
    if (!se.data.length) continue;
    const pts = se.data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="${se.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = se.data.length - 1;
    lines += `<circle cx="${x(last).toFixed(1)}" cy="${y(se.data[last]).toFixed(1)}" r="4" fill="${se.color}"/>`;
  }
  const legend = series.map(se => `<span class="lg"><i style="background:${se.color}"></i>${se.emoji}${esc(se.name)} <b>${fmtG(se.data[se.data.length - 1] || 0)}</b></span>`).join('');
  return `<svg viewBox="0 0 ${W} ${h}" class="chart" role="img" aria-label="お金の推移">${g}${lines}</svg><div class="legend">${legend}</div>`;
}

// ---- 結果 ----
function endScreen() {
  const s = state;
  const rk = E.ranking(s);
  const start = E.RULES.START_CASH;
  const winner = s.players[rk[0].id], loser = s.players[rk[rk.length - 1].id];
  return `<div class="screen">
    <header class="top"><div></div><h2>🏆 結果発表</h2><button class="iconbtn" data-act="menu">☰</button></header>
    <main>
      <div class="card winner" style="--c:${charOf(winner).color}">
        <small>優勝</small>
        ${avatar(winner, 'xl')}
        <b>${esc(winner.name)}</b>
        <div class="big">${fmtG(rk[0].nw)}</div>
        <em>「${esc(winner.title || '')}」</em>
      </div>
      <div class="card">
        <ol class="result">${rk.map(r => { const p = s.players[r.id]; return `<li><span class="rank">${r.rank}</span>${avatar(p, 'sm')}<div><b>${esc(p.name)}</b><br><small>「${esc(p.title || '')}」</small></div><div class="price"><b>${fmtG(r.nw)}</b><small class="${clsChg(r.nw - start)}">${pct(r.nw / start - 1)}</small></div></li>`; }).join('')}</ol>
      </div>
      ${(s.settings.stakeLoser || s.settings.stakeWinner) ? `<div class="card stake">
        ${s.settings.stakeWinner ? `<div>👑 <b>${esc(winner.name)}</b> のごほうび：<b>${esc(s.settings.stakeWinner)}</b></div>` : ''}
        ${s.settings.stakeLoser && rk.length > 1 ? `<div>😈 <b>${esc(loser.name)}</b> のおねがい：<b>${esc(s.settings.stakeLoser)}</b></div>` : ''}
      </div>` : ''}
      <div class="card">${chartSVG(s)}</div>
      ${isHost() ? '<button class="btn primary big" data-act="again">🔁 もう一回</button>' : '<p class="waiting">もう一回やるなら、部屋を作った人が「もう一回」を押してね</p>'}
      <button class="btn ghost" data-act="leaveConfirm">🏠 タイトルへ</button>
    </main></div>`;
}

// ---- レッスン（おまけ） ----
function lessonScreen() {
  const L = ui.lesson;
  const total = LESSON.length + QUIZ.length + 1;
  const step = Math.min(L.step, total - 1);
  let body, canNext = true;
  if (step < LESSON.length) body = lessonSection(LESSON[step]);
  else if (step < LESSON.length + QUIZ.length) { const qi = step - LESSON.length; body = quizSection(qi); canNext = L.answers[qi] !== undefined; }
  else body = lessonSummary();
  return `<div class="screen lesson">
    ${topbar('🎒 こどもNISAのはなし', 'goTitle', `<small>${step + 1}/${total}</small>`)}
    <main>${body}</main>
    <footer class="lessonnav">
      <button class="btn" data-act="lessonPrev" ${step === 0 ? 'disabled' : ''}>← 前へ</button>
      ${step < total - 1 ? `<button class="btn primary" data-act="lessonNext" ${canNext ? '' : 'disabled'}>次へ →</button>` : `<button class="btn primary" data-act="goTitle">おわり</button>`}
    </footer></div>`;
}
function lessonSection(sec) {
  let inner = '';
  if (sec.body) inner += `<ul class="lessonlist">${sec.body.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;
  if (sec.checks) inner += `<ol class="checks">${sec.checks.map(([h, t]) => `<li><b>${esc(h)}</b><p>${esc(t)}</p></li>`).join('')}</ol>`;
  if (sec.motto) inner += `<div class="motto">${esc(sec.motto)}</div>`;
  return `<div class="card"><h3>${sec.emoji} ${esc(sec.title)}</h3>${inner}</div>`;
}
function quizSection(qi) {
  const q = QUIZ[qi];
  const a = ui.lesson.answers[qi];
  return `<div class="card quiz"><small>クイズ ${qi + 1}/${QUIZ.length}</small><h3>${esc(q.q)}</h3>
    <div class="stack">${q.options.map((o, i) => `<button class="btn opt ${a === undefined ? '' : i === q.answer ? 'right' : a === i ? 'wrong' : 'dim'}" data-act="quizPick" data-q="${qi}" data-i="${i}" ${a === undefined ? '' : 'disabled'}>${esc(o)}</button>`).join('')}</div>
    ${a !== undefined ? `<div class="why ${a === q.answer ? 'right' : 'wrong'}"><b>${a === q.answer ? '⭕ せいかい！' : '❌ ざんねん'}</b><p>${esc(q.why)}</p></div>` : ''}
  </div>`;
}
function lessonSummary() {
  const L = ui.lesson;
  const score = QUIZ.reduce((n, q, i) => n + (L.answers[i] === q.answer ? 1 : 0), 0);
  return `<div class="card center">
    <div class="lantern big">${score === QUIZ.length ? '🏅' : '🎒'}</div>
    <h3>クイズ ${score}/${QUIZ.length} 正解</h3>
    <div class="motto">安く・広く・長く</div>
    <p class="hint">※ 実際に口座を作るときは、おうちの人と一緒に金融庁や証券会社の最新情報を確認してね。</p>
  </div>`;
}

// ---- 成績 ----
function recordsScreen(standalone) {
  const back = standalone ? 'goTitle' : 'back';
  const recs = ui.records;
  let body;
  if (ui.recordsLoading || !recs) body = '<p class="waiting">読み込み中…</p>';
  else if (!recs.length) body = '<div class="card"><p>まだ記録がない。1ゲーム遊ぶとここに残るわ。</p></div>';
  else {
    const agg = {};
    for (const g of recs) for (const p of g.players || []) {
      const a = (agg[p.name] = agg[p.name] || { name: p.name, charId: p.charId, games: 0, wins: 0, rankSum: 0, best: -Infinity });
      a.games++; if (p.rank === 1) a.wins++; a.rankSum += p.rank; a.best = Math.max(a.best, p.nw); a.charId = p.charId;
    }
    const rows = Object.values(agg).sort((a, b) => b.wins - a.wins || a.rankSum / a.games - b.rankSum / b.games);
    body = `<div class="card"><h3>🏅 通算</h3><table class="rtable"><tr><th>名前</th><th>回</th><th>優勝</th><th>平均順位</th><th>最高</th></tr>
      ${rows.map(a => `<tr><td>${E.charInfo(a.charId)?.emoji || ''} ${esc(a.name)}</td><td>${a.games}</td><td>${a.wins}</td><td>${(a.rankSum / a.games).toFixed(1)}</td><td>${fmtG(a.best)}</td></tr>`).join('')}</table></div>
      ${recs.map(g => { const d = new Date(g.finishedAt || 0); const key = g.id || String(g.finishedAt); const open = ui.expanded[key]; return `<div class="card game">
        <button class="gamehead" data-act="toggle" data-key="${esc(key)}"><span>${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</span><b>🏆 ${esc(g.players?.[0]?.name || '')}</b><small>${g.rounds}R・${(g.players || []).length}人 ${open ? '▲' : '▼'}</small></button>
        ${open ? `<ol class="result small">${(g.players || []).map(p => `<li><span class="rank">${p.rank}</span><div><b>${E.charInfo(p.charId)?.emoji || ''} ${esc(p.name)}</b> <small>「${esc(p.title || '')}」</small></div><b>${fmtG(p.nw)}</b></li>`).join('')}</ol>
          ${g.stakeLoser ? `<p class="hint">😈 おねがい：${esc(g.stakeLoser)}</p>` : ''}` : ''}
      </div>`; }).join('')}`;
  }
  return `<div class="screen">${topbar('📊 成績', back, '<button class="iconbtn" data-act="recordsReload" aria-label="更新">⟳</button>')}<main>${body}</main></div>`;
}

// ---- あそびかた ----
function howtoScreen(standalone) {
  const back = standalone ? 'goTitle' : 'back';
  return `<div class="screen">${topbar('📖 あそびかた', back)}<main>
    <div class="card"><h3>🎯 ゴール</h3><p>最後のラウンドが終わったとき、<b>お金＋持ってる株の値段</b>が一番多い人の勝ち。みんな 1,000G からスタート。</p></div>
    <div class="card"><h3>🎲 1ラウンド</h3><ol class="steps">
      <li><b>親がサイコロを2つ振る。</b>合計の数字の会社に<b>ニュース</b>が起きて、株が上がったり下がったりする。</li>
      <li><b>7が出たら盗賊。</b>親が好きな会社に送りこむ。その株は −25%。</li>
      <li><b>ゾロ目は号外。</b>町じゅうの株がドーンと上がるか、ドーンと下がる。</li>
      <li><b>みんなで買ったり売ったりする。</b>全員が「おしまい」を押したら次のラウンド。</li></ol></div>
    <div class="card"><h3>🏢 5つの会社</h3>
      ${COMPANIES.map(c => `<p>${c.emoji} <b>${esc(c.short)}</b>（出目 ${c.numbers.join('・')}）：${esc(c.mood)}</p>`).join('')}
      <p class="hint">6・8 はよく出る。2・12 はめったに出ない。でも出たときは大きい。</p></div>
  </main></div>`;
}

// ---- モーダル・トースト ----
function modalHtml() {
  const m = ui.modal;
  if (!m) return '';
  const s = state;
  const anim = ui.modalAnim ? ' anim' : '';
  if (m.type === 'roll' && s && s.lastRoll) {
    const r = s.lastRoll;
    const dealer = s.players[r.dealer];
    const waiting = s.phase === 'robber';
    let newsHtml = '';
    if (r.co && r.card) {
      const c = E.coInfo(r.co);
      const x = s.prices[r.co];
      const p = r.card.p;
      newsHtml = `<div class="newscard" style="--c:${c.color}">
        <div class="nc-co">${c.emoji} ${esc(c.name)}のニュース</div>
        <div class="nc-head">${esc(r.card.t)}</div>
        ${p ? `<div class="nc-pct ${clsChg(p)}">${p > 0 ? '+' : ''}${p}%</div><div class="nc-price">${fmt(x.prev)}G → <b>${fmt(x.price)}G</b></div>` : ''}
        ${r.card.div ? `<div class="nc-pct up">1株につき ${r.card.div}G</div>` : ''}
        ${r.divs.length ? `<div class="nc-divs">${r.divs.map(d => `💎 ${esc(s.players[d.id]?.name)} に ${fmtG(d.amount)}`).join('<br>')}</div>` : ''}
      </div>`;
    } else if (r.sum === 7) {
      const t = r.robberTarget ? E.coInfo(r.robberTarget) : null;
      newsHtml = `<div class="newscard robber"><div class="nc-co">🏴‍☠️ 盗賊があらわれた！</div>${t ? `<div class="nc-head">${esc(dealer?.name)} が盗賊を ${t.emoji}${esc(t.short)} に送りこんだ</div><div class="nc-pct down">−25%</div><div class="nc-price">${fmt(s.prices[t.id].prev)}G → <b>${fmt(s.prices[t.id].price)}G</b></div>` : `<div class="nc-head">${esc(dealer?.name)} が行き先を決める</div>`}</div>`;
    }
    const others = COMPANIES.filter(c => c.id !== r.co && c.id !== r.robberTarget).map(c => `<span class="chip ${clsChg(r.moves[c.id] || 0)}">${c.emoji} ${arrow(r.moves[c.id] || 0)}${pct(r.moves[c.id] || 0)}</span>`).join('');
    const extra = r.extra ? `<div class="evbanner ${r.extra === 'boom' ? 'boom' : 'crash'}">${EXTRAS[r.extra].emoji} ${esc(EXTRAS[r.extra].t)}<b>${EXTRAS[r.extra].p > 0 ? '+' : ''}${EXTRAS[r.extra].p}%</b></div>` : '';
    const ranks = !waiting && r.ranks.length ? `<div class="ranks">${r.ranks.map(k => `<span class="${k.id === ui.pid ? 'me' : ''}">${k.rank}位 ${charOf(s.players[k.id]).emoji}${esc(s.players[k.id]?.name)} ${fmtG(k.nw)} <i class="${clsChg(k.delta)}">${k.delta > 0 ? '▲' : k.delta < 0 ? '▼' : ''}</i></span>`).join('')}</div>` : '';
    return `<div class="modal-bg"><div class="modal rollm${anim}">
      <small>ラウンド ${r.round}・親：${esc(dealer?.name || '')}</small>
      ${diceHtml(r)}
      ${newsHtml}
      <div class="chips">${others}</div>
      ${extra}
      ${ranks}
      ${waiting ? (s.dealer === ui.pid
        ? `<div class="choices">${COMPANIES.map(c => `<button class="btn sm" data-act="robber" data-id="${c.id}">${c.emoji}${esc(c.short)}</button>`).join('')}</div>`
        : `<p class="waiting">${esc(dealer?.name || '')} が考え中…</p>`)
        : `<button class="btn primary big" data-act="closeRoll">OK</button>`}
    </div></div>`;
  }
  if (m.type === 'confirm') {
    return `<div class="modal-bg"><div class="modal${anim}"><h3>${esc(m.title)}</h3><p>${esc(m.text)}</p><div class="row2"><button class="btn" data-act="closeModal">やめる</button><button class="btn warn" data-act="confirmYes">${esc(m.yes || 'はい')}</button></div></div></div>`;
  }
  if (m.type === 'menu') {
    return `<div class="modal-bg" data-act="closeModal"><div class="modal menu${anim}">
      <button class="btn" data-act="goHowto">📖 あそびかた</button>
      <button class="btn" data-act="goRecords">📊 成績</button>
      <button class="btn ghost" data-act="leaveConfirm">🚪 部屋を出る</button>
      <button class="btn ghost" data-act="closeModal">閉じる</button></div></div>`;
  }
  return '';
}
function toastHtml() {
  return ui.toast ? `<div class="toast ${ui.toast.kind}">${esc(ui.toast.text)}</div>` : '';
}

// ---------- 操作 ----------
const ACT = {
  goTitle() { ui.screen = 'title'; ui.overlay = null; ui.modal = null; render(); },
  goJoin(d) { ui.joinMode = d.mode; ui.screen = 'join'; if (d.mode === 'create') ui.code = ''; render(); },
  goHowto() { ui.modal = null; if (state && me()) ui.overlay = 'howto'; else ui.screen = 'howto'; render(); },
  goLesson() { ui.modal = null; ui.lesson = { step: 0, answers: {} }; ui.screen = 'lesson'; render(); },
  goRecords() { ui.modal = null; if (state && me()) ui.overlay = 'records'; else ui.screen = 'records'; loadRecords(); },
  recordsReload() { loadRecords(); },
  back() { ui.overlay = null; ui.modal = null; render(); },
  pickChar(d) { ui.charId = d.id; render(); },
  create() { createRoom(); },
  join() { joinRoom(); },
  async share(d) {
    const data = { title: 'カタン株', text: `カタン株であそぼう！合言葉は「${ui.code}」`, url: d.url };
    if (navigator.share) { try { await navigator.share(data); } catch {} } else ACT.copy({ text: d.url });
  },
  async copy(d) { try { await navigator.clipboard.writeText(d.text); toast('コピーした'); } catch { toast('コピーできなかった。合言葉を口で伝えて'); } },
  setting(d, el) {
    const key = d.key;
    let val = el.value;
    if (key === 'rounds') val = Number(val);
    mutate(s => E.updateSettings(s, ui.pid, { [key]: val }));
  },
  start() { mutate(s => E.startGame(s, ui.pid, Math.random, now())); },
  leaveConfirm() {
    const inGame = state && state.phase !== 'lobby' && state.phase !== 'end';
    ui.modalAnim = true;
    ui.modal = { type: 'confirm', title: '部屋を出る？', text: inGame ? 'ゲームの途中よ。出ても、同じスマホでこのページを開き直せば戻れる。' : 'タイトルに戻るわ。', yes: '出る', then: 'leave' };
    render();
  },
  confirmYes() {
    const m = ui.modal; ui.modal = null;
    if (m && m.then === 'leave') leaveRoom();
    else if (m && m.then === 'force') mutate(s => E.forceAdvance(s, ui.pid, now()));
    else render();
  },
  closeModal() { ui.modal = null; render(); },
  menu() { ui.modalAnim = true; ui.modal = { type: 'menu' }; render(); },
  tab(d) { ui.tab = d.tab; ui.sheet = null; render(); },
  roll() { mutate(s => E.rollDice(s, ui.pid, Math.random, now())); },
  robber(d) { mutate(s => E.placeRobber(s, ui.pid, d.id, now())); },
  closeRoll() { if (state && state.lastRoll) ui.seenRoll = state.lastRoll.round; ui.modal = null; render(); },
  sheet(d) { ui.sheet = d.id; ui.qty = 1; ui.sheetAnim = true; render(); },
  closeSheet() { ui.sheet = null; render(); },
  qty(d) { ui.qty = Math.max(1, (Math.floor(Number(ui.qty)) || 1) + Number(d.d)); render(); },
  qtyMax(d) { ui.qty = Math.max(1, Number(d.n) || 1); render(); },
  buy() { const id = ui.sheet, q = ui.qty; mutate(s => E.buy(s, ui.pid, id, q)); },
  sell() { const id = ui.sheet, q = ui.qty; mutate(s => E.sell(s, ui.pid, id, q)); },
  done() { mutate(s => E.setDone(s, ui.pid, true, now())); },
  undone() { mutate(s => E.setDone(s, ui.pid, false, now())); },
  forceNext() { ui.modalAnim = true; ui.modal = { type: 'confirm', title: '進める？', text: 'まだ「おしまい」を押していない人がいる。待たずに次のラウンドに進む？', yes: '進める', then: 'force' }; render(); },
  again() { mutate(s => E.resetToLobby(s, ui.pid)).then(okk => { if (okk) { ui.seenRoll = 0; ui.tab = 'market'; } }); },
  lessonNext() { ui.lesson.step++; render(); },
  lessonPrev() { ui.lesson.step = Math.max(0, ui.lesson.step - 1); render(); },
  quizPick(d) { ui.lesson.answers[Number(d.q)] = Number(d.i); render(); },
  toggle(d) { ui.expanded[d.key] = !ui.expanded[d.key]; render(); },
};

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.tagName === 'SELECT' || el.tagName === 'INPUT') return; // 設定の入力欄は change で送る
  if ((el.classList.contains('modal-bg') || el.classList.contains('sheet-bg')) && e.target !== el) return;
  const fn = ACT[el.dataset.act];
  if (fn) fn(el.dataset, el);
});
$app.addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset || !el.dataset.bind) return;
  let v = el.value;
  if (el.dataset.bind === 'code') v = String(v).toUpperCase();
  ui[el.dataset.bind] = v;
  if (el.dataset.rerender) render();
});
$app.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset && el.dataset.act === 'setting') ACT.setting(el.dataset, el);
});

// ---------- 起動 ----------
async function boot() {
  if (!configured()) { render(); return; }
  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    onValue(ref(db, '.info/serverTimeOffset'), snap => { serverOffset = snap.val() || 0; });
  } catch (e) {
    $app.innerHTML = `<div class="boot">Firebase の初期化に失敗：${esc(e.message)}<br><small>js/firebase-config.js の内容を確認して</small></div>`;
    return;
  }
  const params = new URLSearchParams(location.search);
  const codeParam = (params.get('code') || '').toUpperCase();
  const sess = loadSession();
  if (sess && sess.code && sess.pid && (!codeParam || codeParam === sess.code)) {
    await rejoin(sess);
    if (state) return;
  }
  if (codeParam) { ui.joinMode = 'join'; ui.code = codeParam; ui.screen = 'join'; }
  render();
}
boot();
