#!/usr/bin/env bats
# End-to-end validation of a *deployed* wwwshare backend.
#
# These tests really publish, fetch, update, list, and delete pages against
# the live worker named by WWWSHARE_ENDPOINT, exercising the real CLI
# (cli/src/wwwshare.mjs) plus direct curl assertions on the public read
# surface. No local server is started and nothing is mocked — the only
# fake is a PATH stub for the browser opener, so a test run never opens
# browser windows. (Publishes pass --no-cp, so your clipboard is safe.)
#
# Requirements:
#   - WWWSHARE_ENDPOINT and WWWSHARE_UPLOAD_TOKEN in the environment, or in
#     ${XDG_CONFIG_HOME:-~/.config}/wwwshare/.env (same file the CLI reads).
#   - node, curl, bats >= 1.7.
#
# Safety: every slug this suite touches starts with a unique per-run prefix
# (e2e-<epoch>-<random>-...). Cleanup removes only slugs with that prefix,
# so pre-existing pages in the same deployment are never modified.

bats_require_minimum_version 1.7.0

# --- one-time setup -------------------------------------------------------

setup_file() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  export CLI="$REPO_ROOT/cli/src/wwwshare.mjs"

  # curl needs the endpoint the CLI will use; the CLI loads its own config,
  # so only the endpoint is resolved here (trailing slash stripped). Missing
  # or bad config fails the pre-flight below with the CLI's own messages.
  ENDPOINT="$(cli_env WWWSHARE_ENDPOINT)"
  export ENDPOINT="${ENDPOINT%/}"

  # Unique namespace for this run. Slug alphabet is [a-z0-9-], so epoch
  # seconds + $RANDOM are safe and keep every slug well under 64 chars.
  export PREFIX="e2e-$(date +%s)-$RANDOM"
  export CREATED_SLUGS="$BATS_FILE_TMPDIR/created-slugs"

  # Pre-flight: one authenticated call proves the deployment is reachable
  # and the token works — fail the whole file fast with one actionable
  # message instead of a dozen confusing test failures.
  if ! cli list >/dev/null; then
    echo "e2e: 'wwwshare list' against $ENDPOINT failed — check" \
      "WWWSHARE_ENDPOINT / WWWSHARE_UPLOAD_TOKEN and that the worker is deployed" >&2
    return 1
  fi

  # Fixture pages. Unique markers (the run prefix) prove we read back what
  # this run wrote; the emoji + snowman exercise UTF-8 byte fidelity.
  export PAGE_V1="$BATS_FILE_TMPDIR/v1.html"
  export PAGE_V2="$BATS_FILE_TMPDIR/v2.html"
  printf '<!doctype html>\n<title>e2e v1</title>\n<p>marker-%s version-one \342\230\203 \360\237\224\254</p>\n' "$PREFIX" > "$PAGE_V1"
  printf '<!doctype html>\n<title>e2e v2</title>\n<p>marker-%s version-two</p>\n' "$PREFIX" > "$PAGE_V2"

  # Browser-opener stubs (`open`/`xdg-open`), ahead of the real binaries
  # for every test in this file: they log their argument so `wwwshare
  # open` is testable without launching a browser.
  local stub_bin="$BATS_FILE_TMPDIR/stub-bin"
  export OPEN_STUB_LOG="$BATS_FILE_TMPDIR/open-stub.log"
  mkdir -p "$stub_bin"
  local name
  for name in open xdg-open; do
    printf '#!/bin/bash\necho "$@" >> "$OPEN_STUB_LOG"\n' > "$stub_bin/$name"
  done
  chmod +x "$stub_bin"/*
  export PATH="$stub_bin:$PATH"
}

teardown_file() {
  # Remove every slug this run created — and nothing else. Union of the
  # slugs publish() tracked and what /list reports under our prefix, so
  # cleanup still works if either side is the regression: a broken /list
  # can't hide tracked pages, and tracking can't miss pages a test
  # created some other way.
  local mine
  mine="$( (cat "$CREATED_SLUGS" 2>/dev/null;
            cli list 2>/dev/null) | grep "^${PREFIX}-" | sort -u )"
  if [ -n "$mine" ]; then
    # shellcheck disable=SC2086  # slugs are [a-z0-9-], splitting is safe
    cli remove $mine || true
  fi
}

# --- helpers --------------------------------------------------------------

# Resolve a config value through the CLI's own loadEnv() (exported for
# tests), so curl and the CLI under test agree on the deployment by
# construction: shell env wins, the config file fills the gaps.
cli_env() {
  node --input-type=module -e '
    const m = await import(process.argv[1]);
    m.loadEnv();
    process.stdout.write(process.env[process.argv[2]] ?? "");
  ' "file://$CLI" "$1"
}

cli() { node "$CLI" "$@"; }

page_url() { echo "$ENDPOINT/p/$1"; }

publish() { # publish <slug> <file> [extra flags...]
  local slug="$1" file="$2"; shift 2
  # Track before uploading so even a half-failed create gets cleaned up.
  echo "$slug" >> "$CREATED_SLUGS"
  cli "$file" "$slug" --no-cp "$@"
}

# GET a page and assert 200; body and headers land in the per-test tmpdir.
fetch_page() {
  local code
  code="$(curl -s --max-time 30 -D "$BATS_TEST_TMPDIR/headers" \
    -o "$BATS_TEST_TMPDIR/body" -w '%{http_code}' "$(page_url "$1")")"
  [ "$code" = "200" ]
}

# Print a response header (case-insensitive) from the last fetch_page.
header() {
  grep -i "^$1:" "$BATS_TEST_TMPDIR/headers" | head -n 1 \
    | sed 's/^[^:]*: *//' | tr -d '\r'
}

status_only() { curl -s --max-time 30 -o /dev/null -w '%{http_code}' "$@"; }

# --- the suite ------------------------------------------------------------

@test "landing page is served at /" {
  run status_only "$ENDPOINT/"
  [ "$output" = "200" ]
}

@test "create: publishes a page and serves the exact bytes back" {
  local slug="${PREFIX}-create"
  run publish "$slug" "$PAGE_V1"
  [ "$status" -eq 0 ]
  [[ "$output" == *"/p/$slug"* ]]

  fetch_page "$slug"
  cmp "$BATS_TEST_TMPDIR/body" "$PAGE_V1"
}

@test "create: same slug twice is rejected with 409" {
  local slug="${PREFIX}-conflict"
  publish "$slug" "$PAGE_V1"

  run --separate-stderr publish "$slug" "$PAGE_V1"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"409"* ]]
}

@test "update: overwrites an existing page" {
  local slug="${PREFIX}-update"
  publish "$slug" "$PAGE_V1"

  cli update "$slug" "$PAGE_V2" --no-cp
  fetch_page "$slug"
  cmp "$BATS_TEST_TMPDIR/body" "$PAGE_V2"
}

@test "update: nonexistent slug is rejected with 404" {
  run --separate-stderr cli update "${PREFIX}-never-created" "$PAGE_V1" --no-cp
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"404"* ]]
}

@test "list: shows published slugs, drops removed ones" {
  local slug="${PREFIX}-list"
  publish "$slug" "$PAGE_V1"

  run cli list
  [ "$status" -eq 0 ]
  [[ "$output" == *"$slug"* ]]

  cli remove "$slug"
  run cli list
  [ "$status" -eq 0 ]
  [[ "$output" != *"$slug"* ]]
}

@test "trust: --trust drops the sandbox; an update without it demotes" {
  local slug="${PREFIX}-trust"
  publish "$slug" "$PAGE_V1" --trust

  fetch_page "$slug"
  # The sandbox CSP directive is --trust's entire user-visible effect:
  # absent on a trusted page, present on a sandboxed one.
  [[ "$(header Content-Security-Policy)" != *"sandbox"* ]]

  # Trust is per-upload, not sticky: update without --trust re-sandboxes.
  cli update "$slug" "$PAGE_V1" --no-cp
  fetch_page "$slug"
  [[ "$(header Content-Security-Policy)" == *"sandbox"* ]]
}

@test "read: unknown slug is a 404" {
  run status_only "$(page_url "${PREFIX}-no-such-page")"
  [ "$output" = "404" ]
}

@test "remove: deletes a page; the URL goes 404" {
  local slug="${PREFIX}-remove"
  publish "$slug" "$PAGE_V1"

  cli remove "$slug"
  run status_only "$(page_url "$slug")"
  [ "$output" = "404" ]
}

@test "remove: handles several slugs in one invocation" {
  local a="${PREFIX}-multi-a" b="${PREFIX}-multi-b"
  publish "$a" "$PAGE_V1"
  publish "$b" "$PAGE_V1"

  cli remove "$a" "$b"
  run status_only "$(page_url "$a")"
  [ "$output" = "404" ]
  run status_only "$(page_url "$b")"
  [ "$output" = "404" ]
}

@test "remove: mixed batch removes what exists and reports what doesn't" {
  local real="${PREFIX}-mixed-real" ghost="${PREFIX}-mixed-ghost"
  publish "$real" "$PAGE_V1"

  run --separate-stderr cli remove "$ghost" "$real"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"$ghost"* ]]
  run status_only "$(page_url "$real")"
  [ "$output" = "404" ]
}

@test "open: launches the page URL via the platform opener" {
  local slug="${PREFIX}-open"

  run cli open "$slug"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$(page_url "$slug")"* ]]

  # The opener is spawned detached; give the stub a moment to write.
  for _ in {1..20}; do
    [ -s "$OPEN_STUB_LOG" ] && break
    sleep 0.1
  done
  grep -q "$(page_url "$slug")" "$OPEN_STUB_LOG"
}

@test "auth: a wrong token is rejected and creates nothing" {
  local slug="${PREFIX}-auth"

  WWWSHARE_UPLOAD_TOKEN="wrong-token-for-e2e" \
    run --separate-stderr publish "$slug" "$PAGE_V1"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"401"* ]]
  # The rejected upload must not have created the page.
  run status_only "$(page_url "$slug")"
  [ "$output" = "404" ]
}

@test "auth: write endpoints refuse unauthenticated requests outright" {
  # Straight curl, no token at all — validates the deployed worker's auth
  # config, independent of the CLI.
  run status_only -X POST "$ENDPOINT/upload"
  [ "$output" = "401" ]
  run status_only "$ENDPOINT/list"
  [ "$output" = "401" ]
  run status_only -X DELETE "$(page_url "${PREFIX}-unauth")"
  [ "$output" = "401" ]
}

@test "routing: wrong methods get 405, malformed page paths get 404" {
  run status_only -X PUT "$ENDPOINT/upload"
  [ "$output" = "405" ]
  run status_only -X POST "$ENDPOINT/list"
  [ "$output" = "405" ]
  # Uppercase violates the slug shape, so it misses the /p/ route entirely.
  run status_only "$ENDPOINT/p/Not-A-Valid-Slug"
  [ "$output" = "404" ]
}
