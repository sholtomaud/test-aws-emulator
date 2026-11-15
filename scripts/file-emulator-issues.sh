#!/usr/bin/env bash
# Files the AWS Emulator issues written up in docs/emulator-issues.md on
# github.com/aws/aws-emulator with the GitHub CLI: one issue per
# "## N. Title" section, its body laid out like the repository's
# "Behavior differs from AWS" issue form.
#
#   scripts/file-emulator-issues.sh                  dry run: writes every issue to
#                                                    reports/emulator-issues/ to review
#   scripts/file-emulator-issues.sh --create         files them, skipping titles that
#                                                    already exist (open or closed)
#   scripts/file-emulator-issues.sh --create --only 10,11,12
#   scripts/file-emulator-issues.sh --create --skip 6
#
# Needs gh (https://cli.github.com), signed in (`gh auth login`) as the
# account the issues should come from. Run it from the repository root.
set -euo pipefail

REPO="${EMULATOR_ISSUES_REPO:-aws/aws-emulator}"
DOC="docs/emulator-issues.md"
OUT="reports/emulator-issues"
CREATE=0
ONLY=""
SKIP=""

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --create) CREATE=1 ;;
    --only) ONLY="${2:?--only needs a list of section numbers, e.g. 10,11}"; shift ;;
    --skip) SKIP="${2:?--skip needs a list of section numbers, e.g. 6}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

[ -f "$DOC" ] || { echo "run this from the repository root ($DOC not found)" >&2; exit 1; }
if [ "$CREATE" = 1 ]; then
  command -v gh >/dev/null || { echo "gh is not installed: https://cli.github.com" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "gh is not signed in: run gh auth login" >&2; exit 1; }
fi

# The emulator version the issues were checked on, from the write-up's header:
#   checked on **1.0.353** (release 2026.11.14, commit `ca8a89d...`),
header=$(sed -n '1,/^## 1\. /p' "$DOC" | tr '\n' ' ')
version=$(sed -nE 's/.*checked on \*\*([0-9.]+)\*\*.*/\1/p' <<<"$header")
released=$(sed -nE 's/.*\(release ([0-9.]+),.*/\1/p' <<<"$header")
commit=$(sed -nE 's/.*commit `([0-9a-f]+)`.*/\1/p' <<<"$header")
[ -n "$version" ] && [ -n "$commit" ] || { echo "could not read the emulator version and commit from $DOC's header" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

# One N.title and N.section file per "## N. Title" section. The "---" lines
# between sections are separators, not content.
awk -v out="$OUT" '
  /^## [0-9]+\. / {
    n = $2; sub(/\.$/, "", n)
    title = $0; sub(/^## [0-9]+\. /, "", title)
    file = out "/" n ".section"
    printf "%s\n", title > (out "/" n ".title"); close(out "/" n ".title")
    printf "" > file
    next
  }
  n && /^---[[:space:]]*$/ { next }
  n { print >> file }
' "$DOC"

selected() {
  local n="$1"
  if [ -n "$ONLY" ] && [[ ",$ONLY," != *",$n,"* ]]; then return 1; fi
  if [ -n "$SKIP" ] && [[ ",$SKIP," == *",$n,"* ]]; then return 1; fi
  return 0
}

# Writes the issue body for section N to N.md: the form's checkboxes, the
# section with its bold headings turned into the form's headings, and the
# version the form asks for.
write_body() {
  local n="$1"
  {
    echo "### Before you file"
    echo
    echo "- [x] I searched open and recently closed issues and found no report of this."
    echo "- [x] I checked that this still happens with the latest version of the emulator."
    echo
    # **What happened** -> ### What happened (and the other form headings);
    # leading and trailing blank lines dropped.
    sed -E 's/^\*\*(What happened|What you expected|Steps to reproduce|Impact and workaround)\*\*[[:space:]]*$/### \1/' "$OUT/$n.section" |
      awk 'NF { started = 1 } started { lines[++count] = $0 } END { while (count > 0 && lines[count] ~ /^[[:space:]]*$/) count--; for (i = 1; i <= count; i++) print lines[i] }'
    echo
    echo "### Emulator version"
    echo
    echo '```text'
    echo "Version: $version"
    [ -n "$released" ] && echo "Release date: $released"
    echo "Commit: $commit"
    echo '```'
    echo
    echo "Linux x86_64 package, Region us-east-1, AWS SDK for JavaScript v3, endpoint set with AWS_ENDPOINT_URL, emulator settings at their defaults except \`-t off\`."
  } >"$OUT/$n.md"
}

# The URL of an issue (open or closed) on $REPO whose title is exactly $1, if
# there is one. GitHub's search matches words, so the result is filtered for
# the exact title.
existing_issue() {
  gh api -X GET search/issues -f q="repo:$REPO is:issue in:title \"$1\"" -f per_page=20 |
    TITLE="$1" python3 -c 'import json, os, sys
title = os.environ["TITLE"]
print(next((i["html_url"] for i in json.load(sys.stdin)["items"] if i["title"] == title), ""))'
}

total=0 created=0 skipped=0
for n in $(ls "$OUT"/*.title | xargs -n1 basename | sed 's/\.title$//' | sort -n); do
  selected "$n" || continue
  title=$(cat "$OUT/$n.title")
  write_body "$n"
  total=$((total + 1))

  if [ "$CREATE" = 0 ]; then
    printf '%3s  %s\n     %s\n' "$n" "$title" "$OUT/$n.md"
    continue
  fi

  url=$(existing_issue "$title")
  if [ -n "$url" ]; then
    echo "skip  $n: already filed: $url"
    skipped=$((skipped + 1))
    continue
  fi
  url=$(gh issue create --repo "$REPO" --title "$title" --body-file "$OUT/$n.md")
  echo "filed $n: $url"
  created=$((created + 1))
  sleep "${EMULATOR_ISSUES_DELAY:-3}" # stay well inside GitHub's limits on creating content
done

[ "$total" -gt 0 ] || { echo "no section matched (--only/--skip, or no '## N. Title' sections in $DOC)" >&2; exit 1; }
echo
if [ "$CREATE" = 0 ]; then
  echo "Dry run: $total issue(s) for $REPO written to $OUT/. Review them, then run again with --create."
else
  echo "Done: $created filed, $skipped already on $REPO."
fi
