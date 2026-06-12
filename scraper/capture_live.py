#!/usr/bin/env python3
"""
capture_live.py — grabs the AlphaRaceHub LIVE timing HTML so the live feed can
be built correctly. Run this on YOUR machine while a session is actually live
(e.g. the UKC race that's on now, or BUKC practice on race day), then upload the
files it drops into ./live_capture/ .

  pip install requests beautifulsoup4
  python capture_live.py --champ ukc          # whatever is live right now
  python capture_live.py --champ bukc          # on the day

Nothing is published anywhere; it only saves local files for inspection.
"""
import argparse, re, json
from pathlib import Path
import requests

BASE = "https://www.alpharacehub.com"
UA = {"User-Agent": "Mozilla/5.0 (pitwall-capture)"}


def grab(url, hx=False):
    h = dict(UA)
    if hx:
        h["HX-Request"] = "true"
    r = requests.get(url, headers=h, timeout=20)
    return r.status_code, r.text


def save(d, name, text):
    p = d / name
    p.write_text(text, encoding="utf-8")
    print(f"  saved {name}  ({len(text):,} bytes)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--champ", default="ukc", help="championship slug in the URL (ukc, bukc, ...)")
    args = ap.parse_args()
    out = Path("live_capture")
    out.mkdir(exist_ok=True)
    c = args.champ

    print(f"Capturing live HTML for /{c}/live ...")
    for label, hx in [("live_plain.html", False), ("live_hx.html", True)]:
        try:
            code, html = grab(f"{BASE}/{c}/live", hx=hx)
            print(f"/{c}/live  (hx={hx}) -> {code}")
            save(out, label, html)
        except Exception as e:
            print(f"  ERROR {label}: {e}")
            html = ""

    # find any session/result/live endpoints referenced in the page
    found = set()
    for pat in [r'/%s/e/\d+/s/\d+[^"\']*' % c, r'/%s/live[^"\']*' % c,
                r'hx-get="([^"]+)"', r'hx-post="([^"]+)"', r'/%s/[^"\']*result[^"\']*' % c]:
        for m in re.findall(pat, html):
            found.add(m if isinstance(m, str) else m)
    print("\nEndpoints referenced in the live page:")
    for f in sorted(found)[:40]:
        print("  ", f)
    save(out, "endpoints.txt", "\n".join(sorted(found)))

    # download the JS bundle — it holds the Pusher channel + payload logic
    js_urls = re.findall(r'src="([^"]*liveTiming[^"]*\.js[^"]*)"', html)
    for i, ju in enumerate(js_urls):
        url = ju if ju.startswith("http") else BASE + ju
        try:
            code, js = grab(url)
            print(f"\nJS bundle {url} -> {code}")
            save(out, f"liveTiming_{i}.js", js)
        except Exception as e:
            print(f"  ERROR js {i}: {e}")
    # also try a couple of likely initial-state REST endpoints the app may call
    for guess in [f"/{c}/live/data", f"/{c}/live/state", f"/api/{c}/live", f"/{c}/live.json"]:
        try:
            code, txt = grab(BASE + guess, hx=True)
            if code == 200 and txt.strip():
                print(f"possible data endpoint {guess} -> {code} ({len(txt)} bytes)")
                save(out, "maybe_" + guess.strip("/").replace("/", "_") + ".txt", txt)
        except Exception:
            pass

    # follow the first result/live fragment so I can see the row structure
    target = next((f for f in found if "/s/" in f or "result" in f or "/live" in f), None)
    if target:
        url = target if target.startswith("http") else BASE + (target if target.startswith("/") else "/" + target)
        for label, hx in [("fragment_plain.html", False), ("fragment_hx.html", True)]:
            try:
                code, html2 = grab(url, hx=hx)
                print(f"\n{url}  (hx={hx}) -> {code}")
                save(out, label, html2)
            except Exception as e:
                print(f"  ERROR {label}: {e}")

    print("\nDONE. Upload everything in the ./live_capture/ folder.")


if __name__ == "__main__":
    main()
