#!/usr/bin/env bash
#
# Phase 11D — hourly worker watchdog for Domain-Monitor expiration reminders.
#
# Design:
#   - Runs `pnpm worker --limit 50` (one tick) then sleeps 3600s, forever.
#   - A failed tick MUST NOT kill the loop: the worker exit code is logged
#     and the loop continues with the next hour. There is deliberately NO
#     `set -e` around the worker invocation.
#   - Single-instance guard via flock(1) — two watchdogs cannot run
#     concurrently, so two worker ticks can never overlap.
#   - The worker itself is a single synchronous tick; this script never
#     starts a second tick while one is in flight (sleep only after exit).
#   - SIGTERM/SIGINT cause a clean loop exit (no pkill anywhere).
#   - stdout/stderr are the worker's JSON summary + watchdog markers; the
#     worker never prints secrets (verified by leakage audit).
#
# Usage:  scripts/worker-watchdog.sh        (foreground)
#         nohup scripts/worker-watchdog.sh & (background)

set -u

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="${APP_DIR}/.worker-watchdog.lock"
LOG_FILE="${APP_DIR}/worker.log"

# Single-instance guard: if another watchdog holds the lock, exit quietly.
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "[watchdog] another instance holds ${LOCK_FILE}; exiting" >> "${LOG_FILE}"
  exit 0
fi

trap 'echo "[watchdog] shutdown at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${LOG_FILE}"; exit 0' TERM INT

cd "${APP_DIR}" || exit 1

echo "[watchdog] start at $(date -u +%Y-%m-%dT%H:%M:%SZ) pid=$$" >> "${LOG_FILE}"

while true; do
  echo "[watchdog] tick start $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${LOG_FILE}"
  # Deliberately not `set -e`: a non-zero worker exit is logged, not fatal.
  # Invoke tsx directly (NOT `pnpm worker`): the watchdog must not depend on
  # pnpm being on PATH in the nohup environment.
  if ./node_modules/.bin/tsx --conditions=react-server scripts/worker.ts --limit 50 >> "${LOG_FILE}" 2>&1; then
    echo "[watchdog] tick ok exit=0" >> "${LOG_FILE}"
  else
    rc=$?
    echo "[watchdog] tick failed exit=${rc}" >> "${LOG_FILE}"
  fi
  echo "[watchdog] tick end $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${LOG_FILE}"
  sleep 3600
done
