#!/usr/bin/env bash
# Runs the whole toolchain in one container: AWS Emulator, Node.js and the test
# browser. The host needs only `make` and a container runtime, not Node.js.
#
#   scripts/dev-container.sh build | up | down | status | logs | exec <command...>
#
# The emulator's TLS certificate is only valid for localhost, so the tools run
# in the same container as the emulator instead of a second one. The
# repository is mounted at /work; node_modules, dist and the test browser are
# written there (as Linux builds).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${DEV_IMAGE:-vendor-tracker-dev}"
NAME="${DEV_CONTAINER_NAME:-vendor-tracker-dev}"
SERVE_PORT="${SERVE_PORT:-8080}"
CHANNEL="${EMULATOR_CHANNEL:-LTS/latest}"

have() { command -v "$1" >/dev/null 2>&1; }
die() { echo "dev-container: $*" >&2; exit 1; }

if [ -n "${DEV_RUNTIME:-}" ]; then RUNTIME="$DEV_RUNTIME"
elif [ "$(uname -s)" = "Darwin" ] && have container; then RUNTIME=container
elif have docker; then RUNTIME=docker
elif have podman; then RUNTIME=podman
else die "no container runtime found (Apple container, Docker or Podman)"; fi

arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo x86_64 ;;
    arm64 | aarch64) echo aarch64 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac
}

start_runtime() {
  if [ "$RUNTIME" = container ]; then container system status >/dev/null 2>&1 || container system start; fi
}

in_container() { "$RUNTIME" exec "$NAME" "$@"; }
healthy() { in_container scripts/emulator.sh status >/dev/null 2>&1; }

build() {
  start_runtime
  "$RUNTIME" build --tag "$IMAGE" --file "${ROOT}/Containerfile" --target dev \
    --build-arg "EMULATOR_ARCH=$(arch)" --build-arg "EMULATOR_CHANNEL=${CHANNEL}" "$ROOT"
}

up() {
  start_runtime
  if healthy; then return; fi
  "$RUNTIME" image inspect "$IMAGE" >/dev/null 2>&1 || build
  "$RUNTIME" rm -f "$NAME" >/dev/null 2>&1 || true   # a stopped leftover
  # On Linux, write files in the mounted repository as the invoking user.
  local user=(); [ "$(uname -s)" = "Linux" ] && user=(--user "$(id -u):$(id -g)")
  "$RUNTIME" run -d --rm --name "$NAME" -m 4g \
    -p "127.0.0.1:${SERVE_PORT}:8080" \
    -v "${ROOT}:/work" -w /work "${user[@]}" \
    -e "EMULATOR_TELEMETRY=${EMULATOR_TELEMETRY:-off}" \
    -e "DEV_CONTAINER_RUNTIME=${RUNTIME}" -e GATEWAY_BIND=0.0.0.0 \
    "$IMAGE" >/dev/null
  for _ in $(seq 60); do
    if healthy; then echo "Dev container is up (${RUNTIME}): AWS Emulator and Node.js $(in_container node -v)" >&2; return; fi
    sleep 1
  done
  { "$RUNTIME" logs "$NAME"; cat "${ROOT}/.emulator/emulator.log"; } 2>&1 | tail -n 40 >&2 || true
  die "the dev container did not become healthy within 60 seconds"
}

case "${1:-}" in
  build) build ;;
  up) up ;;
  down) "$RUNTIME" stop "$NAME" >/dev/null 2>&1 || true; echo "Dev container stopped" ;;
  status) if healthy; then echo "running (${RUNTIME})"; else echo "not running"; exit 1; fi ;;
  logs) cat "${ROOT}/.emulator/emulator.log" ;;
  exec)
    shift; [ $# -gt 0 ] || die "usage: dev-container.sh exec <command...>"
    up
    flags=(-i); [ -t 0 ] && [ -t 1 ] && flags+=(-t)
    exec "$RUNTIME" exec "${flags[@]}" "$NAME" "$@" ;;
  *) die "usage: dev-container.sh build|up|down|status|logs|exec <command...>" ;;
esac
