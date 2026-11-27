#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sdk="$root/vendor/meta-mesh"
. "$sdk/formal/tla-tools-pin.env"
work=$(mktemp -d "${TMPDIR:-/tmp}/tincanban-sdk-core.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
jar=${META_MESH_TLC_JAR:-"$work/tla2tools.jar"}
java=${JAVA_HOME:+"$JAVA_HOME/bin/"}java

if [ -z "${META_MESH_TLC_JAR:-}" ]; then
  curl -fL --retry 3 -H 'Accept: application/octet-stream' -H 'X-GitHub-Api-Version: 2022-11-28' \
    -o "$jar" "$TOOLS_ASSET_URL"
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$jar" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$jar" | awk '{print $1}')
fi
if [ "$actual" != "$TOOLS_SHA256" ]; then
  printf 'SDK TLC checksum mismatch: expected %s, got %s\n' "$TOOLS_SHA256" "$actual" >&2
  exit 1
fi

for model in SessionImplementationStates DeliveryImplementationStates; do
  "$java" -Xmx1g -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
    -cleanup -deadlock -noGenerateSpecTE -metadir "$work/$model-state" -workers 2 \
    -dump dot,actionlabels "$work/$model.dot" \
    -config "$sdk/formal/$model.cfg" "$sdk/formal/$model.tla"
  python3 "$sdk/formal/export_graph.py" "$work/$model.dot" "$work/$model.json"
done

# These tests require fresh model graphs. --include-ignored also runs the large
# signed-history regression; an ordinary library run alone is incomplete.
MESH_TLC_SESSION_IMPLEMENTATION_GRAPH="$work/SessionImplementationStates.json" \
MESH_TLC_DELIVERY_IMPLEMENTATION_GRAPH="$work/DeliveryImplementationStates.json" \
  cargo test --locked --release --manifest-path "$sdk/Cargo.toml" -p meta-mesh-core --lib -- --include-ignored --nocapture
