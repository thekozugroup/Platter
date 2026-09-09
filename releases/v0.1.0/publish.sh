#!/bin/sh
# Publishes Platter 0.1.0.
#
# Everything here is one `git push` and three guards. It is a script rather than a line in a
# chat log because the push has to happen somewhere with permission to create a tag, which is
# not where this release was prepared — so the commit, the message and the checks travel with
# it instead of being retyped from memory.
#
# Creating the tag is the whole publish step. `.github/workflows/release.yml` takes it from
# there: it re-runs typecheck, lint, format and the full suite against the tagged tree, checks
# the manifests agree with the tag, builds and pushes linux/amd64 and linux/arm64 images to
# GHCR, smoke-tests the published image before anyone can pull it, and creates the GitHub
# release from RELEASE_NOTES.md beside this file. Nothing is published if the gate fails.
#
#   ./releases/v0.1.0/publish.sh            tag the reviewed commit
#   ./releases/v0.1.0/publish.sh --head     tag whatever origin/main is now

set -eu

TAG=v0.1.0
REVIEWED=26a15d096ea05e49880ed38e22c8eb89af0561cf

USE_HEAD=false
[ "${1:-}" = "--head" ] && USE_HEAD=true

cd "$(dirname "$0")/../.."

git fetch --quiet origin main --tags

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "$TAG already exists locally. Delete it first if you mean to move it:"
  echo "  git tag -d $TAG"
  exit 1
fi

HEAD_COMMIT=$(git rev-parse origin/main)

# The reviewed commit rather than whatever main happens to be. A release that quietly carries
# something nobody looked at is the failure this exists to prevent — but going stale is a real
# cost too, so when main has moved the script says exactly what by, and `--head` takes it.
if [ "$USE_HEAD" = true ]; then
  TARGET=$HEAD_COMMIT
elif [ "$HEAD_COMMIT" = "$REVIEWED" ]; then
  TARGET=$REVIEWED
else
  echo "origin/main has moved since this release was staged."
  echo
  echo "  staged:  $(git log --oneline -1 "$REVIEWED")"
  echo "  main:    $(git log --oneline -1 "$HEAD_COMMIT")"
  echo
  echo "Not in the staged release:"
  git log --oneline "$REVIEWED..$HEAD_COMMIT" | sed 's/^/    /'
  echo
  echo "Tag the staged commit anyway, or take main as it is now:"
  echo "  git tag -a $TAG $REVIEWED -m 'Platter 0.1.0' && git push origin $TAG"
  echo "  $0 --head"
  exit 1
fi

if ! git merge-base --is-ancestor "$TARGET" origin/main; then
  echo "$TARGET is not on origin/main. Refusing to tag a commit nobody else can see."
  exit 1
fi

git tag -a "$TAG" "$TARGET" -m "Platter 0.1.0

First public release. Self-hosted control panel for game servers, Minecraft-first,
drivable by an AI assistant over MCP.

See CHANGELOG.md for what is in it and what its known limitations are."

git push origin "$TAG"

echo
echo "Pushed $TAG at $(git log --oneline -1 "$TARGET")"
echo "Watch the release build:"
echo "  https://github.com/thekozugroup/Platter/actions/workflows/release.yml"
