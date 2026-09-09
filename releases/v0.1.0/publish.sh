#!/bin/sh
# Publishes Platter 0.1.0.
#
# Everything this does could be one `git push`. It is a script because the push has to
# happen from somewhere with permission to create a tag, which is not where the release was
# prepared — so this carries the exact commit and message rather than leaving them to be
# retyped from a chat log.
#
# Creating the tag is the whole publish step. `.github/workflows/release.yml` takes it from
# there: it re-runs typecheck, lint, format and the full test suite against the tagged tree,
# builds and pushes linux/amd64 and linux/arm64 images to GHCR, smoke-tests the published
# image before anything else can pull it, and creates the GitHub release with the notes
# beside this file. Nothing is published if the gate fails.

set -eu

TAG=v0.1.0
COMMIT=cafda80e3c231d161c3fb4d7b8471d02ef30d0e1

cd "$(dirname "$0")/../.."

echo "Fetching, so the tag lands on what is actually on the remote…"
git fetch origin main --tags

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "$TAG already exists locally. Delete it first if you mean to move it: git tag -d $TAG"
  exit 1
fi

# Tagging the commit by hash rather than by branch name: main may have moved since this
# release was prepared, and a release that quietly includes something unreviewed is the one
# failure mode worth spending three lines on.
if ! git merge-base --is-ancestor "$COMMIT" origin/main; then
  echo "$COMMIT is not on origin/main. Refusing to tag a commit nobody can see."
  exit 1
fi

git tag -a "$TAG" "$COMMIT" -m "Platter 0.1.0

First public release. Self-hosted control panel for game servers, Minecraft-first,
drivable by an AI assistant over MCP.

See CHANGELOG.md for what is in it and what its known limitations are."

git push origin "$TAG"

echo
echo "Pushed $TAG. Watch the release build:"
echo "  https://github.com/thekozugroup/Platter/actions/workflows/release.yml"
