/*
 * videos.json を読んで一覧を描く。
 *
 * ビルド不要・フレームワーク不使用・外部CDNへの依存ゼロ。
 * data/videos.json は相対パスで読むので、GitHub Pages の /リポジトリ名/ 配下でも動く。
 *
 * 動画のタイトルやチャンネル名は外部から来る文字列なので、
 * innerHTML には入れず textContent で入れている（HTMLとして解釈させない）。
 */

'use strict';

// --- 状態 -----------------------------------------------------------------
const state = {
  sort: 'velocity',
  periodDays: 90,
  subsMax: 0,         // 0 は制限なし
  // 検索窓の語。ジャンルのタブは廃止した（2026-09-28）。語で探す
  query: '',
};

let allVideos = [];
let allCategories = [];
let allModifiers = [];
let now = new Date();

// 登録者数に対してこの倍率を超えた動画を「跳ねた」ものとして目立たせる
const RISING_SUB_RATIO = 10;

const PERIODS = [
  { value: 7,  label: '7日以内' },
  { value: 30, label: '30日以内' },
  { value: 90, label: '90日以内' },
];

// --- 表示用の整形 ---------------------------------------------------------

/** 大きい数を「47.7万」のように読みやすくする。 */
function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '億';
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return v.toLocaleString('ja-JP');
}

/** 指標の数字。1未満まで潰れると差が見えないので、小さい値だけ小数を残す。 */
function formatMetric(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return formatCount(Math.round(v));
  if (v >= 10) return Math.round(v).toLocaleString('ja-JP');
  return v.toFixed(1);
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
}

function parseDate(value) {
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function daysSince(value) {
  const d = parseDate(value);
  if (!d) return null;
  return (now - d) / 86400000;
}

function formatDate(value) {
  const d = parseDate(value);
  if (!d) return '不明';
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
}

// --- 検索語の読み方 -------------------------------------------------------
//
// ジャンルのタブは置かない。調べたい語を打つと、その語で伸びている動画が出る。
// Threads / Instagram 版と同じ規則にしてある。
//
//   - 全角/半角と英字の大小はそろえる（「ＡＧＡ」でも「aga」でも当たる）
//   - 空白・「×」「✕」「✖️」で区切った語はすべて含むもの（AND）
//   - ジャンル名と同じ語は「そのジャンルで集めた動画」＋「タイトル・チャンネル名に
//     その語を含む動画」。ジャンルの動画は収集時に関連度フィルタを通っているので、
//     タイトルに語そのものが無くても話題は合っている
//   - 掛け合わせ語（経営・メニューなど）も同じ。「エステティシャン 経営」で
//     集めた動画が「経営」で当たる
//   - ジャンル名はひらがな・カタカナの違いも吸収する（「しみ」でジャンル「シミ」）。
//     ただしタイトルはジャンル名の表記で探す。「しみ」のまま探すと
//     「楽しみ」「しみじみ」が大量に当たるため
//   - 「ネイルサロン」は「ネイル」と「サロン」の掛け合わせとして読む。1語のまま探すと
//     「ネイルサロン」と続けて書いたタイトルしか当たらないため。
//     前半がジャンル名・掛け合わせ語のときだけ分ける（「エステサロン」はそのまま探す）

const SALON = 'サロン';
const SEP = /[\s×✕✖️]+/;
let NAMED = {};   // かなを寄せた語 → { name, kind: 'genre' | 'mod' }

function norm(t) {
  let s = String(t || '');
  if (s.normalize) s = s.normalize('NFKC');
  return s.toLowerCase();
}

// ひらがなをカタカナに寄せる。ジャンル名との突き合わせにだけ使う
function kana(t) {
  return norm(t).replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

function buildNamed() {
  NAMED = {};
  allCategories.forEach((g) => { NAMED[kana(g)] = { name: g, kind: 'genre' }; });
  allModifiers.forEach((m) => {
    if (!NAMED[kana(m)]) NAMED[kana(m)] = { name: m, kind: 'mod' };
  });
}

function parseQuery(raw) {
  const terms = [];
  norm(raw).split(SEP).filter(Boolean).forEach((w) => {
    const k = kana(w);
    const hit = NAMED[k] || null;
    if (!hit && k.length > SALON.length && k.endsWith(SALON)) {
      const head = NAMED[k.slice(0, -SALON.length)] || null;
      if (head) {
        terms.push({ word: norm(head.name), named: head });
        terms.push({ word: norm(SALON), named: null });
        return;
      }
    }
    // 「さろん」とひらがなで打っても、タイトルは「サロン」の表記で探す
    if (!hit && k === SALON) {
      terms.push({ word: norm(SALON), named: null });
      return;
    }
    terms.push({ word: hit ? norm(hit.name) : w, named: hit });
  });
  return terms;
}

function matches(v, terms) {
  if (!terms.length) return true;
  if (v._hay === undefined) v._hay = norm((v.title || '') + ' ' + (v.channelTitle || ''));
  return terms.every((t) => {
    if (t.named) {
      const pool = t.named.kind === 'genre' ? (v.categories || []) : (v.modifiers || []);
      if (pool.includes(t.named.name)) return true;
    }
    return v._hay.includes(t.word);
  });
}

// --- 絞り込みと並び替え ---------------------------------------------------

function filtered() {
  const terms = parseQuery(state.query);

  return allVideos.filter((v) => {
    const age = daysSince(v.publishedAt);
    if (age === null || age > state.periodDays) return false;

    if (state.subsMax > 0 && (v.subscriberCount || 0) > state.subsMax) return false;

    return matches(v, terms);
  });
}

function sorted(videos) {
  const list = videos.slice();
  const score = (v) => v.score || {};

  switch (state.sort) {
    case 'acceleration':
      // 前回データが無い動画は加速度が null。0 と混ぜると順位が嘘になるので必ず末尾に置く。
      return list.sort((a, b) => {
        const x = score(a).acceleration;
        const y = score(b).acceleration;
        if (x === null || x === undefined) return (y === null || y === undefined) ? 0 : 1;
        if (y === null || y === undefined) return -1;
        return y - x;
      });
    case 'views':
      return list.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
    case 'subRatio':
      return list.sort((a, b) => (score(b).subRatio || 0) - (score(a).subRatio || 0));
    case 'newest':
      return list.sort((a, b) => (parseDate(b.publishedAt) || 0) - (parseDate(a.publishedAt) || 0));
    default:
      return list.sort((a, b) => (score(b).velocity || 0) - (score(a).velocity || 0));
  }
}

// --- 描画 -----------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** ラベルと数字が離れないよう、1指標を丸ごと nowrap の中に入れる。 */
function metric(className, label, value, suffix) {
  const node = el('span', 'metric ' + className);
  node.appendChild(document.createTextNode(label));
  node.appendChild(el('b', null, value));
  if (suffix) node.appendChild(document.createTextNode(suffix));
  return node;
}

function buildCard(video, rank) {
  const s = video.score || {};
  const card = el('article', 'card' + (s.subRatio >= RISING_SUB_RATIO ? ' rising' : ''));
  const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(video.videoId);

  // --- サムネイル ---
  const thumbLink = el('a', 'thumb');
  thumbLink.href = url;
  thumbLink.target = '_blank';
  thumbLink.rel = 'noopener noreferrer';
  if (video.thumbnail) {
    const img = el('img');
    img.src = video.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    thumbLink.appendChild(img);
  } else {
    thumbLink.appendChild(el('span', 'noimg', 'サムネイル無し'));
  }
  if (video.durationSec) thumbLink.appendChild(el('span', 'dur', formatDuration(video.durationSec)));
  card.appendChild(thumbLink);

  // --- 本文 ---
  const body = el('div', 'card-body');

  const head = el('div', 'card-head');
  head.appendChild(el('span', 'rank', '#' + rank));
  if (s.subRatio >= RISING_SUB_RATIO) {
    head.appendChild(el('span', 'badge hit', '登録者の' + formatMetric(s.subRatio) + '倍'));
  }
  body.appendChild(head);

  const title = el('h2', 'title');
  const titleLink = el('a', null, video.title || '(タイトル無し)');
  titleLink.href = url;
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  title.appendChild(titleLink);
  body.appendChild(title);

  const channel = el('p', 'channel');
  channel.appendChild(el('span', 'name nb', video.channelTitle || '(チャンネル名不明)'));
  channel.appendChild(document.createTextNode('　'));
  channel.appendChild(el('span', 'nb', '登録者 ' + formatCount(video.subscriberCount) + '人'));
  body.appendChild(channel);

  // 伸びの指標
  const growth = el('div', 'metrics');
  growth.appendChild(metric('vel', '1日あたり ', formatMetric(s.velocity), ' 再生'));
  if (s.acceleration === null || s.acceleration === undefined) {
    growth.appendChild(el('span', 'metric', '直近の伸び 計測待ち'));
  } else {
    const sign = s.acceleration >= 0 ? '+' : '−';
    growth.appendChild(metric('acc', '直近 ', sign + formatMetric(Math.abs(s.acceleration)), ' 再生/日'));
  }
  growth.appendChild(metric('', '登録者の ', formatMetric(s.subRatio), ' 倍'));
  body.appendChild(growth);

  // 実数
  const raw = el('div', 'metrics');
  raw.appendChild(metric('', '再生 ', formatCount(video.viewCount)));
  raw.appendChild(metric('', 'いいね ', formatCount(video.likeCount)));
  raw.appendChild(metric('', 'コメント ', formatCount(video.commentCount)));
  const age = daysSince(video.publishedAt);
  raw.appendChild(el('span', 'metric',
    formatDate(video.publishedAt) + ' 公開' + (age === null ? '' : '（' + Math.floor(age) + '日前）')));
  body.appendChild(raw);

  const tags = el('div', 'tags');
  // どの語の収集で見つかったかを「主ジャンル＋掛け合わせ」で出す。
  // 検索語そのものを出すと「エステティシャン」と「エステティシャン 経営」が
  // 並んで冗長になるため、検索語は出さない。
  const cats = video.categories || [];
  const seen = new Set();
  cats.concat(video.modifiers || []).forEach((t) => {
    if (seen.has(t)) return;
    seen.add(t);
    // 主ジャンルは塗り、掛け合わせは枠線だけにして見分けが付くようにする
    tags.appendChild(el('span', cats.includes(t) ? 'tag' : 'tag tag-mod', t));
  });
  const link = el('a', 'link', 'YouTubeで開く →');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  tags.appendChild(link);
  body.appendChild(tags);

  card.appendChild(body);
  return card;
}

/** 文節を1かたまりずつ .nb で置く。途中で改行されず、助詞が行頭に来ない。 */
function phrases(parent, list) {
  list.forEach((t) => parent.appendChild(el('span', 'nb', t)));
  return parent;
}

// 検索欄の下の一言。自前の文言なので文節ごとに .nb で括る
function renderHint(terms) {
  const hint = document.getElementById('hint');
  hint.textContent = '';
  if (!terms.length) {
    phrases(hint, ['空欄のときは', '全ジャンルの', '伸びている動画を', '表示します。',
                   '複数の語は', '空白で区切ると', 'すべて含む動画に', '絞れます。']);
    return;
  }
  const named = terms.filter((t) => t.named).map((t) => '「' + t.named.name + '」');
  const plain = terms.filter((t) => !t.named).map((t) => '「' + t.word + '」');
  if (named.length && plain.length) {
    // 「ネイルサロン」＝ネイルで集めた動画のうち、サロンも含むもの
    phrases(hint, [named.join(''), 'で集めた動画と、', 'タイトルに', '語を含む動画のうち、',
                   plain.join('') + 'も', '含むものを', '出しています。']);
  } else if (named.length) {
    phrases(hint, [named.join(''), 'で集めた動画と、', 'タイトルに', '語を含む動画を',
                   '出しています。']);
  } else {
    phrases(hint, ['タイトルと', 'チャンネル名から', '探しています。']);
  }
}

function render() {
  renderHint(parseQuery(state.query));
  const videos = sorted(filtered());
  const list = document.getElementById('list');
  list.textContent = '';

  document.getElementById('count').textContent =
    videos.length + ' 件を表示中（収集 ' + allVideos.length + ' 件）';

  if (videos.length === 0) {
    // 「別の語で」を1かたまりにして、「で」が行頭に来ないようにする
    list.appendChild(phrases(el('p', 'empty'), [
      '条件に合う動画が', 'ありません。', '別の語で', '検索するか、', '絞り込みを', '緩めてください。',
    ]));
    return;
  }

  const frag = document.createDocumentFragment();
  videos.forEach((v, i) => frag.appendChild(buildCard(v, i + 1)));
  list.appendChild(frag);
}

// --- 操作バーの組み立て ---------------------------------------------------

function makeChip(label, onClick) {
  const chip = el('button', 'chip');
  chip.type = 'button';
  chip.appendChild(el('span', 'chip-name', label));
  chip.addEventListener('click', onClick);
  return chip;
}

function buildPeriodChips() {
  const box = document.getElementById('period');
  PERIODS.forEach((p) => {
    const chip = makeChip(p.label, () => {
      state.periodDays = p.value;
      syncChipStates();
      render();
    });
    chip.dataset.period = String(p.value);
    box.appendChild(chip);
  });
}

function syncChipStates() {
  document.querySelectorAll('#period .chip').forEach((chip) => {
    const on = Number(chip.dataset.period) === state.periodDays;
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// --- 入力候補 -------------------------------------------------------------
// タブの代わりに、検索窓をタップしたとき収集ジャンルを一覧で見せる。
// <datalist> は iPhone の Safari などで一覧が出ないので自前で組む。
// 候補は打ちかけの最後の語で絞る（ひらがなでも当たる）。選ぶとその語に置き換える。
// 各ジャンルのすぐ後ろに「◯◯サロン」も置く。こちらは何か打ちかけたときだけ出す
// （空欄で全部出すと候補が倍の長さになり、目当てのジャンルを探しにくい）。

let suggestItems = [];
let activeIndex = -1;

function buildSuggest() {
  const box = document.getElementById('genre-suggest');
  box.textContent = '';
  suggestItems = [];
  const add = (label, id, combo) => {
    const li = el('li', 'suggest-item' + (combo ? ' combo' : ''), label);
    li.setAttribute('role', 'option');
    li.id = id;
    li.dataset.genre = label;
    li.dataset.key = kana(label);
    if (combo) li.dataset.combo = '1';
    box.appendChild(li);
    suggestItems.push(li);
  };
  allCategories.forEach((g, i) => {
    add(g, 'suggest-' + i, false);
    // 「美容サロン」に「サロン」を重ねない
    if (!kana(g).endsWith(SALON)) add(g + SALON, 'suggest-s' + i, true);
  });
}

// 打ちかけの最後の語。「ネイル×サ」の「サ」のように、× の後ろも1語として見る
function lastWord(v) {
  const m = String(v).match(/(^|[\s×✕✖️])([^\s×✕✖️]*)$/);
  return m ? m[2] : '';
}

function visibleItems() {
  return suggestItems.filter((li) => !li.hidden);
}

function setActive(i) {
  const input = document.getElementById('search');
  const items = visibleItems();
  suggestItems.forEach((li) => { li.classList.remove('active'); li.removeAttribute('aria-selected'); });
  activeIndex = items.length ? Math.max(-1, Math.min(i, items.length - 1)) : -1;
  if (activeIndex >= 0) {
    const li = items[activeIndex];
    li.classList.add('active');
    li.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', li.id);
    if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

function openSuggest() {
  const input = document.getElementById('search');
  const box = document.getElementById('genre-suggest');
  const key = kana(lastWord(input.value));
  let shown = 0;
  suggestItems.forEach((li) => {
    const hit = key ? li.dataset.key.includes(key) : !li.dataset.combo;
    li.hidden = !hit;
    if (hit) shown += 1;
  });
  box.hidden = shown === 0;
  input.setAttribute('aria-expanded', shown ? 'true' : 'false');
  setActive(-1);
}

function closeSuggest() {
  document.getElementById('genre-suggest').hidden = true;
  document.getElementById('search').setAttribute('aria-expanded', 'false');
  setActive(-1);
}

// --- URL の ?q= -------------------------------------------------------------
// ?q= で開くと、その語で検索した状態から始まる。よく見る語をブックマークしておけるように

function readUrlQuery() {
  try {
    return new URLSearchParams(window.location.search).get('q') || '';
  } catch (e) {
    return '';
  }
}

function writeUrlQuery(value) {
  try {
    const url = new URL(window.location.href);
    const v = String(value || '').trim();
    if (v) url.searchParams.set('q', v); else url.searchParams.delete('q');
    window.history.replaceState(null, '', url.toString());
  } catch (e) {
    // file:// などで書けなくても検索は続ける
  }
}

// --- CSV ------------------------------------------------------------------

const CSV_HEADERS = [
  '順位', 'タイトル', 'チャンネル名', '登録者数', '再生数', 'いいね数', 'コメント数',
  '1日あたり再生数', '加速度(再生/日)', '登録者比', '公開日', '長さ(秒)',
  '主ジャンル', '掛け合わせ', 'ヒットしたキーワード', 'URL',
];

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  // Excel で数式として解釈されないよう、記号で始まるセルの頭に空白を足す
  const safe = /^[=+\-@]/.test(text) ? ' ' + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}

function downloadCsv() {
  const videos = sorted(filtered());
  const rows = [CSV_HEADERS.map(csvCell).join(',')];

  videos.forEach((v, i) => {
    const s = v.score || {};
    rows.push([
      i + 1,
      v.title || '',
      v.channelTitle || '',
      v.subscriberCount || 0,
      v.viewCount || 0,
      v.likeCount || 0,
      v.commentCount || 0,
      s.velocity === undefined ? '' : s.velocity,
      s.acceleration === null || s.acceleration === undefined ? '' : s.acceleration,
      s.subRatio === undefined ? '' : s.subRatio,
      formatDate(v.publishedAt),
      v.durationSec || 0,
      (v.categories || []).join(' / '),
      (v.modifiers || []).join(' / '),
      (v.matchedKeywords || []).join(' / '),
      'https://www.youtube.com/watch?v=' + v.videoId,
    ].map(csvCell).join(','));
  });

  // 先頭の BOM が無いと Excel が日本語を文字化けさせる
  const blob = new Blob(['﻿' + rows.join('\r\n') + '\r\n'],
    { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'youtube-beauty-trends-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- 起動 -----------------------------------------------------------------

function bindControls() {
  document.getElementById('sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    render();
  });
  document.getElementById('subs').addEventListener('change', (e) => {
    state.subsMax = Number(e.target.value) || 0;
    render();
  });

  const input = document.getElementById('search');
  const box = document.getElementById('genre-suggest');

  // 検索語を反映する。URL の ?q= も合わせて書き換える
  const applyQuery = (value) => {
    state.query = value;
    render();
    writeUrlQuery(value);
  };

  let timer = null;
  input.addEventListener('input', (e) => {
    // 候補はすぐ絞る。一覧は1文字ごとに全件描き直すと重いので、入力が止まってから描く
    openSuggest();
    const value = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => applyQuery(value), 180);
  });

  // 選んだジャンルで、打ちかけの最後の語を置き換えて検索する。
  // スマホではキーボードを閉じて結果を見せる
  const pickGenre = (label) => {
    const v = input.value;
    input.value = v.slice(0, v.length - lastWord(v).length) + label;
    clearTimeout(timer);
    closeSuggest();
    applyQuery(input.value);
    input.blur();
  };

  input.addEventListener('focus', openSuggest);
  // アプリ内ブラウザでは、すでにフォーカスがある検索窓をもう一度タップしても
  // focus が来ない（キーボードだけ閉じて開き直す）ことがある。タップでも開く
  input.addEventListener('click', () => { if (box.hidden) openSuggest(); });
  // 一覧の外をタップしたら閉じる
  input.addEventListener('blur', closeSuggest);

  // タップした瞬間に検索窓からフォーカスが外れると、先に一覧が閉じて
  // 選べなくなる。押した時点ではフォーカスを動かさない
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => {
    const li = e.target.closest ? e.target.closest('.suggest-item') : null;
    if (li) pickGenre(li.dataset.genre);
  });

  // 日本語入力の変換を確定する Enter で、検索が走ってキーボードが閉じないようにする。
  // isComposing だけでは Safari で確定直後の Enter を取りこぼすので、
  // compositionend の直後も1拍だけ「変換中」とみなす
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    setTimeout(() => { composing = false; }, 0);
  });

  // PC では矢印キーで候補を選び、Enter で決める。Esc で閉じる
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || composing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (box.hidden) openSuggest();
      e.preventDefault();
      setActive(activeIndex + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && activeIndex >= 0 && !box.hidden) {
      e.preventDefault();
      pickGenre(visibleItems()[activeIndex].dataset.genre);
    } else if (e.key === 'Escape') {
      closeSuggest();
    }
  });

  // Enter や「検索」ボタンでページが再読み込みされないようにする
  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (composing) return;
    clearTimeout(timer);
    closeSuggest();
    applyQuery(input.value);
    input.blur();
  });

  document.getElementById('csv').addEventListener('click', downloadCsv);
}

function showError(message) {
  const list = document.getElementById('list');
  list.textContent = '';
  list.appendChild(el('p', 'empty error', message));
}

async function main() {
  buildPeriodChips();
  bindControls();

  let payload;
  try {
    const res = await fetch('data/videos.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    payload = await res.json();
  } catch (err) {
    showError('データを読み込めませんでした（' + err.message + '）。まだ収集が1回も走っていない可能性があります。');
    return;
  }

  allVideos = Array.isArray(payload.videos) ? payload.videos : [];
  // 並びは keywords.yml の順。無ければ実データから拾う。
  allCategories = Array.isArray(payload.categories) && payload.categories.length
    ? payload.categories
    : Array.from(new Set(allVideos.flatMap((v) => v.categories || [])));
  allModifiers = Array.isArray(payload.modifiers) && payload.modifiers.length
    ? payload.modifiers
    : Array.from(new Set(allVideos.flatMap((v) => v.modifiers || [])));

  // サンプルデータを本物と取り違えないよう、はっきり注意書きを出す
  if (payload.isMock) {
    const notice = el('p', 'notice');
    notice.appendChild(el('span', 'nb', 'これはサンプルデータです。'));
    notice.appendChild(el('span', 'nb', '実際の数字ではありません。'));
    document.querySelector('.head').appendChild(notice);
  }

  // 集計タイル・カテゴリ別の棒・最終更新の行は廃止した（2026-09-28）。
  // 見出しのすぐ下に検索窓を置き、語で探す形にしている
  buildNamed();
  buildSuggest();

  const initial = readUrlQuery();
  if (initial) {
    document.getElementById('search').value = initial;
    state.query = initial;
  }

  syncChipStates();
  render();
}

document.addEventListener('DOMContentLoaded', main);
