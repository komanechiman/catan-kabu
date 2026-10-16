// ゲームの静的データ（ルーレット版）：会社・ニュースカード・ルーレット盤・キャラ・レッスン
// 世界観：石畳とランタンの灯りに包まれた絵本の港町「ランタン通り」

export const TOWN_NAME = 'ランタン通り';

// 会社。cards はニュースカード。p は株価の変化(%)、div は「1株につき○G」の配当
export const COMPANIES = [
  {
    id: 'lantern', name: 'ランタン工房', short: 'ランタン', emoji: '🏮', start: 120, color: '#e0952f',
    mood: '安定。小さくコツコツ',
    cards: [
      { t: 'ランタン祭りで町が大にぎわい', p: 5 },
      { t: '新作ランプが大人気', p: 8 },
      { t: 'お城から大量注文がきた', p: 10 },
      { t: '王様がランタン工房をほめた', p: 12 },
      { t: '配当を出した！', p: 0, div: 5 },
      { t: '配当を出した！', p: 0, div: 5 },
      { t: 'いつも通りの商売', p: 3 },
      { t: '雨つづきでお客が減った', p: -3 },
      { t: 'ろうそくブームでちょっと苦戦', p: -5 },
      { t: '工房でぼや騒ぎ', p: -8 },
    ],
  },
  {
    id: 'cobble', name: '石畳ギルド', short: '石畳', emoji: '🧱', start: 100, color: '#8f8198',
    mood: 'そこそこ動く',
    cards: [
      { t: '町の大通りを石畳に！大工事', p: 10 },
      { t: '新しい橋の工事を引き受けた', p: 15 },
      { t: 'お城の広場の工事をまかされた', p: 20 },
      { t: '小さな修理の注文がいっぱい', p: 5 },
      { t: '配当を出した！', p: 0, div: 4 },
      { t: '雨で工事が遅れた', p: -5 },
      { t: '石が足りなくて工事ストップ', p: -10 },
      { t: '職人たちがストライキ', p: -15 },
      { t: '作った道にヒビが入った', p: -20 },
    ],
  },
  {
    id: 'herb', name: '薬草園カモミラ', short: '薬草', emoji: '🌿', start: 80, color: '#58995f',
    mood: '当たるとよく伸びる',
    cards: [
      { t: '新しい薬が大ヒット', p: 20 },
      { t: 'カゼが流行して薬が売れまくり', p: 25 },
      { t: '女王様がカモミラの薬で元気に', p: 30 },
      { t: 'ハーブティーが流行', p: 10 },
      { t: '日照りで薬草がしおれた', p: -10 },
      { t: '薬の効きがイマイチとうわさ', p: -15 },
      { t: '薬草畑に虫が大発生', p: -20 },
      { t: 'ライバルの薬屋が開店', p: -25 },
    ],
  },
  {
    id: 'fish', name: '魚の塔商会', short: 'さかな', emoji: '🐟', start: 60, color: '#3a8fb0',
    mood: '大波が来る',
    cards: [
      { t: '巨大マグロが釣れた！', p: 30 },
      { t: '宝の沈没船を発見！', p: 40 },
      { t: '伝説の人魚と取引に成功', p: 50 },
      { t: '大漁！市場が魚だらけ', p: 20 },
      { t: '魚がぜんぜん釣れない', p: -20 },
      { t: '嵐で船が3せき沈んだ', p: -30 },
      { t: '海賊に積み荷をうばわれた', p: -35 },
      { t: 'クラーケンが港に出た！', p: -40 },
    ],
  },
  {
    id: 'dragon', name: '竜の鉱山', short: '竜の山', emoji: '⛏️', start: 40, color: '#8a5cd0',
    mood: '一発逆転か、ドカンか',
    cards: [
      { t: 'ドラゴンの金塊を発見！', p: 60 },
      { t: '伝説の竜石が出た！', p: 80 },
      { t: '竜の卵を発見！世界中が大さわぎ', p: 100 },
      { t: '新しい鉱脈を見つけた', p: 30 },
      { t: '掘っても掘っても石ころ', p: -30 },
      { t: '鉱山に幽霊が出るとうわさ', p: -40 },
      { t: 'ドラゴンが怒って坑道が崩れた', p: -50 },
      { t: 'ドラゴンが鉱山を焼きはらった', p: -60 },
    ],
  },
];

// ルーレット盤。20マス。マスの数がそのまま当たりやすさ。
//   type: co=会社のニュース / robber=盗賊 / extra=号外 / lucky=回した人に / rescue=ビリの人に
export const WHEEL = [
  { type: 'co', co: 'lantern' },
  { type: 'co', co: 'cobble' },
  { type: 'co', co: 'herb' },
  { type: 'robber' },
  { type: 'co', co: 'lantern' },
  { type: 'co', co: 'fish' },
  { type: 'co', co: 'cobble' },
  { type: 'lucky' },
  { type: 'co', co: 'lantern' },
  { type: 'co', co: 'herb' },
  { type: 'co', co: 'dragon' },
  { type: 'co', co: 'cobble' },
  { type: 'robber' },
  { type: 'co', co: 'lantern' },
  { type: 'co', co: 'fish' },
  { type: 'co', co: 'herb' },
  { type: 'extra' },
  { type: 'co', co: 'cobble' },
  { type: 'co', co: 'lantern' },
  { type: 'rescue' },
];
export const WHEEL_META = {
  robber: { emoji: '🏴‍☠️', label: '盗賊', color: '#4b3a6b', desc: '回した人が好きな会社に送りこむ。その株は −25%' },
  extra: { emoji: '📰', label: '号外', color: '#e07a2f', desc: '町じゅうの株が +25% か −25%' },
  lucky: { emoji: '🎁', label: 'ラッキー', color: '#d4a017', desc: '回した人に 100G' },
  rescue: { emoji: '🍀', label: 'おたすけ', color: '#2f9e6b', desc: 'ビリの人に 150G' },
};
export const LUCKY_AMOUNT = 100;
export const RESCUE_AMOUNT = 150;

// 号外
export const EXTRAS = {
  boom: { t: '号外！お祭りブームで町じゅう大もうけ', p: 25, emoji: '📈' },
  crash: { t: '号外！となりの国と戦争のうわさ、町じゅう大パニック', p: -25, emoji: '📉' },
};

// キャラクター（見た目だけ）
export const CHARACTERS = [
  { id: 'lumi', name: 'ルミ', emoji: '🐰', title: 'ランプ屋のうさぎ', color: '#f4a261' },
  { id: 'mimi', name: 'ミミ', emoji: '🐭', title: '行商ねずみ', color: '#b89c93' },
  { id: 'baron', name: 'バロン', emoji: '🐱', title: '銀行家ねこ', color: '#6d6875' },
  { id: 'holo', name: 'ホロ', emoji: '🦉', title: '見張りふくろう', color: '#7d8aa3' },
  { id: 'pon', name: 'ポン', emoji: '🧸', title: 'ぬいぐるみ騎士', color: '#bc6c25' },
  { id: 'zephy', name: 'ゼフィ', emoji: '🧙‍♀️', title: '風の魔女', color: '#7b2cbf' },
  { id: 'kurumi', name: 'クルミ', emoji: '🐿️', title: 'パン屋のりす', color: '#c08552' },
  { id: 'jiiya', name: 'じいや', emoji: '🐢', title: '長老がめ', color: '#588157' },
];

// こどもNISAレッスン（タイトル画面から読める、おまけ）。2026年10月時点の公表情報にもとづく
export const LESSON = [
  {
    title: 'こどもNISAってなに？', emoji: '🎒',
    body: [
      '0〜17歳が使える、投資のもうけに税金がかからない口座。2027年1月に始まる予定。',
      '年間60万円まで、合計600万円まで。',
      '買えるのは「たくさんの会社をまとめて買える投資信託」だけ。ゲームみたいな1社の株は買えない。',
      '18歳になったら大人のNISAに自動で引っ越し。',
      '※ 細かいルールはこれから決まる部分もある。使うときは金融庁や証券会社の最新情報を見てね。',
    ],
  },
  {
    title: '投資信託ってなに？', emoji: '🧺',
    body: [
      'ゲームでは「ランタン」「竜の山」みたいに1社ずつ買った。現実の投資信託は、何百・何千の会社をまとめて1つの袋に入れたもの。',
      '1社がドカンと下がっても、袋ぜんぶは少ししか下がらない。これが「分散」。',
      'ただし袋には「持ってるだけでかかる手数料（信託報酬）」がある。安いほどいい。',
    ],
  },
  {
    title: '選ぶときの3つの合言葉', emoji: '✅',
    checks: [
      ['💰 安く', '手数料（信託報酬）が年0.1%くらいのものを。1%をこえたら要注意。'],
      ['🧺 広く', '「全世界」「米国全体」のように、たくさんの会社が入っているものを。'],
      ['⏳ 長く', '10年以上ほったらかしにできるものを。下がった日に売らない。'],
    ],
    motto: '安く・広く・長く',
  },
];

export const QUIZ = [
  { q: 'こどもNISAで買えるのは？', options: ['竜の鉱山みたいな1社の株', 'たくさんの会社をまとめた投資信託'], answer: 1,
    why: 'こどもNISAは、長く・分散して持つのに向いた投資信託だけが対象。' },
  { q: '中身が同じ2つの袋。10年後にお金が多く残るのは？', options: ['A：手数料 0.1%', 'B：手数料 1.5%「プロが選ぶ！」'], answer: 0,
    why: '中身が同じなら手数料が安いほうが必ず多く残る。プロが選んでも手数料の差はなかなか取り返せない。' },
  { q: '町じゅうが大暴落！長く持つつもりの投資信託はどうする？', options: ['こわいから全部売る', '何もしない。むしろ安く買えるチャンス'], answer: 1,
    why: '下がった日に売ると損が決まるだけ。長く持つなら、安いときはたくさん買えるチャンス。' },
];

// 数字フォーマット
export function fmt(n) {
  n = Math.round(n || 0);
  return n.toLocaleString('ja-JP');
}
export function fmtG(n) {
  return fmt(n) + 'G';
}
export function pct(n, digits = 0) {
  const v = (n || 0) * 100;
  return (v > 0 ? '+' : '') + v.toFixed(digits) + '%';
}
