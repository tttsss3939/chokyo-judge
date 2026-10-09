/*
 * judge.js — 調教タイム判定（training_judge.py の JavaScript 移植）
 *
 * training_judge.py と同じ入力に対して同じ判定（点数・ランク・内訳の文言）を返す。
 * Python との一致は tests/parity.mjs で検証している。数値の丸めは Python の挙動を再現:
 *   - round(x, n)        → pyRound（偶数丸め・2進表現どおり）
 *   - statistics.mean    → exactMean（正確な有理数平均を最も近い double に）
 *   - str(float)         → pyStr（12.0 は "12.0"）
 *   - 点数の丸め         → scoreRound（training_judge.py の score_round と同じ四捨五入）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Judge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- 設定 ----
  const OIKIRI_RULES = { '坂路': ['f4', 58.0], 'ウッド': ['f5', 72.0] };
  const GENERIC_BASELINE = {
    '坂路': { main: 53.5, f1: 12.3 },
    'ウッド': { main: 67.0, f1: 11.6 },
  };
  const COURSE_ALIASES = {
    '坂路': '坂路', '坂': '坂路',
    'ウッド': 'ウッド', 'ウッドチップ': 'ウッド', 'CW': 'ウッド', 'W': 'ウッド', 'D': 'ウッド',
    '南W': 'ウッド', '北W': 'ウッド', '栗CW': 'ウッド', '美W': 'ウッド',
  };
  const RANKS = [[70, 'S'], [60, 'A'], [45, 'B'], [-999, 'C']];
  const KEYS = ['f6', 'f5', 'f4', 'f3', 'f2', 'f1'];
  const SHAPE_POINTS = { '加速': 8, '維持': 0, '減速': -6, '大きく減速': -12 };

  // ------------------------------------------------- Python 互換の数値処理 ----
  /** Python の round(x, n)。2進表現の正確な値で丸め、ちょうど中間なら偶数側 */
  function pyRound(x, n = 0) {
    if (!Number.isFinite(x)) return x;
    const ax = Math.abs(x);
    const s = ax.toFixed(100);
    const dot = s.indexOf('.');
    const tail = s.slice(dot + 1 + n);
    let r;
    if (/^50*$/.test(tail)) {
      const kept = s.slice(0, dot + 1 + n);
      const lastDigit = +kept.replace('.', '').slice(-1);
      r = Number(kept.endsWith('.') ? kept.slice(0, -1) : kept);
      if (lastDigit % 2 === 1) r = Number((r + Math.pow(10, -n)).toFixed(n));
    } else {
      r = Number(ax.toFixed(n));
    }
    return x < 0 ? -r : r;
  }

  /** f"{x:.nf}" */
  const pyFmt = (x, n) => pyRound(x, n).toFixed(n);
  /** str(float) */
  const pyStr = (x) => (x == null ? 'None' : Number.isInteger(x) ? x.toFixed(1) : String(x));
  /** f"{p:+d}" */
  const signed = (p) => (p >= 0 ? `+${Math.abs(p)}` : String(p));
  /** 点数の丸め（training_judge.py の score_round と同じ: 四捨五入、浮動小数の誤差は吸収） */
  const scoreRound = (x) => Math.floor(x + 0.5 + 1e-9);

  function decompose(x) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x);
    const hi = dv.getUint32(0), lo = dv.getUint32(4);
    const neg = hi >>> 31 === 1;
    const expBits = (hi >>> 20) & 0x7ff;
    let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let e;
    if (expBits === 0) e = -1074; else { mant |= 1n << 52n; e = expBits - 1075; }
    return [neg ? -mant : mant, e];
  }

  /** p/q（BigInt, q>0）を最も近い double に（偶数丸め） */
  function fracToDouble(p, q) {
    if (p === 0n) return 0;
    const neg = p < 0n; if (neg) p = -p;
    const bl = (v) => v.toString(2).length;
    let k = 53 - (bl(p) - bl(q));
    const quot = (kk) => (kk >= 0 ? [p << BigInt(kk), q] : [p, q << BigInt(-kk)]);
    let [num, den] = quot(k);
    let qt = num / den;
    while (qt >= (1n << 53n)) { k--; [num, den] = quot(k); qt = num / den; }
    while (qt < (1n << 52n)) { k++; [num, den] = quot(k); qt = num / den; }
    const rem = num - qt * den;
    if (2n * rem > den || (2n * rem === den && (qt & 1n) === 1n)) qt += 1n;
    const v = Number(qt) * Math.pow(2, -k);
    return neg ? -v : v;
  }

  /** statistics.mean と同じ（正確な和 / 件数 を double に丸める） */
  function exactMean(arr) {
    const parts = arr.map(decompose);
    const minE = Math.min(...parts.map(([, e]) => e));
    let total = 0n;
    for (const [m, e] of parts) total += m << BigInt(e - minE);
    return fracToDouble(total, BigInt(arr.length)) * Math.pow(2, minE);
  }

  // ---------------------------------------------------------- データ構造 ----
  const dayNum = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  const daysBetween = (a, b) => dayNum(a) - dayNum(b);   // a - b（日）
  const mmdd = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;

  function normCourse(raw) {
    const s = String(raw || '').trim();
    return COURSE_ALIASES[s] || s;
  }

  /** プレーンな調教オブジェクトに派生値を付ける */
  function makeWorkout(o) {
    const w = { date: o.date, time: o.time || '', center: o.center || '', course: normCourse(o.course) };
    for (const k of KEYS) w[k] = o[k] == null || o[k] === '' || Number.isNaN(+o[k]) ? null : +o[k];
    const [key, th] = OIKIRI_RULES[w.course] || ['f4', 58.0];
    w.mainKey = key;
    w.main = w[key];
    w.isOikiri = w.main != null && w.main <= th;
    w.lap2 = w.f2 == null || w.f1 == null ? null : pyRound(w.f2 - w.f1, 1);
    if (w.lap2 == null) w.shape = '不明';
    else {
      const d = pyRound(w.f1 - w.lap2, 1);
      w.shape = d <= -0.1 ? '加速' : d <= 0.3 ? '維持' : d <= 0.6 ? '減速' : '大きく減速';
    }
    const laps = w.lap2 != null ? `${pyStr(w.lap2)}-${pyStr(w.f1)}` : `${pyStr(w.f1)}`;
    w.label = `${mmdd(w.date)} ${w.course} ${w.mainKey.toUpperCase()} ${pyStr(w.main)} / ラスト2F ${laps}（${w.shape}）`;
    return w;
  }

  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  // -------------------------------------------------------------- ロジック ----
  function window_(works, raceDay, prevDay) {
    return works.filter((w) => w.date < raceDay && (prevDay == null || w.date > prevDay));
  }

  function assignSlots(works, raceDay) {
    const slots = {};
    for (const w of works.filter((x) => x.isOikiri).sort(byDate)) {
      const days = daysBetween(raceDay, w.date);
      const slot = days <= 7 ? '最終' : days <= 14 ? '1週前' : days <= 21 ? '2週前' : null;
      if (slot) slots[slot] = w;   // 同じ枠に複数あれば遅い方
    }
    return slots;
  }

  function buildBaseline(past, course) {
    const finals = past.filter((j) => j.slots['最終'] && j.slots['最終'].course === course).map((j) => j.slots['最終']);
    const vols = past.filter((j) => j.status === '判定済').map((j) => j.volume14d);
    if (finals.length >= 1) {
      return {
        main: pyRound(exactMean(finals.map((f) => f.main)), 1),
        f1: pyRound(exactMean(finals.map((f) => f.f1)), 2),
        best_f1: Math.min(...finals.map((f) => f.f1)),
        volume: vols.length ? exactMean(vols) : null,
        n: finals.length, source: '自己',
      };
    }
    const g = GENERIC_BASELINE[course] || GENERIC_BASELINE['坂路'];
    return { ...g, best_f1: g.f1, volume: null, n: 0, source: '汎用' };
  }

  /**
   * works: [{date:'YYYY-MM-DD', time, center, course, f6..f1}]
   * races: [{date, name, result}]
   * 戻り値: レースごとの判定（古い順）
   */
  function judge(worksIn, racesIn) {
    const works = worksIn.map(makeWorkout).sort(byDate);   // 安定ソート（同日は入力順）
    const races = racesIn.map((r) => ({ date: r.date, name: r.name, result: r.result || '' })).sort(byDate);
    const results = [];
    races.forEach((race, i) => {
      const prev = i > 0 ? races[i - 1].date : null;
      const ws = window_(works, race.date, prev);
      const slots = assignSlots(ws, race.date);
      const vol = ws.filter((w) => daysBetween(race.date, w.date) <= 14).length;
      const j = { race, status: '判定済', slots, baseline: {}, score: null, rank: '-', notes: [], volume14d: vol, interval: null };

      if (!ws.length) { j.status = 'データ不足'; results.push(j); return; }

      const course = (slots['最終'] || slots['1週前'] || ws[ws.length - 1]).course;
      const base = buildBaseline(results, course);   // このレースより前の情報だけ使う
      j.baseline = base;
      const interval = prev ? daysBetween(race.date, prev) : null;
      j.interval = interval;

      if (!slots['最終']) {
        j.status = !race.result ? '最終追い切り待ち' : 'データ不足';
        if (interval != null && interval <= 21) j.notes.push(`前走から中${Math.floor(interval / 7) - 1}週。1週前追いなしは想定内`);
        results.push(j);
        return;
      }

      const fin = slots['最終'];
      const items = [];
      let score = 50, p;
      // 1) 終い1Fを自己基準と比較（0.1秒 = 5点、±15で頭打ち）
      const d1 = pyRound(base.f1 - fin.f1, 2);
      p = Math.max(-15, Math.min(15, scoreRound(d1 * 50)));
      score += p;
      items.push({ key: 'f1', points: p, text: `ラスト1F ${pyStr(fin.f1)}（基準${pyStr(base.f1)}より${pyFmt(Math.abs(d1), 2)}秒${d1 > 0 ? '速い' : d1 < 0 ? '遅い' : '同じ'}）${signed(p)}` });
      // 2) 全体時計（1秒 = 5点、±10）
      const dm = pyRound(base.main - fin.main, 1);
      p = Math.max(-10, Math.min(10, scoreRound(dm * 5)));
      score += p;
      items.push({ key: 'main', points: p, text: `全体 ${pyStr(fin.main)}（基準${pyStr(base.main)}）${signed(p)}` });
      // 3) ラップ形状
      p = SHAPE_POINTS[fin.shape] ?? 0;
      score += p;
      items.push({ key: 'shape', points: p, text: `ラスト2F形状 ${fin.shape} ${signed(p)}` });
      // 4) 1週前
      const wk = slots['1週前'];
      if (wk) {
        p = wk.f1 <= base.f1 + 0.2 ? 5 : wk.f1 >= 13.0 ? -5 : 0;
        items.push({ key: 'week1', points: p, text: `1週前 ラスト1F ${pyStr(wk.f1)} ${signed(p)}` });
      } else if (interval != null && interval <= 21) {
        p = 0;
        items.push({ key: 'week1', points: p, text: '1週前なし（間隔詰まりのため減点なし）' });
      } else {
        p = -8;
        items.push({ key: 'week1', points: p, text: '1週前なし（間隔あり）-8' });
      }
      score += p;
      // 5) 乗り込み量（直近14日の調教本数）
      if (base.volume) {
        const ratio = vol / base.volume;
        p = ratio < 0.7 ? -5 : ratio > 1.2 ? 3 : 0;
        items.push({ key: 'volume', points: p, text: `直近14日 ${vol}本（平均${pyFmt(base.volume, 1)}本）${signed(p)}` });
        score += p;
      } else {
        items.push({ key: 'volume', points: null, text: `直近14日 ${vol}本` });
      }

      j.items = items;
      j.notes = items.map((it) => it.text);
      j.score = score;
      j.rank = RANKS.find(([th]) => score >= th)[1];
      results.push(j);
    });
    return results;
  }

  /** 最終追い切り待ちのレースの判定基準 */
  function pendingCriteria(j) {
    const b = j.baseline;
    return [
      `上向き : ラスト1F ${pyFmt(b.f1 - 0.1, 1)}以下 かつ 全体 ${pyStr(b.main)}以内`,
      `据え置き: ラスト1F ${pyFmt(b.f1 + 0.2, 1)}以下`,
      `割引  : ラスト1F ${pyFmt(b.f1 + 0.3, 1)}以上、またはラスト2Fが大きく減速`,
    ];
  }

  /** training_judge.py --json と同じ形に変換（一致テスト用） */
  function toComparable(results) {
    const slot = (w) => ({
      date: w.date, time: w.time, course: w.course, main_key: w.mainKey, main: w.main,
      f1: w.f1, lap2: w.lap2, shape: w.shape, label: w.label,
    });
    return results.map((j) => {
      const slots = {};
      for (const k of ['2週前', '1週前', '最終']) if (j.slots[k]) slots[k] = slot(j.slots[k]);
      return {
        race: { date: j.race.date, name: j.race.name, result: j.race.result },
        status: j.status, score: j.score, rank: j.rank, volume_14d: j.volume14d,
        notes: j.notes, slots, baseline: j.baseline,
        criteria: j.status === '最終追い切り待ち' ? pendingCriteria(j) : [],
      };
    });
  }

  // ---------------------------------------------------------------- CSV ----
  function parseCSV(text) {
    const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
    const head = lines.shift().split(',').map((s) => s.trim());
    return lines.filter((l) => l.trim()).map((l) => {
      const v = l.split(',');
      const o = {};
      head.forEach((h, i) => { o[h] = (v[i] ?? '').trim(); });
      return o;
    });
  }

  function workoutsFromCSV(text) {
    return parseCSV(text).map((r) => {
      const o = { date: r.date.replace(/\//g, '-'), time: r.time || '', center: r.center || '', course: normCourse(r.course) };
      for (const k of KEYS) o[k] = r[k] === '' || r[k] == null || r[k] === '-' ? null : parseFloat(r[k]);
      return o;
    });
  }

  function racesFromCSV(text) {
    return parseCSV(text).map((r) => ({ date: r.date.replace(/\//g, '-'), name: r.name || '', result: r.result || '' }));
  }

  function workoutsToCSV(works) {
    const rows = ['date,time,center,course,' + KEYS.join(',')];
    for (const w of works) rows.push([w.date, w.time, w.center, w.course, ...KEYS.map((k) => (w[k] == null ? '' : w[k].toFixed(1)))].join(','));
    return rows.join('\n') + '\n';
  }

  function racesToCSV(races) {
    return ['date,name,result', ...races.map((r) => [r.date, r.name, r.result || ''].join(','))].join('\n') + '\n';
  }

  return {
    OIKIRI_RULES, GENERIC_BASELINE, RANKS, KEYS,
    judge, pendingCriteria, toComparable, makeWorkout, normCourse,
    parseCSV, workoutsFromCSV, racesFromCSV, workoutsToCSV, racesToCSV,
    pyRound, pyStr, pyFmt, exactMean, scoreRound, daysBetween,
  };
});
