#!/usr/bin/env bash
# Build MuchuBridge — no Gradle/Maven. Downloads compile-time jars into lib/,
# compiles with the highest sdkman JDK (--release 21, the running Paper is Java 25),
# and writes server/plugins/MuchuBridge.jar.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
LIB="$DIR/lib"
BUILD="$DIR/build"
OUT="$ROOT/server/plugins/MuchuBridge.jar"

mkdir -p "$LIB" "$ROOT/server/plugins"
rm -rf "$BUILD"
mkdir -p "$BUILD/classes"

# --- toolchain: highest sdkman JDK, fall back to PATH ---
SDK_JAVA_DIR="$HOME/.sdkman/candidates/java"
JDK=""
if [ -d "$SDK_JAVA_DIR" ]; then
  JDK="$(find "$SDK_JAVA_DIR" -mindepth 1 -maxdepth 1 -type d ! -name current | sort -V | tail -1)"
fi
if [ -n "$JDK" ] && [ -x "$JDK/bin/javac" ]; then
  JAVAC="$JDK/bin/javac"; JAR="$JDK/bin/jar"
else
  JAVAC="$(command -v javac)"; JAR="$(command -v jar)"
fi
echo "[bridge-build] javac: $JAVAC ($("$JAVAC" --version))"

fetch() { # fetch <url> <dest>
  echo "[bridge-build] fetching $1"
  curl -fsSL --retry 3 --retry-delay 2 -o "$2.tmp" "$1" && mv "$2.tmp" "$2"
}

# --- paper-api 1.21.11 (snapshot resolved via maven-metadata.xml) ---
PAPER_REPO="https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api"
PAPER_VER="1.21.11-R0.1-SNAPSHOT"
PAPER_JAR="$LIB/paper-api-1.21.11.jar"
if [ ! -s "$PAPER_JAR" ]; then
  meta="$(curl -fsSL "$PAPER_REPO/$PAPER_VER/maven-metadata.xml")"
  ts="$(grep -oE '<timestamp>[^<]+' <<<"$meta" | head -1 | cut -d'>' -f2)"
  bn="$(grep -oE '<buildNumber>[^<]+' <<<"$meta" | head -1 | cut -d'>' -f2)"
  [ -n "$ts" ] && [ -n "$bn" ] || { echo "[bridge-build] could not resolve paper-api snapshot from maven-metadata.xml" >&2; exit 1; }
  fetch "$PAPER_REPO/$PAPER_VER/paper-api-${PAPER_VER%-SNAPSHOT}-$ts-$bn.jar" "$PAPER_JAR"
fi

# --- VaultAPI 1.7 (jitpack; fall back to the installed Vault.jar, which bundles the API) ---
VAULT_JAR="$LIB/VaultAPI-1.7.jar"
if [ ! -s "$VAULT_JAR" ]; then
  fetch "https://jitpack.io/com/github/MilkBowl/VaultAPI/1.7/VaultAPI-1.7.jar" "$VAULT_JAR" || {
    echo "[bridge-build] jitpack failed — using server/plugins/Vault.jar for the API classes"
    cp "$ROOT/server/plugins/Vault.jar" "$VAULT_JAR"
  }
fi
# --- paper-api transitive compile-time deps (annotations/adventure supertypes) ---
CENTRAL="https://repo1.maven.org/maven2"
TRANSITIVE=(
  "net/kyori/adventure-api/4.26.1/adventure-api-4.26.1.jar"
  "net/kyori/adventure-key/4.26.1/adventure-key-4.26.1.jar"
  "net/kyori/examination-api/1.3.0/examination-api-1.3.0.jar"
  "org/jetbrains/annotations/26.0.2/annotations-26.0.2.jar"
  "org/jspecify/jspecify/1.0.0/jspecify-1.0.0.jar"
)
CP="$PAPER_JAR:$VAULT_JAR"
for path in "${TRANSITIVE[@]}"; do
  dest="$LIB/$(basename "$path")"
  [ -s "$dest" ] || fetch "$CENTRAL/$path" "$dest"
  CP="$CP:$dest"
done

# sanity: the jars must contain the classes we compile against
"$JAR" --list --file "$PAPER_JAR" | grep -q '^org/bukkit/plugin/java/JavaPlugin.class$'
"$JAR" --list --file "$VAULT_JAR" | grep -q '^net/milkbowl/vault/economy/Economy.class$'

# --- compile + jar ---
find "$DIR/src" -name '*.java' > "$BUILD/sources.txt"
"$JAVAC" --release 21 -encoding UTF-8 -Xlint:deprecation \
  -classpath "$CP" -d "$BUILD/classes" @"$BUILD/sources.txt"
cp "$DIR/resources/plugin.yml" "$DIR/resources/config.yml" "$BUILD/classes/"
"$JAR" --create --file "$OUT" -C "$BUILD/classes" .
echo "[bridge-build] wrote $OUT"
"$JAR" --list --file "$OUT" | sed 's/^/[bridge-build]   /'
