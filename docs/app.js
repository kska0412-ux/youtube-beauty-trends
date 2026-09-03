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
  format: 'all',      // all | short | normal
  subsMax: 0,         // 0 は制限なし
  categories: new Set(),   // 主ジャンル。選んだものどうしは OR
  modifiers: new Set(),    // 掛け合わせ語。主ジャンルとは AND、語どうしは OR
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

const FORMATS = [
  { value: 'all',    label: '全て' },
  { value: 'short',  label: 'ショート' },
  { value: 'normal', label: '通常動画' },
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

// --- 絞り込みと並び替え ---------------------------------------------------

function filtered() {
  const q = state.query.trim().toLowerCase();

  return allVideos.filter((v) => {
    const age = daysSince(v.publishedAt);
    if (age === null || age > state.periodDays) return false;

    if (state.format === 'short' && !v.isShort) return false;
    if (state.format === 'normal' && v.isShort) return false;

    if (state.subsMax > 0 && (v.subscriberCount || 0) > state.subsMax) return false;

    if (state.categories.size > 0) {
      const cats = v.categories || [];
      if (!cats.some((c) => state.categories.has(c))) return false;
    }

    // 掛け合わせは主ジャンルと AND。「エステティシャン」かつ「経営」を出すため。
    // 掛け合わせ語どうしは OR（複数選ぶと候補が広がる）。
    if (state.modifiers.size > 0) {
      const mods = v.modifiers || [];
      if (!mods.some((m) => state.modifiers.has(m))) return false;
    }

    if (q) {
      const haystack = ((v.title || '') + ' ' + (v.channelTitle || '')).toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
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
  if (video.isShort) head.appendChild(el('span', 'badge short', 'ショート'));
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
  // 上下2段のチップと同じ「主ジャンル＋掛け合わせ」を出す。
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

function renderBreakdown(videos) {
  const box = document.getElementById('breakdown');
  box.textContent = '';

  const counts = new Map(allCategories.map((c) => [c, 0]));
  videos.forEach((v) => {
    (v.categories || []).forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
  });
  const max = Math.max(1, ...counts.values());

  counts.forEach((count, name) => {
    const row = el('div', 'bar-row');
    // カテゴリ名は「・」の後ろでだけ折る。「小顔・リフトアップ」を「小顔・リフトア」で割らない。
    const nameCell = el('div', 'bar-name');
    name.split('・').forEach((part, i, arr) => {
      nameCell.appendChild(el('span', 'nb', part + (i < arr.length - 1 ? '・' : '')));
    });
    row.appendChild(nameCell);

    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = (count / max * 100).toFixed(1) + '%';
    track.appendChild(fill);
    row.appendChild(track);

    row.appendChild(el('div', 'bar-count', count + '本'));
    box.appendChild(row);
  });
}

function renderSummary(videos) {
  const channels = new Set(videos.map((v) => v.channelId).filter(Boolean));
  const shorts = videos.filter((v) => v.isShort).length;
  document.getElementById('sum-shown').textContent = videos.length.toLocaleString('ja-JP');
  document.getElementById('sum-total').textContent = allVideos.length.toLocaleString('ja-JP');
  document.getElementById('sum-channels').textContent = channels.size.toLocaleString('ja-JP');
  document.getElementById('sum-shorts').textContent =
    videos.length ? Math.round(shorts / videos.length * 100) : 0;
}

function render() {
  const videos = sorted(filtered());
  const list = document.getElementById('list');
  list.textContent = '';

  renderSummary(videos);
  renderBreakdown(videos);
  updateChipCounts();

  document.getElementById('count').textContent =
    videos.length + ' 件を表示中（収集 ' + allVideos.length + ' 件）';

  if (videos.length === 0) {
    list.appendChild(el('p', 'empty', '条件に合う動画がありません。絞り込みを緩めてみてください。'));
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

function buildFormatChips() {
  const box = document.getElementById('format');
  FORMATS.forEach((f) => {
    const chip = makeChip(f.label, () => {
      state.format = f.value;
      syncChipStates();
      render();
    });
    chip.dataset.format = f.value;
    box.appendChild(chip);
  });
}

/**
 * 絞り込みチップの1段分を作る。上段（主ジャンル）と下段（掛け合わせ）で
 * 作りが同じなのでまとめてある。
 *
 * field は動画1件のどの配列を見るか（'categories' か 'modifiers'）。
 */
function buildChipRow(boxId, names, active, field) {
  const box = document.getElementById(boxId);
  box.textContent = '';

  const all = makeChip('すべて', () => {
    active.clear();
    syncChipStates();
    render();
  });
  all.dataset.name = '';
  all.dataset.field = field;
  box.appendChild(all);

  names.forEach((name) => {
    const chip = makeChip(name, () => {
      // 複数選択。押すたびに入り切りが変わる。
      if (active.has(name)) active.delete(name);
      else active.add(name);
      syncChipStates();
      render();
    });
    chip.dataset.name = name;
    chip.dataset.field = field;
    chip.appendChild(el('span', 'chip-count', ''));
    box.appendChild(chip);
  });
}

function buildFilterChips() {
  buildChipRow('categories', allCategories, state.categories, 'categories');
  buildChipRow('modifiers', allModifiers, state.modifiers, 'modifiers');
}

/**
 * チップの件数を数え直す。
 *
 * 自分の段の選択だけを外して数える。そうしないと、あるジャンルを選んだ瞬間に
 * 他のジャンルの件数が全部0になり、次にどれを押せるのか分からなくなる。
 * もう一方の段の選択は効かせたままにするので、上段で「ヘッドスパ」を選ぶと
 * 下段には「ヘッドスパの中で経営が何件か」が出る。
 */
function countsFor(active, field) {
  const saved = new Set(active);
  active.clear();
  const base = filtered();
  saved.forEach((v) => active.add(v));

  const counts = new Map();
  base.forEach((v) => {
    (v[field] || []).forEach((name) => counts.set(name, (counts.get(name) || 0) + 1));
  });
  return counts;
}

function updateChipCounts() {
  const counts = {
    categories: countsFor(state.categories, 'categories'),
    modifiers: countsFor(state.modifiers, 'modifiers'),
  };

  document.querySelectorAll('#categories .chip, #modifiers .chip').forEach((chip) => {
    const name = chip.dataset.name;
    const countNode = chip.querySelector('.chip-count');
    if (!name || !countNode) return;
    const count = counts[chip.dataset.field].get(name) || 0;
    countNode.textContent = String(count);
    // 0件のチップは押しても空振りする。消さずに、選べないことを見た目で示す。
    // 消してしまうと、扱う範囲が狭まったように見えるため。
    const isEmpty = count === 0 && !chip.classList.contains('on');
    chip.classList.toggle('pending', isEmpty);
    chip.setAttribute('aria-disabled', isEmpty ? 'true' : 'false');
    chip.title = isEmpty ? '該当する動画がまだありません' : '';
  });
}

function syncChipStates() {
  document.querySelectorAll('#period .chip').forEach((chip) => {
    chip.classList.toggle('on', Number(chip.dataset.period) === state.periodDays);
  });
  document.querySelectorAll('#format .chip').forEach((chip) => {
    chip.classList.toggle('on', chip.dataset.format === state.format);
  });

  const active = { categories: state.categories, modifiers: state.modifiers };
  document.querySelectorAll('#categories .chip, #modifiers .chip').forEach((chip) => {
    const set = active[chip.dataset.field];
    const name = chip.dataset.name;
    const on = name ? set.has(name) : set.size === 0;
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// --- CSV ------------------------------------------------------------------

const CSV_HEADERS = [
  '順位', 'タイトル', 'チャンネル名', '登録者数', '再生数', 'いいね数', 'コメント数',
  '1日あたり再生数', '加速度(再生/日)', '登録者比', '公開日', '形式', '長さ(秒)',
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
      v.isShort ? 'ショート' : '通常動画',
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

  let timer = null;
  document.getElementById('search').addEventListener('input', (e) => {
    // 1文字ごとに全件描き直すと重いので、入力が止まってから描く
    const value = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = value;
      render();
    }, 180);
  });

  document.getElementById('csv').addEventListener('click', downloadCsv);
}

function showError(message) {
  const list = document.getElementById('list');
  list.textContent = '';
  list.appendChild(el('p', 'empty error', message));
  document.getElementById('stamp').textContent = '';
}

async function main() {
  buildPeriodChips();
  buildFormatChips();
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

  const generated = parseDate(payload.generatedAt);
  document.getElementById('stamp').textContent = generated
    ? '最終更新 ' + generated.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })
    : '最終更新 不明';

  buildFilterChips();
  syncChipStates();
  render();
}

document.addEventListener('DOMContentLoaded', main);
