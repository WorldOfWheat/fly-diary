#!/usr/bin/env bash
#
# rename-dates.sh — rename "M月D日.txt" files to "YYYY-MM-DD.txt"
#
# Unrelated to Fly Diary; a standalone helper for preparing a folder of
# Chinese-named diary files so they can be imported.
#
# Usage:
#   ./rename-dates.sh [OPTIONS] <folder>
#
# Options:
#   -y, --year YEAR    Year to use (default: current year)
#   -n, --dry-run      Show what would happen, change nothing
#   -f, --force        Overwrite an existing target file
#   -r, --recursive    Also process sub-folders
#   -h, --help         Show this help
#
# Examples:
#   ./rename-dates.sh -n ~/diary            # preview with this year
#   ./rename-dates.sh -y 2023 ~/diary       # rename using 2023
#   ./rename-dates.sh -y 2023 -r ~/diary    # include sub-folders
#
# Accepted source names (spaces around the numbers are ignored):
#   1月1日.txt   01月01日.txt   1月1號.txt   1月1日.md
#
# Files that are already YYYY-MM-DD.txt are left alone. Anything that does not
# parse as a real calendar date (e.g. 2月30日.txt) is reported and skipped.

set -euo pipefail

YEAR=""
DRY_RUN=0
FORCE=0
RECURSIVE=0
TARGET=""

usage() {
    sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

# --- Parse arguments -------------------------------------------------------

while [ $# -gt 0 ]; do
    case "$1" in
        -y|--year)
            [ $# -ge 2 ] || die "$1 requires a value"
            YEAR="$2"
            shift 2
            ;;
        -y=*|--year=*)
            YEAR="${1#*=}"
            shift
            ;;
        -n|--dry-run)
            DRY_RUN=1
            shift
            ;;
        -f|--force)
            FORCE=1
            shift
            ;;
        -r|--recursive)
            RECURSIVE=1
            shift
            ;;
        -h|--help)
            usage 0
            ;;
        --)
            shift
            break
            ;;
        -*)
            die "unknown option: $1 (try --help)"
            ;;
        *)
            [ -z "$TARGET" ] || die "only one folder may be given"
            TARGET="$1"
            shift
            ;;
    esac
done

# Anything after `--` is the folder.
if [ -z "$TARGET" ] && [ $# -gt 0 ]; then
    TARGET="$1"
fi

[ -n "$TARGET" ] || usage 1
[ -d "$TARGET" ] || die "not a folder: $TARGET"

if [ -z "$YEAR" ]; then
    YEAR="$(date +%Y)"
fi

case "$YEAR" in
    ''|*[!0-9]*) die "year must be a number, got: $YEAR" ;;
esac
[ "${#YEAR}" -eq 4 ] || die "year must have 4 digits, got: $YEAR"

# --- Helpers ---------------------------------------------------------------

# Zero-pad a number to two digits: 1 -> 01
pad2() {
    printf '%02d' "$((10#$1))"
}

# Days in a month, honouring leap years.
days_in_month() {
    local y="$1" m="$2"
    case "$m" in
        1|3|5|7|8|10|12) echo 31 ;;
        4|6|9|11)        echo 30 ;;
        2)
            if [ $(( y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) )) -eq 1 ]; then
                echo 29
            else
                echo 28
            fi
            ;;
        *) echo 0 ;;
    esac
}

# --- Collect files ---------------------------------------------------------

files=()
if [ "$RECURSIVE" -eq 1 ]; then
    while IFS= read -r -d '' f; do
        files+=("$f")
    done < <(find "$TARGET" -type f -print0)
else
    while IFS= read -r -d '' f; do
        files+=("$f")
    done < <(find "$TARGET" -maxdepth 1 -type f -print0)
fi

if [ "${#files[@]}" -eq 0 ]; then
    echo "No files found in: $TARGET"
    exit 0
fi

# --- Rename -----------------------------------------------------------------

renamed=0
skipped=0
failed=0

for path in "${files[@]}"; do
    dir="$(dirname "$path")"
    base="$(basename "$path")"

    # Split the extension off; only .txt and .md are considered.
    case "$base" in
        *.*) stem="${base%.*}"; ext="${base##*.}" ;;
        *)   continue ;;
    esac
    case "$ext" in
        txt|TXT|md|MD) ;;
        *) continue ;;
    esac

    # Already in the target format: leave it alone.
    if printf '%s' "$stem" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
        skipped=$((skipped + 1))
        continue
    fi

    # Match "M月D日" / "M月D號", tolerating spaces and full-width digits.
    if ! printf '%s' "$stem" | grep -Eq '^[[:space:]]*[0-9０-９]+[[:space:]]*月[[:space:]]*[0-9０-９]+[[:space:]]*[日號][[:space:]]*$'; then
        printf 'skip  %s  (name does not look like M月D日)\n' "$base"
        skipped=$((skipped + 1))
        continue
    fi

    # Normalise full-width digits to ASCII before extracting the numbers.
    # `tr` works on bytes, so a multibyte table would corrupt the trailing
    # 日/號; sed is UTF-8 aware and only rewrites the digits.
    normalised="$(printf '%s' "$stem" | sed -e 's/０/0/g' -e 's/１/1/g' \
        -e 's/２/2/g' -e 's/３/3/g' -e 's/４/4/g' -e 's/５/5/g' \
        -e 's/６/6/g' -e 's/７/7/g' -e 's/８/8/g' -e 's/９/9/g')"

    month="$(printf '%s' "$normalised" | sed -E 's/^[[:space:]]*([0-9]+).*/\1/')"
    day="$(printf '%s' "$normalised" | sed -E 's/.*月[[:space:]]*([0-9]+).*/\1/')"

    # Guard the arithmetic: a failed extraction must not abort the loop.
    case "$month" in
        ''|*[!0-9]*)
            printf 'fail  %s  (could not read the month)\n' "$base"
            failed=$((failed + 1))
            continue
            ;;
    esac
    case "$day" in
        ''|*[!0-9]*)
            printf 'fail  %s  (could not read the day)\n' "$base"
            failed=$((failed + 1))
            continue
            ;;
    esac

    month=$((10#$month))
    day=$((10#$day))

    max_day="$(days_in_month "$YEAR" "$month")"
    if [ "$max_day" -eq 0 ] || [ "$day" -lt 1 ] || [ "$day" -gt "$max_day" ]; then
        printf 'fail  %s  (invalid date: %s-%s-%s)\n' "$base" "$YEAR" "$month" "$day"
        failed=$((failed + 1))
        continue
    fi

    new_name="$(printf '%s-%s-%s.%s' "$YEAR" "$(pad2 "$month")" "$(pad2 "$day")" "$ext")"
    new_path="$dir/$new_name"

    if [ "$path" = "$new_path" ]; then
        skipped=$((skipped + 1))
        continue
    fi

    if [ -e "$new_path" ] && [ "$FORCE" -ne 1 ]; then
        printf 'fail  %s  (target exists: %s)\n' "$base" "$new_name"
        failed=$((failed + 1))
        continue
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
        printf 'would %s -> %s\n' "$base" "$new_name"
        renamed=$((renamed + 1))
        continue
    fi

    if mv -n -- "$path" "$new_path" 2>/dev/null || mv -f -- "$path" "$new_path"; then
        printf 'ok    %s -> %s\n' "$base" "$new_name"
        renamed=$((renamed + 1))
    else
        printf 'fail  %s  (could not rename)\n' "$base"
        failed=$((failed + 1))
    fi
done

# --- Summary ----------------------------------------------------------------

printf '\n%s: %d renamed, %d skipped, %d failed\n' \
    "$([ "$DRY_RUN" -eq 1 ] && echo "Dry run" || echo "Done")" \
    "$renamed" "$skipped" "$failed"

[ "$failed" -eq 0 ]
