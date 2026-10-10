// JS版 (js/judge.js) と Python版 (training_judge.py) の判定結果が一致するかを検証する。
//   node tests/parity.mjs            … サンプル2頭 + ランダム 300 ケース
//   node tests/parity.mjs 2000       … ランダムのケース数を指定
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Judge = createRequire(import.meta.url)(join(root, 'js', 'judge.js'));
const PY = process.env.PYTHON || 'python';

function runPython(workoutsPath, racesPath, poolPath) {
  const out = execFileSync(PY, ['-I', '-X', 'utf8', join(root, 'training_judge.py'), '--json',
    '--workouts', workoutsPath, '--races', racesPath, ...(poolPath ? ['--pool', poolPath] : [])], { encoding: 'utf8' });
  return JSON.parse(out);
}

function runJS(workoutsPath, racesPath, poolPath) {
  const works = Judge.workoutsFromCSV(readFileSync(workoutsPath, 'utf8'));
  const races = Judge.racesFromCSV(readFileSync(racesPath, 'utf8'));
  const pool = poolPath ? Judge.poolFromCSV(readFileSync(poolPath, 'utf8')) : [];
  // JSON を通して Python 側と同じ表現（数値・null）にそろえる
  return JSON.parse(JSON.stringify(Judge.toComparable(Judge.judge(works, races, pool))));
}

function diff(a, b, path = '') {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? [] : [`${path}: py=${a} js=${b}`];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b ? [] : [`${path}: py=${JSON.stringify(a)} js=${JSON.stringify(b)}`];
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diff(a[k], b[k], `${path}/${k}`));
}

let failures = 0;
let poolUsed = 0;
function check(label, w, r, show, pool) {
  const py = runPython(w, r, pool), js = runJS(w, r, pool);
  poolUsed += js.filter((j) => j.baseline && j.baseline.source === '全馬').length;
  const d = diff(py, js);
  if (d.length) { failures++; console.log(`✗ ${label}\n  ` + d.slice(0, 8).join('\n  ')); }
  if (show) for (const j of js) console.log(`  ${j.race.date} ${j.race.name.padEnd(14, '　')} ${j.status === '判定済' ? `${j.rank}${j.score}` : j.status}`);
  return d.length === 0;
}

// 1) サンプル2頭
for (const horse of ['aisansan', 'winmarvel']) {
  const ok = check(horse, join(root, 'data', `${horse}_training.csv`), join(root, 'data', `${horse}_races.csv`), true);
  console.log(`${ok ? '✓' : '✗'} ${horse}: Python と一致`);
}

// 2) ランダムデータ（丸めの境界・同日複数・欠損・汎用基準などを広く踏む）
const N = +(process.argv[2] || 300);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const t1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const iso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);

const dir = mkdtempSync(join(tmpdir(), 'parity-'));
try {
  for (let c = 0; c < N; c++) {
    const start = 20000 + Math.floor(rnd() * 400);
    const span = 60 + Math.floor(rnd() * 300);
    const rows = [];
    const center = pick(['栗東', '美浦']);
    for (let d = start; d < start + span; d++) {
      if (rnd() < 0.45) continue;
      const reps = rnd() < 0.08 ? 2 : 1;
      for (let r = 0; r < reps; r++) {
        const course = pick(['坂路', '坂路', 'ウッド', 'CW', 'D']);
        const fast = rnd() < 0.35;
        const f1 = 10.8 + rnd() * (fast ? 2 : 5);
        const laps = [0, 1, 2, 3, 4].map(() => 11 + rnd() * (fast ? 3 : 8));
        const cum = [f1]; for (const l of laps) cum.push(cum[cum.length - 1] + l);
        const wood = course !== '坂路';
        const v = { f1: t1(cum[0]), f2: rnd() < 0.03 ? '' : t1(cum[1]), f3: t1(cum[2]), f4: t1(cum[3]),
          f5: wood ? t1(cum[4]) : '', f6: wood ? t1(cum[5]) : '' };
        rows.push([iso(d), `0${5 + r}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`, center, course, v.f6, v.f5, v.f4, v.f3, v.f2, v.f1].join(','));
      }
    }
    rows.reverse();
    const races = [];
    let d = start + 10 + Math.floor(rnd() * 30);
    while (d < start + span + 5) { races.push(d); d += 7 + Math.floor(rnd() * 70); }
    const raceRows = races.map((rd, i) => [iso(rd), `R${i}`, i === races.length - 1 && rnd() < 0.5 ? '' : `${1 + Math.floor(rnd() * 18)}着`].join(','));
    const w = join(dir, 'w.csv'), r = join(dir, 'r.csv');
    writeFileSync(w, 'date,time,center,course,f6,f5,f4,f3,f2,f1\n' + rows.join('\n') + '\n');
    writeFileSync(r, 'date,name,result\n' + raceRows.join('\n') + '\n');
    // 他の馬の最終追い切り（半分のケースで付ける。トレセン・コース違いも混ぜる）
    let pool = null;
    if (rnd() < 0.6) {
      const n = Math.floor(rnd() * 12);
      const prow = [];
      for (let k = 0; k < n; k++) {
        const course = pick(['坂路', 'ウッド', 'CW']);
        const wood = course !== '坂路';
        prow.push([iso(start - 60 + Math.floor(rnd() * (span + 60))), pick([center, center, '美浦', '栗東']), course,
          t1(wood ? 64 + rnd() * 6 : 50 + rnd() * 6), t1(10.9 + rnd() * 1.8)].join(','));
      }
      pool = join(dir, 'p.csv');
      writeFileSync(pool, 'date,center,course,main,f1\n' + prow.join('\n') + (prow.length ? '\n' : ''));
    }
    check(`random #${c}`, w, r, false, pool);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`ランダム ${N} ケース: ${failures === 0 ? 'すべて一致' : `${failures} 件不一致`}（うち全馬基準を使った判定 ${poolUsed} 件）`);
process.exit(failures ? 1 : 0);
