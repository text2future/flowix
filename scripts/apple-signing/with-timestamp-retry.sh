#!/usr/bin/env bash
# scripts/apple-signing/with-timestamp-retry.sh
#
# Wrap a command in a retry loop that survives Apple RFC 3161 timestamp
# service transient failures ("A timestamp was expected but was not found" /
# "The timestamp service is not available"). Apple's timestamp endpoints
# (timestamp.apple.com / ts01) are intermittently unreachable; per memory
# `flowix-release-build-detached-timestamp-retry`, retrying with backoff is
# the supported workaround.
#
# Only retries when the wrapped command's exit code + stderr matches one of
# the known timestamp failure signatures. Any other failure aborts
# immediately — we never silently swallow real errors.
#
# Usage:
#   bash scripts/apple-signing/with-timestamp-retry.sh -- <cmd ...>
#
# Env vars:
#   TIMESTAMP_RETRY_MAX       max attempts (default 8)
#   TIMESTAMP_RETRY_BACKOFF   initial backoff seconds, doubles each retry
#                             (default 15)

set -euo pipefail

MAX_ATTEMPTS="${TIMESTAMP_RETRY_MAX:-8}"
INITIAL_BACKOFF="${TIMESTAMP_RETRY_BACKOFF:-15}"

if [ $# -lt 2 ] || [ "$1" != "--" ]; then
  echo "Usage: $0 -- <cmd ...>" >&2
  exit 2
fi
shift

TIMESTAMP_FAILURE_PATTERN='timestamp was expected but was not found|timestamp service is not available|TIMESTAMP_FAILURE_PATTERN_PLACEHOLDER'

attempt=1
backoff="$INITIAL_BACKOFF"
log_file="$(mktemp -t with-timestamp-retry.XXXXXX.log)"
trap 'rm -f "$log_file"' EXIT

while (( attempt <= MAX_ATTEMPTS )); do
  echo "==> attempt $attempt/$MAX_ATTEMPTS: $*"
  if "$@" 2>"$log_file"; then
    exit 0
  else
    rc=$?
  fi

  if (( attempt == MAX_ATTEMPTS )); then
    echo "==> failed after $MAX_ATTEMPTS attempts (last exit=$rc); giving up" >&2
    echo "--- last stderr ---" >&2
    cat "$log_file" >&2
    exit "$rc"
  fi

  if grep -Eiq "$TIMESTAMP_FAILURE_PATTERN" "$log_file"; then
    echo "==> attempt $attempt failed with Apple timestamp service error; sleeping ${backoff}s and retrying" >&2
    echo "--- stderr (truncated) ---" >&2
    tail -20 "$log_file" >&2
    sleep "$backoff"
    backoff=$((backoff * 2))
    if (( backoff > 300 )); then backoff=300; fi
    attempt=$((attempt + 1))
    continue
  fi

  echo "==> attempt $attempt failed with non-retryable error (exit=$rc); aborting" >&2
  cat "$log_file" >&2
  exit "$rc"
done
