#!/usr/bin/env bash
# Rebuild Comonad and install the resulting VSIX into VS Code.
#
# Usage:
#   ./scripts/reinstall.sh              build, package and install
#   ./scripts/reinstall.sh --build-only build and package, but do not install
#
# Environment:
#   CODE_CMD=code-insiders   the VS Code CLI to install into (default: auto-detect
#                            code, code-insiders or cursor)
#   VSCE_VERSION=4.0.0       the @vscode/vsce version used to package

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
	cat <<'EOF'
Rebuild Comonad and install the resulting VSIX.

Usage: scripts/reinstall.sh [--build-only]

  --build-only   build and package, but do not install
  -h, --help     show this help

Environment:
  CODE_CMD       VS Code CLI (default: code, code-insiders or cursor)
  VSCE_VERSION   @vscode/vsce version (default: 4.0.0)
EOF
}

BUILD_ONLY=0
for arg in "$@"; do
	case "$arg" in
		--build-only) BUILD_ONLY=1 ;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "Unknown argument: $arg" >&2
			usage >&2
			exit 2
			;;
	esac
done

command -v node >/dev/null 2>&1 || {
	echo "node is required (Node 22 or newer)." >&2
	exit 1
}
command -v npm >/dev/null 2>&1 || {
	echo "npm is required." >&2
	exit 1
}

if [ ! -d node_modules ]; then
	echo "→ Installing dependencies"
	npm ci
fi

VERSION="$(node -p "require('./package.json').version")"
VSIX="$ROOT/comonad-$VERSION.vsix"
VSCE_VERSION="${VSCE_VERSION:-4.0.0}"

echo "→ Building and packaging Comonad $VERSION"
echo "  (vsce runs vscode:prepublish — typecheck, lint and the production bundle)"
rm -f "$VSIX"
npx --yes "@vscode/vsce@$VSCE_VERSION" package --out "$VSIX"

if [ ! -f "$VSIX" ]; then
	echo "Packaging failed: $VSIX was not created." >&2
	exit 1
fi

if [ "$BUILD_ONLY" = 1 ]; then
	echo "→ Built $VSIX (not installed)"
	exit 0
fi

if [ -n "${CODE_CMD:-}" ]; then
	CODE="$CODE_CMD"
else
	CODE=""
	for candidate in code code-insiders cursor; do
		if command -v "$candidate" >/dev/null 2>&1; then
			CODE="$candidate"
			break
		fi
	done
fi

if [ -z "$CODE" ]; then
	echo "No VS Code CLI found. Set CODE_CMD=code (or code-insiders, cursor)." >&2
	exit 1
fi

echo "→ Installing into $CODE"
"$CODE" --install-extension "$VSIX" --force

echo "→ Installed:"
"$CODE" --list-extensions --show-versions | grep -i '^comonad\.' || true

echo
echo "Reload VS Code (Developer: Reload Window) to load the new build."
