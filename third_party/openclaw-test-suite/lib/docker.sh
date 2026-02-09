#!/usr/bin/env bash
# openclaw-test-suite: docker.sh — Docker helpers for isolated testing
[ -n "${_OCT_DOCKER_LOADED:-}" ] && return 0
_OCT_DOCKER_LOADED=1

source "${OCT_LIB_DIR}/core.sh"

docker_build() {
  local image="$1"
  local dockerfile="$2"
  local context="$3"
  echo "  Building test image: $image"
  docker build -t "$image" -f "$dockerfile" "$context"
}

docker_run() {
  local image="$1"
  shift
  local args=(--rm)

  [ -n "${OCT_GATEWAY_TOKEN:-}" ] && args+=(-e "OCT_GATEWAY_TOKEN=${OCT_GATEWAY_TOKEN}")
  [ -n "${OCT_PLUGIN_ID:-}" ] && args+=(-e "OCT_PLUGIN_ID=${OCT_PLUGIN_ID}")
  [ -n "${OCT_OUTPUT_FORMAT:-}" ] && args+=(-e "OCT_OUTPUT_FORMAT=${OCT_OUTPUT_FORMAT}")

  docker run "${args[@]}" "$@" "$image"
}

docker_generate_dockerfile() {
  local template="$1"
  local output="$2"
  shift 2
  local content
  content=$(cat "$template")
  for var in "$@"; do
    local key="${var%%=*}"
    local val="${var#*=}"
    content="${content//\{\{${key}\}\}/${val}}"
  done
  echo "$content" > "$output"
}

