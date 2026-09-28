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
  // 公開日のチップだけが残っている（ジャンルのチップは 2026-09-28 に廃止）
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
check('件数表示', $('#count').textContent, (t) => t.includes(`${SHOWN_DEFAULT} 件を表示中`));
// 集計タイル・カテゴリ別の棒・最終更新の行・ジャンルのチップは廃止した（2026-09-28）
check('集計タイルが無い', $$('.summary, .stat, #sum-shown').length, 0);
check('カテゴリ別の棒が無い', $$('#breakdown, .bar-row').length, 0);
check('最終更新の行が無い', $('#stamp'), null);
check('ジャンルのチップ列が無い', [$('#categories'), $('#modifiers')], [null, null]);
check('見出しの次が検索窓', $('.head').nextElementSibling.id, 'controls');
check('操作バーの先頭が検索窓', $('#controls').firstElementChild.id, 'search-form');
// 候補（◯◯サロンを除く）は keywords.yml の順
check('入力候補の並びは辞書順',
  $$('#genre-suggest .suggest-item:not(.combo)').map((n) => n.textContent), DATA.categories);
check('datalist を使っていない（iPhone の Safari などで一覧が出ない）',
  [$('datalist'), $('#search').hasAttribute('list')], [null, false]);
check('標準モードで描かれる（doctype あり）', doc.compatMode, 'CSS1Compat');
check('キャッシュしない指定がある',
  !!$('meta[http-equiv="Cache-Control"][content*="no-cache"]'), true);
check('CSS と JS に版番号を付けている（アプリ内ブラウザに古い版を使わせない）',
  [$('link[rel=stylesheet]').getAttribute('href'), $('script[src]').getAttribute('src')],
  (v) => v.every((x) => /\?v=\d+/.test(x)));
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

// --- 3b. 語で探す（ジャンルのタブの代わり）--------------------------------

console.log('\n[3b] 語で探す');
const inWindow = (v) => (Date.now() - Date.parse(v.publishedAt)) / 86400000 <= 90;
const hay = (v) => ((v.title || '') + ' ' + (v.channelTitle || '')).normalize('NFKC').toLowerCase();

// ジャンル名で探すと、そのジャンルで集めた動画＋タイトル・チャンネル名にその語を含む動画
await type('ヘッドスパ');
const wantHead = DATA.videos.filter((v) => inWindow(v)
  && ((v.categories || []).includes('ヘッドスパ') || hay(v).includes('ヘッドスパ'))).length;
check('ジャンル名でジャンル＋タイトル一致', cards().length, wantHead);
check('全件より少ない', wantHead, (n) => n > 0 && n < SHOWN_DEFAULT);
check('ヒントにジャンル名が出る', $('#hint').textContent, (t) => t.includes('「ヘッドスパ」で集めた動画'));
await type('へっどすぱ');
check('ひらがなでもジャンルに当たる', cards().length, wantHead);

// 掛け合わせ語（旧・下段のチップ）も語で探せる
await type('経営');
const wantKeiei = DATA.videos.filter((v) => inWindow(v)
  && ((v.modifiers || []).includes('経営') || hay(v).includes('経営'))).length;
check('掛け合わせ語でも絞れる', cards().length, wantKeiei);

// 旧・上下段の AND は「ジャンル 掛け合わせ語」で表せる
await type('エステティシャン 経営');
const wantAnd = DATA.videos.filter((v) => inWindow(v)
  && ((v.categories || []).includes('エステティシャン') || hay(v).includes('エステティシャン'))
  && ((v.modifiers || []).includes('経営') || hay(v).includes('経営'))).length;
check('空白区切りはAND（エステティシャン かつ 経営）', cards().length, wantAnd);
check('ANDなのでどちらの単独よりも少ない', wantAnd, (n) => n > 0 && n <= wantKeiei);
await type('エステティシャン　経営');
check('全角空白でも区切れる', cards().length, wantAnd);
check('カードに主ジャンルと掛け合わせのタグが出る（タグは見た目を分けている）',
  $$('.card .tag-mod').length, (n) => n > 0);

// 「◯◯サロン」「◯◯×サロン」は、ジャンルと「サロン」の掛け合わせとして読む
const wantSalon = DATA.videos.filter((v) => inWindow(v)
  && ((v.categories || []).includes('ヘッドスパ') || hay(v).includes('ヘッドスパ'))
  && hay(v).includes('サロン')).length;
const salonCounts = [];
for (const q of ['ヘッドスパサロン', 'ヘッドスパ×サロン', 'ヘッドスパ✖️サロン', 'へっどすぱ さろん']) {
  await type(q);
  salonCounts.push(cards().length);
}
check('「ヘッドスパサロン」＝ヘッドスパ×サロン（書き方によらず同じ）', salonCounts,
  (c) => c.every((n) => n === wantSalon));
await type('ヘッドスパサロン');
check('ヒントに「サロン」も含む旨が出る', $('#hint').textContent, (t) => t.includes('「サロン」も'));
await type('エステサロン');
check('前半がジャンル名でなければ分けずに探す', $('#hint').textContent,
  (t) => t.includes('タイトルと') && !t.includes('で集めた'));
await type('');
check('空欄に戻すと全件', cards().length, SHOWN_DEFAULT);
check('空欄のヒントは全ジャンルの案内', $('#hint').textContent, (t) => t.includes('全ジャンル'));

// --- 3c. 入力候補 ---------------------------------------------------------

console.log('\n[3c] 入力候補（スマホでも出る自前の一覧）');
const box = $('#genre-suggest');
const input = $('#search');
const shown = () => $$('#genre-suggest .suggest-item').filter((li) => !li.hidden).map((li) => li.textContent);
input.dispatchEvent(new window.Event('blur'));
check('フォーカスが無ければ閉じている', box.hidden, true);
input.dispatchEvent(new window.Event('focus'));
check('タップ（フォーカス）で開く', [box.hidden, input.getAttribute('aria-expanded')], [false, 'true']);
check('空欄なら全ジャンル（◯◯サロンは出さない）', shown(), DATA.categories);
input.value = 'へっど';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
check('打ちかけの語で絞る（ひらがなでも当たる。◯◯サロンも出る）', shown(), ['ヘッドスパ', 'ヘッドスパサロン']);
input.value = 'ざざざ';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
check('当たる候補が無ければ閉じる', box.hidden, true);
input.value = '経営×へっど';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
check('「×」の後ろの語で絞る', shown(), ['ヘッドスパ', 'ヘッドスパサロン']);
const item = $$('#genre-suggest .suggest-item').find((li) => li.textContent === 'ヘッドスパサロン');
const md = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
item.dispatchEvent(md);
check('押した瞬間はフォーカスを動かさない', md.defaultPrevented, true);
await click(item);
check('選ぶと最後の語が置き換わる', input.value, '経営×ヘッドスパサロン');
check('選ぶと閉じる', box.hidden, true);
check('選ぶとすぐ検索が効く（待たない）', $('#hint').textContent, (t) => t.includes('「経営」「ヘッドスパ」'));
check('URL の ?q= も変わる', new window.URL(window.location.href).searchParams.get('q'), '経営×ヘッドスパサロン');
input.dispatchEvent(new window.Event('blur'));
await click(input);
check('タップだけでも開く（アプリ内ブラウザ対策）', box.hidden, false);
input.dispatchEvent(new window.Event('blur'));
// キーボード操作（PC）
await type('');
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
const ent = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
input.dispatchEvent(ent);
check('↓とEnterで先頭の候補に決まる', [input.value, ent.defaultPrevented], [DATA.categories[0], true]);
input.dispatchEvent(new window.Event('focus'));
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
check('Escで閉じる', box.hidden, true);
// 変換中の Enter では候補を決めない
input.value = '';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
check('変換確定のEnterでは決めない', input.value, '');
// 「検索」ボタン/Enter でページが再読み込みされない
input.value = 'ヘッドスパ';
const sub = new window.Event('submit', { bubbles: true, cancelable: true });
$('#search-form').dispatchEvent(sub);
await settle();
check('送信してもページ遷移しない', sub.defaultPrevented, true);
check('送信するとすぐ検索が効く', cards().length, wantHead);
await type('');
input.dispatchEvent(new window.Event('blur'));

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
check('空状態の案内は文節ごとに括られている',
  $$('.empty .nb').map((n) => n.textContent).join(''), $('.empty').textContent);
await type('');
check('検索クリアで全件に戻る', cards().length, SHOWN_DEFAULT);

// --- 5. CSV ---------------------------------------------------------------

console.log('\n[5] CSVダウンロード');
await type('ヘッドスパ');
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
await type('');

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

// --- 8. 絞り込みが隠れていないこと ----------------------------------------

console.log('\n[8] 絞り込みが常に見えていること');

// スマホでは畳む案を一度入れたが、ジャンル別の件数が見えなくなって使いにくかった。
// 隠す仕掛けを戻さないよう、ここで固定しておく。
check('開閉ボタンは存在しない', $('#filter-toggle'), null);
check('件数バッジは存在しない', $('#filter-badge'), null);
check('controls に open 状態は無い', $('#controls').className.includes('open'), false);

// 絞り込みの部品が全部そのまま DOM にあること
check('絞り込みの部品が揃っている',
  ['#sort', '#subs', '#period', '#search', '#genre-suggest', '#csv']
    .filter((sel) => $(sel) === null), []);

// 隠す指定が紛れ込んでいないか（CSS の意図を明文化しておく）
const css = readFileSync(join(DOCS, 'style.css'), 'utf8');
check('スマホで controls を固定しない', css, (t) => /\.controls\s*\{[^}]*position:\s*static/.test(t));
check('filter-body を display:none にしていない', css, (t) => !/\.filter-body\s*\{\s*display:\s*none/.test(t));

// --- まとめ ---------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} 件が期待どおり`);
if (failures > 0) {
  console.log(`${failures} 件が失敗`);
  process.exit(1);
}
console.log('すべて期待どおりです');
