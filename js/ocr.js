/*
 * ocr.js — JRA-VAN「調教タイム」画面スクショの読み取り
 *
 * 方針
 *   1. 明るい領域（表の白/黄色背景）を自動で切り出し、幅 TARGET_W に拡大
 *   2. グレースケール → 大津の二値化（黄色/白の縞・グレーのセル・罫線を白に飛ばす）
 *   3. Tesseract.js（英数字のみ）で単語単位の bounding box を取得
 *   4. 日付の単語で行を検出 → 同じ行帯の数値を列ごとに拾う
 *      - 列は全行の数値の x 座標をクラスタリングして推定し、右から 1F,2F,…,6F に割当
 *      - セル内の上段（累計）を採用、括弧付き・下段（ラップ）は検算に使う
 *   5. 妥当性チェック（6F>5F>…>1F、ラップ10〜30秒、累計と下段ラップの整合）
 *
 * 画像はブラウザ内で処理し、外部には送信しない（Tesseract のモデルを CDN から取得するだけ）。
 * parseWords() 以降は DOM 非依存なので Node からもテストできる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChokyoOCR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  // 前処理・OCRの設定（テストページから上書きして比較できるように公開）
  const config = { targetW: 1600, lo: 80, hi: 195, psm: '11' };
  const KEYS = ['f6', 'f5', 'f4', 'f3', 'f2', 'f1'];
  const LAP_MIN = 10, LAP_MAX = 30;

  // ------------------------------------------------------------ 前処理 ----
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Tesseract.js を読み込めませんでした（通信を確認）'));
      document.head.appendChild(s);
    });
  }

  async function fileToImage(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file); } catch (e) { /* fall through */ }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像を読み込めませんでした'));
      img.src = URL.createObjectURL(file);
    });
  }

  /** 最長の連続区間（短い途切れは許容）を返す */
  function longestRun(flags, maxGap) {
    let best = [0, flags.length - 1], bestLen = -1, start = -1, last = -1;
    for (let i = 0; i <= flags.length; i++) {
      const on = i < flags.length && flags[i];
      if (on) {
        if (start < 0 || i - last > maxGap + 1) {
          if (start >= 0 && last - start > bestLen) { bestLen = last - start; best = [start, last]; }
          start = i;
        }
        last = i;
      }
    }
    if (start >= 0 && last - start > bestLen) best = [start, last];
    return best;
  }

  /** 表の白/黄色の領域を見つけて切り出し範囲を返す（元画像座標） */
  function findTableRect(img) {
    const W = img.width, H = img.height;
    const s = Math.min(1, 600 / Math.max(W, H));
    const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const light = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      light[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) > 170 ? 1 : 0;
    }
    const colOn = [];
    for (let x = 0; x < w; x++) { let n = 0; for (let y = 0; y < h; y++) n += light[y * w + x]; colOn.push(n / h > 0.35); }
    const [x0, x1] = longestRun(colOn, 2);
    const rowOn = [];
    for (let y = 0; y < h; y++) { let n = 0; for (let x = x0; x <= x1; x++) n += light[y * w + x]; rowOn.push(n / (x1 - x0 + 1) > 0.6); }
    const [y0, y1] = longestRun(rowOn, 3);
    const rect = { x: Math.floor(x0 / s), y: Math.floor(y0 / s), w: Math.ceil((x1 - x0 + 1) / s), h: Math.ceil((y1 - y0 + 1) / s) };
    // 明るい領域が小さすぎる場合は全体を使う
    if (rect.w < W * 0.2 || rect.h < H * 0.2) return { x: 0, y: 0, w: W, h: H };
    return rect;
  }

  /** 切り出し・拡大・二値化したキャンバスを返す */
  function preprocess(img) {
    const rect = findTableRect(img);
    const scale = Math.min(4, config.targetW / rect.w);
    const w = Math.round(rect.w * scale), h = Math.round(rect.h * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h), d = id.data;
    // レベル補正: 背景（白 254 / 黄 246 / グレーのセル 210 / 罫線）を真っ白に飛ばし、
    // 文字のアンチエイリアスは残す（二値化は Tesseract 内部に任せる）
    const { lo, hi } = config;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = g <= lo ? 0 : g >= hi ? 255 : Math.round((g - lo) * 255 / (hi - lo));
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    const th = hi;
    ctx.putImageData(id, 0, 0);
    return { canvas: c, rect, scale, threshold: th };
  }

  // ------------------------------------------------------------- OCR 本体 ----
  let workerPromise = null;
  async function getWorker(onProgress) {
    if (!workerPromise) {
      workerPromise = (async () => {
        if (typeof Tesseract === 'undefined') await loadScript(TESSERACT_URL);
        const worker = await Tesseract.createWorker('eng', 1, {
          logger: (m) => onProgress && onProgress({ phase: m.status, progress: m.progress }),
        });
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789./:()-',
          tessedit_pageseg_mode: config.psm,   // 11 = sparse text: 表の数値をばらばらに拾う
        });
        return worker;
      })().catch((e) => { workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  /**
   * 画像ファイル1枚を読み取る。
   * 戻り値: { rows, image, prep }  rows の各行は bandTop/bandBottom（元画像座標）を持つ
   */
  async function recognizeFile(file, onProgress) {
    const img = await fileToImage(file);
    const prep = preprocess(img);
    const worker = await getWorker(onProgress);
    const { data } = await worker.recognize(prep.canvas);
    const words = (data.words || []).map((wd) => ({
      text: wd.text, conf: wd.confidence,
      x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1,
    }));
    const rows = parseWords(words, { width: prep.canvas.width, height: prep.canvas.height });
    // 行帯を元画像の座標に戻す（確認画面でその行の画像を切り出すため）
    for (const r of rows) {
      r.bandTop = Math.max(0, Math.floor(prep.rect.y + r.bandTop / prep.scale));
      r.bandBottom = Math.min(img.height, Math.ceil(prep.rect.y + r.bandBottom / prep.scale));
      r.bandLeft = prep.rect.x; r.bandWidth = prep.rect.w;
    }
    return { rows, image: img, prep, words };
  }

  // ------------------------------------------------- 単語 → 行（DOM非依存） ----
  const median = (a) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const r1 = (x) => Math.round(x * 10) / 10;

  function validYMD(y, mo, d) {
    return y >= 2000 && y < 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
  }
  const ymd = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  /** "2026/10/07(7)" → "2026-10-07"。スラッシュの誤読（"10/125" など）にも耐える */
  function parseDate(text) {
    if (!/^20\d\d/.test(text)) return null;
    const body = text.split('(')[0];
    const parts = body.split('/').filter(Boolean);
    if (parts.length === 3 && /^\d{4}$/.test(parts[0])) {
      const y = +parts[0], mo = +parts[1].replace(/\D/g, '');
      let dd = parts[2].replace(/\D/g, '');
      if (dd.length > 2) dd = dd.slice(-2);  // スラッシュが "1" に化けた場合
      if (validYMD(y, mo, +dd)) return ymd(y, mo, +dd);
    }
    const m = /^(20\d{2})(\d{2})(\d{2})/.exec(body.replace(/\D/g, ''));
    if (m && validYMD(+m[1], +m[2], +m[3])) return ymd(+m[1], +m[2], +m[3]);
    return null;
  }

  /** "52.4" "524" "(12.5)" → { value, paren } */
  function parseNumber(text) {
    const paren = /[()]/.test(text);
    let t = text.replace(/[^0-9.]/g, '');
    if (!t) return null;
    // 小数点の脱落 "524" → 52.4、"17"（"11.7" の 1 と小数点が脱落）→ 1.7（後で列の文脈で補正）
    if (!t.includes('.') && /^\d{2,4}$/.test(t)) t = t.slice(0, -1) + '.' + t.slice(-1);
    if (!/^\d{1,3}\.\d$/.test(t)) return null;
    const v = parseFloat(t);
    if (!(v >= 1 && v < 200)) return null;
    return { value: v, paren };
  }

  /** "85.667.0" のようにくっついた2値を分割 */
  function splitMerged(w) {
    const t = w.text.replace(/[^0-9.()]/g, '');
    const m = /^\(?(\d{2,3}\.\d)\)?\(?(\d{2,3}\.\d)\)?$/.exec(t);
    if (!m) return [w];
    const mid = (w.x0 + w.x1) / 2;
    return [{ ...w, text: m[1], x1: mid }, { ...w, text: m[2], x0: mid }];
  }

  function clusterX(xs, gap) {
    const s = [...xs].sort((a, b) => a - b);
    const groups = [];
    for (const x of s) {
      const g = groups[groups.length - 1];
      if (g && x - g[g.length - 1] <= gap) g.push(x); else groups.push([x]);
    }
    return groups.map((g) => ({ center: median(g), n: g.length }));
  }

  /**
   * Tesseract の単語リストから調教行を組み立てる。
   * words: [{text, x0,y0,x1,y1, conf}]（前処理後キャンバスの座標）
   */
  function parseWords(words, size) {
    const W = (size && size.width) || Math.max(...words.map((w) => w.x1));
    const toks = [];
    for (const w of words) {
      if (!w.text || !w.text.trim()) continue;
      for (const p of splitMerged(w)) {
        toks.push({ ...p, cx: (p.x0 + p.x1) / 2, cy: (p.y0 + p.y1) / 2, h: p.y1 - p.y0 });
      }
    }

    // 1) 日付で行を検出（左側 40% にあるものだけ）
    let dates = toks.filter((t) => t.cx < W * 0.4).map((t) => ({ t, date: parseDate(t.text) })).filter((d) => d.date);
    dates.sort((a, b) => a.t.cy - b.t.cy);
    // 同じ行で日付が2つに割れた場合の重複除去
    dates = dates.filter((d, i) => i === 0 || Math.abs(d.t.cy - dates[i - 1].t.cy) > d.t.h * 0.8);
    if (!dates.length) return [];

    const gaps = dates.slice(1).map((d, i) => d.t.cy - dates[i].t.cy);
    const textH = median(dates.map((d) => d.t.h));
    let rowH = median(gaps.filter((g) => g > textH * 1.5));
    if (!(rowH > 0)) rowH = textH * 2.6;

    // 2) 数値トークン（日付・時刻より右）
    const dateRight = median(dates.map((d) => d.t.x1));
    const nums = [];
    for (const t of toks) {
      if (t.cx <= dateRight) continue;
      if (/^\d{1,2}:\d{2}/.test(t.text.replace(/[^0-9:]/g, ''))) continue;
      const n = parseNumber(t.text);
      if (n) nums.push({ ...t, ...n });
    }

    // 3) 列の推定：上段/中段（括弧なし）の数値の x 中心をクラスタリング
    const tokW = median(nums.map((n) => n.x1 - n.x0)) || 40;
    let cols = clusterX(nums.filter((n) => !n.paren).map((n) => n.cx), tokW * 0.6)
      .filter((c) => c.n >= Math.max(1, Math.min(3, dates.length * 0.15)));
    // 時刻列などの誤検出を避けるため、右から最大6列
    cols = cols.slice(-6);
    const colOf = (cx) => {
      let best = -1, bd = Infinity;
      cols.forEach((c, i) => { const dd = Math.abs(c.center - cx); if (dd < bd) { bd = dd; best = i; } });
      return bd <= tokW * 0.8 ? best : -1;
    };
    // 右端の列 = 1F
    const keyOfCol = (i) => KEYS[KEYS.length - (cols.length - i)];

    // 4) 行ごとに値を割り当て
    const rows = [];
    dates.forEach((d, idx) => {
      const y = d.t.cy;
      const top = y - rowH * 0.5, bottom = y + rowH * 0.5;
      const row = { date: d.date, time: '', course: '', warnings: [], notes: [], bandTop: top, bandBottom: bottom };
      KEYS.forEach((k) => { row[k] = null; });
      row.laps = {};

      const time = toks
        .filter((t) => Math.abs(t.cy - y) < rowH * 0.35 && t.cx > d.t.x0)
        .map((t) => ({ t, m: /(\d{1,2}):(\d{2})/.exec(t.text) }))
        .filter((o) => o.m)
        .sort((a, b) => a.t.cx - b.t.cx)[0];
      if (time) row.time = `${time.m[1].padStart(2, '0')}:${time.m[2]}`;

      const inRow = nums.filter((n) => n.cy > top && n.cy < bottom);
      const byCol = {};
      for (const n of inRow) {
        const ci = colOf(n.cx);
        if (ci < 0) continue;
        (byCol[ci] = byCol[ci] || []).push(n);
      }
      for (const ci of Object.keys(byCol)) {
        const key = keyOfCol(+ci);
        if (!key) continue;
        const list = byCol[ci].sort((a, b) => a.cy - b.cy);
        // 上段（累計）：括弧なしで、行の中心より少し下までのうち最上段
        const cum = list.find((n) => !n.paren && n.cy < y + rowH * 0.15);
        if (cum) {
          row[key] = cum.value;
          // 累計は必ず10秒以上。"11.7" の先頭の 1 が脱落して "1.7" と読めた場合を補正
          if (row[key] < 10) { row[key] = r1(row[key] + 10); row.notes.push(`${key.slice(1)}F ${cum.value}→${row[key]}に補正`); }
        }
        const lap = list.find((n) => n !== cum && n.cy > y);
        if (lap) row.laps[key] = lap.value;
      }
      // 上下端で見切れた行（累計の上段が画面外）
      row.clipped = top < 0 || (idx === 0 && d.t.y0 < rowH * 0.15);
      finalizeRow(row);
      rows.push(row);
    });
    // 画面は新しい日付が上。並びが逆転していたら日付の誤読を疑う
    rows.forEach((r, i) => {
      const prev = rows[i - 1], next = rows[i + 1];
      if ((prev && r.date > prev.date) || (next && r.date < next.date)) {
        r.warnings.push('日付の並びが不自然（誤読？）'); r.ok = false;
      }
    });
    return rows;
  }

  /** コース判定・ラップによる補完・妥当性チェック */
  function finalizeRow(row) {
    const order = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
    // 坂路の 5F/6F は「-」のセル。そこで拾ったノイズ（右隣との差がラップとしてありえない値）は捨てる
    for (const k of ['f5', 'f6']) {
      const right = order[order.indexOf(k) - 1];
      if (row[k] == null || row[right] == null) continue;
      const lap = row[k] - row[right];
      if (lap < LAP_MIN || lap > LAP_MAX) { (row.debug = row.debug || []).push(`${k.slice(1)}F ノイズ ${row[k]} を除外`); row[k] = null; }
    }
    row.notes = row.notes.filter((n) => !/^[56]F /.test(n) || row[`f${n[0]}`] != null);
    if (row.f5 == null && row.f6 != null) { (row.debug = row.debug || []).push(`6F ノイズ ${row.f6} を除外`); row.f6 = null; }
    // 下段ラップと上段累計から欠けた累計を補う: f(k) = f(k-1) + lap(k)
    for (let i = 1; i < order.length; i++) {
      const k = order[i], prev = order[i - 1];
      if (row[k] == null && row[prev] != null && row.laps[k] != null) {
        const v = r1(row[prev] + row.laps[k]);
        // 坂路は 5F/6F が無いので、4F より左は補完しない
        if (i <= 3) { row[k] = v; row.notes.push(`${k.slice(1)}Fを下段ラップから補完`); }
      }
    }
    row.course = row.f5 != null || row.f6 != null ? 'ウッド' : '坂路';
    row.warnings.push(...validateRow(row));
    // 下段ラップとの整合（読めたものだけ）
    for (let i = 1; i < order.length; i++) {
      const k = order[i], prev = order[i - 1];
      if (row[k] != null && row[prev] != null && row.laps[k] != null &&
          Math.abs(row[k] - row[prev] - row.laps[k]) > 0.05) {
        row.warnings.push(`${k.slice(1)}F: 累計と下段ラップ(${row.laps[k]})が不一致`);
      }
    }
    row.ok = row.warnings.length === 0;
  }

  /** 1行の妥当性チェック。警告文の配列を返す（アプリの手入力でも使う） */
  function validateRow(row) {
    const warn = [];
    if (!row.date) warn.push('日付なし');
    for (const k of ['f4', 'f3', 'f2', 'f1']) if (row[k] == null) warn.push(`${k.slice(1)}Fが空`);
    if (row.course === 'ウッド' && row.f5 == null) warn.push('ウッドなのに5Fが空');
    const present = KEYS.filter((k) => row[k] != null);
    for (let i = 0; i < present.length - 1; i++) {
      const a = present[i], b = present[i + 1];
      if (!(row[a] > row[b])) warn.push(`${a.slice(1)}F ≤ ${b.slice(1)}F`);
    }
    // 隣り合う区間のラップ
    for (let i = 0; i < KEYS.length - 1; i++) {
      const a = KEYS[i], b = KEYS[i + 1];
      if (row[a] == null || row[b] == null) continue;
      const lap = r1(row[a] - row[b]);
      if (lap < LAP_MIN || lap > LAP_MAX) warn.push(`${a.slice(1)}F区間ラップ ${lap}秒`);
    }
    if (row.f1 != null && (row.f1 < LAP_MIN || row.f1 > LAP_MAX)) warn.push(`1F ${row.f1}秒`);
    return warn;
  }

  /**
   * 複数スクショの行を統合（重なり部分の重複を除去）。
   * 同じ日付・時刻なら警告の少ない方を採用。時刻と全タイムが同じなのに日付が違う行は
   * 日付の誤読とみなして警告する。
   */
  function mergeRows(rowLists) {
    const map = new Map();
    const badness = (x) => x.warnings.length + (x.clipped ? 0.5 : 0) + x.notes.length * 0.1;
    for (const list of rowLists) {
      for (const r of list) {
        const key = `${r.date} ${r.time}`;
        const cur = map.get(key);
        if (!cur || badness(r) < badness(cur)) map.set(key, r);
      }
    }
    const out = [...map.values()];
    const sig = (r) => [r.time, ...KEYS.map((k) => r[k])].join('|');
    const bySig = new Map();
    for (const r of out) {
      if (!r.time || r.f1 == null) continue;
      const o = bySig.get(sig(r));
      if (o && o.date !== r.date) {
        for (const x of [o, r]) { x.warnings.push(`日付が画像間で不一致（${o.date} / ${r.date}）`); x.ok = false; }
      } else bySig.set(sig(r), r);
    }
    out.sort((a, b) => (a.date === b.date ? (a.time < b.time ? 1 : -1) : a.date < b.date ? 1 : -1));
    return out;
  }

  return { config, recognizeFile, parseWords, parseDate, parseNumber, validateRow, mergeRows, preprocess, getWorker, KEYS };
});
