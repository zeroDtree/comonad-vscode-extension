#!/usr/bin/env bash
# Automate a Comonad release: bump version, update CHANGELOG, build, commit,
# tag, push, and optionally watch the GitHub Actions publish workflow.
#
# Run `scripts/auto_publish.sh --help` for options.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH="main"
TARGET=""
NOTES=""
ASSUME_YES=0
DRY_RUN=0
NO_PUSH=0
SKIP_CHECKS=0
NO_CHANGELOG=0
NO_WATCH=0

usage() {
	cat <<'EOF'
Automate a Comonad release.

Usage:
  scripts/auto_publish.sh <patch|minor|major|x.y.z> [options]

What it does:
  1. checks the branch is clean and up to date with origin
  2. bumps package.json and package-lock.json
  3. prepends a CHANGELOG.md section
  4. runs the production build (typecheck + lint + esbuild)
  5. commits "release: x.y.z", tags vx.y.z, pushes main and the tag
  6. the tag push triggers .github/workflows/publish.yml

Options:
  -y, --yes          do not ask for confirmation
      --dry-run      print the plan and exit; change nothing
      --no-push      commit and tag locally only
      --skip-checks  skip the production build before committing
      --notes TEXT   changelog bullets (default: commit subjects since the last tag)
      --no-changelog do not edit CHANGELOG.md
      --branch NAME  branch to release from (default: main)
      --no-watch     push but do not wait for the Actions run
  -h, --help         show this help

Examples:
  scripts/auto_publish.sh patch --dry-run
  scripts/auto_publish.sh minor --notes "Add the new tool; fix the parser" --yes
  scripts/auto_publish.sh 0.3.0 --no-watch

Requires git, node and npm. gh is optional; without it the script prints the
Actions URL instead of watching the run. The publish workflow runs the test suite.
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '\n→ %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
	case "$1" in
		-y | --yes) ASSUME_YES=1 ;;
		--dry-run) DRY_RUN=1 ;;
		--no-push) NO_PUSH=1 ;;
		--skip-checks) SKIP_CHECKS=1 ;;
		--no-changelog) NO_CHANGELOG=1 ;;
		--no-watch) NO_WATCH=1 ;;
		--notes)
			[ $# -ge 2 ] || die "--notes needs a value"
			NOTES="$2"
			shift
			;;
		--branch)
			[ $# -ge 2 ] || die "--branch needs a value"
			BRANCH="$2"
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		-*)
			die "unknown option: $1"
			;;
		*)
			[ -z "$TARGET" ] || die "unexpected argument: $1"
			TARGET="$1"
			;;
	esac
	shift
done

[ -n "$TARGET" ] || {
	usage >&2
	exit 2
}

for cmd in git node npm; do
	command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required"
done

info "Checking repository"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository"
CURRENT_BRANCH="$(git branch --show-current)"
[ "$CURRENT_BRANCH" = "$BRANCH" ] || die "must be on $BRANCH (current: $CURRENT_BRANCH)"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean; commit or stash first"

git fetch --quiet origin "$BRANCH" --tags || die "git fetch origin $BRANCH failed"
git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1 || die "origin/$BRANCH not found"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] || \
	die "local $BRANCH is not up to date with origin/$BRANCH; pull/push first"

OLD_VERSION="$(node -p "require('./package.json').version")"
case "$TARGET" in
	patch | minor | major)
		NEW_VERSION="$(node -e '
			const [kind, current] = process.argv.slice(1);
			const [major, minor, patch] = current.split(".").map(Number);
			if (kind === "patch") console.log(`${major}.${minor}.${patch + 1}`);
			else if (kind === "minor") console.log(`${major}.${minor + 1}.0`);
			else console.log(`${major + 1}.0.0`);
		' "$TARGET" "$OLD_VERSION")"
		;;
	*)
		NEW_VERSION="${TARGET#v}"
		node -e 'if (/^\d+\.\d+\.\d+$/.test(process.argv[1]) === false) process.exit(1)' "$NEW_VERSION" || \
			die "version must be patch, minor, major or x.y.z"
		;;
esac

version_gt() {
	node -e '
		const [a, b] = process.argv.slice(1).map(v => v.split(".").map(Number));
		const gt = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
		process.exit(gt ? 0 : 1);
	' "$1" "$2"
}

version_gt "$NEW_VERSION" "$OLD_VERSION" || die "$NEW_VERSION must be greater than $OLD_VERSION"

TAG="v$NEW_VERSION"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
	die "tag $TAG already exists"
fi
REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/$TAG")"
[ -z "$REMOTE_TAG" ] || die "tag $TAG already exists on origin"

PUBLISHER="$(node -p "require('./package.json').publisher")"
EXTENSION="$(node -p "require('./package.json').name")"
MARKETPLACE_LATEST=""
if command -v curl >/dev/null 2>&1; then
	MARKETPLACE_LATEST="$(
		curl -fsS --max-time 15 -X POST 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' \
			-H 'Accept: application/json;api-version=7.2-preview.1' \
			-H 'Content-Type: application/json' \
			--data "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"$PUBLISHER.$EXTENSION\"}]}],\"flags\":914}" |
			node -e '
				let input = "";
				process.stdin.on("data", chunk => input += chunk).on("end", () => {
					try {
						const version = JSON.parse(input).results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
						if (version) process.stdout.write(version);
					} catch {}
				});
			'
	)" || MARKETPLACE_LATEST=""
	if [ -n "$MARKETPLACE_LATEST" ]; then
		version_gt "$NEW_VERSION" "$MARKETPLACE_LATEST" || \
			die "Marketplace already has $MARKETPLACE_LATEST; choose a higher version"
	fi
else
	warn "curl not found; skipping the Marketplace version check"
fi

LAST_TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
if [ -n "$NOTES" ]; then
	RELEASE_NOTES="$NOTES"
elif [ -n "$LAST_TAG" ]; then
	[ "$(git rev-list --count "$LAST_TAG"..HEAD)" -gt 0 ] || \
		die "no commits since $LAST_TAG; pass --notes to release metadata-only changes"
	RELEASE_NOTES="$(git log --no-merges --max-count=50 --pretty='- %s' "$LAST_TAG"..HEAD)"
else
	RELEASE_NOTES="$(git log --no-merges --max-count=20 --pretty='- %s' HEAD)"
fi
[ -n "$RELEASE_NOTES" ] || RELEASE_NOTES="- Maintenance release."

cat <<EOF

Release plan
  branch:      $BRANCH
  version:     $OLD_VERSION -> $NEW_VERSION
  tag:         $TAG
  changelog:   $([ "$NO_CHANGELOG" = 1 ] && echo "skipped" || echo "CHANGELOG.md")
  marketplace: ${MARKETPLACE_LATEST:-unknown}
  changes:
$(printf '%s\n' "$RELEASE_NOTES" | sed 's/^/    /')

EOF

if [ "$DRY_RUN" = 1 ]; then
	info "Dry run: nothing changed, nothing committed, nothing pushed"
	exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
	printf 'Continue? [y/N] '
	read -r ANSWER
	case "$ANSWER" in
		y | Y | yes | YES) ;;
		*)
			echo "Aborted."
			exit 1
			;;
	esac
fi

if [ "$SKIP_CHECKS" != 1 ]; then
	[ -d node_modules ] || die "node_modules is missing; run npm ci first"
	info "Running the production build (typecheck + lint + esbuild)"
	npm run package
	if [ -n "$(git status --porcelain)" ]; then
		git status --short
		die "the build changed tracked files; commit them, then rerun"
	fi
fi

info "Bumping $OLD_VERSION -> $NEW_VERSION"
OLD_VERSION="$OLD_VERSION" NEW_VERSION="$NEW_VERSION" node <<'NODE'
const fs = require("fs");
const oldVersion = process.env.OLD_VERSION;
const newVersion = process.env.NEW_VERSION;

function bump(file, expected) {
	const text = fs.readFileSync(file, "utf8");
	let count = 0;
	const next = text.replace(/"version": "([^"]+)"/g, (match, version) => {
		if (version === oldVersion && count < expected) {
			count += 1;
			return `"version": "${newVersion}"`;
		}
		return match;
	});
	if (count !== expected) {
		throw new Error(`${file}: expected ${expected} version fields, found ${count}`);
	}
	fs.writeFileSync(file, next);
}

bump("package.json", 1);
bump("package-lock.json", 2);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
if (
	pkg.version !== newVersion ||
	lock.version !== newVersion ||
	lock.packages?.[""]?.version !== newVersion
) {
	throw new Error("version validation failed");
}
NODE

if [ "$NO_CHANGELOG" != 1 ]; then
	[ -f CHANGELOG.md ] || die "CHANGELOG.md not found"
	info "Updating CHANGELOG.md"
	NEW_VERSION="$NEW_VERSION" RELEASE_DATE="$(date -u +%F)" RELEASE_NOTES="$RELEASE_NOTES" node <<'NODE'
const fs = require("fs");
const version = process.env.NEW_VERSION;
const date = process.env.RELEASE_DATE;
const notes = (process.env.RELEASE_NOTES || "").trim();

const text = fs.readFileSync("CHANGELOG.md", "utf8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (new RegExp(`^## \\[${escaped}\\]`, "m").test(text)) {
	console.error(`CHANGELOG.md already has a ${version} section`);
	process.exit(1);
}

const lines = text.split("\n");
const index = lines.findIndex(line => line.startsWith("## ["));
const section = [`## [${version}] — ${date}`, "", ...notes.split("\n"), ""];
if (index === -1) {
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	lines.push("", ...section);
} else {
	const lead = index > 0 && lines[index - 1].trim() !== "" ? [""] : [];
	lines.splice(index, 0, ...lead, ...section);
}
fs.writeFileSync("CHANGELOG.md", `${lines.join("\n").replace(/\n+$/, "")}\n`);
NODE
fi

git --no-pager diff --stat
git --no-pager diff --check || die "diff has whitespace errors"

info "Committing and tagging"
git add package.json package-lock.json
[ "$NO_CHANGELOG" = 1 ] || git add CHANGELOG.md
git commit -m "release: $NEW_VERSION" || die "git commit failed; inspect git status"
git tag -a "$TAG" -m "$TAG" || die "git tag failed; inspect git status"

if [ "$NO_PUSH" = 1 ]; then
	info "Committed and tagged locally (not pushed)"
	echo "  git push origin $BRANCH"
	echo "  git push origin $TAG"
	exit 0
fi

info "Pushing $BRANCH"
git push origin "$BRANCH"
info "Pushing $TAG (this triggers the publish workflow)"
if ! git push origin "$TAG"; then
	warn "the tag push failed; the release commit is already on origin"
	echo "Retry with: git push origin $TAG" >&2
	exit 1
fi

REPO_PATH="$(git remote get-url origin | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
ACTIONS_URL="https://github.com/$REPO_PATH/actions/workflows/publish.yml"
MARKETPLACE_URL="https://marketplace.visualstudio.com/items?itemName=$PUBLISHER.$EXTENSION"

if [ "$NO_WATCH" = 1 ]; then
	info "Pushed; not waiting for the workflow"
	echo "  Actions:     $ACTIONS_URL"
	echo "  Marketplace: $MARKETPLACE_URL"
	exit 0
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
	info "Waiting for the publish workflow"
	RUN_ID=""
	for _ in 1 2 3 4 5; do
		RUN_ID="$(gh run list --workflow publish.yml --commit "$(git rev-parse HEAD)" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"
		if [ -n "$RUN_ID" ]; then
			break
		fi
		sleep 3
	done
	if [ -z "$RUN_ID" ]; then
		warn "could not find the workflow run; open $ACTIONS_URL"
		exit 0
	fi
	if ! gh run watch "$RUN_ID" --exit-status; then
		warn "the publish workflow failed"
		echo "Inspect: gh run view $RUN_ID --log-failed" >&2
		echo "Retry after fixing: git tag -d $TAG && git push origin :refs/tags/$TAG" >&2
		exit 1
	fi

	info "Verifying the release"
	gh release view "$TAG" --json tagName,assets --jq '"release: \(.tagName) — " + ([.assets[].name] | join(", "))' || \
		warn "GitHub Release not visible yet"
else
	warn "gh is not authenticated; not watching the run"
	echo "  Actions:     $ACTIONS_URL"
	echo "  Marketplace: $MARKETPLACE_URL"
	exit 0
fi

info "Checking Marketplace for $NEW_VERSION"
LATEST=""
for _ in 1 2 3 4 5 6; do
	if command -v curl >/dev/null 2>&1; then
		LATEST="$(
			curl -fsS --max-time 15 -X POST 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' \
				-H 'Accept: application/json;api-version=7.2-preview.1' \
				-H 'Content-Type: application/json' \
				--data "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"$PUBLISHER.$EXTENSION\"}]}],\"flags\":914}" |
				node -e '
					let input = "";
					process.stdin.on("data", chunk => input += chunk).on("end", () => {
						try {
							const version = JSON.parse(input).results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
							if (version) process.stdout.write(version);
						} catch {}
					});
				'
		)" || LATEST=""
	fi
	if [ "$LATEST" = "$NEW_VERSION" ]; then
		break
	fi
	sleep 15
done

if [ "$LATEST" = "$NEW_VERSION" ]; then
	info "Marketplace: $NEW_VERSION"
else
	warn "Marketplace still reports ${LATEST:-unknown} (CDN cache); check $MARKETPLACE_URL"
fi

info "Release $TAG pushed"
