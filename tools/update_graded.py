"""
JRA の「重賞レース一覧」から、その年の重賞日程を data/graded_<年>.json に書き出す。
年に1回（日程が発表されたら）手で実行する想定。依存なし（標準ライブラリのみ）。

    python tools/update_graded.py 2027

出力: [{"date": "2026-10-12", "name": "スワンS(GII)", "place": "京都", "course": "芝1400m", "cond": "3歳以上"}, ...]
"""
import html
import json
import re
import sys
import urllib.request
from pathlib import Path

URL = "https://www.jra.go.jp/datafile/seiseki/replay/{year}/jyusyo.html"
ROMAN = {"Ⅰ": "I", "Ⅱ": "II", "Ⅲ": "III"}


def text(cell: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", cell))).strip()


def parse(page: str, year: int) -> list[dict]:
    races = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S):
        cells = dict(re.findall(r'<td class="(\w+)[^"]*">(.*?)</td>', tr, re.S))
        if "race" not in cells or "date" not in cells:
            continue
        m = re.match(r"(\d+)月(\d+)日", text(cells["date"]))
        g = re.match(r"^(J・G|G)(Ⅰ|Ⅱ|Ⅲ)\s*(.+)$", text(cells["race"]))
        if not m or not g:
            print("skip:", text(cells["date"]), text(cells["race"]), file=sys.stderr)
            continue
        grade = ("J・" if g.group(1) != "G" else "") + "G" + ROMAN[g.group(2)]
        course = text(cells.get("course", "")).replace(",", "").replace("メートル", "m").replace(" ", "")
        races.append({
            "date": f"{year}-{int(m.group(1)):02d}-{int(m.group(2)):02d}",
            "name": f"{g.group(3).strip()}({grade})",
            "place": text(cells.get("place", "")),
            "course": course,
            "cond": text(cells.get("age", "")),
        })
    return races


def main():
    year = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
    req = urllib.request.Request(URL.format(year=year), headers={"User-Agent": "Mozilla/5.0 (chokyo-judge; yearly schedule update)"})
    with urllib.request.urlopen(req) as r:
        page = r.read().decode("cp932")
    races = parse(page, year)
    out = Path(__file__).resolve().parent.parent / "data" / f"graded_{year}.json"
    out.write_text(json.dumps(races, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    print(f"{len(races)} races -> {out}")


if __name__ == "__main__":
    main()
