# BUKC AlphaRaceHub Scraper

Scrapes race results from [alpharacehub.com](https://www.alpharacehub.com/bukc) and outputs clean JSON files ready to consume from any website.

AlphaRaceHub has no public API — this scrapes the HTML and parses it. It's stable because the URL and HTML structure are consistent.

---

## Setup

```bash
pip install requests beautifulsoup4
```

Python 3.9+ required. No other dependencies.

---

## Usage

### Scrape a specific event

```bash
python3 scraper.py --event 317059
```

The event ID is the number in the AlphaRaceHub URL:
`https://www.alpharacehub.com/bukc/event/317059`

### Scrape all events for the current season

```bash
python3 scraper.py
```

### Include full lap times per session (slower — ~2× requests)

```bash
python3 scraper.py --event 317059 --full
```

### Scrape a different championship

```bash
python3 scraper.py --championship wmkc --event 347935
```

### Custom output directory

```bash
python3 scraper.py --event 317059 --output /var/www/mysite/data
```

---

## Output structure

```
output/
  index.json              ← summary of all scraped events
  events/
    317059.json           ← full data for one event
    344637.json
    ...
```

### `index.json`

```json
{
  "updated_at": "2026-01-31T03:00:01Z",
  "events": [
    {
      "event_public_id": 317059,
      "title": "Inters Round 1",
      "date": "January 30, 2026",
      "championship": "bukc",
      "url": "https://www.alpharacehub.com/bukc/event/317059",
      "scraped_at": "2026-01-31T03:00:01Z",
      "session_count": 18,
      "has_overall_result": true,
      "file": "events/317059.json"
    }
  ]
}
```

### `events/{id}.json`

```json
{
  "event_public_id": 317059,
  "title": "Inters Round 1",
  "championship": "bukc",
  "scraped_at": "2026-01-31T03:00:01Z",
  "sessions": [
    {
      "session_id": 726060,
      "type": "race",
      "title": "Race 7: Inters Round 1 Race 1",
      "date": "January 30, 2026",
      "start_time": "13:17",
      "total_laps": 22,
      "avg_speed_mph": 28.8,
      "status": "confirmed",
      "results": [
        {
          "position": 1,
          "kart": "71",
          "team": "Royal Holloway A",
          "penalty": false,
          "gap": null,
          "diff": null,
          "best_lap_time": "1:08.741",
          "best_lap_number": 7,
          "sector_1": "28.175",
          "sector_2": "20.849",
          "sector_3": "18.945",
          "ultimate_lap": "1:07.969",
          "total_time": "25:35.380",
          "points": 60,
          "position_change": null
        }
      ],
      "penalties": [
        {
          "kart": "62",
          "team": "Leeds Beckett A",
          "penalty": "+4 Positions",
          "reason": "11j. Forcing driver wide"
        }
      ],
      "lap_times": null
    }
  ],
  "overall_result": [
    {
      "position": 1,
      "kart": "81",
      "team": "Surrey C",
      "total_laps": "174",
      "session_positions": "[5 3 2]",
      "total_points": 60
    }
  ]
}
```

`lap_times` is `null` unless you ran with `--full`. When populated, each entry is:

```json
{ "kart": "71", "team": "Royal Holloway A", "laps": ["1:11.49", "1:09.04", ...] }
```

---

## Nightly cron setup

Run at 3am every night. Change the path to wherever you put the script.

```cron
0 3 * * * cd /home/youruser/bukc-scraper && python3 scraper.py >> /var/log/bukc-scraper.log 2>&1
```

To edit your crontab:

```bash
crontab -e
```

If you want to only re-scrape events from the last 7 days (to pick up late result confirmations) without hammering everything, you can filter by `scraped_at` in your own wrapper — or just re-run everything nightly since a full season is ~10 events × 18 sessions ≈ 180 requests, which takes ~3 minutes at a 1s delay.

---

## Using the data on a website

The JSON files are static — just commit them to your repo or serve from any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages, etc.).

### Fetch in JavaScript

```js
// Get the event index
const index = await fetch('/data/index.json').then(r => r.json());

// Load a specific event
const event = await fetch('/data/events/317059.json').then(r => r.json());

// Get all race sessions
const races = event.sessions.filter(s => s.type === 'race');

// Find your team's results across all races
const myTeam = 'Leeds A';
const myResults = races.map(race => ({
  race: race.title,
  result: race.results.find(r => r.team === myTeam)
}));
```

### Filter to your university

```js
const UNI = 'Leeds';  // matches "Leeds A", "Leeds B", "Leeds C", etc.

const myTeamResults = race.results.filter(r => r.team.startsWith(UNI));
```

---

## Notes

- **Be polite**: the scraper has a 1-second delay between requests. Don't reduce this.
- **No auth needed**: all BUKC results are public.
- **Rate limits**: AlphaRaceHub doesn't appear to rate-limit but don't hammer it — nightly is fine.
- **Status field**: `"confirmed"` means official results; `"live"` means the session is in progress (nightly scraping will naturally catch confirmed results).
- **Points = 0**: some entries show 0 points (e.g. guest teams ineligible for championship points). This is correct data from the source.
- **Championship slug**: the slug is whatever appears in the AlphaRaceHub URL — `bukc`, `wmkc`, `lhrc`, etc.
