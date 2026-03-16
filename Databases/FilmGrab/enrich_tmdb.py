#!/usr/bin/env python3
"""
FilmGrab TMDB Enrichment Script
Enriches filmgrab_data.csv with genre, overview, and keywords from TMDB API.
Outputs filmgrab_enriched.csv with new columns: genres, overview, keywords, tmdb_id.
Uses a local JSON cache for resume safety and rate-limit friendliness.

Usage:
    python3 enrich_tmdb.py                  # Full run
    python3 enrich_tmdb.py --limit 50       # Process only 50 films
    python3 enrich_tmdb.py --dry-run        # Show what would be fetched
"""

import csv, json, os, sys, time, re, ssl, urllib.request, urllib.error
from pathlib import Path

# macOS Python often lacks default SSL certificates — bypass verification for TMDB API
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

SCRIPT_DIR = Path(__file__).resolve().parent
CSV_INPUT  = SCRIPT_DIR / "filmgrab-scraper" / "filmgrab_data.csv"
CSV_OUTPUT = SCRIPT_DIR / "filmgrab_enriched.csv"
CACHE_FILE = SCRIPT_DIR / "tmdb_cache.json"

TMDB_API_KEY = "988c5079332b3cb4ef5af8bed1ccfc7c"
TMDB_BASE    = "https://api.themoviedb.org/3"

# TMDB genre ID → name mapping (static, rarely changes)
GENRE_MAP = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
    80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
    14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
    9648: "Mystery", 10749: "Romance", 878: "Science Fiction",
    10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
}


def load_cache():
    if CACHE_FILE.exists():
        with open(CACHE_FILE, "r") as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def tmdb_get(path, params=None):
    """Make a GET request to TMDB API with rate-limit handling."""
    url = f"{TMDB_BASE}{path}?api_key={TMDB_API_KEY}"
    if params:
        for k, v in params.items():
            url += f"&{k}={urllib.request.quote(str(v))}"

    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                # Rate limited — wait and retry
                retry_after = int(e.headers.get("Retry-After", "2"))
                print(f"    Rate limited, waiting {retry_after}s...")
                time.sleep(retry_after + 0.5)
                continue
            elif e.code == 404:
                return None
            else:
                print(f"    HTTP {e.code} for {path}")
                return None
        except Exception as e:
            print(f"    Error: {e}")
            if attempt < 2:
                time.sleep(1)
    return None


def search_movie(title, year=None):
    """Search TMDB for a movie by title and optional year."""
    params = {"query": title, "include_adult": "false"}
    if year:
        params["year"] = year
    data = tmdb_get("/search/movie", params)
    if not data or not data.get("results"):
        # Retry without year if no results
        if year:
            params.pop("year")
            data = tmdb_get("/search/movie", params)
    if not data or not data.get("results"):
        return None
    return data["results"][0]  # Best match


def get_keywords(movie_id):
    """Fetch keywords for a movie."""
    data = tmdb_get(f"/movie/{movie_id}/keywords")
    if not data:
        return []
    return [kw["name"] for kw in data.get("keywords", [])]


def clean_title(title):
    """Clean title for better TMDB matching."""
    # Remove parenthetical year references
    title = re.sub(r'\s*\(\d{4}\)\s*', '', title)
    # Remove "aka" suffixes
    title = re.sub(r'\s+aka\s+.*$', '', title, flags=re.IGNORECASE)
    return title.strip()


def main():
    dry_run = "--dry-run" in sys.argv
    limit = None
    if "--limit" in sys.argv:
        idx = sys.argv.index("--limit")
        limit = int(sys.argv[idx + 1])

    # Load existing cache
    cache = load_cache()
    print(f"TMDB cache: {len(cache)} entries loaded")

    # Read input CSV
    with open(CSV_INPUT, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    print(f"Input: {len(rows)} films from filmgrab_data.csv")
    if limit:
        rows = rows[:limit]
        print(f"  (limited to {limit})")

    enriched = []
    new_lookups = 0
    matched = 0
    unmatched = 0

    for i, row in enumerate(rows):
        title = row.get("Title", "").strip()
        year_str = row.get("Year", "").strip()
        year = int(year_str) if year_str.isdigit() else None

        # Cache key: normalized title + year
        cache_key = f"{title.lower()}|{year or ''}"

        if cache_key in cache:
            # Use cached data
            entry = cache[cache_key]
        elif dry_run:
            print(f"  [{i+1}/{len(rows)}] WOULD FETCH: {title} ({year or '?'})")
            enriched.append({**row, "genres": "", "overview": "", "keywords": "", "tmdb_id": ""})
            continue
        else:
            # Search TMDB
            clean = clean_title(title)
            result = search_movie(clean, year)

            if result:
                movie_id = result["id"]
                genres = [GENRE_MAP.get(gid, f"Genre-{gid}") for gid in result.get("genre_ids", [])]
                overview = result.get("overview", "")
                keywords = get_keywords(movie_id)

                entry = {
                    "tmdb_id": movie_id,
                    "genres": genres,
                    "overview": overview,
                    "keywords": keywords,
                }
                status = "MATCHED"
                matched += 1
            else:
                entry = {"tmdb_id": None, "genres": [], "overview": "", "keywords": []}
                status = "NOT FOUND"
                unmatched += 1

            cache[cache_key] = entry
            new_lookups += 1

            # Progress
            if (i + 1) % 25 == 0 or status == "NOT FOUND":
                print(f"  [{i+1}/{len(rows)}] {status}: {title} ({year or '?'})")

            # Save cache periodically
            if new_lookups % 100 == 0:
                save_cache(cache)

            # Rate limit: ~4 requests per film (search + keywords), TMDB allows 40/10s
            time.sleep(0.3)

        # Build enriched row
        enriched.append({
            **row,
            "genres":   "|".join(entry.get("genres", [])),
            "overview": entry.get("overview", ""),
            "keywords": "|".join(entry.get("keywords", [])),
            "tmdb_id":  str(entry.get("tmdb_id", "") or ""),
        })

        # Count cached hits
        if cache_key in cache and entry.get("tmdb_id"):
            matched += 1

    # Final cache save
    if not dry_run:
        save_cache(cache)

    # Write enriched CSV
    if not dry_run and enriched:
        fieldnames = list(rows[0].keys()) + ["genres", "overview", "keywords", "tmdb_id"]
        with open(CSV_OUTPUT, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(enriched)

    print(f"\n{'[DRY RUN] ' if dry_run else ''}Enrichment complete:")
    print(f"  Total films:   {len(rows)}")
    print(f"  New lookups:   {new_lookups}")
    print(f"  Matched:       {matched}")
    print(f"  Not found:     {unmatched}")
    if not dry_run:
        print(f"  Output:        {CSV_OUTPUT}")
        print(f"  Cache entries: {len(cache)}")


if __name__ == "__main__":
    main()
