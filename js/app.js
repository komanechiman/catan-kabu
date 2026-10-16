// 画面と通信。ゲームのルール計算は engine.js に任せ、ここでは
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
import {
  STOCKS, FUNDS, CHARACTERS, GLOSSARY, LESSON, QUIZ, FINAL_CHOICE, DICE_WAYS, TOWN_NAME, fmt, fmtG, pct,
} from './data.js';

window.__booted = true;

const $app = document.getElementById('app');
const LS_SESSION = 'catan-kabu-session';
const LS_NOWARN = 'catan-kabu-nowarn';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let db = null;
let state = null;        // 部屋の最新状態（engine.normalize 済み）
let unsub = null;        // onValue の解除関数
let serverOffset = 0;    // サーバー時刻との差
let timerHandle = null;
let advancingRound = 0;  // タイマー切れで進めたラウンド（二重送信防止）
let saving = false;

const ui = {
  screen: 'title',       // title | setup | join | records | howto | lesson （部屋に入っていないとき）
  overlay: null,         // 部屋に入っているときに上にかぶせる画面: lesson | howto | glossary | records
  joinMode: 'create',
  code: '', pid: '', name: '', charId: '',
  tab: 'market',
  sheet: null, qty: 1,
  borrowAmt: 10000, repayAmt: 10000,
  dcaAsset: 'index', dcaAmount: 5000,
  offer: { to: '', giveCash: '', giveAsset: '', giveQty: '', getCash: '', getAsset: '', getQty: '' },
  seenRoll: 0,
  modal: null,
  toast: null,
  lesson: { step: 0, answers: {}, choice: null, saved: false },
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
const unitOf = id => (E.isFund(id) ? '口' : '株');
const term = w => `<button class="term" data-act="term" data-term="${esc(w)}">${esc(w)}</button>`;
const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const EV = { boom: ['📈', '大暴騰'], crash: ['📉', '大暴落'], calm: ['🌊', '凪'], none: ['⚪', 'なにもなし'] };
const evOf = ev => (ev === 1 ? 'boom' : ev === 2 ? 'crash' : ev === 3 ? 'calm' : 'none');
const man = v => (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
const clsChg = v => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

function avatar(p, size = '') {
  const c = charOf(p);
  return `<span class="avatar ${size}" style="--c:${c.color}" title="${esc(c.name)}">${c.emoji}</span>`;
}
function toast(text, kind = 'info') {
  ui.toast = { text, kind };
  render();
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { ui.toast = null; render(); }, 3200);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
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
function noWarn(kind) {
  try { return (JSON.parse(localStorage.getItem(LS_NOWARN) || '{}'))[kind] === true; } catch { return false; }
}
function setNoWarn(kind) {
  try { const o = JSON.parse(localStorage.getItem(LS_NOWARN) || '{}'); o[kind] = true; localStorage.setItem(LS_NOWARN, JSON.stringify(o)); } catch {}
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
      // ローカルにまだ値がないときは、購読で受け取った state をたたき台にする（サーバー側で検証される）
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
  ui.lesson = { step: 0, answers: {}, choice: null, saved: false };
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
    npc: s.npc ? E.npcValue(s) : 0,
    players: rk.map(r => {
      const p = s.players[r.id];
      return { name: p.name, charId: p.charId, nw: r.nw, rank: r.rank, title: p.title || '', bankrupt: p.stats.bankrupt, trades: p.stats.trades, borrowedMax: p.stats.borrowedMax, shorts: p.stats.shorts, dcaTotal: p.stats.dcaTotal };
    }),
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

async function saveLesson() {
  const L = ui.lesson;
  if (L.saved || !L.choice) return;
  const hid = state && state.historyId;
  const p = me();
  if (!hid || !p || !db) return;
  const score = QUIZ.reduce((n, q, i) => n + (L.answers[i] === q.answer ? 1 : 0), 0);
  try {
    await set(ref(db, `history/${hid}/lesson/${ui.pid}`), { name: p.name, charId: p.charId, choice: L.choice, score, total: QUIZ.length, at: now() });
    L.saved = true;
  } catch (e) { console.warn('lesson save failed', e); }
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
  if (ui.pid && !s.players[ui.pid]) {
    // 自分が部屋にいない（ホストがやり直した等）→ ロビーなら入り直す
    if (s.phase === 'lobby' && ui.name && ui.charId && !onState._rejoining) {
      onState._rejoining = true;
      mutate(st => E.addPlayer(st, { id: ui.pid, name: ui.name, charId: ui.charId }, now())).finally(() => { onState._rejoining = false; });
    }
  }
  if (s.lastRoll && s.phase !== 'lobby' && s.lastRoll.round > ui.seenRoll && (!ui.modal || ui.modal.type === 'roll')) {
    ui.modalAnim = true; ui.modal = { type: 'roll' };
    ui.sheet = null;
  }
  if (s.phase === 'end') {
    ui.sheet = null;
    if (ui.modal && ui.modal.type === 'roll') ui.modal = null;
    if (!s.saved && isHost()) saveHistory();
  }
  if (s.phase === 'lobby') { ui.overlay = ui.overlay === 'lesson' ? null : ui.overlay; ui.modal = ui.modal && ui.modal.type !== 'roll' ? ui.modal : null; }
  render();
}

// ---------- タイマー ----------
function timerText() {
  const s = state;
  if (!s || s.phase !== 'trade' || !s.settings.timer) return '';
  const left = Math.max(0, Math.round(s.settings.timer - (now() - (s.tradeStartedAt || now())) / 1000));
  return `⏱ ${left}秒`;
}
function tickTimer() {
  const s = state;
  if (!s || s.phase !== 'trade' || !s.settings.timer) return;
  const el = document.getElementById('timer');
  if (el) el.textContent = timerText();
  const left = s.settings.timer - (now() - (s.tradeStartedAt || now())) / 1000;
  if (left <= -1 && isHost() && advancingRound !== s.round) {
    advancingRound = s.round;
    mutate(st => E.forceAdvance(st, ui.pid, now()));
  }
}

// ---------- 画面 ----------
// innerHTML の差し替え中に blur/change イベントから再描画が呼ばれると DOM が壊れるので、
// 描画中の呼び出しは「あとでもう一回」に回す
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
  // 開いた直後の1回だけアニメーションさせる（再描画のたびに動くとチラつく）
  ui.sheetAnim = false;
  ui.modalAnim = false;
  if (bind) {
    const el = $app.querySelector(`[data-bind="${bind}"]`);
    if (el) { el.focus({ preventScroll: true }); if (selStart !== null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selStart); } catch {} } }
  }
  clearInterval(timerHandle);
  if (state && state.phase === 'trade' && state.settings.timer) timerHandle = setInterval(tickTimer, 1000);
}

function screenByName() {
  switch (ui.screen) {
    case 'join': return joinScreen();
    case 'records': return recordsScreen(true);
    case 'howto': return howtoScreen(true);
    case 'lesson': return lessonScreen(true);
    case 'glossary': return glossaryScreen(true);
    default: return titleScreen();
  }
}
function overlayScreen() {
  switch (ui.overlay) {
    case 'lesson': return lessonScreen(false);
    case 'howto': return howtoScreen(false);
    case 'glossary': return glossaryScreen(false);
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
      <p>このゲームは、4人のスマホをつなぐために Firebase（無料）を使う。<br>
      <b>README.md</b> の手順で Firebase プロジェクトを作って、<code>js/firebase-config.js</code> に設定を貼り付けてね。</p>
      <ol class="steps">
        <li>Firebase コンソールでプロジェクトを作る</li>
        <li>Realtime Database を作る（場所はシンガポール）</li>
        <li>ルールに <code>database.rules.json</code> の中身を貼る</li>
        <li>ウェブアプリを登録して firebaseConfig をコピー</li>
        <li><code>js/firebase-config.js</code> に貼り付けて保存</li>
      </ol>
    </div></div>`;
}

function titleScreen() {
  return `<div class="screen title-screen">
    <div class="hero">
      <div class="arch"><div class="lantern big">🏮</div></div>
      <h1>カタン株</h1>
      <p class="tagline">〜 ${esc(TOWN_NAME)}の大富豪 〜</p>
      <p class="sub">サイコロと交渉で株を学ぶ、家族のボードゲーム</p>
    </div>
    <div class="stack">
      <button class="btn primary big" data-act="goJoin" data-mode="create">🏠 部屋を作る</button>
      <button class="btn big" data-act="goJoin" data-mode="join">🔑 合言葉で入る</button>
      <div class="row2">
        <button class="btn ghost" data-act="goHowto">📖 あそびかた</button>
        <button class="btn ghost" data-act="goRecords">📊 成績</button>
      </div>
      <button class="btn ghost" data-act="goLesson">🎒 こどもNISAレッスン</button>
    </div>
    <p class="foot">2〜4人・1ゲーム 30〜60分・お金は一切かかりません</p>
  </div>`;
}

function charGrid() {
  return `<div class="chargrid">${CHARACTERS.map(c => `
    <button class="charcard ${ui.charId === c.id ? 'sel' : ''}" data-act="pickChar" data-id="${c.id}" style="--c:${c.color}">
      <span class="avatar lg" style="--c:${c.color}">${c.emoji}</span>
      <b>${esc(c.name)}</b><small>${esc(c.title)}</small>
      <em>${esc(c.skillName)}</em>
    </button>`).join('')}</div>`;
}

function joinScreen() {
  const create = ui.joinMode === 'create';
  const c = ui.charId ? E.charInfo(ui.charId) : null;
  return `<div class="screen">
    ${topbar(create ? '部屋を作る' : '合言葉で入る', 'goTitle')}
    <main>
      ${create ? '' : `<label class="field"><span>合言葉（4文字）</span><input data-bind="code" class="code-input" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="ABCD" value="${esc(ui.code)}"></label>`}
      <label class="field"><span>名前（10文字まで）</span><input data-bind="name" maxlength="10" autocomplete="off" placeholder="なまえ" value="${esc(ui.name)}"></label>
      <div class="field"><span>キャラを選ぶ</span>${charGrid()}</div>
      ${c ? `<div class="skillbox"><b>${c.emoji} ${esc(c.name)}の特技「${esc(c.skillName)}」</b><p>${esc(c.skillDesc)}</p></div>` : ''}
      <button class="btn primary big" data-act="${create ? 'create' : 'join'}">${create ? '部屋を作る' : '入る'}</button>
    </main></div>`;
}

function lobbyScreen() {
  const s = state;
  const ps = E.players(s);
  const host = isHost();
  const st = s.settings;
  const url = location.origin + location.pathname + '?code=' + s.code;
  const sel = (name, opts, val, fmtf) => `<select data-act="setting" data-key="${name}" ${host ? '' : 'disabled'}>${opts.map(o => `<option value="${o}" ${o === val ? 'selected' : ''}>${fmtf(o)}</option>`).join('')}</select>`;
  return `<div class="screen">
    ${topbar('ロビー', 'leaveConfirm')}
    <main>
      <div class="card codecard">
        <small>合言葉</small>
        <div class="code">${esc(s.code)}</div>
        <p>みんなはタイトル画面の「合言葉で入る」でこの4文字を入れてね</p>
        <div class="row2"><button class="btn sm" data-act="share" data-url="${esc(url)}">🔗 リンクを送る</button><button class="btn sm" data-act="copy" data-text="${esc(url)}">📋 コピー</button></div>
      </div>
      <div class="card">
        <h3>メンバー（${ps.length}/4）</h3>
        <ul class="plist">${ps.map(p => `<li>${avatar(p)}<div><b>${esc(p.name)}</b>${p.id === s.hostId ? ' 👑' : ''}${p.id === ui.pid ? ' <small>(あなた)</small>' : ''}<br><small>${esc(charOf(p).title)}・${esc(charOf(p).skillName)}</small></div></li>`).join('')}</ul>
        ${ps.length < 2 ? '<p class="hint">2人以上集まるとゲームらしくなるわ（1人でも練習はできる）</p>' : ''}
      </div>
      <div class="card">
        <h3>設定 ${host ? '' : '<small>（部屋を作った人が変えられる）</small>'}</h3>
        <label class="setrow"><span>ラウンド数</span>${sel('rounds', E.RULES.ROUND_OPTIONS, st.rounds, o => `${o}ラウンド`)}</label>
        <p class="hint">目安：10R=20〜30分、15R=30〜45分、20R=40〜60分</p>
        <label class="setrow"><span>取引の制限時間</span>${sel('timer', E.RULES.TIMER_OPTIONS, st.timer, o => (o ? `${o}秒` : 'なし（全員が「おしまい」で進む）'))}</label>
        <label class="setrow"><span>🤖 つみたてくん</span><select data-act="setting" data-key="npc" ${host ? '' : 'disabled'}><option value="1" ${st.npc ? 'selected' : ''}>いる（比較用のボット）</option><option value="0" ${!st.npc ? 'selected' : ''}>いない</option></select></label>
        <label class="setrow col"><span>😈 負けた人のおねがい</span><input data-act="setting" data-key="stakeLoser" maxlength="40" placeholder="例：皿洗い1週間、肩たたき10分" value="${esc(st.stakeLoser)}" ${host ? '' : 'disabled'}></label>
        <label class="setrow col"><span>👑 勝った人のごほうび</span><input data-act="setting" data-key="stakeWinner" maxlength="40" placeholder="例：夕ごはんのメニューを決める" value="${esc(st.stakeWinner)}" ${host ? '' : 'disabled'}></label>
        <p class="hint">※ 本物のお金は賭けないこと。おねがい・ごほうびは「家の中のこと」で。</p>
      </div>
      ${host ? `<button class="btn primary big" data-act="start" ${ps.length < 1 ? 'disabled' : ''}>🎲 ゲームスタート</button>` : `<p class="waiting">👑 ${esc(s.players[s.hostId]?.name || '')} がスタートするのを待ってる…</p>`}
      <button class="btn ghost" data-act="goHowto">📖 あそびかたを読む</button>
    </main></div>`;
}

// ---- ゲーム画面 ----
function gameScreen() {
  const s = state;
  const p = me();
  const rk = E.ranking(s);
  const myRank = rk.find(r => r.id === ui.pid)?.rank || '-';
  const nw = E.netWorth(s, p);
  const phaseLabel = s.phase === 'roll' ? '🎲 サイコロ' : s.phase === 'robber' ? '🏴‍☠️ 盗賊' : '🛒 取引タイム';
  const tabs = [['market', '市場'], ['me', '自分'], ['all', 'みんな'], ['chart', 'グラフ'], ['log', 'ログ']];
  let body;
  switch (ui.tab) {
    case 'me': body = meTab(s, p); break;
    case 'all': body = allTab(s); break;
    case 'chart': body = `<div class="card">${chartSVG(s)}<p class="hint">線は各プレイヤーの${term('純資産')}。点線は🤖つみたてくん（毎ラウンド同じ額を全部入りファンドに積み立てるだけのボット）。</p></div>`; break;
    case 'log': body = logTab(s); break;
    default: body = marketTab(s, p);
  }
  return `<div class="screen game">
    <header class="gamebar">
      <div class="round">R<b>${s.round}</b>/${s.settings.rounds}</div>
      <div class="phase">${phaseLabel}</div>
      <div class="mine">${avatar(p, 'sm')}<b>${fmtG(nw)}</b><small>${myRank}位</small></div>
      <button class="iconbtn" data-act="menu" aria-label="メニュー">☰</button>
    </header>
    ${phaseStrip(s, p)}
    <nav class="tabs">${tabs.map(([k, l]) => `<button class="${ui.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}${k === 'me' && pendingOffers(s).length ? `<i class="badge">${pendingOffers(s).length}</i>` : ''}</button>`).join('')}</nav>
    <main class="tabbody">${body}</main>
    ${ui.sheet ? sheetHtml(s, p) : ''}
  </div>`;
}

function pendingOffers(s) {
  return Object.values(s.offers).filter(o => o.status === 'open' && o.to === ui.pid);
}

function phaseStrip(s, p) {
  const dealer = s.players[s.dealer];
  const dn = dealer ? esc(dealer.name) : '';
  if (s.phase === 'roll') {
    if (s.dealer === ui.pid) return `<div class="strip roll"><div>あなたが${term('親')}よ。みんな準備できたら振って！</div><button class="btn primary" data-act="roll">🎲 サイコロを振る</button></div>`;
    return `<div class="strip wait">🎲 ${term('親')}の ${dn} がサイコロを振るのを待ってる…</div>`;
  }
  if (s.phase === 'robber') {
    if (s.dealer === ui.pid) return `<div class="strip robber"><div>🏴‍☠️ 7が出た！${term('盗賊')}をどの会社に置く？（置かれた株は −20%、次の7まで上がらない）</div><div class="choices">${STOCKS.map(st => `<button class="btn sm" data-act="robber" data-id="${st.id}" ${s.robber === st.id ? 'disabled' : ''}>${st.emoji}${esc(st.name)}</button>`).join('')}</div></div>`;
    return `<div class="strip wait">🏴‍☠️ ${dn} が盗賊を置く場所を考え中…</div>`;
  }
  const ps = E.players(s);
  const dots = ps.map(x => `<span class="done ${x.done ? 'ok' : ''}" title="${esc(x.name)}">${charOf(x).emoji}${x.done ? '✓' : ''}</span>`).join('');
  const timer = s.settings.timer ? `<span id="timer" class="timer">${timerText()}</span>` : '';
  const btn = p.done
    ? `<button class="btn" data-act="undone">↩️ まだやる</button>`
    : `<button class="btn primary" data-act="done">✅ この回はおしまい</button>`;
  const force = isHost() && !ps.every(x => x.done) ? `<button class="btn ghost sm" data-act="forceNext">⏭ 締め切って進める</button>` : '';
  return `<div class="strip trade"><div class="dots">${dots}${timer}</div>${btn}${force}</div>`;
}

function marketTab(s, p) {
  const stockCards = STOCKS.map(st => {
    const x = s.stocks[st.id];
    const chg = x.prev ? x.price / x.prev - 1 : 0;
    const lq = p.long[st.id] || 0, sq = p.short[st.id] || 0;
    const ways = st.numbers.reduce((n, k) => n + DICE_WAYS[k], 0);
    const hit = s.lastRoll && s.lastRoll.hit === st.id && !s.lastRoll.blocked;
    return `<button class="card asset ${hit ? 'hit' : ''}" data-act="sheet" data-id="${st.id}" style="--c:${st.color}">
      <div class="asset-head">
        <span class="emoji">${st.emoji}</span>
        <div class="asset-name"><b>${esc(st.name)}${s.robber === st.id ? ' <span class="rob">🏴‍☠️</span>' : ''}</b>
          <small>${esc(st.type)}・出目 ${st.numbers.map(n => `<i class="num">${n}</i>`).join('')} <span class="ways">${ways}/36</span></small></div>
        <div class="price"><b>${fmt(x.price)}G</b><small class="${clsChg(chg)}">${pct(chg)}</small></div>
      </div>
      ${lq || sq ? `<div class="holding">${lq ? `持ち株 ${lq}株（${fmtG(lq * x.price)}）` : ''}${lq && sq ? ' / ' : ''}${sq ? `<span class="down">空売り ${sq}株</span>` : ''}</div>` : ''}
    </button>`;
  }).join('');
  const fundCards = FUNDS.map(f => {
    const x = s.funds[f.id];
    const chg = x.prev ? x.price / x.prev - 1 : 0;
    const lq = p.long[f.id] || 0;
    return `<button class="card asset fund" data-act="sheet" data-id="${f.id}" style="--c:${f.color}">
      <div class="asset-head">
        <span class="emoji">${f.emoji}</span>
        <div class="asset-name"><b>${esc(f.name)}</b><small>${esc(f.type)}・信託報酬 ${(f.fee * 100).toFixed(1)}%/R${f.payout ? `・分配 ${f.payout * 100}%/R` : ''}</small></div>
        <div class="price"><b>${fmt(x.price)}G</b><small class="${clsChg(chg)}">${pct(chg)}</small></div>
      </div>
      ${lq ? `<div class="holding">持ち分 ${lq}口（${fmtG(lq * x.price)}）</div>` : ''}
    </button>`;
  }).join('');
  return `<section><h3 class="sec">🏢 会社の${term('株')} <small>タップで売り買い</small></h3>${stockCards}
    <p class="hint">「出目」はその会社が当たるサイコロの合計。6・8は36回に10回当たるけど小さく上がる。2・12は36回に2回しか当たらないけど、当たると大きい。</p></section>
    <section><h3 class="sec">🧺 ${term('投資信託')} <small>5社まとめて少しずつ</small></h3>${fundCards}
    <p class="hint">投資信託は手数料0で買えるかわりに、持っているあいだずっと${term('信託報酬')}が引かれる。${term('盗賊')}は置けない。</p></section>`;
}

function sheetHtml(s, p) {
  const id = ui.sheet;
  const a = E.assetInfo(id);
  if (!a) { ui.sheet = null; return ''; }
  const stock = E.isStock(id);
  const x = stock ? s.stocks[id] : s.funds[id];
  const price = x.price;
  const lq = p.long[id] || 0, sq = p.short[id] || 0;
  const avg = p.avg[id] || 0, savg = p.shortAvg[id] || 0;
  const fr = E.feeRate(p, id);
  const qty = Math.max(1, Math.floor(Number(ui.qty) || 1));
  const buyCost = Math.round(price * qty * (1 + fr));
  const sellGet = Math.round(price * qty * (1 - fr));
  const canTrade = s.phase === 'trade' && !p.done;
  const maxBuy = Math.floor(p.cash / (price * (1 + fr)));
  const maxShort = Math.floor(E.shortLimit(s, p) / price);
  const unreal = lq ? Math.round((price - avg) * lq) : 0;
  const sunreal = sq ? Math.round((savg - price) * sq) : 0;
  const ways = stock ? a.numbers.reduce((n, k) => n + DICE_WAYS[k], 0) : 0;
  return `<div class="sheet-bg" data-act="closeSheet"></div><div class="sheet ${ui.sheetAnim ? 'anim' : ''}" style="--c:${a.color}">
    <div class="sheet-head"><span class="emoji">${a.emoji}</span><div><b>${esc(a.name)}</b><small>${esc(a.type)}</small></div><div class="price"><b>${fmt(price)}G</b><small class="${clsChg(price / x.prev - 1)}">${pct(x.prev ? price / x.prev - 1 : 0)}</small></div><button class="iconbtn" data-act="closeSheet">✕</button></div>
    <p class="desc">${esc(a.desc)}</p>
    ${stock ? `<p class="desc">当たる出目：${a.numbers.map(n => `<i class="num">${n}</i>`).join('')}（36回に${ways}回）。当たると <b>+${Math.round(a.hitUp * 100)}%</b>${a.div ? `、${term('配当')} ${a.div * 100}%` : ''}。${s.robber === id ? '<b class="down">今は盗賊に居座られていて上がらない。</b>' : ''}</p>` : `<p class="desc">${esc(a.real)}</p>`}
    <div class="mypos">
      ${lq ? `<div>持ち株 <b>${lq}${unitOf(id)}</b> 平均 ${fmt(avg)}G → <span class="${clsChg(unreal)}">${unreal >= 0 ? term('含み益') : term('含み損')} ${fmtG(unreal)}</span></div>` : ''}
      ${sq ? `<div>空売り <b>${sq}株</b> 平均 ${fmt(savg)}G → <span class="${clsChg(sunreal)}">損益 ${fmtG(sunreal)}</span></div>` : ''}
      <div>現金 <b>${fmtG(p.cash)}</b>${stock && fr ? `・手数料 ${fr * 100}%` : stock ? '・手数料なし（特技）' : '・手数料なし'}</div>
    </div>
    <div class="qty">
      <button class="btn sm" data-act="qty" data-d="-10">−10</button><button class="btn sm" data-act="qty" data-d="-1">−1</button>
      <input type="number" inputmode="numeric" min="1" data-bind="qty" data-rerender="1" value="${qty}">
      <button class="btn sm" data-act="qty" data-d="1">+1</button><button class="btn sm" data-act="qty" data-d="10">+10</button>
    </div>
    <div class="actions">
      <div class="actrow"><button class="btn buy" data-act="buy" ${canTrade && buyCost <= p.cash ? '' : 'disabled'}>買う <small>${fmtG(buyCost)}</small></button><button class="btn ghost sm" data-act="qtyMax" data-n="${maxBuy}">全力 ${maxBuy}</button></div>
      <div class="actrow"><button class="btn sell" data-act="sell" ${canTrade && lq >= qty ? '' : 'disabled'}>売る <small>+${fmtG(sellGet)}</small></button><button class="btn ghost sm" data-act="qtyMax" data-n="${lq}">全部 ${lq}</button></div>
      ${stock ? `
      <div class="actrow"><button class="btn short" data-act="short" ${canTrade && !lq && qty <= maxShort ? '' : 'disabled'}>${term('空売り')} <small>+${fmtG(sellGet)}</small></button><button class="btn ghost sm" data-act="qtyMax" data-n="${maxShort}">上限 ${maxShort}</button></div>
      <div class="actrow"><button class="btn cover" data-act="cover" ${canTrade && sq >= qty && buyCost <= p.cash ? '' : 'disabled'}>${term('買い戻し')} <small>${fmtG(buyCost)}</small></button><button class="btn ghost sm" data-act="qtyMax" data-n="${sq}">全部 ${sq}</button></div>` : ''}
    </div>
    ${!canTrade ? `<p class="hint">${s.phase !== 'trade' ? '取引タイムになったら売り買いできる' : '「まだやる」を押すと取引できる'}</p>` : ''}
  </div>`;
}

function meTab(s, p) {
  const c = charOf(p);
  const nw = E.netWorth(s, p);
  const lv = E.longValue(s, p), sl = E.shortLiab(s, p);
  const ratio = E.maintRatio(s, p);
  const start = E.RULES.START_CASH + (c.skill === 'rich_start' ? E.RULES.RICH_START : 0);
  const canTrade = s.phase === 'trade' && !p.done;
  const others = E.players(s).filter(x => x.id !== ui.pid);
  const assetOpts = (val, allowEmpty) => `${allowEmpty ? `<option value="" ${!val ? 'selected' : ''}>（なし）</option>` : ''}${[...STOCKS, ...FUNDS].map(a => `<option value="${a.id}" ${val === a.id ? 'selected' : ''}>${a.emoji} ${esc(a.name)}</option>`).join('')}`;
  const inbox = pendingOffers(s);
  const outbox = Object.values(s.offers).filter(o => o.from === ui.pid && o.status === 'open');
  const holdings = [...Object.entries(p.long).map(([id, q]) => ({ id, q, side: 'long' })), ...Object.entries(p.short).map(([id, q]) => ({ id, q, side: 'short' }))];
  const o = ui.offer;
  return `
    <div class="card summary">
      <div class="nw"><small>${term('純資産')}</small><b>${fmtG(nw)}</b><span class="${clsChg(nw - start)}">${pct(nw / start - 1)}</span></div>
      <div class="grid2">
        <div><small>現金</small><b>${fmtG(p.cash)}</b></div>
        <div><small>持ち株・投信</small><b>${fmtG(lv)}</b></div>
        <div><small>借金</small><b class="${p.debt ? 'down' : ''}">${fmtG(p.debt)}</b></div>
        <div><small>空売りの借り</small><b class="${sl ? 'down' : ''}">${fmtG(sl)}</b></div>
      </div>
      ${(p.debt || sl) ? `<div class="ratio ${ratio < 0.35 ? 'danger' : ''}">${term('維持率')} <b>${isFinite(ratio) ? (ratio * 100).toFixed(0) + '%' : '—'}</b>（25%を切ると${term('追証')}）</div>` : ''}
      <div class="skill">${c.emoji} <b>${esc(c.name)}</b>の特技「${esc(c.skillName)}」：${esc(c.skillDesc)}</div>
    </div>

    <div class="card">
      <h3>🏦 ${term('信用取引')}（銀行から借りる）</h3>
      <p class="hint">借りられるのはあと <b>${fmtG(E.borrowLimit(s, p))}</b>（純資産の2倍まで）。${term('金利')}は毎ラウンド ${c.skill === 'half_interest' ? '1%（特技で半分）' : '2%'}。</p>
      <div class="qty">
        <button class="btn sm" data-act="amt" data-key="borrowAmt" data-d="-10000">−1万</button>
        <input type="number" inputmode="numeric" min="1" step="1000" data-bind="borrowAmt" value="${ui.borrowAmt}">
        <button class="btn sm" data-act="amt" data-key="borrowAmt" data-d="10000">+1万</button>
      </div>
      <div class="row2"><button class="btn warn" data-act="borrow" ${canTrade ? '' : 'disabled'}>借りる</button><button class="btn" data-act="repay" ${canTrade && p.debt > 0 ? '' : 'disabled'}>返す</button></div>
      ${p.debt ? `<button class="btn ghost sm" data-act="repayAll" ${canTrade ? '' : 'disabled'}>全部返す（${fmtG(Math.min(p.cash, p.debt))}）</button>` : ''}
    </div>

    <div class="card">
      <h3>🔁 ${term('つみたて')}（毎ラウンド自動で買う）</h3>
      ${p.dca ? `<p>いま：<b>${E.assetInfo(p.dca.assetId)?.emoji} ${esc(E.assetInfo(p.dca.assetId)?.name)}</b> を毎ラウンド <b>${fmtG(p.dca.amount)}</b></p>` : '<p class="hint">設定すると、毎ラウンドのサイコロのあとに自動で買ってくれる。値段が高いときは少なく、安いときは多く買えるのがミソ。</p>'}
      <div class="row2">
        <select data-bind="dcaAsset">${assetOpts(ui.dcaAsset, false)}</select>
        <input type="number" inputmode="numeric" min="100" step="1000" data-bind="dcaAmount" value="${ui.dcaAmount}" placeholder="金額">
      </div>
      <div class="row2"><button class="btn primary" data-act="dcaSet">設定する</button>${p.dca ? '<button class="btn ghost" data-act="dcaClear">やめる</button>' : ''}</div>
    </div>

    <div class="card">
      <h3>🤝 ${term('相対取引')}（プレイヤー同士で交換）${inbox.length ? `<i class="badge">${inbox.length}</i>` : ''}</h3>
      ${inbox.map(of => `<div class="offer in"><div>${avatar(s.players[of.from], 'sm')} <b>${esc(s.players[of.from]?.name)}</b> から：<br>「<b>${esc(sideText(of.give))}</b> をあげるから、<b>${esc(sideText(of.get))}</b> ちょうだい」</div>
        <div class="row2"><button class="btn primary sm" data-act="offerAccept" data-id="${of.id}" ${s.phase === 'trade' ? '' : 'disabled'}>OK！</button><button class="btn sm" data-act="offerDecline" data-id="${of.id}">ことわる</button></div></div>`).join('')}
      ${outbox.map(of => `<div class="offer out"><div>→ <b>${esc(s.players[of.to]?.name)}</b> に提案中：${esc(sideText(of.give))} ⇄ ${esc(sideText(of.get))}</div><button class="btn ghost sm" data-act="offerCancel" data-id="${of.id}">取り消す</button></div>`).join('')}
      ${others.length ? `
      <div class="offerform">
        <label class="setrow"><span>相手</span><select data-bind="offer.to"><option value="">えらぶ</option>${others.map(x => `<option value="${x.id}" ${o.to === x.id ? 'selected' : ''}>${charOf(x).emoji} ${esc(x.name)}</option>`).join('')}</select></label>
        <div class="side"><b>あげる</b>
          <div class="row2"><input type="number" inputmode="numeric" min="0" data-bind="offer.giveCash" placeholder="お金(G)" value="${esc(o.giveCash)}"><select data-bind="offer.giveAsset">${assetOpts(o.giveAsset, true)}</select></div>
          <input type="number" inputmode="numeric" min="0" data-bind="offer.giveQty" placeholder="株数・口数" value="${esc(o.giveQty)}">
        </div>
        <div class="side"><b>もらう</b>
          <div class="row2"><input type="number" inputmode="numeric" min="0" data-bind="offer.getCash" placeholder="お金(G)" value="${esc(o.getCash)}"><select data-bind="offer.getAsset">${assetOpts(o.getAsset, true)}</select></div>
          <input type="number" inputmode="numeric" min="0" data-bind="offer.getQty" placeholder="株数・口数" value="${esc(o.getQty)}">
        </div>
        <button class="btn primary" data-act="offerPropose" ${canTrade ? '' : 'disabled'}>提案する</button>
        <p class="hint">手数料なし。相手が OK を押すと成立。おねだりも、ぼったくりも自由（カタンと同じ）。</p>
      </div>` : '<p class="hint">相手がいないと交換できない</p>'}
    </div>

    <div class="card">
      <h3>📦 持っているもの</h3>
      ${holdings.length ? `<ul class="hold">${holdings.map(h => {
        const a = E.assetInfo(h.id); const price = E.priceOf(s, h.id);
        const avg = h.side === 'long' ? (p.avg[h.id] || price) : (p.shortAvg[h.id] || price);
        const pl = Math.round((h.side === 'long' ? price - avg : avg - price) * h.q);
        return `<li><button class="link" data-act="sheet" data-id="${h.id}">${a.emoji} ${esc(a.name)}</button><span>${h.side === 'short' ? '<i class="down">空売り</i> ' : ''}${h.q}${unitOf(h.id)} × ${fmt(price)}G</span><b class="${clsChg(pl)}">${fmtG(pl)}</b></li>`;
      }).join('')}</ul>` : '<p class="hint">まだ何も持っていない。「市場」タブから買ってみて。</p>'}
      <div class="statline">取引 ${p.stats.trades}回・手数料 ${fmtG(p.stats.fees)}・利息 ${fmtG(p.stats.interest)}・配当/分配 ${fmtG(p.stats.dividends + p.stats.payouts)}${p.stats.margin ? `・追証 ${p.stats.margin}回` : ''}${p.stats.bankrupt ? `・破産 ${p.stats.bankrupt}回` : ''}</div>
    </div>`;
}

function sideText(side) {
  const parts = [];
  if (side.cash > 0) parts.push(`${fmt(side.cash)}G`);
  if (side.asset && side.qty > 0) { const a = E.assetInfo(side.asset); parts.push(`${a.emoji}${a.name} ${side.qty}${unitOf(side.asset)}`); }
  return parts.length ? parts.join(' + ') : 'なし';
}

function allTab(s) {
  const rk = E.ranking(s);
  const start = E.RULES.START_CASH;
  const rows = rk.map(r => {
    const p = s.players[r.id];
    const c = charOf(p);
    const hold = [...Object.entries(p.long).map(([id, q]) => `${E.assetInfo(id).emoji}${q}`), ...Object.entries(p.short).map(([id, q]) => `<i class="down">空${E.assetInfo(id).emoji}${q}</i>`)].join(' ');
    return `<div class="card player ${p.id === ui.pid ? 'me' : ''}">
      <div class="phead"><span class="rank">${r.rank}</span>${avatar(p)}<div><b>${esc(p.name)}</b>${p.id === s.dealer ? ' 🎲' : ''}${p.done && s.phase === 'trade' ? ' ✓' : ''}<br><small>${esc(c.title)}${p.dca ? '・🔁つみたて中' : ''}</small></div><div class="price"><b>${fmtG(r.nw)}</b><small class="${clsChg(r.nw - start)}">${pct(r.nw / start - 1)}</small></div></div>
      <div class="pdetail">現金 ${fmtG(p.cash)}${p.debt ? `・<i class="down">借金 ${fmtG(p.debt)}</i>` : ''}${hold ? `<br>${hold}` : ''}</div>
    </div>`;
  }).join('');
  const npc = s.npc ? `<div class="card player npc"><div class="phead"><span class="rank">🤖</span><span class="avatar" style="--c:#9a9a9a">🤖</span><div><b>つみたてくん</b><br><small>毎ラウンド ${fmtG(s.npc.perRound)} を全部入りファンドに積み立てるだけ</small></div><div class="price"><b>${fmtG(E.npcValue(s))}</b><small class="${clsChg(E.npcValue(s) - start)}">${pct(E.npcValue(s) / start - 1)}</small></div></div></div>` : '';
  return rows + npc + `<p class="hint">順位は${term('純資産')}（現金＋株−借金）で決まる。現金が多くても株で負けてたら負け。</p>`;
}

function logTab(s) {
  const r = s.lastRoll;
  const cur = r ? `<div class="card"><h3>このラウンドの出来事（R${r.round}）</h3>${diceHtml(r)}<ul class="effects">${r.effects.map(e => `<li class="${e.kind}">${esc(e.text)}</li>`).join('')}</ul></div>` : '';
  const logs = [...s.log].reverse().map(l => `<li><small>R${l.r}</small> ${esc(l.t)}</li>`).join('');
  return cur + `<div class="card"><h3>みんなの動き</h3><ul class="loglist">${logs || '<li>まだ何もない</li>'}</ul></div>`;
}

function diceHtml(r) {
  const [ico, label] = EV[r.evType] || EV.none;
  return `<div class="dice"><span class="die">${DIE[r.d1]}</span><span class="die">${DIE[r.d2]}</span><span class="sum">= ${r.sum}</span><span class="evdie ${r.evType}"><i>${ico}</i><small>${label}</small></span></div>`;
}

function chartSVG(s, h = 230) {
  const W = 360, L = 48, Rr = 10, T = 12, B = 26;
  const series = E.players(s).map(p => ({ name: p.name, color: charOf(p).color, data: p.history, emoji: charOf(p).emoji }));
  if (s.npc) series.push({ name: 'つみたてくん', color: '#8a8a8a', data: s.npc.history, dashed: true, emoji: '🤖' });
  const rounds = Math.max(1, s.settings.rounds);
  let min = Infinity, max = -Infinity;
  for (const se of series) for (const v of se.data) { if (v < min) min = v; if (v > max) max = v; }
  if (!isFinite(min)) { min = 0; max = E.RULES.START_CASH; }
  const START = E.RULES.START_CASH;
  min = Math.min(min, START); max = Math.max(max, START * 1.1);
  const pad = (max - min) * 0.08 || 1000;
  min -= pad; max += pad;
  const x = i => L + (W - L - Rr) * (i / rounds);
  const y = v => T + (h - T - B) * (1 - (v - min) / (max - min));
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4;
    g += `<line x1="${L}" x2="${W - Rr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 4}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${man(v)}</text>`;
  }
  g += `<line x1="${L}" x2="${W - Rr}" y1="${y(START).toFixed(1)}" y2="${y(START).toFixed(1)}" class="startline"/>`;
  const step = Math.max(1, Math.ceil(rounds / 6));
  for (let i = 0; i <= rounds; i += step) g += `<text x="${x(i).toFixed(1)}" y="${h - 8}" class="axis" text-anchor="middle">${i}</text>`;
  let lines = '';
  for (const se of series) {
    if (!se.data.length) continue;
    const pts = se.data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="${se.color}" stroke-width="${se.dashed ? 2 : 3}" ${se.dashed ? 'stroke-dasharray="6 4"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = se.data.length - 1;
    lines += `<circle cx="${x(last).toFixed(1)}" cy="${y(se.data[last]).toFixed(1)}" r="4" fill="${se.color}"/>`;
  }
  const legend = series.map(se => `<span class="lg"><i style="background:${se.color}"></i>${se.emoji}${esc(se.name)} <b>${fmtG(se.data[se.data.length - 1] || 0)}</b></span>`).join('');
  return `<svg viewBox="0 0 ${W} ${h}" class="chart" role="img" aria-label="資産の推移">${g}${lines}</svg><div class="legend">${legend}</div>`;
}

// ---- 結果 ----
function endScreen() {
  const s = state;
  const rk = E.ranking(s);
  const start = E.RULES.START_CASH;
  const winner = s.players[rk[0].id], loser = s.players[rk[rk.length - 1].id];
  const npcV = s.npc ? E.npcValue(s) : null;
  const beat = npcV !== null ? rk.filter(r => r.nw > npcV).map(r => s.players[r.id].name) : [];
  const lost = npcV !== null ? rk.filter(r => r.nw <= npcV).map(r => s.players[r.id].name) : [];
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
        <ol class="result">${rk.map(r => { const p = s.players[r.id]; return `<li><span class="rank">${r.rank}</span>${avatar(p, 'sm')}<div><b>${esc(p.name)}</b><br><small>「${esc(p.title || '')}」</small></div><div class="price"><b>${fmtG(r.nw)}</b><small class="${clsChg(r.nw - start)}">${pct(r.nw / start - 1)}</small></div></li>`; }).join('')}
        ${npcV !== null ? `<li class="npc"><span class="rank">🤖</span><span class="avatar sm" style="--c:#9a9a9a">🤖</span><div><b>つみたてくん</b><br><small>ほったらかし積み立て</small></div><div class="price"><b>${fmtG(npcV)}</b><small class="${clsChg(npcV - start)}">${pct(npcV / start - 1)}</small></div></li>` : ''}</ol>
        ${npcV !== null ? `<p class="npcnote">${beat.length ? `🎉 ${esc(beat.join('・'))} は、つみたてくんに勝った！` : ''}${lost.length ? `<br>😅 ${esc(lost.join('・'))} は、何も考えずに積み立てるだけのボットに負けた…。現実の投資でもよくあることよ。` : ''}</p>` : ''}
      </div>
      ${(s.settings.stakeLoser || s.settings.stakeWinner) ? `<div class="card stake">
        ${s.settings.stakeWinner ? `<div>👑 <b>${esc(winner.name)}</b> のごほうび：<b>${esc(s.settings.stakeWinner)}</b></div>` : ''}
        ${s.settings.stakeLoser && rk.length > 1 ? `<div>😈 <b>${esc(loser.name)}</b> のおねがい：<b>${esc(s.settings.stakeLoser)}</b></div>` : ''}
      </div>` : ''}
      <div class="card">${chartSVG(s)}</div>
      <div class="card">
        <h3>📋 みんなの成績表</h3>
        ${rk.map(r => { const p = s.players[r.id]; const st = p.stats; return `<div class="statcard"><b>${charOf(p).emoji} ${esc(p.name)}</b>
          <div class="statgrid"><span>取引 ${st.trades}回</span><span>手数料 ${fmtG(st.fees)}</span><span>配当・分配 ${fmtG(st.dividends + st.payouts)}</span><span>利息 ${fmtG(st.interest)}</span><span>最高 ${fmtG(st.peak)}</span><span>借金最大 ${fmtG(st.borrowedMax)}</span><span>空売り ${st.shorts}回</span><span>つみたて ${fmtG(st.dcaTotal)}</span>${st.margin ? `<span class="down">追証 ${st.margin}回</span>` : ''}${st.bankrupt ? `<span class="down">破産 ${st.bankrupt}回</span>` : ''}</div></div>`; }).join('')}
      </div>
      <button class="btn primary big" data-act="goLesson">🎒 こどもNISAレッスンへ</button>
      ${isHost() ? '<button class="btn big" data-act="again">🔁 同じメンバーでもう一回</button>' : '<p class="waiting">もう一回やるなら、部屋を作った人が「もう一回」を押してね</p>'}
      <button class="btn ghost" data-act="leaveConfirm">🏠 タイトルへ</button>
    </main></div>`;
}

// ---- レッスン ----
function lessonScreen(standalone) {
  const L = ui.lesson;
  const total = LESSON.length + QUIZ.length + 2;
  const step = Math.min(L.step, total - 1);
  let body, canNext = true;
  if (step < LESSON.length) body = lessonSection(LESSON[step]);
  else if (step < LESSON.length + QUIZ.length) { const qi = step - LESSON.length; body = quizSection(qi); canNext = L.answers[qi] !== undefined; }
  else if (step === total - 2) { body = finalChoice(); canNext = !!L.choice; }
  else body = lessonSummary();
  const back = standalone ? 'goTitle' : 'back';
  return `<div class="screen lesson">
    ${topbar('🎒 こどもNISAレッスン', back, `<small>${step + 1}/${total}</small>`)}
    <main>${body}</main>
    <footer class="lessonnav">
      <button class="btn" data-act="lessonPrev" ${step === 0 ? 'disabled' : ''}>← 前へ</button>
      ${step < total - 1 ? `<button class="btn primary" data-act="lessonNext" ${canNext ? '' : 'disabled'}>次へ →</button>` : `<button class="btn primary" data-act="${back}">おわり</button>`}
    </footer></div>`;
}
function lessonSection(sec) {
  let inner = '';
  if (sec.body) inner += `<ul class="lessonlist">${sec.body.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;
  if (sec.table) inner += `<table class="ltable">${sec.table.map((row, i) => `<tr>${row.map(c => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</table>`;
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
function finalChoice() {
  const ch = ui.lesson.choice;
  const picked = FINAL_CHOICE.options.find(o => o.id === ch);
  return `<div class="card quiz"><small>さいごに</small><h3>${esc(FINAL_CHOICE.q)}</h3>
    <div class="stack">${FINAL_CHOICE.options.map(o => `<button class="btn opt ${ch ? (o.id === ch ? o.verdict : 'dim') : ''}" data-act="finalPick" data-id="${o.id}">${esc(o.label)}</button>`).join('')}</div>
    ${picked ? `<div class="why ${picked.verdict}"><p>${esc(picked.why)}</p>${ch !== 'index' ? '<p>もう一度選びなおしてもいいわよ。</p>' : ''}</div>` : ''}
  </div>`;
}
function lessonSummary() {
  const L = ui.lesson;
  const score = QUIZ.reduce((n, q, i) => n + (L.answers[i] === q.answer ? 1 : 0), 0);
  const picked = FINAL_CHOICE.options.find(o => o.id === L.choice);
  return `<div class="card center">
    <div class="lantern big">${score === QUIZ.length ? '🏅' : '🎒'}</div>
    <h3>クイズ ${score}/${QUIZ.length} 正解</h3>
    <p>あなたが選んだのは <b>${picked ? esc(picked.label) : '—'}</b></p>
    <div class="motto">安く・広く・長く</div>
    <p class="hint">${L.saved ? '成績に記録したわ。' : state && state.historyId ? '' : 'ゲームのあとに開くと、選んだ結果が成績に残る。'}</p>
    <p class="hint">※ こどもNISAの細かいルールはこれから決まる部分もある。実際に口座を作るときは、おうちの人と一緒に金融庁や証券会社の最新情報を確認してね。</p>
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
      const a = (agg[p.name] = agg[p.name] || { name: p.name, charId: p.charId, games: 0, wins: 0, rankSum: 0, bankrupt: 0, best: -Infinity, lastChoice: null });
      a.games++; if (p.rank === 1) a.wins++; a.rankSum += p.rank; a.bankrupt += p.bankrupt || 0; a.best = Math.max(a.best, p.nw); a.charId = p.charId;
      const les = g.lesson && Object.values(g.lesson).find(l => l.name === p.name);
      if (les && !a.lastChoice) a.lastChoice = les.choice;
    }
    const rows = Object.values(agg).sort((a, b) => b.wins - a.wins || a.rankSum / a.games - b.rankSum / b.games);
    body = `<div class="card"><h3>🏅 通算成績</h3><table class="rtable"><tr><th>名前</th><th>回</th><th>優勝</th><th>平均順位</th><th>最高資産</th><th>NISAの選択</th></tr>
      ${rows.map(a => `<tr><td>${E.charInfo(a.charId)?.emoji || ''} ${esc(a.name)}</td><td>${a.games}</td><td>${a.wins}</td><td>${(a.rankSum / a.games).toFixed(1)}</td><td>${fmtG(a.best)}</td><td>${a.lastChoice ? E.assetInfo(a.lastChoice)?.emoji : '—'}</td></tr>`).join('')}</table></div>
      ${recs.map(g => { const d = new Date(g.finishedAt || 0); const key = g.id || String(g.finishedAt); const open = ui.expanded[key]; return `<div class="card game">
        <button class="gamehead" data-act="toggle" data-key="${esc(key)}"><span>${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</span><b>🏆 ${esc(g.players?.[0]?.name || '')}</b><small>${g.rounds}R・${(g.players || []).length}人 ${open ? '▲' : '▼'}</small></button>
        ${open ? `<ol class="result small">${(g.players || []).map(p => `<li><span class="rank">${p.rank}</span><div><b>${E.charInfo(p.charId)?.emoji || ''} ${esc(p.name)}</b> <small>「${esc(p.title || '')}」</small></div><b>${fmtG(p.nw)}</b></li>`).join('')}${g.npc ? `<li class="npc"><span class="rank">🤖</span><div>つみたてくん</div><b>${fmtG(g.npc)}</b></li>` : ''}</ol>
          ${g.lesson ? `<p class="hint">レッスン：${Object.values(g.lesson).map(l => `${esc(l.name)} → ${E.assetInfo(l.choice)?.emoji || '?'}（クイズ ${l.score}/${l.total}）`).join('、')}</p>` : ''}
          ${g.stakeLoser ? `<p class="hint">😈 おねがい：${esc(g.stakeLoser)}</p>` : ''}` : ''}
      </div>`; }).join('')}`;
  }
  return `<div class="screen">${topbar('📊 成績', back, '<button class="iconbtn" data-act="recordsReload" aria-label="更新">⟳</button>')}<main>${body}</main></div>`;
}

// ---- あそびかた ----
function howtoScreen(standalone) {
  const back = standalone ? 'goTitle' : 'back';
  return `<div class="screen">${topbar('📖 あそびかた', back)}<main>
    <div class="card"><h3>🎯 目的</h3><p>決めたラウンド数が終わったとき、${term('純資産')}（現金＋持ち株−借金）が一番多い人の勝ち。みんな 100,000G からスタート。</p></div>
    <div class="card"><h3>🎲 1ラウンドの流れ</h3><ol class="steps">
      <li><b>${term('親')}がサイコロを3つ振る。</b>2つの合計で「当たる会社」が決まり、その株が上がる（持っていれば${term('配当')}も）。3つ目はイベントダイス：📈大暴騰／📉大暴落／🌊凪／なし。</li>
      <li><b>7が出たら${term('盗賊')}。</b>親が好きな会社に置く。その株は −20%、次の7まで上がらない。現金を5万Gより多く持っている人は、はみ出た分の10%を盗まれる。</li>
      <li><b>取引タイム。</b>全員いっせいに売り買い・借入・空売り・つみたて設定・プレイヤー同士の交換ができる。</li>
      <li>全員が「おしまい」を押すと次のラウンド。親は順番にまわる。</li></ol></div>
    <div class="card"><h3>🏢 会社の株</h3><p>それぞれ「当たる出目」が2つある。<b>6・8のランタン工房</b>は36回に10回当たるけど +8%。<b>2・12の竜の鉱山</b>は36回に2回しか当たらないけど +70%。当たりやすさと上がり幅はトレードオフ。</p></div>
    <div class="card"><h3>🧺 投資信託</h3><p>5社にまとめて投資する商品。サイコロで直接は動かず、5社の平均に連動する。手数料なしで買えるけど、持っているあいだ毎ラウンド${term('信託報酬')}が引かれる。3種類の違いはレッスンで。</p></div>
    <div class="card"><h3>🏦 ${term('信用取引')}・${term('空売り')}（上級）</h3>
      <p><b>借りる：</b>純資産の2倍まで借りられる。毎ラウンド2%の${term('金利')}。</p>
      <p><b>空売り：</b>持っていない株を売って、あとで買い戻す。下がれば得、上がれば損。純資産と同じ額まで。毎ラウンド1%の${term('貸株料')}。</p>
      <p class="warn">⚠️ ${term('維持率')}が25%を切ると${term('追証')}（全部強制決済）。純資産がマイナスになると${term('破産')}（10,000Gからやり直し）。</p></div>
    <div class="card"><h3>🤝 ${term('相対取引')}</h3><p>「自分」タブから相手に提案を送れる。株とお金を好きな組み合わせで交換。手数料なし。相手がOKすれば成立。</p></div>
    <div class="card"><h3>🔁 ${term('つみたて')}と🤖つみたてくん</h3><p>「自分」タブで設定すると、毎ラウンド自動で決まった金額ぶん買ってくれる。つみたてくんは全部入りファンドに積み立てるだけのボット。最後にみんなと比べられる。</p></div>
    <div class="card"><h3>👑 勝ったら・負けたら</h3><p>ロビーで決めた「おねがい」「ごほうび」が結果画面に出る。本物のお金は賭けないこと。</p></div>
    <button class="btn" data-act="goGlossary">📚 用語集を見る</button>
  </main></div>`;
}
function glossaryScreen(standalone) {
  const back = standalone ? 'goTitle' : 'back';
  return `<div class="screen">${topbar('📚 用語集', back)}<main><div class="card"><dl class="gloss">${Object.entries(GLOSSARY).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div></main></div>`;
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
    const [ico, label] = EV[r.evType] || EV.none;
    return `<div class="modal-bg"><div class="modal rollm${anim}">
      <small>ラウンド ${r.round}・親：${esc(dealer?.name || '')}</small>
      ${diceHtml(r)}
      <div class="evbanner ${r.evType}">${ico} ${label}${r.evType === 'none' ? '' : '！'}</div>
      <ul class="effects">${r.effects.map(e => `<li class="${e.kind}">${esc(e.text)}</li>`).join('')}</ul>
      ${waiting ? (s.dealer === ui.pid
        ? `<p><b>🏴‍☠️ 盗賊をどの会社に置く？</b>（−20%、次の7まで上がらない）</p><div class="choices">${STOCKS.map(st => `<button class="btn sm" data-act="robber" data-id="${st.id}" ${s.robber === st.id ? 'disabled' : ''}>${st.emoji}${esc(st.name)}</button>`).join('')}</div>`
        : `<p class="waiting">🏴‍☠️ ${esc(dealer?.name || '')} が盗賊を置く場所を考え中…</p>`)
        : `<button class="btn primary big" data-act="closeRoll">OK、取引へ</button>`}
    </div></div>`;
  }
  if (m.type === 'warn') {
    const texts = {
      short: ['⚠️ 空売りする前に', '空売りは「株が下がる」と得をする取引。でも株は上がり続けることがあって、そのときの損には<b>上限がない</b>。毎ラウンド貸株料もかかる。純資産がマイナスになったら破産よ。'],
      borrow: ['⚠️ お金を借りる前に', '借りたお金には毎ラウンド<b>2%の利息</b>がつく。株が下がって維持率が25%を切ると、持ち株を<b>全部強制的に売られる</b>（追証）。もうけが2倍になるってことは、損も2倍ってこと。'],
    }[m.kind];
    return `<div class="modal-bg"><div class="modal${anim}"><h3>${texts[0]}</h3><p>${texts[1]}</p>
      <label class="chk"><input type="checkbox" data-bind="nowarn"> 次からこの注意を出さない</label>
      <div class="row2"><button class="btn" data-act="closeModal">やめとく</button><button class="btn warn" data-act="warnConfirm">わかった、やる</button></div></div></div>`;
  }
  if (m.type === 'term') {
    return `<div class="modal-bg" data-act="closeModal"><div class="modal${anim}"><h3>📚 ${esc(m.word)}</h3><p>${esc(GLOSSARY[m.word] || '')}</p><button class="btn" data-act="closeModal">閉じる</button></div></div>`;
  }
  if (m.type === 'confirm') {
    return `<div class="modal-bg"><div class="modal${anim}"><h3>${esc(m.title)}</h3><p>${esc(m.text)}</p><div class="row2"><button class="btn" data-act="closeModal">やめる</button><button class="btn warn" data-act="confirmYes">${esc(m.yes || 'はい')}</button></div></div></div>`;
  }
  if (m.type === 'menu') {
    return `<div class="modal-bg" data-act="closeModal"><div class="modal menu${anim}">
      <button class="btn" data-act="goHowto">📖 あそびかた</button>
      <button class="btn" data-act="goGlossary">📚 用語集</button>
      <button class="btn" data-act="goLesson">🎒 こどもNISAレッスン</button>
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
  goGlossary() { ui.modal = null; if (state && me()) ui.overlay = 'glossary'; else ui.screen = 'glossary'; render(); },
  goLesson() { ui.modal = null; ui.lesson.step = 0; if (state && me()) ui.overlay = 'lesson'; else ui.screen = 'lesson'; render(); },
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
    if (key === 'rounds' || key === 'timer') val = Number(val);
    if (key === 'npc') val = val === '1';
    mutate(s => E.updateSettings(s, ui.pid, { [key]: val }));
  },
  start() { mutate(s => E.startGame(s, ui.pid, Math.random, now())); },
  leaveConfirm() {
    const inGame = state && state.phase !== 'lobby' && state.phase !== 'end';
    ui.modalAnim = true; ui.modal = { type: 'confirm', title: '部屋を出る？', text: inGame ? 'ゲームの途中よ。出ても、同じスマホでこのページを開き直せば戻れる（合言葉を覚えておいて）。' : 'タイトルに戻るわ。', yes: '出る', then: 'leave' };
    render();
  },
  confirmYes() { const m = ui.modal; ui.modal = null; if (m && m.then === 'leave') leaveRoom(); else render(); },
  closeModal() { ui.modal = null; render(); },
  menu() { ui.modalAnim = true; ui.modal = { type: 'menu' }; render(); },
  tab(d) { ui.tab = d.tab; ui.sheet = null; render(); },
  roll() { mutate(s => E.rollDice(s, ui.pid, Math.random, now())); },
  robber(d) { mutate(s => E.placeRobber(s, ui.pid, d.id, Math.random, now())); },
  closeRoll() { if (state && state.lastRoll) ui.seenRoll = state.lastRoll.round; ui.modal = null; render(); },
  sheet(d) { ui.sheet = d.id; ui.qty = 1; ui.sheetAnim = true; render(); },
  closeSheet() { ui.sheet = null; render(); },
  qty(d) { ui.qty = Math.max(1, (Math.floor(Number(ui.qty)) || 1) + Number(d.d)); render(); },
  qtyMax(d) { ui.qty = Math.max(1, Number(d.n) || 1); render(); },
  amt(d) { ui[d.key] = Math.max(1000, (Number(ui[d.key]) || 0) + Number(d.d)); render(); },
  buy() { const id = ui.sheet, q = ui.qty; mutate(s => E.buy(s, ui.pid, id, q)); },
  sell() { const id = ui.sheet, q = ui.qty; mutate(s => E.sell(s, ui.pid, id, q)); },
  short() { withWarn('short', () => { const id = ui.sheet, q = ui.qty; mutate(s => E.shortSell(s, ui.pid, id, q)); }); },
  cover() { const id = ui.sheet, q = ui.qty; mutate(s => E.cover(s, ui.pid, id, q)); },
  borrow() { withWarn('borrow', () => { const a = Number(ui.borrowAmt); mutate(s => E.borrow(s, ui.pid, a)); }); },
  repay() { const a = Number(ui.borrowAmt); mutate(s => E.repay(s, ui.pid, a)); },
  repayAll() { mutate(s => E.repay(s, ui.pid, Math.min(s.players[ui.pid].cash, s.players[ui.pid].debt))); },
  dcaSet() { const id = ui.dcaAsset, a = Number(ui.dcaAmount); mutate(s => E.setDca(s, ui.pid, id, a)); },
  dcaClear() { mutate(s => E.setDca(s, ui.pid, null, 0)); },
  offerPropose() {
    const o = ui.offer;
    const payload = { to: o.to, give: { cash: Number(o.giveCash) || 0, asset: o.giveAsset || null, qty: Number(o.giveQty) || 0 }, get: { cash: Number(o.getCash) || 0, asset: o.getAsset || null, qty: Number(o.getQty) || 0 } };
    mutate(s => E.proposeOffer(s, ui.pid, payload, now())).then(okk => { if (okk) { ui.offer = { ...ui.offer, giveCash: '', giveAsset: '', giveQty: '', getCash: '', getAsset: '', getQty: '' }; toast('提案を送った'); } });
  },
  offerAccept(d) { mutate(s => E.acceptOffer(s, ui.pid, d.id)); },
  offerDecline(d) { mutate(s => E.declineOffer(s, ui.pid, d.id)); },
  offerCancel(d) { mutate(s => E.cancelOffer(s, ui.pid, d.id)); },
  done() { mutate(s => E.setDone(s, ui.pid, true, now())); },
  undone() { mutate(s => E.setDone(s, ui.pid, false, now())); },
  forceNext() { ui.modalAnim = true; ui.modal = { type: 'confirm', title: '締め切る？', text: 'まだ「おしまい」を押していない人がいる。取引を締め切って次のラウンドに進む？', yes: '進める', then: 'force' }; render(); },
  warnConfirm() { const m = ui.modal; ui.modal = null; if (ui.nowarn) setNoWarn(m.kind); ui.nowarn = false; if (m && typeof m.then === 'function') m.then(); render(); },
  term(d) { ui.modalAnim = true; ui.modal = { type: 'term', word: d.term }; render(); },
  again() { mutate(s => E.resetToLobby(s, ui.pid)).then(okk => { if (okk) { ui.seenRoll = 0; ui.lesson = { step: 0, answers: {}, choice: null, saved: false }; ui.tab = 'market'; } }); },
  lessonNext() { ui.lesson.step++; render(); },
  lessonPrev() { ui.lesson.step = Math.max(0, ui.lesson.step - 1); render(); },
  quizPick(d) { ui.lesson.answers[Number(d.q)] = Number(d.i); render(); },
  finalPick(d) { ui.lesson.choice = d.id; ui.lesson.saved = false; saveLesson(); render(); },
  toggle(d) { ui.expanded[d.key] = !ui.expanded[d.key]; render(); },
};
// confirmYes の 'force' 分岐
const _confirmYes = ACT.confirmYes;
ACT.confirmYes = function () {
  const m = ui.modal;
  if (m && m.then === 'force') { ui.modal = null; mutate(s => E.forceAdvance(s, ui.pid, now())); return; }
  _confirmYes();
};

function withWarn(kind, fn) {
  if (noWarn(kind)) return fn();
  ui.nowarn = false;
  ui.modalAnim = true; ui.modal = { type: 'warn', kind, then: fn };
  render();
}

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.tagName === 'SELECT' || el.tagName === 'INPUT') return; // 設定の入力欄は change で送る
  // 背景クリックで閉じる系は、子要素のクリックでは発火させない
  if ((el.classList.contains('modal-bg') || el.classList.contains('sheet-bg')) && e.target !== el) return;
  const fn = ACT[el.dataset.act];
  if (fn) fn(el.dataset, el);
});
$app.addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset || !el.dataset.bind) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.bind === 'code') v = String(v).toUpperCase();
  setPath(ui, el.dataset.bind, v);
  if (el.dataset.rerender) render();
});
$app.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset && el.dataset.act === 'setting') { ACT.setting(el.dataset, el); return; }
  if (!el.dataset || !el.dataset.bind) return;
  const v = el.type === 'checkbox' ? el.checked : el.value;
  setPath(ui, el.dataset.bind, v);
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
