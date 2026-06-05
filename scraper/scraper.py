#!/usr/bin/env python3
"""
BUKC AlphaRaceHub Scraper (Dynamic Header Refit)
Scrapes race results from alpharacehub.com dynamically based on table headers.
"""

import requests
import json
import re
import time
import argparse
import logging
from pathlib import Path
from datetime import datetime
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_URL = "https://www.alpharacehub.com"
CHAMPIONSHIP = "bukc"          
OUTPUT_DIR = Path("output")
DELAY = 1.5                    # seconds between requests — be polite
TIMEOUT = 15

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-GB,en;q=0.9",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

SESSION = requests.Session()
SESSION.headers.update(HEADERS)

LONG_COOLDOWN = 300  # if the server asks us to wait longer than this, stop and resume later

class RateLimited(Exception):
    """Raised when the server imposes a cooldown too long to wait out in one run."""
    def __init__(self, wait):
        self.wait = wait
        super().__init__(f"rate limited, server asked for {wait}s")

def get(url: str, fragment: bool = False, max_retries: int = 5) -> BeautifulSoup:
    headers = {"HX-Request": "true"} if fragment else {}
    log.debug(f"GET {url}")
    attempt = 0
    while True:
        r = SESSION.get(url, headers=headers, timeout=TIMEOUT)
        if r.status_code == 429 or r.status_code >= 500:
            attempt += 1
            if attempt > max_retries:
                r.raise_for_status()
            retry_after = r.headers.get("Retry-After")
            wait = int(retry_after) if (retry_after and retry_after.isdigit()) else min(60, DELAY * (2 ** attempt))
            if wait > LONG_COOLDOWN:
                raise RateLimited(wait)  # too long to sit through; stop and resume later
            log.warning(f"{r.status_code} from server, backing off {wait}s (attempt {attempt}/{max_retries})...")
            time.sleep(wait)
            continue
        r.raise_for_status()
        time.sleep(DELAY)
        return BeautifulSoup(r.text, "html.parser")

# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

def parse_name_cell(text: str) -> dict:
    text = text.strip()
    m = re.match(r'^(\d+)\s*(.*)', text)
    if m:
        return {"kart": m.group(1), "team": m.group(2).strip()}
    return {"kart": None, "team": text}


def parse_best_lap(text: str) -> dict:
    m = re.match(r'([\d:\.]+)\s*L(\d+)', text.strip())
    if m:
        return {"time": m.group(1), "lap": int(m.group(2))}
    return {"time": text.strip() or None, "lap": None}


def clean_label(text: str) -> str:
    """Trim the over-grabbed session label down to just the session name.

    The event page anchor text comes through as e.g.
    "Inters Round 1 Practice 1 Confirmed Practice · 09:55 Winner: Liverpool A".
    We only want the leading "Inters Round 1 Practice 1". Cut at the first
    status word, time, mid-dot separator, or "Winner:" tail, whichever is first.
    """
    text = (text or "").strip()
    head = re.split(
        r'\s+(?:Confirmed|Live|Provisional|Unconfirmed|Result)\b'
        r'|\s+[·\u00b7]\s+'
        r'|\s+\d{1,2}:\d{2}\b'
        r'|\s+Winner:',
        text, maxsplit=1)[0]
    return head.strip() or text


def parse_session_meta(soup: BeautifulSoup) -> dict:
    meta = {}
    h1 = soup.find("h1")
    if h1:
        meta["title"] = h1.get_text(strip=True)

    if h1:
        siblings = [s for s in h1.next_siblings if hasattr(s, "get_text")]
        for sib in siblings[:6]:
            text = sib.get_text(separator=" ", strip=True)
            if not text:
                continue
            date_m = re.search(
                r'(January|February|March|April|May|June|July|August|'
                r'September|October|November|December)\s+\d+,\s+\d{4}', text)
            if date_m:
                meta["date"] = date_m.group(0)
            start_m = re.search(r'Start\s+(\d{1,2}:\d{2})', text)
            laps_m = re.search(r'Laps\s+(\d+)\s*\(([0-9.]+)\s*mph\)', text)
            if start_m:
                meta["start_time"] = start_m.group(1)
            if laps_m:
                meta["total_laps"] = int(laps_m.group(1))
                meta["avg_speed_mph"] = float(laps_m.group(2))

    body_text = soup.get_text()
    if "Result Confirmed" in body_text:
        meta["status"] = "confirmed"
    elif "Live" in body_text:
        meta["status"] = "live"
    else:
        meta["status"] = "unknown"

    return meta


def parse_result_table(soup: BeautifulSoup) -> list:
    """Dynamically parses the main results grid regardless of class column shifts."""
    table = soup.find("table")
    if not table:
        return []

    # Map the web row headers dynamically to isolate column indexes
    headers = [th.get_text(separator=" ", strip=True).lower() for th in table.find_all("th")]
    
    change_idx = next((i for i, h in enumerate(headers) if "+/" in h or "change" in h or "chg" in h), None)
    if change_idx is None and len(headers) > 0 and headers[0] == "":
        change_idx = 0 # Fallback icon column index
        
    pos_idx = next((i for i, h in enumerate(headers) if "pos" in h and "change" not in h and "+/" not in h), 1)
    name_idx = next((i for i, h in enumerate(headers) if "name" in h or "team" in h or "driver" in h or "competitor" in h), 2)
    gap_idx = next((i for i, h in enumerate(headers) if "gap" in h), None)
    diff_idx = next((i for i, h in enumerate(headers) if "diff" in h), None)
    best_idx = next((i for i, h in enumerate(headers) if "best" in h), None)
    s1_idx = next((i for i, h in enumerate(headers) if "s1" in h or "sector 1" in h), None)
    s2_idx = next((i for i, h in enumerate(headers) if "s2" in h or "sector 2" in h), None)
    s3_idx = next((i for i, h in enumerate(headers) if "s3" in h or "sector 3" in h), None)
    ult_idx = next((i for i, h in enumerate(headers) if "ultimate" in h or "ult" in h), None)
    time_idx = next((i for i, h in enumerate(headers) if ("time" in h or "total" in h) and "best" not in h), None)
    points_idx = next((i for i, h in enumerate(headers) if "pts" in h or "points" in h), None)

    results = []
    rows = table.find_all("tr")[1:]  

    for row in rows:
        cells = [td.get_text(strip=True) for td in row.find_all("td")]
        if len(cells) < 3:
            continue

        pos_change_raw = cells[change_idx] if (change_idx is not None and change_idx < len(cells)) else ""
        pos_raw        = cells[pos_idx] if pos_idx < len(cells) else ""
        name_raw       = cells[name_idx] if name_idx < len(cells) else ""
        gap_raw        = cells[gap_idx] if (gap_idx is not None and gap_idx < len(cells)) else ""
        diff_raw       = cells[diff_idx] if (diff_idx is not None and diff_idx < len(cells)) else ""
        best_raw       = cells[best_idx] if (best_idx is not None and best_idx < len(cells)) else ""
        s1_raw         = cells[s1_idx] if (s1_idx is not None and s1_idx < len(cells)) else ""
        s2_raw         = cells[s2_idx] if (s2_idx is not None and s2_idx < len(cells)) else ""
        s3_raw         = cells[s3_idx] if (s3_idx is not None and s3_idx < len(cells)) else ""
        ultimate_raw   = cells[ult_idx] if (ult_idx is not None and ult_idx < len(cells)) else ""
        time_raw       = cells[time_idx] if (time_idx is not None and time_idx < len(cells)) else ""
        points_raw     = cells[points_idx] if (points_idx is not None and points_idx < len(cells)) else ""

        has_penalty = "*pen" in name_raw or "[+penalty]" in name_raw.lower()
        name_clean = name_raw.replace("*pen", "").replace("[+Penalty]", "").replace("[+penalty]", "").strip()

        name_parsed = parse_name_cell(name_clean)
        best_parsed = parse_best_lap(best_raw) if best_raw else {"time": None, "lap": None}

        # Parse position changes into standard integers
        cleaned_change = None
        if pos_change_raw:
            change_digits = re.findall(r'-?\d+', pos_change_raw)
            if change_digits:
                cleaned_change = int(change_digits[0])

        # Direction lives in the arrow's CSS class, not the text:
        # gain-arrow-box = positions gained (+), loss-arrow-box = positions lost (-)
        arrow = row.find("div", class_=lambda c: c and ("gain-arrow-box" in c or "loss-arrow-box" in c))
        if arrow is not None:
            digits = re.findall(r'\d+', arrow.get_text(strip=True))
            if digits:
                mag = int(digits[0])
                classes = arrow.get("class") or []
                cleaned_change = -mag if "loss-arrow-box" in classes else mag

        result = {
            "position":       int(pos_raw) if pos_raw.isdigit() else None,
            "position_raw":   pos_raw,
            "position_change": cleaned_change,
            "kart":           name_parsed["kart"],
            "team":           name_parsed["team"],
            "penalty":        has_penalty,
            "gap":            gap_raw or None,
            "diff":           diff_raw or None,
            "best_lap_time":  best_parsed["time"],
            "best_lap_number":best_parsed["lap"],
            "sector_1":       s1_raw or None,
            "sector_2":       s2_raw or None,
            "sector_3":       s3_raw or None,
            "ultimate_lap":   ultimate_raw or None,
            "total_time":     time_raw or None,
            "points":         int(points_raw) if points_raw.isdigit() else None,
        }
        results.append(result)

    return results


def parse_penalty_table(soup: BeautifulSoup) -> list:
    tables = soup.find_all("table")
    if len(tables) < 2:
        return []

    penalties = []
    for row in tables[1].find_all("tr")[1:]:
        cells = [td.get_text(strip=True) for td in row.find_all("td")]
        if len(cells) >= 3:
            name_parsed = parse_name_cell(cells[0])
            penalties.append({
                "kart":    name_parsed["kart"],
                "team":    name_parsed["team"],
                "penalty": cells[1],
                "reason":  cells[2],
            })
    return penalties


def parse_laptimes_table(soup: BeautifulSoup) -> list:
    table = soup.find("table")
    if not table:
        return []

    drivers = []
    rows = table.find_all("tr")

    for row in rows:
        first_td = row.find("td")
        if not first_td:
            continue

        team_div = first_td.get_text(strip=True)
        if not team_div:
            continue

        name_parsed = parse_name_cell(team_div)
        all_cells = [td.get_text(strip=True) for td in row.find_all("td")]
        
        # PREMIER TIME CORRECTION: Allows tracking strings with decimal points or colons
        lap_times = [t for t in all_cells[1:] if re.match(r'[\d:\.]+', t) and ("." in t or ":" in t)]

        drivers.append({
            "kart": name_parsed["kart"],
            "team": name_parsed["team"],
            "laps": lap_times,
        })

    return drivers


def parse_combined_result(soup: BeautifulSoup) -> list:
    """Dynamically parses the championship overall standings table."""
    table = soup.find("table")
    if not table:
        return []

    headers = [th.get_text(separator=" ", strip=True).lower() for th in table.find_all("th")]
    
    pos_idx = next((i for i, h in enumerate(headers) if "pos" in h or h == "#"), 0)
    team_idx = next((i for i, h in enumerate(headers) if "team" in h or "name" in h or "competitor" in h), 1)
    laps_idx = next((i for i, h in enumerate(headers) if "laps" in h or "total" in h or "count" in h), 2)
    pos_str_idx = next((i for i, h in enumerate(headers) if "position" in h and h != "pos"), None)
    points_idx = next((i for i, h in enumerate(headers) if "pts" in h or "points" in h or "score" in h), -1)

    results = []
    rows = table.find_all("tr")[1:]

    for row in rows:
        cells = [td.get_text(strip=True) for td in row.find_all("td")]
        if len(cells) < 2:
            continue
            
        pos_raw = cells[pos_idx] if pos_idx < len(cells) else ""
        team_raw = cells[team_idx] if team_idx < len(cells) else ""
        laps_raw = cells[laps_idx] if laps_idx < len(cells) else ""
        pos_str = cells[pos_str_idx] if (pos_str_idx is not None and pos_str_idx < len(cells)) else ""
        
        name_parsed = parse_name_cell(team_raw)
        
        total_points = None
        if points_idx < len(cells) and points_idx >= 0 and cells[points_idx].isdigit():
            total_points = int(cells[points_idx])
        else:
            for cell in reversed(cells):
                if cell.isdigit():
                    total_points = int(cell)
                    break

        result = {
            "position":    int(pos_raw) if pos_raw.isdigit() else None,
            "kart":        name_parsed["kart"],
            "team":        name_parsed["team"],
            "total_laps":  laps_raw,
            "session_positions": pos_str or None,
            "total_points": total_points
        }
        results.append(result)

    return results


# ---------------------------------------------------------------------------
# Pipeline Controllers
# ---------------------------------------------------------------------------

def scrape_session(event_id: int, session_id: int, include_laps: bool = False) -> dict:
    base = f"{BASE_URL}/{CHAMPIONSHIP}/e/{event_id}/s/{session_id}"
    log.info(f"  Scraping session {session_id} result...")
    soup = get(f"{base}/result")

    meta = parse_session_meta(soup)
    results = parse_result_table(soup)
    penalties = parse_penalty_table(soup)

    session_data = {
        "session_id": session_id,
        "url": f"{BASE_URL}/{CHAMPIONSHIP}/e/{event_id}/s/{session_id}",
        **meta,
        "results": results,
        "penalties": penalties,
    }

    if include_laps and meta.get("status") == "confirmed":
        log.info(f"  Scraping session {session_id} lap times...")
        laps_soup = get(f"{base}/laptimes")
        session_data["lap_times"] = parse_laptimes_table(laps_soup)

    return session_data


def scrape_event(event_public_id: int, include_laps: bool = False) -> dict:
    log.info(f"Fetching event {event_public_id}...")
    soup = get(f"{BASE_URL}/{CHAMPIONSHIP}/e/{event_public_id}")

    h1 = soup.find("h1")
    event_title = h1.get_text(strip=True) if h1 else f"Event {event_public_id}"

    session_links = soup.find_all("a", href=re.compile(r'/bukc/e/\d+/s/\d+'))
    if not session_links:
        log.warning(f"No sessions found for event {event_public_id}")
        return {}

    internal_id_m = re.search(r'/bukc/e/(\d+)/s/', session_links[0]['href'])
    internal_event_id = int(internal_id_m.group(1)) if internal_id_m else None

    sessions_meta = []
    seen = set()
    for a in session_links:
        href = a['href']
        sid_m = re.search(r'/s/(\d+)', href)
        if not sid_m:
            continue
        sid = int(sid_m.group(1))
        if sid in seen:
            continue
        seen.add(sid)
        text = clean_label(a.get_text(separator=" ", strip=True))
        if "Race" in text and "Qualifying" not in text and "Practice" not in text:
            session_type = "race"
        elif "Qualifying" in text:
            session_type = "qualifying"
        else:
            session_type = "practice"
        sessions_meta.append({
            "session_id": sid,
            "label": text,
            "type": session_type,
        })

    combined_links = soup.find_all("a", href=re.compile(r'/bukc/e/\d+/m/\d+'))

    sessions = []
    for sm in sessions_meta:
        try:
            session_data = scrape_session(internal_event_id, sm["session_id"], include_laps)
            session_data["type"] = sm["type"]
            session_data["label"] = sm["label"]
            sessions.append(session_data)
        except Exception as e:
            log.error(f"  Failed session {sm['session_id']}: {e}")
            sessions.append({"session_id": sm["session_id"], "error": str(e), **sm})

    combined_result = None
    if combined_links:
        combined_url = BASE_URL + combined_links[0]['href']
        try:
            log.info(f"  Scraping combined result...")
            combined_soup = get(combined_url)
            combined_result = parse_combined_result(combined_soup)
        except Exception as e:
            log.error(f"  Failed combined result: {e}")

    event_data = {
        "event_public_id":   event_public_id,
        "internal_event_id": internal_event_id,
        "title":             event_title,
        "championship":      CHAMPIONSHIP,
        "url":               f"{BASE_URL}/{CHAMPIONSHIP}/e/{event_public_id}",
        "scraped_at":        datetime.utcnow().isoformat() + "Z",
        "sessions":          sessions,
        "overall_result":    combined_result,
    }

    return event_data


def discover_events(championship: str = CHAMPIONSHIP, season: int = None) -> list:
    if season is None:
        season = datetime.now().year
    log.info(f"Discovering events for {championship} season {season}...")

    event_ids = []
    seen = set()
    skip = 0
    PAGE = 10  # site lists 10 per page; "show more" loads &skip=10, &skip=20, ...
    while True:
        url = f"{BASE_URL}/{championship}?view=Results&s={season}&skip={skip}"
        soup = get(url, fragment=True)
        page_ids = []
        for a in soup.find_all("a", href=re.compile(rf'/{championship}/e/\d+')):
            m = re.search(rf'/{championship}/e/(\d+)', a['href'])
            if m:
                eid = int(m.group(1))
                if eid not in seen:
                    seen.add(eid)
                    page_ids.append(eid)
        if not page_ids:
            break  # no new events -> reached the end (or skip ignored)
        event_ids.extend(page_ids)
        log.info(f"  page skip={skip}: +{len(page_ids)} new (total {len(event_ids)})")
        skip += PAGE
        if skip > 1000:
            break

    return event_ids


def save_event(event_data: dict):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    events_dir = OUTPUT_DIR / "events"
    events_dir.mkdir(exist_ok=True)

    eid = event_data.get("event_public_id", "unknown")
    path = events_dir / f"{eid}.json"
    path.write_text(json.dumps(event_data, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info(f"Saved {path}")


def update_index():
    events_dir = OUTPUT_DIR / "events"
    if not events_dir.exists():
        return

    index = []
    for f in sorted(events_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            race_sessions = [s for s in data.get("sessions", []) if s.get("type") == "race"]
            first_race_date = next((s.get("date") for s in race_sessions if s.get("date")), None)

            index.append({
                "event_public_id":   data.get("event_public_id"),
                "internal_event_id": data.get("internal_event_id"),
                "title":             data.get("title"),
                "date":              first_race_date,
                "championship":      data.get("championship"),
                "url":               data.get("url"),
                "scraped_at":        data.get("scraped_at"),
                "session_count":     len(data.get("sessions", [])),
                "has_overall_result":data.get("overall_result") is not None,
                "file":              f"events/{f.name}",
            })
        except Exception as e:
            log.warning(f"Could not index {f}: {e}")

    index.sort(key=lambda x: x.get("date") or "", reverse=True)
    index_path = OUTPUT_DIR / "index.json"
    index_path.write_text(json.dumps({"updated_at": datetime.utcnow().isoformat() + "Z", "events": index}, indent=2, ensure_ascii=False), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Scrape BUKC results from AlphaRaceHub")
    parser.add_argument("--event", type=int, help="Scrape a specific event by public ID")
    parser.add_argument("--championship", default="bukc", help="Championship slug (default: bukc)")
    parser.add_argument("--season", type=int, default=datetime.now().year, help="Season year")
    parser.add_argument("--full", action="store_true", help="Also scrape lap times arrays")
    parser.add_argument("--output", default="output", help="Output directory")
    parser.add_argument("--skip-existing", action="store_true",
                        help="Skip events already saved (finished rounds don't change). "
                             "Delete a round's JSON to force a re-pull.")
    args = parser.parse_args()

    global OUTPUT_DIR, CHAMPIONSHIP
    OUTPUT_DIR = Path(args.output)
    CHAMPIONSHIP = args.championship

    if args.event:
        event_data = scrape_event(args.event, include_laps=args.full)
        save_event(event_data)
    else:
        try:
            event_ids = discover_events(args.championship, args.season)
            log.info(f"Found {len(event_ids)} events.")
            events_dir = OUTPUT_DIR / "events"
            for eid in event_ids:
                if args.skip_existing and (events_dir / f"{eid}.json").exists():
                    log.info(f"Skipping {eid} (already saved)")
                    continue
                try:
                    event_data = scrape_event(eid, include_laps=args.full)
                    save_event(event_data)
                except RateLimited:
                    raise
                except Exception as e:
                    log.error(f"Failed event {eid}: {e}")
        except RateLimited as rl:
            mins = round(rl.wait / 60)
            log.warning(f"Rate limited — server wants a ~{mins} min cooldown. Stopping here.")
            log.warning(f"Saved rounds are kept. Wait ~{mins} min, then re-run with --skip-existing to grab the rest.")

    update_index()
    log.info("Done.")

if __name__ == "__main__":
    main()