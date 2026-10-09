/* app.js — 画面まわり（保存・取り込み・確認画面・判定表示・チャート） */
(function () {
  'use strict';
  const KEYS = Judge.KEYS;
  const STORE_KEY = 'chokyo-judge-v1';
  const THEME_KEY = 'chokyo-judge-theme';
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f1d = (v) => (v == null ? '' : Number(v).toFixed(1));
  const slash = (iso) => iso.replace(/-/g, '/');
  const md = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const courseCls = (c) => (c === 'ウッド' ? 'wood' : 'hanro');

  // ------------------------------------------------------------ 保存 ----
  let state = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.horses) return s;
    } catch (e) { /* 読めなければ新規 */ }
    return { version: 1, current: null, horses: {} };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('保存できませんでした（プライベートブラウズ／容量不足？）'); }
  }
  const horse = () => state.horses[state.current] || null;
  function newHorse(name, center) {
    const id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    state.horses[id] = { name, center: center || '栗東', workouts: [], races: [] };
    state.current = id;
    return state.horses[id];
  }
  function ensureHorse() {
    if (horse()) return horse();
    const name = prompt('馬名を入力してください');
    if (!name || !name.trim()) return null;
    const h = newHorse(name.trim());
    save(); render();
    return h;
  }
  const sortWorkouts = (ws) => ws.sort((a, b) => (a.date === b.date ? (a.time < b.time ? 1 : a.time > b.time ? -1 : 0) : a.date < b.date ? 1 : -1));
  const sortRaces = (rs) => rs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // ------------------------------------------------------------ 表示 ----
  function render() {
    renderHorseSelect();
    const h = horse();
    const results = h ? Judge.judge(h.workouts, h.races) : [];
    renderSummary(h, results);
    renderCompare(h, results);
    renderRaceList(h);
    renderChart(h, results);
    renderRaceCards(results);
    renderWorkouts(h);
  }

  function renderHorseSelect() {
    const sel = $('#horseSelect');
    const ids = Object.keys(state.horses);
    sel.innerHTML = ids.length
      ? ids.map((id) => `<option value="${id}"${id === state.current ? ' selected' : ''}>${esc(state.horses[id].name)}</option>`).join('')
      : '<option value="">馬が未登録</option>';
    sel.innerHTML += '<option value="__new">＋ 馬を追加…</option>';
  }

  function targetIndex(results) {
    for (let i = results.length - 1; i >= 0; i--) if (!results[i].race.result) return i;
    return results.length - 1;
  }

  function renderSummary(h, results) {
    const el = $('#summaryCard');
    if (!h) {
      el.innerHTML = `<h2>判定サマリー</h2><p class="empty">まず馬を登録し、JRA-VAN の「調教タイム」画面のスクショを読み込んでください。<br>メニュー（…）の「サンプル2頭を読み込む」で動作を試せます。</p>`;
      return;
    }
    if (!results.length) {
      el.innerHTML = `<h2>判定サマリー</h2><p class="empty">出走レース（日付・レース名・着順）を登録すると判定します。対象レースは着順が空欄のレースです。</p>`;
      return;
    }
    const ti = targetIndex(results);
    const j = results[ti];
    const days = Judge.daysBetween(j.race.date, todayISO());
    const when = days > 0 ? `あと${days}日` : days === 0 ? '本日' : `${-days}日前`;
    let badge, body = '';
    if (j.status === '判定済') {
      badge = `<div class="rank-badge rank-${j.rank}"><div><b>${j.rank}</b><span class="num">${j.score}点</span></div></div>`;
      const fin = j.slots['最終'];
      body = `<div class="meta num">最終 ${md(fin.date)} ${fin.course} ${fin.mainKey.slice(1)}F ${f1d(fin.main)}・ラスト1F ${f1d(fin.f1)}（${fin.shape}）</div>`;
    } else if (j.status === '最終追い切り待ち') {
      badge = `<div class="rank-badge pending"><div><b>最終<br>待ち</b></div></div>`;
      const c = Judge.pendingCriteria(j).map((s) => s.split(':').map((x) => x.trim()));
      const cls = ['up', 'keep', 'down'];
      body = `<div class="meta">基準: ${esc(j.baseline.source)}（過去最終${j.baseline.n}本）全体 ${Judge.pyStr(j.baseline.main)} / ラスト1F ${Judge.pyStr(j.baseline.f1)}</div>`;
      body += `<ul class="criteria num">${c.map(([k, v], i) => `<li class="${cls[i]}"><b>${esc(k)}</b><span>${esc(v)}</span></li>`).join('')}</ul>`;
    } else {
      badge = `<div class="rank-badge pending"><div><b>データ<br>不足</b></div></div>`;
      body = `<div class="meta">調整期間（前走の翌日〜前日）の追い切りが見つかりません。</div>`;
    }
    const hist = results.filter((r, i) => i !== ti && r.status === '判定済')
      .map((r) => `<span class="chip"><span>${esc(shortName(r.race.name))}</span><b class="chip rank c-${r.rank}" style="border:0;padding:0;background:none">${r.rank}${r.score}</b>${r.race.result ? `→ ${esc(r.race.result)}` : ''}</span>`).join('');
    const comment = j.status === 'データ不足' ? '' : commentHTML(Comment.make(results, ti));
    el.innerHTML = `<h2>判定サマリー</h2>
      <div class="summary">${badge}<div><div class="race-name">${esc(j.race.name)}</div>
      <div class="meta num">${slash(j.race.date)}（${when}）${j.race.result ? '・' + esc(j.race.result) : ''}</div></div></div>
      ${comment}
      ${j.status === '最終追い切り待ち' ? body : `<div style="margin-top:10px">${body}</div>`}
      ${hist ? `<div class="history">${hist}</div>` : ''}`;
  }

  function commentHTML(cm, withHead = true) {
    return `<div class="comment">${withHead ? `<p class="c-head">${esc(cm.head)}</p>` : ''}<ul>${cm.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  }

  const normName = (n) => String(n || '').normalize('NFKC').replace(/\s/g, '');
  function findHorseByName(name) {
    return Object.keys(state.horses).find((id) => normName(state.horses[id].name) === normName(name)) || null;
  }

  // ------------------------------------------------------- 出走馬の比較 ----
  const raceKey = (r) => `${r.date}|${normName(shortName(r.name)).toUpperCase()}`;

  /** 全馬の判定（馬ID → results） */
  function judgeAll() {
    const out = {};
    for (const [id, h] of Object.entries(state.horses)) out[id] = Judge.judge(h.workouts, h.races);
    return out;
  }

  function renderCompare(h, results) {
    const el = $('#compareCard');
    if (!h || !results.length) { el.hidden = true; return; }
    const target = results[targetIndex(results)];
    const key = raceKey(target.race);
    const all = judgeAll();
    const entries = [];
    for (const [id, rs] of Object.entries(all)) {
      const i = rs.findIndex((j) => raceKey(j.race) === key);
      if (i >= 0) entries.push({ id, name: state.horses[id].name, j: rs[i], cm: Comment.make(rs, i) });
    }
    if (entries.length < 2) { el.hidden = true; return; }
    const order = (e) => (e.j.status === '判定済' ? 0 : e.j.status === '最終追い切り待ち' ? 1 : 2);
    entries.sort((a, b) => order(a) - order(b) || (b.j.score ?? 0) - (a.j.score ?? 0) || a.name.localeCompare(b.name, 'ja'));
    el.hidden = false;
    el.innerHTML = `<h2>${esc(shortName(target.race.name))} の登録馬（${entries.length}頭）</h2>
      <div class="cmp">${entries.map((e, n) => {
        const j = e.j;
        const badge = j.status === '判定済'
          ? `<span class="cmp-rank rank-${j.rank}">${j.rank}</span><span class="cmp-score num">${j.score}</span>`
          : `<span class="cmp-rank pending">${j.status === '最終追い切り待ち' ? '待' : '－'}</span><span class="cmp-score"></span>`;
        const fin = j.slots['最終'];
        const sub = fin ? `最終 ${fin.course} ${fin.mainKey.slice(1)}F ${f1d(fin.main)}・1F ${f1d(fin.f1)}` : j.status;
        return `<button class="cmp-row${e.id === state.current ? ' me' : ''}" data-horse="${e.id}">
          <span class="cmp-no num">${j.status === '判定済' ? n + 1 : ''}</span>${badge}
          <span class="cmp-body"><b>${esc(e.name)}</b><small class="num">${esc(sub)}</small><small>${esc(j.status === '最終追い切り待ち' ? `ラスト1F ${Judge.pyFmt(j.baseline.f1 - 0.1, 1)}以下なら上向き` : e.cm.head)}</small></span></button>`;
      }).join('')}</div>`;
  }

  $('#compareCard').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-horse]'); if (!b || b.dataset.horse === state.current) return;
    state.current = b.dataset.horse; save(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ------------------------------------------------------------ 成績の検証 ----
  function finishOf(result) {
    const m = /(\d+)\s*着/.exec(String(result || '').normalize('NFKC'));
    return m ? +m[1] : null;
  }

  /** 順位相関（スピアマン、同順位は平均順位） */
  function spearman(xs, ys) {
    const rankOf = (vals) => {
      const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
      const r = [];
      for (let i = 0; i < idx.length;) {
        let k = i;
        while (k + 1 < idx.length && idx[k + 1][0] === idx[i][0]) k++;
        for (let t = i; t <= k; t++) r[idx[t][1]] = (i + k) / 2 + 1;
        i = k + 1;
      }
      return r;
    };
    const a = rankOf(xs), b = rankOf(ys);
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
    let num = 0, da = 0, db = 0;
    a.forEach((x, i) => { num += (x - ma) * (b[i] - mb); da += (x - ma) ** 2; db += (b[i] - mb) ** 2; });
    return da && db ? num / Math.sqrt(da * db) : null;
  }

  function openStats() {
    const all = judgeAll();
    const rows = [];
    let skipped = 0;
    for (const [id, rs] of Object.entries(all)) {
      for (const j of rs) {
        if (!j.race.result) continue;
        const fin = finishOf(j.race.result);
        if (j.status !== '判定済' || fin == null) { skipped++; continue; }
        rows.push({ horse: state.horses[id].name, race: j.race, rank: j.rank, score: j.score, fin });
      }
    }
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
    const agg = ['S', 'A', 'B', 'C'].map((rk) => {
      const g = rows.filter((r) => r.rank === rk);
      return {
        rk, n: g.length, avg: g.length ? (g.reduce((t, r) => t + r.fin, 0) / g.length).toFixed(1) : '-',
        win: pct(g.filter((r) => r.fin === 1).length, g.length),
        top2: pct(g.filter((r) => r.fin <= 2).length, g.length),
        top3: pct(g.filter((r) => r.fin <= 3).length, g.length),
      };
    });
    // 点数が高いほど着順が良い（数字が小さい）なら正になるように、点数の符号を反転して比べる
    const rho = rows.length >= 3 ? spearman(rows.map((r) => -r.score), rows.map((r) => r.fin)) : null;
    const body = $('#statsBody');
    if (!rows.length) {
      body.innerHTML = '<p class="empty">着順（例「4着」）が入った判定済みのレースがまだありません。出走レースに着順を入れると集計されます。</p>';
    } else {
      const rhoText = rho == null ? '' : `<p class="meta">点数と着順の順位相関: <b class="num">${rho.toFixed(2)}</b>（+1に近いほど「点数が高い馬ほど着順が良い」。0付近なら関係なし）</p>`;
      body.innerHTML = `
        ${rows.length < 30 ? `<p class="warnbox">まだ ${rows.length} レース分なので参考程度です。30レース以上たまると傾向が見えてきます。</p>` : ''}
        <table class="stats num"><thead><tr><th>ランク</th><th>件数</th><th>平均着順</th><th>勝率</th><th>連対率</th><th>3着内率</th></tr></thead>
        <tbody>${agg.map((g) => `<tr><td><span class="cmp-rank rank-${g.rk}">${g.rk}</span></td><td>${g.n}</td><td>${g.avg}</td><td>${g.win}</td><td>${g.top2}</td><td>${g.top3}</td></tr>`).join('')}</tbody></table>
        ${rhoText}
        ${skipped ? `<p class="meta">着順はあるが判定できなかったレース（データ不足など）${skipped}件は除外しています</p>` : ''}
        <h4>レース一覧（点数順）</h4>
        <div class="list">${rows.sort((a, b) => b.score - a.score).map((r) => `<div class="list-row"><div><b>${esc(r.horse)}</b> <span class="sub">${esc(shortName(r.race.name))}</span><div class="sub num">${slash(r.race.date)}</div></div>
          <div class="num" style="text-align:right;white-space:nowrap"><span class="chip rank c-${r.rank}">${r.rank}${r.score}</span> → <b>${r.fin}着</b></div></div>`).join('')}</div>`;
    }
    $('#statsDlg').showModal();
  }
  $('#statsClose').addEventListener('click', () => $('#statsDlg').close());

  const shortName = (n) => n.replace(/\(.*?\)|（.*?）/g, '').trim() || n;

  function renderRaceList(h) {
    const el = $('#raceList');
    if (!h || !h.races.length) { el.innerHTML = '<p class="empty">未登録</p>'; return; }
    el.innerHTML = h.races.map((r, i) => ({ r, i })).reverse().map(({ r, i }) => `
      <div class="list-row">
        <button class="link-btn" style="text-align:left;color:inherit;font-weight:400;font-size:14px" data-edit-race="${i}">
          <div><b>${esc(r.name)}</b> ${r.result ? `<span class="result">${esc(r.result)}</span>` : '<span class="tag new">対象</span>'}</div>
          <div class="sub num">${slash(r.date)}</div>
        </button>
        <button class="btn small danger" data-del-race="${i}" aria-label="削除">削除</button>
      </div>`).join('');
  }

  function slotRow(k, w) {
    return `<div class="slot num"><span class="k">${k}</span><span class="dt">${md(w.date)}</span>
      <span class="main"><span class="course ${courseCls(w.course)}">${w.course}</span>${w.mainKey.slice(1)}F ${f1d(w.main)}
      <small>ラスト2F ${w.lap2 != null ? `${f1d(w.lap2)}-` : ''}${f1d(w.f1)}</small></span>
      <span class="shape ${w.shape}">${w.shape}</span></div>`;
  }

  function renderRaceCards(results) {
    const el = $('#raceCards');
    el.innerHTML = results.map((j, i) => ({ j, i })).reverse().map(({ j, i }) => {
      const r = j.race;
      let score;
      if (j.status === '判定済') score = `<div class="score r-${j.rank}"><b>${j.rank}</b><span class="num">${j.score}点</span></div>`;
      else score = `<div class="score pending"><b>${j.status === '最終追い切り待ち' ? '最終待ち' : 'データ不足'}</b></div>`;
      const slots = ['2週前', '1週前', '最終'].filter((k) => j.slots[k]).map((k) => slotRow(k, j.slots[k])).join('');
      let body = '';
      if (slots) body += `<div class="slots">${slots}</div>`;
      if (j.baseline && j.baseline.source) {
        body += `<div class="base num">基準: ${esc(j.baseline.source)}（過去最終${j.baseline.n}本）全体 ${Judge.pyStr(j.baseline.main)} / ラスト1F ${Judge.pyStr(j.baseline.f1)}・直近14日 ${j.volume14d}本</div>`;
      }
      if (j.status === '判定済') {
        body += commentHTML(Comment.make(results, i));
        body += `<ul class="items">${j.items.map((it) => {
          const p = it.points;
          const cls = p == null ? 'zero' : p > 0 ? 'plus' : p < 0 ? 'minus' : 'zero';
          const label = it.text.replace(/\s?[+-]\d+$/, '');
          return `<li><span>${esc(label)}</span><span class="pts ${cls} num">${p == null ? '' : p > 0 ? '+' + p : p}</span></li>`;
        }).join('')}</ul>`;
      } else if (j.status === '最終追い切り待ち') {
        body += `<ul class="items">${Judge.pendingCriteria(j).map((c) => `<li><span>${esc(c)}</span></li>`).join('')}</ul>`;
        body += j.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('');
      } else if (!slots) {
        body += `<div class="note">調整期間（前走の翌日〜レース前日）の調教データがありません。</div>`;
      } else {
        body += `<div class="note">最終追い切り（レース7日前以内）が見つからないため判定できません。</div>`;
      }
      return `<section class="card race-card"><div class="race-head">
        <div class="t"><div class="n">${esc(r.name)}</div><div class="d num">${slash(r.date)} ${r.result ? `<span class="result">${esc(r.result)}</span>` : ''}</div></div>
        ${score}</div><div class="race-body">${body}</div></section>`;
    }).join('');
  }

  function renderWorkouts(h) {
    const ws = h ? h.workouts : [];
    $('#wkCount').textContent = ws.length ? `${ws.length}件` : '';
    const el = $('#wkList');
    if (!ws.length) { el.innerHTML = '<p class="empty">まだありません</p>'; return; }
    el.innerHTML = ws.map((w, i) => {
      const mw = Judge.makeWorkout(w);
      const times = KEYS.filter((k) => w[k] != null).map((k) => f1d(w[k])).join('-');
      return `<div class="wk num${mw.isOikiri ? ' oikiri' : ''}"><span>${w.date.slice(2).replace(/-/g, '/')}</span>
        <span><span class="course ${courseCls(w.course)}">${w.course}</span></span>
        <span class="times">${mw.isOikiri ? '★ ' : ''}${times}</span>
        <button class="x" data-del-wk="${i}" aria-label="削除">×</button></div>`;
    }).join('');
  }

  // ---------------------------------------------------------- チャート ----
  let chartPoints = [];
  function renderChart(h, results) {
    const wrap = $('#chartWrap');
    $('#chartTip').textContent = '';
    const pts = h ? h.workouts.map(Judge.makeWorkout).filter((w) => w.isOikiri && w.f1 != null) : [];
    if (pts.length < 1) { wrap.innerHTML = '<p class="empty">追い切りデータがありません</p>'; chartPoints = []; return; }
    const finals = new Set(results.filter((j) => j.slots['最終']).map((j) => j.slots['最終'].date + j.slots['最終'].time));
    const W = Math.max(280, Math.round(wrap.clientWidth || 340)), H = 220;
    const L = 34, R = 10, T = 22, B = 24;
    const dn = (iso) => Judge.daysBetween(iso, '2000-01-01');
    const races = h.races;
    const xs = pts.map((p) => dn(p.date));
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    for (const r of races) { const d = dn(r.date); if (d >= x0 - 30 && d <= x1 + 30) { x0 = Math.min(x0, d); x1 = Math.max(x1, d); } }
    if (x1 - x0 < 14) { x0 -= 7; x1 += 7; }
    const ys = pts.map((p) => p.f1);
    let y0 = Math.floor((Math.min(...ys) - 0.2) * 2) / 2, y1 = Math.ceil((Math.max(...ys) + 0.2) * 2) / 2;
    const X = (d) => L + (d - x0) / (x1 - x0) * (W - L - R);
    const Y = (v) => T + (v - y0) / (y1 - y0) * (H - T - B);   // 速い（小さい）ほど上
    let g = '';
    const step = y1 - y0 > 3 ? 1 : 0.5;
    for (let v = y0; v <= y1 + 1e-9; v += step) {
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 5}" y="${Y(v) + 3}" text-anchor="end">${v.toFixed(1)}</text>`;
    }
    // 月の目盛り
    const start = new Date((x0) * 86400000 + Date.UTC(2000, 0, 1));
    let m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const months = [];
    while (true) {
      const iso = m.toISOString().slice(0, 10);
      const d = dn(iso);
      if (d > x1) break;
      months.push({ d, label: m.getUTCMonth() === 0 ? `${m.getUTCFullYear() % 100}年1月` : `${m.getUTCMonth() + 1}月` });
      m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    }
    const every = Math.max(1, Math.ceil(months.length / Math.floor((W - L) / 46)));
    months.forEach((mo, i) => { if (i % every === 0 || mo.label.includes('年')) g += `<text x="${X(mo.d)}" y="${H - 6}" text-anchor="middle">${mo.label}</text><line class="grid" x1="${X(mo.d)}" x2="${X(mo.d)}" y1="${H - B}" y2="${H - B + 4}"/>`; });
    // 出走日の点線
    let lastLabelX = -1e9;
    for (const r of races) {
      const d = dn(r.date); if (d < x0 || d > x1) continue;
      const x = X(d);
      g += `<line class="raceline" x1="${x}" x2="${x}" y1="${T - 4}" y2="${H - B}"/>`;
      if (x - lastLabelX > 44) {
        const anchor = x > W - 40 ? 'end' : x < L + 30 ? 'start' : 'middle';
        g += `<text x="${x}" y="${T - 8}" text-anchor="${anchor}">${esc(shortName(r.name).slice(0, 7))}</text>`;
        lastLabelX = x;
      }
    }
    // 系列（坂路・ウッド）。間隔が45日以上空いたら線を切る
    chartPoints = [];
    for (const course of ['坂路', 'ウッド']) {
      const s = pts.filter((p) => p.course === course).sort((a, b) => (a.date < b.date ? -1 : 1));
      if (!s.length) continue;
      const color = course === 'ウッド' ? 'var(--wood)' : 'var(--hanro)';
      let path = '';
      s.forEach((p, i) => {
        const gap = i > 0 && dn(p.date) - dn(s[i - 1].date) > 45;
        path += `${i === 0 || gap ? 'M' : 'L'}${X(dn(p.date)).toFixed(1)},${Y(p.f1).toFixed(1)}`;
      });
      g += `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" opacity=".75"/>`;
      for (const p of s) {
        const cx = X(dn(p.date)), cy = Y(p.f1);
        const fin = finals.has(p.date + p.time);
        g += fin
          ? `<circle cx="${cx}" cy="${cy}" r="5" fill="var(--surface)" stroke="${color}" stroke-width="2.4"/>`
          : `<circle cx="${cx}" cy="${cy}" r="3.2" fill="${color}"/>`;
        chartPoints.push({ cx, cy, p, fin });
      }
    }
    wrap.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="追い切りラスト1Fの推移">${g}<circle id="chartSel" r="8" fill="none" stroke="var(--text)" stroke-width="1.5" visibility="hidden"/></svg>`;
  }

  $('#chartWrap').addEventListener('click', (ev) => {
    const svg = $('#chartWrap svg'); if (!svg || !chartPoints.length) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const x = (ev.clientX - rect.left) * vb.width / rect.width, y = (ev.clientY - rect.top) * vb.height / rect.height;
    let best = null, bd = Infinity;
    for (const c of chartPoints) { const d = (c.cx - x) ** 2 + ((c.cy - y) * 0.4) ** 2; if (d < bd) { bd = d; best = c; } }
    if (!best) return;
    const sel = $('#chartSel'); sel.setAttribute('cx', best.cx); sel.setAttribute('cy', best.cy); sel.setAttribute('visibility', 'visible');
    const p = best.p;
    $('#chartTip').textContent = `${slash(p.date)} ${p.course} ${p.mainKey.slice(1)}F ${f1d(p.main)}・ラスト1F ${f1d(p.f1)}（${p.shape}）${best.fin ? '・最終追い切り' : ''}`;
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { const h = horse(); if (h) renderChart(h, Judge.judge(h.workouts, h.races)); }, 150); });

  // ------------------------------------------------------ スクショ取り込み ----
  $('#fileInput').addEventListener('change', async (ev) => {
    const files = [...ev.target.files];
    ev.target.value = '';
    if (!files.length) return;
    const prog = $('#progress'), text = $('#progressText'), bar = $('#progressBar');
    prog.hidden = false;
    const lists = [], names = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const base = i / files.length;
        text.textContent = `読み取り中 ${i + 1}/${files.length}`;
        const res = await ChokyoOCR.recognizeFile(files[i], (m) => {
          if (m.phase === 'recognizing text') bar.style.width = `${Math.round((base + (m.progress || 0) / files.length) * 100)}%`;
          else text.textContent = m.phase && /load|init/i.test(m.phase) ? `OCRの準備中（初回のみ数秒〜）… ${files.length > 1 ? `${i + 1}/${files.length}` : ''}` : text.textContent;
        });
        for (const r of res.rows) r.snippet = snippet(res.image, r);
        if (res.image.close) res.image.close();
        lists.push(res.rows);
        if (res.horseName) names.push(res.horseName);
        bar.style.width = `${Math.round(((i + 1) / files.length) * 100)}%`;
      }
    } catch (e) {
      console.error(e);
      toast('読み取りに失敗しました: ' + e.message);
      prog.hidden = true;
      return;
    }
    prog.hidden = true; bar.style.width = '0';
    const merged = ChokyoOCR.mergeRows(lists);
    if (!merged.length) { toast('調教の行が見つかりませんでした。JRA-VAN の調教タイム画面のスクショか確認してください'); return; }
    const detected = names.length ? names.sort((a, b) => names.filter((x) => x === b).length - names.filter((x) => x === a).length)[0] : null;
    openConfirm(merged.map(fromOcrRow), `${files.length}枚から${merged.length}行を読み取りました${detected ? `・馬名「${detected}」を検出` : ''}`, detected);
  });

  function snippet(img, r) {
    const sh = r.bandBottom - r.bandTop;
    if (!(sh > 4)) return null;
    const outW = 640, outH = Math.round(sh * outW / r.bandWidth);
    const c = document.createElement('canvas'); c.width = outW; c.height = outH;
    c.getContext('2d').drawImage(img, r.bandLeft, r.bandTop, r.bandWidth, sh, 0, 0, outW, outH);
    return c.toDataURL('image/jpeg', 0.8);
  }

  function fromOcrRow(r) {
    const o = { date: slash(r.date), time: r.time, course: r.course, snippet: r.snippet, warnings: r.warnings.slice(), notes: r.notes.slice(), excluded: false, edited: false };
    for (const k of KEYS) o[k] = r[k] == null ? '' : f1d(r[k]);
    return o;
  }

  // ------------------------------------------------------ 確認・修正画面 ----
  let cfRows = [];
  const dlg = $('#confirmDlg');

  function parseDateIn(s) {
    const t = String(s).trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    let m = /^(20\d\d)[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(t) || /^(20\d\d)(\d\d)(\d\d)$/.exec(t);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function parseTimeIn(s) {
    const t = String(s).trim();
    const m = /^(\d{1,2}):?(\d{2})$/.exec(t);
    return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : (t ? null : '');
  }
  function parseNumIn(s) {
    let t = String(s).trim().replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    if (t === '' || t === '-') return null;
    if (/^\d{3}$/.test(t)) t = t.slice(0, 2) + '.' + t.slice(2);
    if (!/^\d{1,3}(\.\d)?$/.test(t)) return NaN;
    return parseFloat(t);
  }

  /** 確認画面の1行 → 保存用オブジェクトと警告 */
  function evalRow(r) {
    const out = { date: parseDateIn(r.date), time: parseTimeIn(r.time), course: r.course };
    const warn = [];
    if (!out.date) warn.push('日付の形式（例 2026/10/07）');
    if (out.time === null) warn.push('時刻の形式（例 07:01）');
    for (const k of KEYS) {
      const v = parseNumIn(r[k]);
      if (Number.isNaN(v)) warn.push(`${k.slice(1)}F が数値でない`);
      out[k] = Number.isNaN(v) ? null : v;
    }
    warn.push(...ChokyoOCR.validateRow({ ...out, date: out.date || 'x' }));
    return { out, warn: [...new Set(warn)] };
  }

  /** 確認画面で選ばれている保存先（既存の馬 or null = 新規） */
  function targetHorse() {
    const v = $('#cfHorse').value;
    return v && !v.startsWith('new:') ? state.horses[v] || null : null;
  }

  function existingStatus(out) {
    const h = targetHorse(); if (!h || !out.date) return 'new';
    const ex = h.workouts.find((w) => w.date === out.date && w.time === (out.time || ''));
    if (!ex) return 'new';
    return KEYS.every((k) => ex[k] === out[k]) && ex.course === out.course ? 'same' : 'upd';
  }

  function openConfirm(rows, sub, detectedName) {
    cfRows = rows;
    const sel = $('#cfHorse');
    const ids = Object.keys(state.horses);
    const hit = detectedName ? findHorseByName(detectedName) : null;
    let opts = ids.map((id) => `<option value="${id}">${esc(state.horses[id].name)}</option>`).join('');
    if (detectedName && !hit) opts += `<option value="new:${esc(detectedName)}">＋ 新規: ${esc(detectedName)}</option>`;
    opts += '<option value="new:">＋ 新しい馬…</option>';
    sel.innerHTML = opts;
    sel.value = hit || (detectedName ? `new:${detectedName}` : state.current && state.horses[state.current] ? state.current : 'new:');
    const h = targetHorse() || horse();
    $('#cfCenter').value = (h && h.center) || '栗東';
    $('#cfSub').textContent = sub || '';
    $('#cfWarnOnly').checked = false;
    renderConfirm();
    dlg.showModal();
    $('#cfBody').scrollTop = 0;
  }

  function renderConfirm() {
    const body = $('#cfBody');
    body.innerHTML = '';
    cfRows.forEach((r, i) => body.appendChild(buildCfRow(r, i)));
    updateCfHeader();
  }

  function buildCfRow(r, i) {
    const el = document.createElement('div');
    el.className = 'cf-row';
    el.innerHTML = `
      ${r.snippet ? `<div class="cf-imgwrap"><img class="cf-img" src="${r.snippet}" alt="スクショのこの行" title="タップで拡大"></div>` : ''}
      <div class="cf-top">
        <input data-k="date" value="${esc(r.date)}" inputmode="numeric" aria-label="日付" placeholder="2026/10/07">
        <input data-k="time" value="${esc(r.time)}" inputmode="numeric" aria-label="時刻" placeholder="07:00">
        <select data-k="course" aria-label="コース"><option>坂路</option><option>ウッド</option></select>
        <button type="button" class="cf-toggle" aria-label="この行を除外">✕</button>
      </div>
      <div class="cf-grid">${KEYS.map((k) => `<label>${k.slice(1)}F<input data-k="${k}" value="${esc(r[k])}" inputmode="decimal" aria-label="${k.slice(1)}F"></label>`).join('')}</div>
      <div class="cf-msg"></div>`;
    $('select', el).value = r.course;
    const img = $('.cf-img', el);
    if (img) img.addEventListener('click', () => img.parentElement.classList.toggle('zoom'));
    el.addEventListener('input', (ev) => {
      const k = ev.target.dataset.k; if (!k) return;
      r[k] = ev.target.value; r.edited = true;
      if ((k === 'f5' || k === 'f6')) {
        const wood = String(r.f5).trim() !== '' || String(r.f6).trim() !== '';
        if (wood && r.course === '坂路') { r.course = 'ウッド'; $('select', el).value = 'ウッド'; }
        if (!wood && r.course === 'ウッド') { r.course = '坂路'; $('select', el).value = '坂路'; }
      }
      updateCfRow(el, r); updateCfHeader();
    });
    el.addEventListener('change', (ev) => { if (ev.target.dataset.k === 'course') { r.course = ev.target.value; r.edited = true; updateCfRow(el, r); updateCfHeader(); } });
    $('.cf-toggle', el).addEventListener('click', () => {
      r.excluded = !r.excluded;
      updateCfRow(el, r); updateCfHeader();
    });
    updateCfRow(el, r);
    return el;
  }

  function rowWarnings(r) {
    const { out, warn } = evalRow(r);
    // OCR 固有の警告（下段ラップとの不一致・日付の並び）は手で直すまで残す
    const ocrOnly = r.edited ? [] : r.warnings.filter((w) => /ラップ\(|並び|不一致/.test(w));
    return { out, warn: [...new Set([...warn, ...ocrOnly])] };
  }

  function updateCfRow(el, r) {
    const { out, warn } = rowWarnings(r);
    r._warn = warn; r._out = out;
    el.classList.toggle('has-warn', !r.excluded && warn.length > 0);
    el.classList.toggle('excluded', r.excluded);
    $('.cf-toggle', el).textContent = r.excluded ? '↺' : '✕';
    $('.cf-toggle', el).setAttribute('aria-label', r.excluded ? 'この行を戻す' : 'この行を除外');
    const bad = new Set();
    for (const w of warn) for (const m of w.matchAll(/([1-6])F/g)) bad.add('f' + m[1]);
    for (const k of KEYS) $(`input[data-k="${k}"]`, el).classList.toggle('bad', bad.has(k));
    const st = existingStatus(out);
    const tag = r.excluded ? '<span class="tag">除外</span>' : st === 'new' ? '<span class="tag new">新規</span>' : st === 'upd' ? '<span class="tag upd">更新</span>' : '<span class="tag">登録済</span>';
    const notes = r.edited ? [] : r.notes;
    el.querySelector('.cf-msg').innerHTML = `${tag} ${warn.map((w) => `<span class="w">${esc(w)}</span>`).join(' ')} ${notes.map((n) => `<span class="i">${esc(n)}</span>`).join(' ')}`;
    el.hidden = $('#cfWarnOnly').checked && !(warn.length && !r.excluded);
  }

  function updateCfHeader() {
    const active = cfRows.filter((r) => !r.excluded);
    const warnN = active.filter((r) => r._warn && r._warn.length).length;
    $('#cfTitle').textContent = `読み取り結果の確認（${active.length}行${warnN ? `・要確認 ${warnN}` : ''}）`;
    $('#cfSave').textContent = `保存（${active.length}行）`;
  }

  $('#cfHorse').addEventListener('change', () => {
    const h = targetHorse(); if (h && h.center) $('#cfCenter').value = h.center;
    [...$('#cfBody').children].forEach((el, i) => updateCfRow(el, cfRows[i]));
  });
  $('#cfWarnOnly').addEventListener('change', () => {
    [...$('#cfBody').children].forEach((el, i) => updateCfRow(el, cfRows[i]));
  });
  $('#cfAddRow').addEventListener('click', () => {
    const r = blankRow();
    cfRows.unshift(r);
    renderConfirm();
    $('#cfBody').scrollTop = 0;
    const first = $('#cfBody input[data-k="date"]'); if (first) first.focus();
  });
  $('#cfCancel').addEventListener('click', () => {
    if (cfRows.some((r) => r.edited) && !confirm('修正内容を破棄して閉じますか？')) return;
    dlg.close();
  });
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); $('#cfCancel').click(); });

  $('#cfSave').addEventListener('click', () => {
    let h = targetHorse();
    const sv = $('#cfHorse').value;
    if (!h) {
      let name = sv.startsWith('new:') ? sv.slice(4) : '';
      if (!name) name = (prompt('馬名を入力してください') || '').trim();
      if (!name) return;
      const id = findHorseByName(name);
      if (id) { h = state.horses[id]; state.current = id; } else h = newHorse(name);
    } else {
      state.current = sv;
    }
    const center = $('#cfCenter').value;
    const active = cfRows.filter((r) => !r.excluded).map((r) => ({ r, ...rowWarnings(r) }));
    const unsavable = active.filter(({ out }) => !out.date || out.f1 == null || out.time === null);
    const warned = active.filter(({ warn }) => warn.length);
    if (unsavable.length && !confirm(`日付・時刻・1F が読めない ${unsavable.length} 行は保存されません。続けますか？`)) return;
    if (warned.length - unsavable.length > 0 && !confirm(`要確認の行が ${warned.length - unsavable.length} 行あります。このまま保存しますか？`)) return;
    let added = 0, updated = 0, same = 0;
    for (const { out } of active) {
      if (!out.date || out.f1 == null || out.time === null) continue;
      const w = { date: out.date, time: out.time || '', center, course: out.course };
      for (const k of KEYS) w[k] = out[k];
      const idx = h.workouts.findIndex((x) => x.date === w.date && x.time === w.time);
      if (idx >= 0) {
        const old = h.workouts[idx];
        if (old.course === w.course && old.center === w.center && KEYS.every((k) => old[k] === w[k])) same++; else updated++;
        h.workouts[idx] = w;
      } else { h.workouts.push(w); added++; }
    }
    h.center = center;
    sortWorkouts(h.workouts);
    save(); dlg.close(); render();
    toast(`${added}件追加・${updated}件更新${same ? `（${same}件は変更なし）` : ''}`);
  });

  function blankRow() {
    const r = { date: '', time: '', course: '坂路', snippet: null, warnings: [], notes: [], excluded: false, edited: true };
    for (const k of KEYS) r[k] = '';
    return r;
  }

  $('#manualBtn').addEventListener('click', () => {
    const r = blankRow(); r.date = slash(todayISO());
    openConfirm([r], '手入力。坂路は 4F〜1F、ウッドは 5F（6F）〜1F を入力');
  });

  // ------------------------------------------------------------- レース ----
  const raceForm = $('#raceForm');
  $('#addRaceToggle').addEventListener('click', () => {
    if (!ensureHorse()) return;
    raceForm.reset(); raceForm.index.value = ''; raceForm.hidden = !raceForm.hidden;
    if (!raceForm.hidden) { fillRacePicker(true); ($('#racePickWrap').hidden ? raceForm.date : $('#racePick')).focus(); }
  });

  /** 他の馬で登録済みのレース（この馬にまだ無いもの）を選択肢に。レース名の入力候補も全馬から */
  function fillRacePicker(show) {
    const h = horse();
    const mine = new Set((h ? h.races : []).map(raceKey));
    const seen = new Map(), names = new Set();
    for (const hh of Object.values(state.horses)) {
      for (const r of hh.races) {
        names.add(r.name);
        const k = raceKey(r);
        if (mine.has(k)) continue;
        const e = seen.get(k) || { date: r.date, name: r.name, n: 0 };
        e.n++; seen.set(k, e);
      }
    }
    const list = [...seen.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
    const today = todayISO();
    $('#racePick').innerHTML = '<option value="">選択してください</option>' + list.map((r, i) =>
      `<option value="${i}">${r.date >= today ? '◆ ' : ''}${slash(r.date)} ${esc(r.name)}（${r.n}頭登録）</option>`).join('');
    $('#racePick')._list = list;
    $('#racePickWrap').hidden = !show || !list.length;
    $('#raceNames').innerHTML = [...names].sort((a, b) => a.localeCompare(b, 'ja')).map((n) => `<option value="${esc(n)}">`).join('');
  }
  $('#racePick').addEventListener('change', (ev) => {
    const r = ev.target._list && ev.target._list[+ev.target.value];
    if (!r) return;
    raceForm.date.value = r.date; raceForm.name.value = r.name;
    raceForm.result.focus();
  });
  $('#raceCancel').addEventListener('click', () => { raceForm.hidden = true; });
  raceForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const h = ensureHorse(); if (!h) return;
    const r = { date: raceForm.date.value, name: raceForm.name.value.trim(), result: raceForm.result.value.trim() };
    if (!r.date || !r.name) return;
    const idx = raceForm.index.value === '' ? -1 : +raceForm.index.value;
    if (idx >= 0) h.races[idx] = r; else h.races.push(r);
    sortRaces(h.races);
    save(); raceForm.hidden = true; render();
  });
  $('#raceList').addEventListener('click', (ev) => {
    const h = horse(); if (!h) return;
    const e = ev.target.closest('[data-edit-race]'), d = ev.target.closest('[data-del-race]');
    if (e) {
      const r = h.races[+e.dataset.editRace];
      fillRacePicker(false);
      raceForm.hidden = false; raceForm.index.value = e.dataset.editRace;
      raceForm.date.value = r.date; raceForm.name.value = r.name; raceForm.result.value = r.result || '';
      raceForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (d) {
      const r = h.races[+d.dataset.delRace];
      if (!confirm(`${slash(r.date)} ${r.name} を削除しますか？`)) return;
      h.races.splice(+d.dataset.delRace, 1); save(); render();
    }
  });
  $('#wkList').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-del-wk]'); if (!b) return;
    const h = horse(); const w = h.workouts[+b.dataset.delWk];
    if (!confirm(`${slash(w.date)} ${w.time} ${w.course} の調教を削除しますか？`)) return;
    h.workouts.splice(+b.dataset.delWk, 1); save(); render();
  });

  // ---------------------------------------------------------- 馬・メニュー ----
  $('#horseSelect').addEventListener('change', (ev) => {
    if (ev.target.value === '__new') {
      const name = prompt('馬名を入力してください');
      if (name && name.trim()) { newHorse(name.trim()); save(); }
    } else if (ev.target.value) { state.current = ev.target.value; save(); }
    raceForm.hidden = true;
    render();
  });
  const menu = $('#menuDlg');
  $('#menuBtn').addEventListener('click', () => { updateThemeLabel(); menu.showModal(); });
  menu.addEventListener('click', async (ev) => {
    if (ev.target === menu) { menu.close(); return; }
    const act = ev.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act !== 'theme') menu.close();
    const h = horse();
    switch (act) {
      case 'newHorse': { const n = prompt('馬名を入力してください'); if (n && n.trim()) { newHorse(n.trim()); save(); render(); } break; }
      case 'renameHorse': { if (!h) break; const n = prompt('新しい馬名', h.name); if (n && n.trim()) { h.name = n.trim(); save(); render(); } break; }
      case 'deleteHorse': {
        if (!h || !confirm(`${h.name} のデータ（調教${h.workouts.length}件・レース${h.races.length}件）を削除しますか？`)) break;
        delete state.horses[state.current]; state.current = Object.keys(state.horses)[0] || null; save(); render(); break;
      }
      case 'exportWorkouts': if (h) download(`${h.name}_training.csv`, Judge.workoutsToCSV(h.workouts), 'text/csv'); break;
      case 'exportRaces': if (h) download(`${h.name}_races.csv`, Judge.racesToCSV(h.races), 'text/csv'); break;
      case 'exportAll': download(`chokyo-judge-backup-${todayISO()}.json`, JSON.stringify(state, null, 1), 'application/json'); break;
      case 'importAll': $('#csvInput').click(); break;
      case 'sample': await loadSamples(); break;
      case 'stats': openStats(); break;
      case 'theme': cycleTheme(); break;
    }
  });

  function download(name, text, type) {
    const blob = new Blob([type === 'text/csv' ? '﻿' + text : text], { type: type + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  $('#csvBtn').addEventListener('click', () => $('#csvInput').click());
  $('#csvInput').addEventListener('change', async (ev) => {
    const file = ev.target.files[0]; ev.target.value = '';
    if (!file) return;
    const text = await file.text();
    try {
      if (/^\s*\{/.test(text)) {   // バックアップ JSON
        const s = JSON.parse(text);
        if (!s.horses) throw new Error('バックアップ形式ではありません');
        if (!confirm(`バックアップの ${Object.keys(s.horses).length} 頭を読み込みます（同じIDの馬は上書き）。よろしいですか？`)) return;
        Object.assign(state.horses, s.horses);
        state.current = s.current && state.horses[s.current] ? s.current : Object.keys(state.horses)[0];
        save(); render(); toast('復元しました');
        return;
      }
      const head = text.replace(/^﻿/, '').split(/\r?\n/)[0];
      if (/\bf1\b/.test(head)) {
        const rows = Judge.workoutsFromCSV(text).map((w) => {
          const r = { date: slash(w.date), time: w.time, course: w.course === 'ウッド' ? 'ウッド' : '坂路', snippet: null, warnings: [], notes: [], excluded: false, edited: false };
          for (const k of KEYS) r[k] = f1d(w[k]);
          return r;
        });
        openConfirm(rows, `${file.name} から ${rows.length} 行`);
      } else if (/\bname\b/.test(head)) {
        const h = ensureHorse(); if (!h) return;
        const races = Judge.racesFromCSV(text);
        for (const r of races) {
          const i = h.races.findIndex((x) => x.date === r.date);
          if (i >= 0) h.races[i] = r; else h.races.push(r);
        }
        sortRaces(h.races); save(); render(); toast(`レース ${races.length} 件を読み込みました`);
      } else throw new Error('ヘッダーが date,time,center,course,f6..f1 または date,name,result のCSVを選んでください');
    } catch (e) { toast('読み込めませんでした: ' + e.message); }
  });

  async function loadSamples() {
    const samples = [['アイサンサン', '栗東', 'aisansan'], ['ウインマーベル', '美浦', 'winmarvel']];
    try {
      for (const [name, center, key] of samples) {
        const [wt, rt] = await Promise.all([`data/${key}_training.csv`, `data/${key}_races.csv`].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.text(); })));
        const id = Object.keys(state.horses).find((k) => state.horses[k].name === name);
        const h = id ? state.horses[id] : newHorse(name, center);
        h.center = center;
        h.workouts = sortWorkouts(Judge.workoutsFromCSV(wt));
        h.races = sortRaces(Judge.racesFromCSV(rt));
        if (id) state.current = id;
      }
      save(); render(); toast('サンプル2頭を読み込みました');
    } catch (e) { toast('サンプルを取得できませんでした: ' + e.message); }
  }

  // --------------------------------------------------------------- テーマ ----
  function applyTheme() {
    let t = 'auto'; try { t = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { /* noop */ }
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    return t;
  }
  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(applyTheme()) + 1) % 3];
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* noop */ }
    applyTheme(); updateThemeLabel();
  }
  function updateThemeLabel() { $('#themeLabel').textContent = { auto: '自動', light: 'ライト', dark: 'ダーク' }[applyTheme()]; }

  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  applyTheme();
  if (!state.current || !state.horses[state.current]) state.current = Object.keys(state.horses)[0] || null;
  render();
})();
