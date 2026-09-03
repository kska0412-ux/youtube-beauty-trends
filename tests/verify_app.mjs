/*
 * docs/index.html + app.js を実際に動かして、絞り込み・並び替え・CSV が
 * 仕様どおりかを確認する。
 *
 * 本物のブラウザを使いたいところだが、この環境ではブラウザを起動できないので
 * jsdom（salon-karte の node_modules を借用）で DOM を再現している。
 * 見た目・改行位置はここでは分からないので、目視確認は別途行うこと。
 *
 * 実行:
 *   node tests/verify_app.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/Users/kameda/Projects/salon-karte/');
const { JSDOM } = require('jsdom');

const REPO = new URL('..', import.meta.url).pathname;
const DOCS = join(REPO, 'docs');
const DATA = JSON.parse(readFileSync(join(DOCS, 'data', 'videos.json'), 'utf8'));

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks += 1;
  let ok;
  if (typeof expected === 'function') {
    ok = expected(actual);
  } else if (typeof expected === 'object' && expected !== null) {
    // 配列どうしは === では一致しない（参照の比較になる）ので中身で比べる
    ok = JSON.stringify(actual) === JSON.stringify(expected);
  } else {
    ok = actual === expected;
  }
  if (!ok) {
    failures += 1;
    console.log(`  NG  ${name}\n        期待: ${JSON.stringify(expected)}`
      + `\n        実際: ${JSON.stringify(actual)}`);
  } else {
    console.log(`  OK  ${name}  → ${JSON.stringify(actual)}`);
  }
}

// --- ページを起動する -----------------------------------------------------

const dom = new JSDOM(readFileSync(join(DOCS, 'index.html'), 'utf8'), {
  url: 'https://example.github.io/youtube-beauty-trends/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// 相対パスが正しく解決されるかも同時に見る
const fetched = [];
window.fetch = async (url) => {
  fetched.push(String(url));
  const resolved = new window.URL(url, window.location.href);
  if (resolved.pathname === '/youtube-beauty-trends/data/videos.json') {
    return { ok: true, status: 200, json: async () => DATA };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// CSV の中身を受け取れるようにしておく
let csvBlobText = null;
window.URL.createObjectURL = (blob) => {
  csvBlobText = blob.__text;
  return 'blob:mock';
};
window.URL.revokeObjectURL = () => {};
const NativeBlob = window.Blob;
window.Blob = class extends NativeBlob {
  constructor(parts, opts) {
    super(parts, opts);
    // jsdom の Blob は同期で中身を読めないので、組み立て時の文字列を持たせる
    this.__text = parts.join('');
  }
};
// ダウンロードのクリックは何もしない（jsdom は遷移しようとして警告を出す）
const originalCreate = window.document.createElement.bind(window.document);
window.document.createElement = (tag) => {
  const node = originalCreate(tag);
  if (String(tag).toLowerCase() === 'a') node.click = () => {};
  return node;
};

const APP_JS = readFileSync(join(DOCS, 'app.js'), 'utf8');

/**
 * app.js を読み込んで起動を待つ。
 * jsdom は生成直後に自分で DOMContentLoaded を発火するので、無条件に
 * dispatchEvent すると main() が2回走ってしまう。動いていなければ発火する。
 */
async function boot(instance) {
  instance.window.eval(APP_JS);
  await new Promise((r) => setTimeout(r, 50));
  if (!instance.window.document.querySelector('.card, .empty')) {
    instance.window.document.dispatchEvent(new instance.window.Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 50));
  }
}

await boot(dom);

const doc = window.document;
const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => Array.from(doc.querySelectorAll(sel));
const cards = () => $$('.card');
const cardTitles = () => $$('.card .title').map((n) => n.textContent);
const settle = () => new Promise((r) => setTimeout(r, 0));

function chip(group, label) {
  const found = $$(`#${group} .chip`).find((c) => c.querySelector('.chip-name').textContent === label);
  if (!found) throw new Error(`チップが見つからない: ${group} / ${label}`);
  return found;
}
async function click(node) {
  node.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
}
async function select(id, value) {
  $(id).value = value;
  $(id).dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
}
async function type(value) {
  $('#search').value = value;
  $('#search').dispatchEvent(new window.Event('input', { bubbles: true }));
  // 入力は 180ms のディレイ後に反映される
  await new Promise((r) => setTimeout(r, 260));
}

const byId = new Map(DATA.videos.map((v) => [v.videoId, v]));
// 画面の既定は「90日以内」。収集後に時間が経つと範囲から外れる動画が出るので、
// 期待値は総数を決め打ちせずデータから数える。
const within = (days) => DATA.videos.filter(
  (v) => (Date.now() - Date.parse(v.publishedAt)) / 86400000 <= days).length;
const SHOWN_DEFAULT = within(90);
const idsOf = () => $$('.card .link').map((a) => new URL(a.href).searchParams.get('v'));
const isSorted = (values, cmp) => values.every((v, i) => i === 0 || cmp(values[i - 1], v));
const desc = (a, b) => a >= b;

// --- 1. 初期表示 ----------------------------------------------------------

console.log('\n[1] 初期表示');
check('データの取得先が相対パスで解決されている', fetched, (f) => f.length === 1 && f[0] === 'data/videos.json');
check('JSエラーが無い（カードが描かれている）', cards().length, (n) => n > 0);
check('90日以内の動画が全て表示される', cards().length, SHOWN_DEFAULT);
check('最終更新が表示されている', $('#stamp').textContent, (t) => /最終更新 \d/.test(t));
check('件数表示', $('#count').textContent, (t) => t.includes(`${SHOWN_DEFAULT} 件を表示中`));
// 画面は3桁区切りで出す（1053 → 1,053）。生の数字ではなく整形後と比べる。
check('集計：表示中', $('#sum-shown').textContent, SHOWN_DEFAULT.toLocaleString('ja-JP'));
check('集計：収集数', $('#sum-total').textContent, DATA.videos.length.toLocaleString('ja-JP'));
check('集計：チャンネル数', Number($('#sum-channels').textContent),
  new Set(DATA.videos.map((v) => v.channelId)).size);
check('集計：7日以内の動画',
  Number($('#sum-week').textContent.replace(/,/g, '')),
  DATA.videos.filter((v) => (Date.now() - Date.parse(v.publishedAt)) / 86400000 <= 7).length);
check('主ジャンル内訳の行数', $$('#breakdown .bar-row').length, DATA.categories.length);
check('上段は主ジャンル12＋すべて', $$('#categories .chip').length, DATA.categories.length + 1);
check('下段は掛け合わせ6＋すべて', $$('#modifiers .chip').length, DATA.modifiers.length + 1);
check('主ジャンルの並びは辞書順',
  $$('#categories .chip .chip-name').slice(1).map((n) => n.textContent), DATA.categories);
check('掛け合わせの並びは辞書順',
  $$('#modifiers .chip .chip-name').slice(1).map((n) => n.textContent), DATA.modifiers);
check('既定の並びは伸びの速さ',
  idsOf().map((id) => byId.get(id).score.velocity), (v) => isSorted(v, desc));
check('カードにYouTubeリンクが新規タブで付く',
  $$('.card .link').every((a) => a.target === '_blank' && a.rel.includes('noopener')), true);
check('「1日あたり◯再生」が日本語で出る',
  $('.card .metric.vel').textContent, (t) => /^1日あたり [\d.,万億]+ 再生$/.test(t));
check('サンプルデータには注意書きが出る',
  DATA.isMock ? $('.notice')?.textContent : '（本番データ）',
  (t) => (DATA.isMock ? t.includes('サンプルデータ') : true));

// --- 2. 並び替え ----------------------------------------------------------

console.log('\n[2] 並び替え');
await select('#sort', 'acceleration');
const accs = idsOf().map((id) => byId.get(id).score.acceleration);
check('加速度の降順', accs.filter((a) => a !== null), (v) => isSorted(v, desc));
check('加速度が null の動画は末尾', accs, (v) => {
  const firstNull = v.indexOf(null);
  return firstNull === -1 || v.slice(firstNull).every((x) => x === null);
});

await select('#sort', 'views');
check('再生数の降順', idsOf().map((id) => byId.get(id).viewCount), (v) => isSorted(v, desc));

await select('#sort', 'subRatio');
check('登録者比の降順', idsOf().map((id) => byId.get(id).score.subRatio), (v) => isSorted(v, desc));

await select('#sort', 'newest');
check('新着順', idsOf().map((id) => Date.parse(byId.get(id).publishedAt)), (v) => isSorted(v, desc));

await select('#sort', 'velocity');

// --- 3. 絞り込み ----------------------------------------------------------

console.log('\n[3] 絞り込み');
await select('#subs', '10000');
const subsFiltered = idsOf().map((id) => byId.get(id).subscriberCount);
check('登録者1万人以下だけが残る', subsFiltered, (v) => v.length > 0 && v.every((s) => s <= 10000));
check('母数より減っている', subsFiltered.length, (n) => n < SHOWN_DEFAULT);
await select('#subs', '0');

// ショートは収集していないので、形式の絞り込みそのものが無い
check('形式の絞り込みは画面から消えている', $('#format'), null);
check('ショートバッジは出ない', $$('.card .badge.short').length, 0);
check('60秒以下の動画が混ざっていない',
  DATA.videos.filter((v) => v.durationSec > 0 && v.durationSec <= 60).length, 0);

await click(chip('period', '7日以内'));
const now = Date.now();
const ages = idsOf().map((id) => (now - Date.parse(byId.get(id).publishedAt)) / 86400000);
check('7日以内だけが残る', ages, (v) => v.every((d) => d <= 7));
check('7日以内は全件より少ない', ages.length, (n) => n < SHOWN_DEFAULT);
await click(chip('period', '30日以内'));
check('30日以内は7日以内より多い', cards().length, (n) => n > ages.length);
await click(chip('period', '90日以内'));

await click(chip('categories', 'ヘッドスパ'));
check('ヘッドスパだけ',
  idsOf().every((id) => byId.get(id).categories.includes('ヘッドスパ')), true);
const onlyHead = cards().length;
await click(chip('categories', 'エステティシャン'));
check('ヘッドスパ OR エステティシャン（上段どうしはOR）',
  idsOf().every((id) => byId.get(id).categories
    .some((c) => ['ヘッドスパ', 'エステティシャン'].includes(c))), true);
check('2つ選ぶと件数が増える', cards().length, (n) => n > onlyHead);
await click(chip('categories', 'エステティシャン'));
check('もう一度押すと外れる', cards().length, onlyHead);
await click(chip('categories', 'すべて'));
check('「すべて」で解除', cards().length, SHOWN_DEFAULT);

// --- 3b. 2段フィルタ（主ジャンル AND 掛け合わせ）-------------------------

console.log('\n[3b] 主ジャンルと掛け合わせの掛け算');

await click(chip('modifiers', '経営'));
check('掛け合わせ単独でも絞れる',
  idsOf().every((id) => (byId.get(id).modifiers || []).includes('経営')), true);
const onlyKeiei = cards().length;
check('全件より少ない', onlyKeiei, (n) => n > 0 && n < SHOWN_DEFAULT);

await click(chip('modifiers', 'スクール'));
check('経営 OR スクール（下段どうしはOR）',
  idsOf().every((id) => (byId.get(id).modifiers || [])
    .some((m) => ['経営', 'スクール'].includes(m))), true);
check('2つ選ぶと件数が増える', cards().length, (n) => n >= onlyKeiei);
await click(chip('modifiers', 'スクール'));

// ここが本題。上段と下段は AND。
await click(chip('categories', 'エステティシャン'));
check('エステティシャン かつ 経営（段をまたぐとAND）',
  idsOf().every((id) => {
    const v = byId.get(id);
    return v.categories.includes('エステティシャン') && (v.modifiers || []).includes('経営');
  }), true);
const andCount = cards().length;
check('ANDなのでどちらの単独よりも少ない', andCount, (n) => n > 0 && n < onlyKeiei);

// 期待値を素のデータからも数えて突き合わせる
const expectedAnd = DATA.videos.filter((v) =>
  (Date.now() - Date.parse(v.publishedAt)) / 86400000 <= 90
  && v.categories.includes('エステティシャン')
  && (v.modifiers || []).includes('経営')).length;
check('件数がデータから数えた値と一致', andCount, expectedAnd);
check('カードに主ジャンルと掛け合わせの両方のタグが出る',
  $$('.card').every((c) => {
    const tags = Array.from(c.querySelectorAll('.tag')).map((t) => t.textContent);
    return tags.includes('エステティシャン') && tags.includes('経営');
  }), true);
check('掛け合わせタグは見た目を分けている',
  $$('.card')[0].querySelectorAll('.tag-mod').length, (n) => n > 0);

await click(chip('categories', 'すべて'));
await click(chip('modifiers', 'すべて'));
check('両方解除で全件に戻る', cards().length, SHOWN_DEFAULT);

// 0件のチップは押せないことを見た目で示す
console.log('\n[3c] 0件のチップの扱い');
await type('絶対に一致しない語zzz');
check('0件でもチップは消えない', $$('#categories .chip').length, DATA.categories.length + 1);
check('0件のチップに pending が付く',
  $$('#categories .chip').filter((c) => c.dataset.name).every((c) => c.classList.contains('pending')),
  true);
check('pending チップは選べないと伝える',
  $$('#categories .chip').find((c) => c.dataset.name).getAttribute('aria-disabled'), 'true');
await type('');
// 検索を戻しても、実データで本当に0件のカテゴリは pending のまま残るのが正しい。
// （例: パーマネントジュエリーは日本語の動画がほとんど無く0件になる）
const emptyInData = DATA.categories.filter((c) =>
  !DATA.videos.some((v) => (v.categories || []).includes(c)
    && (Date.now() - Date.parse(v.publishedAt)) / 86400000 <= 90));
const pendingNow = $$('#categories .chip')
  .filter((c) => c.dataset.name && c.classList.contains('pending'))
  .map((c) => c.dataset.name);
check('検索を戻すと、本当に0件のカテゴリだけ pending が残る',
  pendingNow.sort(), emptyInData.slice().sort());

// --- 4. 検索 --------------------------------------------------------------

console.log('\n[4] フリーワード検索');
const sampleChannel = DATA.videos[0].channelTitle;
await type(sampleChannel);
check(`チャンネル名「${sampleChannel}」で絞れる`,
  idsOf().every((id) => byId.get(id).channelTitle === sampleChannel), true);
check('件数が減っている', cards().length, (n) => n > 0 && n < SHOWN_DEFAULT);

const word = '毛穴ケア';
await type(word);
check(`タイトル「${word}」で絞れる`, cardTitles().every((t) => t.includes(word)), true);

await type('zzz該当なしzzz');
check('該当なしのとき0件', cards().length, 0);
check('空状態の案内が出る', $('.empty').textContent, (t) => t.includes('条件に合う動画がありません'));
await type('');
check('検索クリアで全件に戻る', cards().length, SHOWN_DEFAULT);

// --- 5. CSV ---------------------------------------------------------------

console.log('\n[5] CSVダウンロード');
await click(chip('categories', 'ヘッドスパ'));
await click($('#csv'));
const lines = (csvBlobText || '').replace(/^﻿/, '').trim().split('\r\n');
check('BOM付き（Excelで文字化けしない）', (csvBlobText || '').charCodeAt(0), 0xfeff);
check('ヘッダー行', lines[0], (t) => t.startsWith('"順位","タイトル","チャンネル名"'));
check('CSVに主ジャンルと掛け合わせの列がある', lines[0],
  (t) => t.includes('"主ジャンル","掛け合わせ"'));
check('CSVに形式の列は無い', lines[0], (t) => !t.includes('"形式"'));
check('行数＝絞り込み後の件数＋ヘッダー', lines.length, cards().length + 1);
check('1行目にURLが入る', lines[1], (t) => t.includes('https://www.youtube.com/watch?v='));
check('全セルがクォートされている', lines[1], (t) => /^"/.test(t) && /"$/.test(t));
await click(chip('categories', 'すべて'));

// --- 6. データが空のとき --------------------------------------------------

console.log('\n[6] データが読めないとき');
const dom2 = new JSDOM(readFileSync(join(DOCS, 'index.html'), 'utf8'), {
  url: 'https://example.github.io/youtube-beauty-trends/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
dom2.window.fetch = async () => ({ ok: false, status: 404 });
await boot(dom2);
check('404でも落ちずに案内を出す',
  dom2.window.document.querySelector('.empty').textContent,
  (t) => t.includes('データを読み込めませんでした'));

// --- 7. HTMLエスケープ ----------------------------------------------------

console.log('\n[7] タイトルがHTMLとして解釈されない');
const dom3 = new JSDOM(readFileSync(join(DOCS, 'index.html'), 'utf8'), {
  url: 'https://example.github.io/youtube-beauty-trends/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const evil = { ...DATA.videos[0], videoId: 'evil0000001', title: '<img src=x onerror=alert(1)>危険' };
dom3.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ...DATA, videos: [evil] }) });
await boot(dom3);
check('タグが文字列として表示される',
  dom3.window.document.querySelector('.title').textContent, evil.title);
check('img要素は生成されない', dom3.window.document.querySelectorAll('.title img').length, 0);

// --- 8. スマホ向けの絞り込み開閉 -------------------------------------------

console.log('\n[8] 絞り込みの開閉とバッジ');

// 構造：畳む対象がすべて filter-body の中にあること
const body = $('#filter-body');
check('絞り込みは filter-body にまとまっている',
  ['#subs', '#period', '#categories', '#modifiers', '#search', '#csv']
    .every((sel) => body.querySelector(sel) !== null), true);
check('並び替えは畳まれない（常に押せる）', body.querySelector('#sort'), null);
check('開閉ボタンは filter-body の外にある', body.querySelector('#filter-toggle'), null);

// 開閉
const controls = $('#controls');
const toggle = $('#filter-toggle');
check('初期状態は閉じている', controls.classList.contains('open'), false);
check('初期の aria-expanded', toggle.getAttribute('aria-expanded'), 'false');
check('開閉ボタンは filter-body を指している',
  toggle.getAttribute('aria-controls'), 'filter-body');
await click(toggle);
check('押すと開く', controls.classList.contains('open'), true);
check('開いたら aria-expanded も変わる', toggle.getAttribute('aria-expanded'), 'true');
await click(toggle);
check('もう一度押すと閉じる', controls.classList.contains('open'), false);

// バッジ（畳んだままでも、いくつ絞り込んでいるか分かるように）
const badge = $('#filter-badge');
check('絞り込みが無ければバッジは出ない', badge.hidden, true);

await click(chip('categories', 'ヘッドスパ'));
check('主ジャンル1つでバッジ1', [badge.hidden, badge.textContent], [false, '1']);

await click(chip('modifiers', '経営'));
check('掛け合わせも足されてバッジ2', badge.textContent, '2');

await select('#subs', '10000');
check('登録者数の絞り込みも数える', badge.textContent, '3');

await click(chip('period', '7日以内'));
check('公開日を既定から変えたら数える', badge.textContent, '4');

await type('サロン');
check('フリーワードも数える', badge.textContent, '5');

// すべて解除
await type('');
await click(chip('period', '90日以内'));
await select('#subs', '0');
await click(chip('modifiers', 'すべて'));
await click(chip('categories', 'すべて'));
check('全部解除するとバッジが消える', [badge.hidden, badge.textContent], [true, '0']);
check('解除後は全件に戻る', cards().length, SHOWN_DEFAULT);

// --- まとめ ---------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} 件が期待どおり`);
if (failures > 0) {
  console.log(`${failures} 件が失敗`);
  process.exit(1);
}
console.log('すべて期待どおりです');
