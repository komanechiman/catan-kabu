// ブラウザ動作テスト用の Firebase もどき。
// 本物の SDK の代わりに読み込まれ、localStorage を共有ストレージにして
// 同じブラウザ内の複数ページ（＝複数プレイヤー）を同期させる。
// 本物と同じく「undefined は保存できない」「空のオブジェクト・配列・null は消える」をまねる。
const KEY = 'fbstub-db';
const listeners = new Map(); // path -> Set<cb>

function readDb() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function writeDb(db) {
  localStorage.setItem(KEY, JSON.stringify(db));
}
function clean(v, path = '') {
  if (v === undefined) throw new Error('set failed: contains undefined at ' + path);
  if (v === null) return undefined;
  if (Array.isArray(v)) {
    const out = v.map((x, i) => clean(x, path + '/' + i));
    return out.some(x => x !== undefined) ? out.map(x => (x === undefined ? null : x)) : undefined;
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) { const c = clean(x, path + '/' + k); if (c !== undefined) out[k] = c; }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('set failed: non-finite number at ' + path);
  return v;
}
const split = p => p.split('/').filter(Boolean);
function getAt(db, path) {
  let o = db;
  for (const k of split(path)) { if (o == null || typeof o !== 'object') return null; o = o[k]; }
  return o === undefined ? null : JSON.parse(JSON.stringify(o));
}
function setAt(db, path, val) {
  const keys = split(path);
  if (!keys.length) return val === undefined ? {} : val;
  let o = db;
  for (let i = 0; i < keys.length - 1; i++) { if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {}; o = o[keys[i]]; }
  if (val === undefined) delete o[keys[keys.length - 1]]; else o[keys[keys.length - 1]] = val;
  return db;
}
function snap(path, val) {
  return { val: () => val, exists: () => val !== null && val !== undefined, key: split(path).pop() || null };
}
// 本物の SDK と同じく、通知は非同期で届く
function notifyAll() {
  setTimeout(() => {
    for (const [path, set] of listeners) {
      const val = path === '.info/serverTimeOffset' ? 0 : getAt(readDb(), path);
      for (const cb of set) cb(snap(path, val));
    }
  }, 0);
}
window.addEventListener('storage', e => { if (e.key === KEY) notifyAll(); });

export function initializeApp(config) { return { options: config }; }
export function getDatabase(app) { return { app }; }
export function ref(db, path = '') { return { path, db }; }
export function query(r, ...mods) { return { ...r, mods }; }
export function orderByChild(key) { return { type: 'orderByChild', key }; }
export function limitToLast(n) { return { type: 'limitToLast', n }; }

export async function get(r) {
  let val = getAt(readDb(), r.path);
  if (r.mods && val && typeof val === 'object') {
    let entries = Object.entries(val);
    const ob = r.mods.find(m => m.type === 'orderByChild');
    if (ob) entries.sort((a, b) => ((a[1] || {})[ob.key] || 0) - ((b[1] || {})[ob.key] || 0));
    const lim = r.mods.find(m => m.type === 'limitToLast');
    if (lim) entries = entries.slice(-lim.n);
    val = Object.fromEntries(entries);
  }
  return snap(r.path, val);
}
export async function set(r, val) {
  const db = readDb();
  writeDb(setAt(db, r.path, clean(val)));
  notifyAll();
}
export function onValue(r, cb, errCb) {
  if (!listeners.has(r.path)) listeners.set(r.path, new Set());
  listeners.get(r.path).add(cb);
  const val = r.path === '.info/serverTimeOffset' ? 0 : getAt(readDb(), r.path);
  setTimeout(() => cb(snap(r.path, val)), 0);
  return () => listeners.get(r.path)?.delete(cb);
}
export async function runTransaction(r, fn, opts) {
  // 本物と同じく、最初はキャッシュなし(null)で呼ばれることがある → ここでは常に現在値で呼ぶ
  const db = readDb();
  const cur = getAt(db, r.path);
  const next = fn(cur);
  if (next === undefined) return { committed: false, snapshot: snap(r.path, cur) };
  const cleaned = clean(next);
  writeDb(setAt(db, r.path, cleaned));
  notifyAll();
  return { committed: true, snapshot: snap(r.path, cleaned === undefined ? null : cleaned) };
}
export function serverTimestamp() { return Date.now(); }
