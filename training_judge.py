"""
training_judge.py — 調教タイム判定プロトタイプ

やること
  1. 調教記録を「追い切り」と「キャンター」に分類
  2. 出走レースごとに 最終 / 1週前 / 2週前 の追い切りを紐付け
  3. その馬自身の過去の最終追い切り（対象レースより前のものだけ = point-in-time）と比較
  4. ラスト2Fのラップ形状、1週前の有無、乗り込み量を加味して点数化（S/A/B/C）
  5. 最終追い切りがまだ無いレースは「木曜の判定基準」を出す

入力
  - 調教CSV: date,time,center,course,f6,f5,f4,f3,f2,f1（空欄可）
    もしくは JRA-VAN の画面からコピペしたテキスト（--text オプション）
  - レースCSV: date,name,result（result 空欄 = 未出走の対象レース）

注意
  - JRA-VAN の調教データには 馬なり/一杯 の強弱・併せ馬情報が無いため、時計のみで判定する
  - 閾値・配点はすべて仮置き。keiba-ai-core に載せたら実データでチューニングする前提
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional

# ---------------------------------------------------------------- 設定 ----
# 追い切り判定: (使う区間, 閾値秒)。この時計以内なら追い切り扱い
OIKIRI_RULES = {
    "坂路": ("f4", 58.0),
    "ウッド": ("f5", 72.0),
}
# 基準の優先順:
#   1. 自己   … 登録した過去レースの最終追い切り（同コース）の平均
#   2. 自己調教 … 過去レースの登録が無くても、自身の追い切り（同コース、レース22〜365日前）が
#                 SELF_WORK_MIN 本以上あれば、ラスト1Fが速い方の半分（最低 SELF_WORK_MIN 本）の平均
#   3. 全馬   … 他の登録馬の最終追い切り（同トレセン・同コース）が POOL_MIN 本以上あればその平均
#   4. 汎用   … 固定値
# 最終追い切り = レース2〜6日前の追い切り（7日前の日曜追いや前日の調整は最終にしない）
FINAL_DAYS = (2, 6)
# 同じ週に複数あるとき、一番強い追い切りから1Fあたりこの秒数以内のものを「メイン」とみなす
MAIN_MARGIN = 0.5
SELF_WORK_MIN = 3
SELF_WORK_DAYS = (22, 365)
POOL_MIN = 3
GENERIC_BASELINE = {
    "坂路": {"main": 53.5, "f1": 12.3},
    "ウッド": {"main": 67.0, "f1": 11.6},
}
COURSE_ALIASES = {
    "坂路": "坂路", "坂": "坂路",
    "ウッド": "ウッド", "ウッドチップ": "ウッド", "CW": "ウッド", "W": "ウッド",
    "南W": "ウッド", "北W": "ウッド", "栗CW": "ウッド", "美W": "ウッド", "D": "ウッド",
}
RANKS = [(70, "S"), (60, "A"), (45, "B"), (-999, "C")]


def score_round(x: float) -> int:
    """点数の丸め: 四捨五入（.5 は切り上げ）。
    Python の round() は偶数丸め（-3.5 → -4, 2.5 → 2）なうえ、67.0-67.7 のような
    浮動小数の誤差も拾うため、1e-9 だけ足してから切り捨てる。JS版 (js/judge.js) と共通。"""
    return math.floor(x + 0.5 + 1e-9)


# ---------------------------------------------------------- データ構造 ----
@dataclass
class Workout:
    day: date
    time: str
    center: str
    course: str
    f6: Optional[float] = None
    f5: Optional[float] = None
    f4: Optional[float] = None
    f3: Optional[float] = None
    f2: Optional[float] = None
    f1: Optional[float] = None

    @property
    def main_key(self) -> str:
        return OIKIRI_RULES.get(self.course, ("f4", 58.0))[0]

    @property
    def main(self) -> Optional[float]:
        return getattr(self, self.main_key)

    @property
    def is_oikiri(self) -> bool:
        _, th = OIKIRI_RULES.get(self.course, ("f4", 58.0))
        return self.main is not None and self.main <= th

    @property
    def lap2(self) -> Optional[float]:
        """ラスト2F目の1ハロンラップ（2F − 1F）"""
        if self.f2 is None or self.f1 is None:
            return None
        return round(self.f2 - self.f1, 1)

    @property
    def shape(self) -> str:
        """ラスト2Fの形: 加速 / 維持 / 減速 / 大きく減速"""
        if self.lap2 is None:
            return "不明"
        d = round(self.f1 - self.lap2, 1)
        if d <= -0.1:
            return "加速"
        if d <= 0.3:
            return "維持"
        if d <= 0.6:
            return "減速"
        return "大きく減速"

    def label(self) -> str:
        laps = f"{self.lap2}-{self.f1}" if self.lap2 is not None else f"{self.f1}"
        return (f"{self.day:%m/%d} {self.course} {self.main_key.upper()} {self.main} "
                f"/ ラスト2F {laps}（{self.shape}）")


@dataclass
class Race:
    day: date
    name: str
    result: str = ""


@dataclass
class PoolEntry:
    """他の馬の最終追い切り（汎用基準の代わりに使う）。day = 追い切りの日"""
    day: date
    center: str
    course: str
    main: float
    f1: float


@dataclass
class Judgement:
    race: Race
    status: str                     # 判定済 / 最終追い切り待ち / データ不足
    slots: dict = field(default_factory=dict)
    baseline: dict = field(default_factory=dict)
    score: Optional[int] = None
    rank: str = "-"
    notes: list = field(default_factory=list)
    volume_14d: int = 0


# ------------------------------------------------------------ 読み込み ----
def _num(s: str) -> Optional[float]:
    s = (s or "").strip()
    if s in ("", "-", "－"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _course(raw: str) -> str:
    return COURSE_ALIASES.get(raw.strip(), raw.strip())


def load_workouts_csv(path: str) -> list[Workout]:
    out = []
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            out.append(Workout(
                day=datetime.strptime(r["date"], "%Y-%m-%d").date(),
                time=r.get("time", ""), center=r.get("center", ""),
                course=_course(r["course"]),
                **{k: _num(r.get(k, "")) for k in ("f6", "f5", "f4", "f3", "f2", "f1")},
            ))
    return sorted(out, key=lambda w: w.day)


LINE_RE = re.compile(
    r"(\d{4})/(\d{1,2})/(\d{1,2})\S*\s+(\d{1,2}:\d{2})\s+(\S+)\s+(\S+)\s+(.*)")


def parse_jravan_text(text: str) -> list[Workout]:
    """JRA-VAN の調教タイム表をコピペしたテキストを解析する。
    括弧内のラップは捨て、行末の6トークンを 6F〜1F とみなす。"""
    out = []
    for line in text.splitlines():
        m = LINE_RE.search(line)
        if not m:
            continue
        y, mo, d, tm, center, course, rest = m.groups()
        rest = re.sub(r"\([^)]*\)", " ", rest)
        tokens = [t for t in rest.split() if re.fullmatch(r"-|\d+(\.\d+)?", t)]
        if len(tokens) < 6:
            continue
        f6, f5, f4, f3, f2, f1 = (_num(t) for t in tokens[-6:])
        out.append(Workout(date(int(y), int(mo), int(d)), tm, center, _course(course),
                           f6, f5, f4, f3, f2, f1))
    return sorted(out, key=lambda w: w.day)


def load_races_csv(path: str) -> list[Race]:
    with open(path, encoding="utf-8-sig") as f:
        races = [Race(datetime.strptime(r["date"], "%Y-%m-%d").date(), r["name"],
                      r.get("result", "") or "") for r in csv.DictReader(f)]
    return sorted(races, key=lambda r: r.day)


def load_pool_csv(path: str) -> list[PoolEntry]:
    """他の馬の最終追い切り CSV: date,center,course,main,f1（アプリの「全馬の最終追い切りCSV」と同じ形式）"""
    with open(path, encoding="utf-8-sig") as f:
        return [PoolEntry(datetime.strptime(r["date"], "%Y-%m-%d").date(), r.get("center", ""),
                          _course(r["course"]), float(r["main"]), float(r["f1"]))
                for r in csv.DictReader(f)]


# -------------------------------------------------------------- ロジック ----
def window(works: list[Workout], race_day: date, prev_day: Optional[date]) -> list[Workout]:
    """対象レースの調整期間 = 前走の翌日〜レース前日"""
    return [w for w in works if w.day < race_day and (prev_day is None or w.day > prev_day)]


def intensity(w: Workout) -> float:
    """追い切りの強さ = 1Fあたりで追い切りの基準時計よりどれだけ速いか（秒）。坂路とウッドを同じ物差しで比べる"""
    key, th = OIKIRI_RULES.get(w.course, ("f4", 58.0))
    n = int(key[1])
    return (th - w.main) / n


def pick_main(cands: list[Workout]) -> Optional[Workout]:
    """同じ週に追い切りが複数あれば、一番強いものから1Fあたり MAIN_MARGIN 秒以内のうち遅い日（軽い調整は除く）"""
    if not cands:
        return None
    best = max(intensity(w) for w in cands)
    return [w for w in cands if intensity(w) >= best - MAIN_MARGIN][-1]


def assign_slots(works: list[Workout], race_day: date) -> dict:
    """最終 = レース2〜6日前（無ければ前日）。日曜追いなど7日前のものは最終にしない。
    1週前・2週前 = 最終追い切りの日（無ければレース4日前）から7日前・14日前に最も近い追い切り（±3日）"""
    oik = sorted((w for w in works if w.is_oikiri), key=lambda w: w.day)
    days = lambda w: (race_day - w.day).days
    slots = {}
    fin = pick_main([w for w in oik if FINAL_DAYS[0] <= days(w) <= FINAL_DAYS[1]]) \
        or pick_main([w for w in oik if days(w) == 1])
    if fin:
        slots["最終"] = fin
    anchor = fin.day if fin else race_day - timedelta(days=4)
    for name, back in (("1週前", 7), ("2週前", 14)):
        cands = [w for w in oik if w is not fin and abs((anchor - w.day).days - back) <= 3]
        if cands:
            # 7日前（14日前）に一番近い日。同じ近さなら強い方、さらに同じなら遅い方
            slots[name] = min(cands, key=lambda w: (abs((anchor - w.day).days - back), -intensity(w), -w.day.toordinal()))
    return slots


def build_baseline(past: list[Judgement], course: str, center: str = "",
                   race_day: Optional[date] = None, pool: Optional[list[PoolEntry]] = None,
                   works: Optional[list[Workout]] = None) -> dict:
    finals = [j.slots["最終"] for j in past
              if "最終" in j.slots and j.slots["最終"].course == course]
    vols = [j.volume_14d for j in past if j.status == "判定済"]
    if len(finals) >= 1:
        return {
            "main": round(statistics.mean(f.main for f in finals), 1),
            "f1": round(statistics.mean(f.f1 for f in finals), 2),
            "best_f1": min(f.f1 for f in finals),
            "volume": statistics.mean(vols) if vols else None,
            "n": len(finals), "source": "自己",
        }
    # 過去レースの登録が無ければ、自身の普段の追い切り（今回の調整より前）のうち
    # ラスト1Fが速い方の半分の平均（最終追い切りは普段の追い切りより速いので、全体平均だと甘くなる）
    lo, hi = SELF_WORK_DAYS
    own = [w for w in (works or [])
           if race_day is not None and w.is_oikiri and w.course == course and w.f1 is not None
           and lo <= (race_day - w.day).days <= hi]
    if len(own) >= SELF_WORK_MIN:
        own = sorted(own, key=lambda w: w.f1)[:max(SELF_WORK_MIN, math.ceil(len(own) / 2))]
        return {
            "main": round(statistics.mean(w.main for w in own), 1),
            "f1": round(statistics.mean(w.f1 for w in own), 2),
            "best_f1": min(w.f1 for w in own),
            "volume": None, "n": len(own), "source": "自己調教",
        }
    # 自分の過去が無ければ、他の馬の最終追い切り（同トレセン・同コース、このレースより前）の平均
    peers = [p for p in (pool or [])
             if p.course == course and p.center == center and race_day is not None and p.day < race_day]
    if len(peers) >= POOL_MIN:
        return {
            "main": round(statistics.mean(p.main for p in peers), 1),
            "f1": round(statistics.mean(p.f1 for p in peers), 2),
            "best_f1": min(p.f1 for p in peers),
            "volume": None, "n": len(peers), "source": "全馬",
        }
    g = GENERIC_BASELINE.get(course, GENERIC_BASELINE["坂路"])
    return {**g, "best_f1": g["f1"], "volume": None, "n": 0, "source": "汎用"}


def judge(works: list[Workout], races: list[Race], pool: Optional[list[PoolEntry]] = None) -> list[Judgement]:
    results: list[Judgement] = []
    for i, race in enumerate(races):
        prev = races[i - 1].day if i > 0 else None
        ws = window(works, race.day, prev)
        slots = assign_slots(ws, race.day)
        vol = sum(1 for w in ws if (race.day - w.day).days <= 14)
        j = Judgement(race, "判定済", slots, volume_14d=vol)

        if not ws:
            j.status = "データ不足"
            results.append(j)
            continue

        ref = slots.get("最終") or slots.get("1週前") or ws[-1]
        course = ref.course
        base = build_baseline(results, course, ref.center, race.day, pool, works)   # ← このレースより前の情報だけ使う
        j.baseline = base
        interval = (race.day - prev).days if prev else None

        if "最終" not in slots:
            j.status = "最終追い切り待ち" if not race.result else "データ不足"
            if interval is not None and interval <= 21:
                j.notes.append(f"前走から中{interval // 7 - 1}週。1週前追いなしは想定内")
            results.append(j)
            continue

        fin = slots["最終"]
        score = 50
        # 1) 終い1Fを自己基準と比較（0.1秒 = 3点、±12で頭打ち。0.1〜0.2秒は馬場や計測のぶれでも出るので控えめに）
        d1 = round(base["f1"] - fin.f1, 2)
        p = max(-12, min(12, score_round(d1 * 30)))
        score += p
        j.notes.append(f"ラスト1F {fin.f1}（基準{base['f1']}より{abs(d1):.2f}秒"
                       f"{'速い' if d1 > 0 else '遅い' if d1 < 0 else '同じ'}）{p:+d}")
        # 2) 全体時計（1秒 = 4点、±12）
        dm = round(base["main"] - fin.main, 1)
        p = max(-12, min(12, score_round(dm * 4)))
        score += p
        j.notes.append(f"全体 {fin.main}（基準{base['main']}）{p:+d}")
        # 3) ラップ形状
        p = {"加速": 5, "維持": 0, "減速": -5, "大きく減速": -10}.get(fin.shape, 0)
        score += p
        j.notes.append(f"ラスト2F形状 {fin.shape} {p:+d}")
        # 4) 1週前
        wk = slots.get("1週前")
        if wk:
            p = 5 if wk.f1 <= base["f1"] + 0.2 else -5 if wk.f1 >= 13.0 else 0
            j.notes.append(f"1週前 ラスト1F {wk.f1} {p:+d}")
        elif interval is not None and interval <= 21:
            p = 0
            j.notes.append("1週前なし（間隔詰まりのため減点なし）")
        else:
            p = -8
            j.notes.append("1週前なし（間隔あり）-8")
        score += p
        # 5) 乗り込み量（直近14日の調教本数）
        if base.get("volume"):
            ratio = vol / base["volume"]
            p = -5 if ratio < 0.7 else 3 if ratio > 1.2 else 0
            j.notes.append(f"直近14日 {vol}本（平均{base['volume']:.1f}本）{p:+d}")
            score += p
        else:
            j.notes.append(f"直近14日 {vol}本")

        j.score = score
        j.rank = next(r for th, r in RANKS if score >= th)
        results.append(j)
    return results


def pending_criteria(j: Judgement) -> list[str]:
    b = j.baseline
    return [
        f"上向き : ラスト1F {b['f1'] - 0.1:.1f}以下 かつ 全体 {b['main']}以内",
        f"据え置き: ラスト1F {b['f1'] + 0.2:.1f}以下",
        f"割引  : ラスト1F {b['f1'] + 0.3:.1f}以上、またはラスト2Fが大きく減速",
    ]


# ------------------------------------------- keiba-ai-core 向け特徴量 ----
def extract_features(j: Judgement) -> dict:
    """1レース分の調教特徴量。available_at = 最終追い切り日（これ以降の予測でのみ使用可）"""
    fin = j.slots.get("最終")
    return {
        "train_status": j.status,
        "train_final_main": fin.main if fin else None,
        "train_final_f1": fin.f1 if fin else None,
        "train_final_f1_vs_self": round(j.baseline["f1"] - fin.f1, 2) if fin and j.baseline else None,
        "train_final_shape": fin.shape if fin else None,
        "train_has_1w": "1週前" in j.slots,
        "train_volume_14d": j.volume_14d,
        "train_score": j.score,
        "train_rank": j.rank,
        "baseline_source": j.baseline.get("source") if j.baseline else None,
        "available_at": fin.day.isoformat() if fin else None,
    }


# ------------------------------------------------------------------ 出力 ----
def to_dict(j: Judgement) -> dict:
    """JS版 (Judge.toComparable) と突き合わせるための JSON 形式"""
    def slot(w: Workout) -> dict:
        return {"date": w.day.isoformat(), "time": w.time, "course": w.course,
                "main_key": w.main_key, "main": w.main, "f1": w.f1, "lap2": w.lap2,
                "shape": w.shape, "label": w.label()}
    return {
        "race": {"date": j.race.day.isoformat(), "name": j.race.name, "result": j.race.result},
        "status": j.status, "score": j.score, "rank": j.rank, "volume_14d": j.volume_14d,
        "notes": j.notes,
        "slots": {k: slot(j.slots[k]) for k in ("2週前", "1週前", "最終") if k in j.slots},
        "baseline": j.baseline,
        "criteria": pending_criteria(j) if j.status == "最終追い切り待ち" else [],
    }


def report(horse: str, results: list[Judgement]) -> str:
    lines = [f"■ {horse} 調教判定", ""]
    for j in results:
        r = j.race
        head = f"【{r.day:%Y/%m/%d} {r.name}】"
        if r.result:
            head += f" 結果: {r.result}"
        lines.append(head)
        if j.status == "データ不足":
            lines += ["  調教データなし（期間外）", ""]
            continue
        for k in ("2週前", "1週前", "最終"):
            if k in j.slots:
                lines.append(f"  {k:<4}: {j.slots[k].label()}")
        b = j.baseline
        what = {"自己": "過去最終", "自己調教": "普段の追い切り上位", "全馬": "他の馬の最終"}.get(b["source"], "過去最終")
        lines.append(f"  基準  : {b['source']}（{what}{b['n']}本） 全体{b['main']} / ラスト1F {b['f1']}")
        if j.status == "最終追い切り待ち":
            lines.append(f"  判定  : 最終追い切り待ち（直近14日 {j.volume_14d}本）")
            for n in j.notes:
                lines.append(f"    ・{n}")
            lines.append("  木曜の判定基準:")
            for c in pending_criteria(j):
                lines.append(f"    {c}")
        else:
            lines.append(f"  判定  : {j.rank}（{j.score}点）")
            for n in j.notes:
                lines.append(f"    ・{n}")
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="調教タイム判定")
    ap.add_argument("--horse", default="サンプルA")
    ap.add_argument("--workouts", default="data/sample_a_training.csv")
    ap.add_argument("--text", help="JRA-VANからコピペした調教テキスト（CSVの代わり）")
    ap.add_argument("--races", default="data/sample_a_races.csv")
    ap.add_argument("--pool", help="他の馬の最終追い切りCSV（date,center,course,main,f1）。自分の過去が無いときの基準に使う")
    ap.add_argument("--json", action="store_true", help="判定結果を JSON で出力（JS版との一致テスト用）")
    a = ap.parse_args()

    if a.text:
        with open(a.text, encoding="utf-8") as f:
            works = parse_jravan_text(f.read())
    else:
        works = load_workouts_csv(a.workouts)
    races = load_races_csv(a.races)
    pool = load_pool_csv(a.pool) if a.pool else None
    results = judge(works, races, pool)
    if a.json:
        print(json.dumps([to_dict(j) for j in results], ensure_ascii=False, indent=1))
    else:
        print(report(a.horse, results))


if __name__ == "__main__":
    main()
