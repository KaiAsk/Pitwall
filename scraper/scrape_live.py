#!/usr/bin/env python3
"""
scrape_live.py — live feeder for Pitwall's 24h section.

The main scraper.py writes a whole event once. The website's live views read a
single file (dashboard/public/live/24h.json) that needs to refresh every ~30s
during a session. This runner does that, and crucially it pulls lap times even
while a session is LIVE (scraper.py only fetches laps once a session is
"confirmed", which is too late for live analytics).

It auto-follows whichever session is live (practice -> qualifying -> race), so
you don't have to change anything on the day. If nothing is live yet it writes
the most recent/last session so the board isn't blank.

Usage:
  python scrape_live.py --event 344637 --interval 30 --max-hours 26 \
      --output ../dashboard/public

  --session 795960   # optional: pin one session id instead of auto-following
"""
import argparse, json, time, sys, re
from datetime import datetime
from pathlib import Path

import scraper as S  # reuse the proven parsers (get, parse_*), BASE_URL, CHAMPIONSHIP


def resolve_sessions(public_id: int):
    """Return (internal_event_id, [ {session_id,label,type} ... ])."""
    soup = S.get(f"{S.BASE_URL}/{S.CHAMPIONSHIP}/e/{public_id}")
    links = soup.find_all("a", href=re.compile(r"/%s/e/\d+/s/\d+" % S.CHAMPIONSHIP))
    if not links:
        raise RuntimeError("no sessions found for event %s" % public_id)
    internal = int(re.search(r"/e/(\d+)/s/", links[0]["href"]).group(1))
    out, seen = [], set()
    for a in links:
        m = re.search(r"/s/(\d+)", a["href"])
        if not m:
            continue
        sid = int(m.group(1))
        if sid in seen:
            continue
        seen.add(sid)
        text = S.clean_label(a.get_text(separator=" ", strip=True))
        typ = "race" if ("Race" in text and "Qualifying" not in text and "Practice" not in text) \
            else "qualifying" if "Qualifying" in text else "practice"
        out.append({"session_id": sid, "label": text, "type": typ})
    return internal, out


def scrape_session_live(internal_event_id: int, session_id: int):
    """Like scraper.scrape_session but ALWAYS attempts lap times (live or not)."""
    base = f"{S.BASE_URL}/{S.CHAMPIONSHIP}/e/{internal_event_id}/s/{session_id}"
    soup = S.get(f"{base}/result")
    meta = S.parse_session_meta(soup)
    data = {
        "session_id": session_id,
        "url": base,
        **meta,
        "results": S.parse_result_table(soup),
        "penalties": S.parse_penalty_table(soup),
    }
    try:
        laps_soup = S.get(f"{base}/laptimes")
        data["lap_times"] = S.parse_laptimes_table(laps_soup)
    except Exception as e:
        data["lap_times"] = []
        data["lap_error"] = str(e)
    return data


def pick_live(internal, sessions, pinned):
    """Choose which session to scrape this tick."""
    if pinned:
        return next((s for s in sessions if s["session_id"] == pinned), {"session_id": pinned})
    # find the one whose result page reports status 'live'
    for s in sessions:
        try:
            soup = S.get(f"{S.BASE_URL}/{S.CHAMPIONSHIP}/e/{internal}/s/{s['session_id']}/result")
            if S.parse_session_meta(soup).get("status") == "live":
                return s
        except Exception:
            continue
    # nothing live -> the last session in the list (usually the race / most recent)
    return sessions[-1] if sessions else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", type=int, required=True, help="public event id (e.g. 344637)")
    ap.add_argument("--session", type=int, default=None, help="pin a session id (skip auto-follow)")
    ap.add_argument("--interval", type=int, default=30, help="seconds between refreshes")
    ap.add_argument("--max-hours", type=float, default=26.0)
    ap.add_argument("--output", default="../dashboard/public", help="public dir (writes live/24h.json)")
    args = ap.parse_args()

    out = Path(args.output) / "live"
    out.mkdir(parents=True, exist_ok=True)
    target = out / "24h.json"

    print(f"[live] event {args.event} -> {target} every {args.interval}s")
    internal, sessions = resolve_sessions(args.event)
    print(f"[live] internal id {internal}; sessions: " + ", ".join(f"{s['type']}:{s['session_id']}" for s in sessions))

    deadline = time.time() + args.max_hours * 3600
    refresh_every = 20  # re-resolve which session is live every N ticks
    tick = 0
    while time.time() < deadline:
        try:
            if not args.session and tick % refresh_every == 0:
                try:
                    internal, sessions = resolve_sessions(args.event)
                except Exception as e:
                    print(f"[live] re-resolve failed: {e}")
            chosen = pick_live(internal, sessions, args.session)
            if chosen:
                sd = scrape_session_live(internal, chosen["session_id"])
                sd["type"] = chosen.get("type")
                sd["label"] = chosen.get("label")
                payload = {
                    "event_public_id": args.event,
                    "internal_event_id": internal,
                    "scraped_at": datetime.utcnow().isoformat() + "Z",
                    "sessions": [sd],
                }
                tmp = target.with_suffix(".tmp")
                tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                tmp.replace(target)  # atomic so the site never reads a half-written file
                st = sd.get("status", "?")
                print(f"[live] {datetime.now():%H:%M:%S} {chosen.get('label','?')} status={st} "
                      f"results={len(sd.get('results', []))} lap_rows={len(sd.get('lap_times', []))}")
        except Exception as e:
            print(f"[live] tick error: {e}", file=sys.stderr)
        tick += 1
        time.sleep(args.interval)
    print("[live] finished (max-hours reached)")


if __name__ == "__main__":
    main()
