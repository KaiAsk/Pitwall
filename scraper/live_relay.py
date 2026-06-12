#!/usr/bin/env python3
"""
live_relay.py — feeds Pitwall's live timing from AlphaRaceHub's real-time data.

AlphaRaceHub's /<site>/live page is a JS app fed by Pusher websockets; the data
itself comes from a REST endpoint /api/v1/<site>/live/current that the app
re-fetches whenever Pusher signals a refresh. This relay just polls that same
endpoint and writes the one file the Pitwall site reads
(dashboard/public/live/24h.json), mapped into Pitwall's shape.

No scraping, no Pusher needed — same data the official live page shows.

  pip install requests
  # TEST IT NOW against the live UKC race (nothing to do with us):
  python live_relay.py --site ukc  --interval 5
  # RACE DAY (the 24h):
  python live_relay.py --site bukc --interval 5 --output ../dashboard/public

It always also writes live/current_raw.json (the untouched API response). If any
column looks wrong on the site, send me that one file and I'll lock the mapping.
"""
import argparse, json, re, sys, time
from datetime import datetime
from pathlib import Path
import requests

BASE = "https://www.alpharacehub.com"
UA = {"User-Agent": "Mozilla/5.0 (pitwall-relay)"}


def get_token(site):
    """The live page embeds a fresh pusher/auth token; the REST API wants it."""
    try:
        r = requests.get(f"{BASE}/{site}/live", headers=UA, timeout=15)
        m = re.search(r'data-pusherToken="([^"]+)"', r.text)
        return (m.group(1).replace("&#x2B;", "+") if m else None)
    except Exception:
        return None


def num(v):
    if v is None: return None
    s = str(v).strip()
    m = re.search(r"-?\d+(?:\.\d+)?", s.replace(":", ""))
    return None


def secs(v):
    """'1:12.345' or '72.345' -> 72.345 ; else None."""
    if v is None: return None
    s = str(v).strip()
    m = re.match(r"(?:(\d+):)?(\d+(?:\.\d+)?)$", s)
    if not m: return None
    mm = float(m.group(1)) if m.group(1) else 0.0
    return mm * 60 + float(m.group(2))


def first(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d[k]
    return default


def transform(api, site):
    """Map /live/current JSON -> Pitwall's sessions[0] shape (tolerant of key names)."""
    if not isinstance(api, dict):
        return None
    rows = first(api, "competitors", "entries", "results", "rows", "standings", default=[]) or []
    session_name = first(api, "sessionName", "session", "name", default="Live")
    session_type = (first(api, "sessionType", "type", default="") or "").lower()
    status = first(api, "status", default="live")

    results, lap_times, penalties = [], [], []
    for r in rows:
        if not isinstance(r, dict):
            continue
        kart = str(first(r, "competitorNumber", "number", "kart", "num", default="") or "").strip()
        if not kart:
            continue
        name = first(r, "name", "teamName", "team", "competitor", default="")
        pos = first(r, "position", "pos", "rank", default=None)
        laps = first(r, "laps", "lapCount", "lapsCompleted", "lap", default=None)
        gap = first(r, "gap", "gapToLeader", "interval", default=None)
        best = first(r, "bestLapTime", "bestLap", "best", default=None)
        last = first(r, "lastLapTime", "lastLap", "last", default=None)
        pen = bool(first(r, "penalty", "hasPenalty", default=False)) or "*pen" in str(name).lower()
        results.append({
            "position": pos, "kart": kart,
            "name": re.sub(r"\*pen|\[\+penalty\]", "", str(name), flags=re.I).strip(),
            "team": re.sub(r"\*pen|\[\+penalty\]", "", str(name), flags=re.I).strip(),
            "laps": laps,
            "gap": str(gap) if gap not in (None, "") else None,
            "best_lap_time": str(best) if best not in (None, "") else None,
            "last_lap_time": str(last) if last not in (None, "") else None,
            "penalty": pen,
        })
        # per-kart lap list if the API includes one
        laplist = first(r, "lapTimes", "lapList", "lapsList", default=None)
        if isinstance(laplist, list) and laplist:
            lap_times.append({"kart": kart, "laps": [str(x) for x in laplist]})
        # penalty detail if present
        pdet = first(r, "penalties", "penaltyList", default=None)
        if isinstance(pdet, list):
            for p in pdet:
                penalties.append({"kart": kart, "penalty": str(first(p, "time", "value", "penalty", default=p) if isinstance(p, dict) else p),
                                  "reason": (first(p, "reason", "description", default="") if isinstance(p, dict) else ""),
                                  "lap": (first(p, "lap", default=None) if isinstance(p, dict) else None)})

    return {
        "scraped_at": datetime.utcnow().isoformat() + "Z",
        "event_public_id": None,
        "sessions": [{
            "session_id": first(api, "sessionId", "sid", "sessionUuid", default=None),
            "label": session_name, "type": session_type or "race",
            "status": "live" if str(status).lower() in ("live", "running", "green") else str(status).lower(),
            "results": results, "lap_times": lap_times, "penalties": penalties,
        }],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="bukc", help="ukc (test) or bukc (the 24h)")
    ap.add_argument("--interval", type=int, default=5)
    ap.add_argument("--max-hours", type=float, default=26.0)
    ap.add_argument("--output", default="../dashboard/public")
    args = ap.parse_args()

    out = Path(args.output) / "live"
    out.mkdir(parents=True, exist_ok=True)
    target, raw = out / "24h.json", out / "current_raw.json"
    api_url = f"{BASE}/api/v1/{args.site}/live/current"

    token = get_token(args.site)
    headers = dict(UA); headers["at-site"] = args.site
    if token: headers["at-pst"] = token
    print(f"[relay] {api_url}  (token: {'yes' if token else 'none'}) -> {target} every {args.interval}s")

    deadline = time.time() + args.max_hours * 3600
    tick = 0
    while time.time() < deadline:
        try:
            if tick % 120 == 0:  # refresh token every ~10 min
                t = get_token(args.site)
                if t: headers["at-pst"] = t
            r = requests.get(api_url, headers=headers, timeout=15)
            if r.status_code != 200:
                print(f"[relay] {api_url} -> {r.status_code} (auth/site issue?)", file=sys.stderr)
            else:
                api = r.json()
                raw.write_text(json.dumps(api, ensure_ascii=False), encoding="utf-8")
                payload = transform(api, args.site)
                if payload:
                    tmp = target.with_suffix(".tmp")
                    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                    tmp.replace(target)
                    s = payload["sessions"][0]
                    print(f"[relay] {datetime.now():%H:%M:%S} {s['label']} status={s['status']} karts={len(s['results'])} lap_rows={len(s['lap_times'])}")
        except Exception as e:
            print(f"[relay] tick error: {e}", file=sys.stderr)
        tick += 1
        time.sleep(args.interval)
    print("[relay] done")


if __name__ == "__main__":
    main()
