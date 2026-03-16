#!/usr/bin/env python3
"""
Visual Archive — Data Backup Utility
Copies all CSV files + unified.jsonl to a timestamped folder inside _backups/.
Generates a manifest.json with filename, line count, MD5 hash, size, and timestamp.
Keeps the last 5 backups; deletes older ones.

Usage:
    python3 backup.py              # Full backup
    python3 backup.py --dry-run    # Show what would be backed up
"""

import os, sys, json, shutil, hashlib, glob
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BACKUPS_DIR = SCRIPT_DIR / "_backups"
MAX_BACKUPS = 5

# Files to back up: all CSVs in any subdirectory + unified.jsonl at root
def collect_files():
    files = []
    # All CSVs recursively (skip _backups dir)
    for csv in SCRIPT_DIR.rglob("*.csv"):
        if "_backups" in csv.parts:
            continue
        files.append(csv)
    # unified.jsonl
    jsonl = SCRIPT_DIR / "unified.jsonl"
    if jsonl.exists():
        files.append(jsonl)
    return sorted(files)


def md5_hash(filepath, chunk_size=8192):
    h = hashlib.md5()
    with open(filepath, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def line_count(filepath):
    count = 0
    with open(filepath, "rb") as f:
        for _ in f:
            count += 1
    return count


def human_size(nbytes):
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024:
            return f"{nbytes:.1f} {unit}"
        nbytes /= 1024
    return f"{nbytes:.1f} TB"


def prune_old_backups():
    """Keep only the last MAX_BACKUPS timestamped folders."""
    if not BACKUPS_DIR.exists():
        return
    # Find folders matching pattern backup_YYYYMMDD_HHMMSS
    folders = sorted(
        [d for d in BACKUPS_DIR.iterdir() if d.is_dir() and d.name.startswith("backup_")],
        key=lambda d: d.name,
    )
    while len(folders) > MAX_BACKUPS:
        oldest = folders.pop(0)
        print(f"  Pruning old backup: {oldest.name}")
        shutil.rmtree(oldest)


def main():
    dry_run = "--dry-run" in sys.argv

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_folder = BACKUPS_DIR / f"backup_{timestamp}"

    files = collect_files()
    if not files:
        print("No files found to back up.")
        return

    total_size = sum(f.stat().st_size for f in files)
    print(f"\n{'[DRY RUN] ' if dry_run else ''}Visual Archive Backup")
    print(f"  Files:      {len(files)}")
    print(f"  Total size: {human_size(total_size)}")
    print(f"  Target:     {backup_folder.name}/")
    print()

    manifest = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_files": len(files),
        "total_size_bytes": total_size,
        "total_size_human": human_size(total_size),
        "files": [],
    }

    if not dry_run:
        backup_folder.mkdir(parents=True, exist_ok=True)

    for f in files:
        rel = f.relative_to(SCRIPT_DIR)
        lines = line_count(f)
        size = f.stat().st_size
        md5 = md5_hash(f)

        entry = {
            "path": str(rel),
            "lines": lines,
            "size_bytes": size,
            "size_human": human_size(size),
            "md5": md5,
        }
        manifest["files"].append(entry)

        status = "OK" if not dry_run else "WOULD COPY"
        print(f"  {status}  {rel}  ({lines:,} lines, {human_size(size)}, md5:{md5[:8]})")

        if not dry_run:
            dest = backup_folder / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)

    if not dry_run:
        manifest_path = backup_folder / "manifest.json"
        with open(manifest_path, "w") as mf:
            json.dump(manifest, mf, indent=2)
        print(f"\n  Manifest: {manifest_path.name}")

        # Prune old backups
        prune_old_backups()

    print(f"\n{'[DRY RUN] ' if dry_run else ''}Backup complete: {len(files)} files, {human_size(total_size)}")


if __name__ == "__main__":
    main()
