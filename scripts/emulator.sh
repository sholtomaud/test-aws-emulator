#!/usr/bin/env bash
# Builds, starts and stops AWS Emulator, and runs commands pointed at it.
#
#   scripts/emulator.sh runtime | version | build | up | down | status | logs | run <command...>
#
# Where the emulator runs (override with EMULATOR_RUNTIME):
#   container  macOS with Apple's `container` CLI
#   docker     GitHub Actions, and any other machine with a Docker daemon
#   podman     Linux with Podman and no Docker
#   native     the Linux package, run as a process (Claude Code cloud sessions,
#              or any Linux with `aws-emulator` installed)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${EMULATOR_PORT:-9297}"
TELEMETRY="${EMULATOR_TELEMETRY:-off}"
CHANNEL="${EMULATOR_CHANNEL:-LTS/latest}"
IMAGE="${EMULATOR_IMAGE:-aws-emulator}"
NAME="aws-emulator-${PORT}"
STATE="${ROOT}/.emulator"
FILES="${HOME}/.aws/emulator/${PORT}"       # written by the emulator on start
ENDPOINT="https://127.0.0.1:${PORT}"
DOWNLOADS="https://downloads.aws.com/aws-emulator/packages/aws-emulator/${CHANNEL}"

have() { command -v "$1" >/dev/null 2>&1; }
die() { echo "emulator: $*" >&2; exit 1; }

detect_runtime() {
  if [ -n "${EMULATOR_RUNTIME:-}" ]; then echo "$EMULATOR_RUNTIME"; return; fi
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo docker; return; fi
  if [ "$(uname -s)" = "Darwin" ]; then
    if have container; then echo container; elif have docker; then echo docker
    else die "install Apple's container CLI (https://github.com/apple/container) or Docker"; fi
    return
  fi
  # Claude Code cloud sessions: the Linux package needs no image pull or daemon.
  if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then echo native; return; fi
  if have docker && docker info >/dev/null 2>&1; then echo docker
  elif have podman; then echo podman
  else echo native; fi
}
RUNTIME="$(detect_runtime)"

arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo x86_64 ;;
    arm64 | aarch64) echo aarch64 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac
}

as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

install_native() {
  have aws-emulator && return
  [ "$(uname -s)" = "Linux" ] || die "the native package is Linux-only; use a container runtime"
  local tmp; tmp="$(mktemp -d)"
  if have apt-get; then
    local deb_arch=amd64; [ "$(arch)" = aarch64 ] && deb_arch=arm64
    curl -fsSLo "${tmp}/aws-emulator.deb" "${DOWNLOADS}/aws-emulator_${deb_arch}.deb"
    as_root apt-get install -y "${tmp}/aws-emulator.deb"
  elif have dnf || have yum; then
    as_root "$(have dnf && echo dnf || echo yum)" install -y "${DOWNLOADS}/aws-emulator-$(arch).rpm"
  else
    die "no apt-get, dnf or yum to install the AWS Emulator package"
  fi
  rm -rf "$tmp"
}

build() {
  case "$RUNTIME" in
    native) install_native; aws-emulator -v ;;
    container)
      container system status >/dev/null 2>&1 || container system start
      container build --tag "$IMAGE" --file "${ROOT}/Containerfile" --target emulator \
        --build-arg "EMULATOR_ARCH=$(arch)" --build-arg "EMULATOR_CHANNEL=${CHANNEL}" "$ROOT" ;;
    docker | podman)
      "$RUNTIME" build --tag "$IMAGE" --file "${ROOT}/Containerfile" --target emulator \
        --build-arg "EMULATOR_ARCH=$(arch)" --build-arg "EMULATOR_CHANNEL=${CHANNEL}" "$ROOT" ;;
    *) die "unknown EMULATOR_RUNTIME: $RUNTIME" ;;
  esac
}

healthy() {
  [ -f "${FILES}/ca.pem" ] && curl -sf --max-time 2 --cacert "${FILES}/ca.pem" "${ENDPOINT}/__admin/health" >/dev/null 2>&1
}

up() {
  if healthy; then echo "AWS Emulator is already running at ${ENDPOINT}"; return; fi
  mkdir -p "$STATE" "${HOME}/.aws/emulator"   # the directory shared with the container
  # The container sees the same $HOME path as the host, so the paths the
  # emulator writes into its config are valid on both sides. The port is
  # published on loopback only.
  local args=(-p "$PORT" -t "$TELEMETRY")
  case "$RUNTIME" in
    native)
      have aws-emulator || die "aws-emulator is not installed; run \`make emulator-build\`"
      nohup aws-emulator "${args[@]}" >"${STATE}/emulator.log" 2>&1 &
      echo $! >"${STATE}/emulator.pid" ;;
    container)
      container system status >/dev/null 2>&1 || container system start
      container run --detach --rm --name "$NAME" --memory 2g \
        --publish "127.0.0.1:${PORT}:${PORT}" \
        --env "HOME=${HOME}" --volume "${HOME}/.aws/emulator:${HOME}/.aws/emulator" \
        "$IMAGE" "${args[@]}" >/dev/null ;;
    docker | podman)
      local user=(); [ "$(uname -s)" = "Linux" ] && user=(--user "$(id -u):$(id -g)")
      "$RUNTIME" run --detach --rm --name "$NAME" --memory=2g --memory-swap=2g \
        --publish "127.0.0.1:${PORT}:${PORT}" ${user[@]+"${user[@]}"} \
        --env "HOME=${HOME}" --volume "${HOME}/.aws/emulator:${HOME}/.aws/emulator" \
        "$IMAGE" "${args[@]}" >/dev/null ;;
    *) die "unknown EMULATOR_RUNTIME: $RUNTIME" ;;
  esac
  for _ in $(seq 60); do
    if healthy; then echo "AWS Emulator is running at ${ENDPOINT} (${RUNTIME})"; return; fi
    sleep 1
  done
  logs | tail -n 40 >&2 || true
  die "AWS Emulator did not become healthy within 60 seconds"
}

down() {
  case "$RUNTIME" in
    native)
      if [ -f "${STATE}/emulator.pid" ]; then
        kill "$(cat "${STATE}/emulator.pid")" 2>/dev/null || true   # SIGTERM: clean stop
        rm -f "${STATE}/emulator.pid"
      fi ;;
    container | docker | podman) "$RUNTIME" stop "$NAME" >/dev/null 2>&1 || true ;;
  esac
  rm -f "${STATE}/ca-bundle.pem"
  echo "AWS Emulator stopped"
}

version() {
  case "$RUNTIME" in
    native) aws-emulator -v ;;
    container | docker | podman) "$RUNTIME" run --rm "$IMAGE" -v ;;
  esac
}

logs() {
  case "$RUNTIME" in
    native) cat "${STATE}/emulator.log" ;;
    container | docker | podman) "$RUNTIME" logs "$NAME" ;;
  esac
}

# Runs a command with the AWS SDKs, the AWS CLI and the CDK pointed at the emulator.
run() {
  healthy || die "AWS Emulator is not running at ${ENDPOINT}; run \`make emulator-up\`"
  # Node.js trusts NODE_EXTRA_CA_CERTS in addition to its defaults. Keep any
  # certificates already configured there (e.g. a corporate proxy's).
  mkdir -p "$STATE"
  cat "${FILES}/ca.pem" >"${STATE}/ca-bundle.pem"
  if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$NODE_EXTRA_CA_CERTS" ] &&
    [ "$NODE_EXTRA_CA_CERTS" != "${STATE}/ca-bundle.pem" ]; then
    cat "$NODE_EXTRA_CA_CERTS" >>"${STATE}/ca-bundle.pem"
  fi
  # Never let real credentials reach the emulator, or emulator runs reach AWS.
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
  export AWS_ENDPOINT_URL="$ENDPOINT"
  export AWS_SHARED_CREDENTIALS_FILE="${FILES}/emulator_credentials"
  export AWS_CONFIG_FILE="${FILES}/config"
  export AWS_CA_BUNDLE="${FILES}/ca.pem"
  export NODE_EXTRA_CA_CERTS="${STATE}/ca-bundle.pem"
  export AWS_EC2_METADATA_DISABLED=true
  export AWS_DISABLE_HOST_PREFIX_INJECTION=true
  export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
  exec "$@"
}

case "${1:-}" in
  runtime) echo "$RUNTIME" ;;
  version) version ;;
  build) build ;;
  up) up ;;
  down) down ;;
  status) if healthy; then echo "running at ${ENDPOINT} (${RUNTIME})"; else echo "not running"; exit 1; fi ;;
  logs) logs ;;
  run) shift; [ $# -gt 0 ] || die "usage: emulator.sh run <command...>"; run "$@" ;;
  *) die "usage: emulator.sh runtime|version|build|up|down|status|logs|run <command...>" ;;
esac
