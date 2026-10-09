/*
 * comment.js — 判定結果から短い講評文を作る（ルールベース。点数・ランクには影響しない）
 *
 * Comment.make(results, i) → { head, lines }
 *   results: Judge.judge() の戻り値（古い順）、i: 対象レースの添字
 *   head : 一言まとめ（ランクと一番効いた要素から）
 *   lines: 根拠の文（終い・全体・ラップ・1週前・乗り込み量・前走比）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./judge.js'));
  else root.Comment = factory(root.Judge);
})(typeof self !== 'undefined' ? self : this, function (Judge) {
  'use strict';
  const r2 = (x) => Judge.pyRound(x, 2);
  const s1 = (x) => Math.abs(x).toFixed(1);
  const sec = (x) => Number(x).toFixed(1);

  function finalF1Text(d1) {
    if (d1 >= 0.25) return `終いは基準より${s1(d1)}秒速く、切れ味は上々`;
    if (d1 >= 0.1) return `終いは基準よりやや速く（${s1(d1)}秒）、動きは良好`;
    if (d1 > -0.1) return '終いは基準並み';
    if (d1 > -0.25) return `終いは基準より${s1(d1)}秒遅く、やや物足りない`;
    return `終いが基準より${s1(d1)}秒遅く、切れを欠く`;
  }

  function mainText(dm, fin) {
    if (dm >= 1.0) return `全体時計（${fin.mainKey.slice(1)}F ${sec(fin.main)}）は速く、負荷は十分`;
    if (dm <= -1.0) return `全体時計（${fin.mainKey.slice(1)}F ${sec(fin.main)}）は遅めで、軽めの仕上げ`;
    return null;
  }

  const SHAPE_TEXT = {
    '加速': 'ラスト2Fは加速ラップで内容が良い',
    '維持': 'ラスト2Fは平均的なラップ',
    '減速': 'ラスト1Fで減速しており、余力はやや疑問',
    '大きく減速': 'ラスト1Fで大きく失速しており割引',
  };

  function week1Text(j) {
    const wk = j.slots['1週前'], b = j.baseline;
    if (wk) {
      if (wk.f1 <= b.f1 + 0.2) return `1週前はラスト1F ${sec(wk.f1)}としっかり動けていた`;
      if (wk.f1 >= 13.0) return `1週前はラスト1F ${sec(wk.f1)}と物足りない`;
      return `1週前はラスト1F ${sec(wk.f1)}でまずまず`;
    }
    if (j.interval != null && j.interval <= 21) return '間隔が詰まっており、1週前追いなしは想定内';
    return '1週前追いがなく、調整過程に不安が残る';
  }

  function volumeText(j) {
    const v = j.baseline && j.baseline.volume;
    if (!v) return null;
    const ratio = j.volume14d / v;
    if (ratio > 1.2) return `直近14日は${j.volume14d}本と普段（平均${v.toFixed(1)}本）より多く乗り込まれている`;
    if (ratio < 0.7) return `直近14日は${j.volume14d}本と普段（平均${v.toFixed(1)}本）より少なめ`;
    return null;
  }

  /** 前走（同じコースで最終追い切りがあるレース）との比較 */
  function prevText(results, i) {
    const fin = results[i].slots['最終'];
    if (!fin) return null;
    for (let k = i - 1; k >= 0; k--) {
      const p = results[k].slots['最終'];
      if (!p || p.course !== fin.course) continue;
      const d = r2(p.f1 - fin.f1);
      const name = results[k].race.name.replace(/\(.*?\)|（.*?）/g, '').trim();
      const res = results[k].race.result ? `（${results[k].race.result}）` : '';
      if (d >= 0.2) return `${name}${res}の最終（${sec(p.f1)}）より終いが${s1(d)}秒良化`;
      if (d <= -0.2) return `${name}${res}の最終（${sec(p.f1)}）より終いが${s1(d)}秒悪化`;
      return `${name}${res}の最終（${sec(p.f1)}）と同程度`;
    }
    return null;
  }

  function headline(j, d1) {
    const fin = j.slots['最終'];
    const bad = fin.shape === '大きく減速' || d1 <= -0.25;
    const good = fin.shape === '加速' && d1 >= 0.1;
    switch (j.rank) {
      case 'S': return '好仕上がり。自身の基準を大きく上回る調教内容';
      case 'A': return good ? '状態は良好。終いの伸びが目立つ' : '状態は良好。大きな不安はない';
      case 'B': return bad ? '可もなく不可もなく。終いの内容は一息' : '平行線。状態の上積みは感じにくい';
      default: return bad ? '割引が必要。終いの内容が物足りない' : '割引が必要。調整過程に不安がある';
    }
  }

  function make(results, i) {
    const j = results[i];
    if (j.status === '判定済') {
      const fin = j.slots['最終'], b = j.baseline;
      const d1 = r2(b.f1 - fin.f1), dm = Judge.pyRound(b.main - fin.main, 1);
      const lines = [
        finalF1Text(d1),
        mainText(dm, fin),
        SHAPE_TEXT[fin.shape],
        week1Text(j),
        volumeText(j),
        prevText(results, i),
      ].filter(Boolean);
      if (b.source === '汎用') lines.push('※過去の最終追い切りがないため、汎用基準との比較');
      return { head: headline(j, d1), lines };
    }
    if (j.status === '最終追い切り待ち') {
      const b = j.baseline, lines = [];
      const wk = j.slots['1週前'], w2 = j.slots['2週前'];
      if (wk) lines.push(week1Text(j));
      else if (j.interval != null && j.interval <= 21) lines.push('間隔が詰まっており、1週前追いなしは想定内');
      if (w2) lines.push(`2週前はラスト1F ${sec(w2.f1)}（${w2.shape}）`);
      lines.push(`最終追い切りでラスト1F ${Judge.pyFmt(b.f1 - 0.1, 1)}以下なら上向き、${Judge.pyFmt(b.f1 + 0.3, 1)}以上なら割引`);
      return { head: '最終追い切り待ち', lines };
    }
    return { head: 'データ不足', lines: [] };
  }

  return { make };
});
