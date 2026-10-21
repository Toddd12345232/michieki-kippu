"""Refresh the source sections that are due, then write data.json for the app.

    python -m scraper.build --out DIR [--cache DIR] [--delay S] [--force NAME ...]

DIR/state.json keeps the raw sections between runs (only this script reads it).
DIR/data.json is what the app downloads. A section that fails, or comes back
suspiciously short, keeps its previous copy; the run then exits 1 so GitHub
emails the owner.
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

from . import apt, michieki, regional
from .fetch import FetchError, Fetcher
from .hours import schedule
from .match import Matcher, norm
from .regions import APT_PAGES, MICHIEKI_XML, apt_page_url, michieki_detail_url, michieki_xml_url, pref_code

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_AGE = {"michieki": timedelta(days=6), "apt_status": timedelta(hours=20), "apt_specials": timedelta(hours=20),
           "apt_notices": timedelta(hours=20), "chubu": timedelta(days=6)}
MIN_COUNT = {"michieki": 1150, "apt_status": 1150, "apt_specials": 100, "apt_notices": 10, "chubu": 50}
DETAIL_FAIL_LIMIT = 0.05
DETAILS_PER_RUN = 200
DETAIL_MAX_AGE = timedelta(days=14)
DETAIL_BUDGET_SECONDS = 25 * 60  # leave time in the 60-minute job for everything else
SHORT_PAGE = 0.5  # a page with under half its previous rows is treated as broken


def _load_json(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return json.load(f)


def _short(new, old):
    return len(old) >= 5 and len(new) < len(old) * SHORT_PAGE


def _refresh_michieki(fetcher, state):
    """Station list, one XML file per prefecture (Hokkaido has six).

    A file that fails or comes back much shorter keeps its previous stations. Stations
    that drop out of a file that otherwise looks fine are kept and marked `gone`,
    so ticks for them still show.
    """
    old_by_file = {}
    for r in state.get("michieki", []):
        old_by_file.setdefault(r.get("f"), []).append(r)
    rows, problems = [], []
    for file_id, pref in MICHIEKI_XML:
        old = old_by_file.get(file_id, [])
        try:
            got = michieki.parse_pref_xml(fetcher.get(michieki_xml_url(file_id)), pref)
        except FetchError as e:
            problems.append(f"michieki: {file_id}: {e}")
            rows += old
            continue
        if _short(got, old):
            problems.append(f"michieki: {file_id} returned {len(got)} of {len(old)} stations")
            rows += old
            continue
        ids = {r["id"] for r in got}
        rows += [{**r, "f": file_id} for r in got]
        rows += [{**o, "gone": True} for o in old if o["id"] not in ids]
    return rows, len(rows), problems


def _refresh_details(fetcher, state, now, limit):
    """Read up to `limit` station pages, those never read first, then the oldest.

    michieki.jp is slow (about 3 s a page), so the 1,241 pages are spread over
    several daily runs instead of one long one.
    """
    details = dict(state.get("details", {}))
    ids = [s["id"] for s in state.get("michieki", []) if not s.get("gone")]
    due = [i for i in ids if i not in details or now - datetime.fromisoformat(details[i]["at"]) > DETAIL_MAX_AGE]
    due.sort(key=lambda i: details.get(i, {}).get("at", ""))
    started, tried, failed = time.monotonic(), 0, 0
    for sid in due[:limit]:
        if time.monotonic() - started >= DETAIL_BUDGET_SECONDS:
            break
        tried += 1
        try:
            d = michieki.parse_detail(fetcher.get(michieki_detail_url(sid), encoding="cp932"))
        except FetchError:
            failed += 1
            continue
        if not any(d.values()) and sid in details:  # an empty page: keep what we had
            d = {k: details[sid].get(k) for k in ("yomi", "hours", "closed")}
        details[sid] = {**d, "at": now.isoformat(timespec="seconds")}
    problems = []
    if tried >= 20 and failed / tried > DETAIL_FAIL_LIMIT:
        problems.append(f"details: {failed} of {tried} station pages failed")
    return details, tried, problems


def _refresh_apt_status(fetcher, state):
    """a-pt's table for each prefecture. A page that fails or comes back much shorter keeps its previous rows."""
    old_by_page = {}
    for r in state.get("apt_status", []):
        old_by_page.setdefault(r["prefs"][0], []).append(r)
    rows, problems = [], []
    for name, prefs in APT_PAGES:
        old = old_by_page.get(prefs[0], [])
        try:
            got = [{"prefs": prefs, "name": r["name"], "raw": r["raw"], "status": r["status"]}
                   for r in apt.parse_status_page(fetcher.get(apt_page_url(name)))]
        except FetchError as e:
            problems.append(f"apt_status: {name}: {e}")
            rows += old
            continue
        if _short(got, old):
            problems.append(f"apt_status: {name} returned {len(got)} of {len(old)} rows")
            rows += old
            continue
        rows += got
    return rows, len(rows), problems


def _refresh_specials(fetcher, state):
    """Special tickets. Posts that roll off the bottom of a-pt's page are kept, because ticks refer to them."""
    page = fetcher.get(apt.SPECIALS_URL)
    posts = apt.parse_specials(page)
    prev = state.get("apt_specials") or {}
    ids = {p["id"] for p in posts}
    merged = posts + [p for p in prev.get("posts", []) if p["id"] not in ids]
    merged.sort(key=lambda p: p["posted"], reverse=True)
    ended = sorted({tuple(e) for e in prev.get("ended", [])} | set(apt.parse_ended(page)))
    return {"posts": merged, "ended": [list(e) for e in ended]}, len(posts), []


def _refresh_notices(fetcher, state):
    notices = apt.parse_notices(fetcher.get(apt.NOTICES_URL))
    return notices, len(notices), []


def _refresh_chubu(fetcher, state):
    lists = regional.parse_chubu(fetcher.get(regional.CHUBU_URL))
    return lists, sum(len(v) for v in lists.values()), []


REFRESH = {
    "michieki": _refresh_michieki,
    "apt_status": _refresh_apt_status,
    "apt_specials": _refresh_specials,
    "apt_notices": _refresh_notices,
    "chubu": _refresh_chubu,
}


def build(fetcher, prev, now, force=frozenset(), details_per_run=None):
    state = dict(prev or {})
    sources = dict(state.get("sources", {}))
    errors = []
    for name, refresh in REFRESH.items():
        last = sources.get(name)
        if name not in force and last and now - datetime.fromisoformat(last) < MAX_AGE[name]:
            continue
        try:
            value, count, problems = refresh(fetcher, state)
            if count < MIN_COUNT[name]:
                raise ValueError(f"only {count} items")
        except Exception as e:  # keep the previous copy of this section
            errors.append(f"{name}: {e}")
            continue
        errors.extend(problems)
        state[name] = value
        sources[name] = now.isoformat(timespec="seconds")
    if state.get("michieki"):
        try:
            limit = DETAILS_PER_RUN if details_per_run is None else details_per_run
            state["details"], tried, problems = _refresh_details(fetcher, state, now, limit)
            errors.extend(problems)
            if tried:
                sources["details"] = now.isoformat(timespec="seconds")
        except Exception as e:
            errors.append(f"details: {e}")
    state["sources"] = sources
    if not state.get("michieki"):
        return state, None, errors
    data = derive(state, now)
    state["aptonly"] = [s["id"] for s in data["stations"] if s["id"].startswith("apt-")]
    return state, data, errors


def derive(state, now):
    overrides = _load_json("overrides.json")
    details = state.get("details", {})
    stations = []
    for b in state["michieki"]:
        d = details.get(b["id"], {})
        st = {**{k: v for k, v in b.items() if k != "f"}, "yomi": d.get("yomi"), "hours": d.get("hours"), "closed": d.get("closed")}
        st.update({"sched": schedule(st["hours"], st["closed"]), "apt": None, "shitei": [], "cards": [], "alias": []})
        stations.append(st)
    by_id = {s["id"]: s for s in stations}
    matcher = Matcher(state["michieki"], overrides)
    aliases = dict(state.get("aliases", {}))
    was_aptonly = set(state.get("aptonly", []))
    for row in state.get("apt_status", []):
        if any(overrides.get(f"{p}:{row['name'].strip()}") == "none" for p in row["prefs"]):
            continue
        info = {"status": row["status"], "raw": row["raw"], "name": row["name"]}
        aptid = f"apt-{row['prefs'][0]}-{norm(row['name'])}"
        sid = matcher.find(row["prefs"], row["name"])
        if sid in by_id:
            if by_id[sid]["apt"] is None:
                by_id[sid]["apt"] = info
            if aptid in was_aptonly:
                aliases[aptid] = sid
        elif aptid not in by_id:
            st = {"id": aptid, "name": row["name"], "yomi": None, "pref": row["prefs"][0], "addr": "", "tel": "",
                  "lat": None, "lng": None, "hours": None, "closed": None, "sched": None, "apt": info,
                  "shitei": [], "cards": [], "alias": []}
            stations.append(st)
            by_id[aptid] = st
    for aptid, sid in aliases.items():
        if sid in by_id and aptid not in by_id[sid]["alias"]:
            by_id[sid]["alias"].append(aptid)
    state["aliases"] = aliases
    shikoku = _load_json("shikoku_cards.json")["names"]
    regional.assign(stations, state.get("chubu", {}), shikoku, Matcher(stations, overrides))

    specials = []
    for p in (state.get("apt_specials") or {}).get("posts", []):
        code = pref_code(p["pref"])
        sid = matcher.find([code], p["station"]) if code else None
        specials.append({**p, "st": sid if sid in by_id else None})
    for name, day in (state.get("apt_specials") or {}).get("ended", []):
        same = [s for s in specials if norm(s["station"] or "") == norm(name) and s["posted"] <= day]
        if same:
            max(same, key=lambda s: s["posted"])["ended"] = day
    notices = []
    for n in state.get("apt_notices", []):
        code = pref_code(n["pref"])
        st = matcher.find([code], n["station"]) if code and n["station"] else None
        notices.append({**n, "st": st if st in by_id else None})
    return {"v": 1, "built": now.isoformat(timespec="seconds"), "sources": state["sources"],
            "stations": stations, "specials": specials, "notices": notices}


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write(path, obj, compact):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def main(argv, fetcher=None):
    ap = argparse.ArgumentParser(prog="python -m scraper.build")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache")
    ap.add_argument("--delay", type=float, default=1.0)
    ap.add_argument("--force", nargs="*", default=[], choices=list(MAX_AGE))
    ap.add_argument("--details", type=int, default=DETAILS_PER_RUN, help="station pages to read this run")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    fetcher = fetcher or Fetcher(cache_dir=args.cache, delay=args.delay)
    prev = _read(os.path.join(args.out, "state.json"))
    state, data, errors = build(fetcher, prev, datetime.now(timezone.utc), set(args.force), args.details)
    for e in errors:
        print("ERROR", e, file=sys.stderr)
    if data is None:
        print("No station list, nothing written.", file=sys.stderr)
        return 1
    _write(os.path.join(args.out, "state.json"), state, compact=False)
    _write(os.path.join(args.out, "data.json"), data, compact=True)
    print(f"{len(data['stations'])} stations, {len(data['specials'])} specials, {len(data['notices'])} notices")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
