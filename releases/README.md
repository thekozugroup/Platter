# Staged releases

A release that is prepared but not yet published lives here, one directory per version.

This exists because preparing a release and being allowed to publish one are not always the
same place. Creating the tag is the entire publish step — `.github/workflows/release.yml`
does everything after it — so a release that is ready and a release that is out differ by a
single `git push`, and that push needs credentials the preparing environment may not hold.
Rather than leave the version, the commit and the notes to be reconstructed from memory, they
are written down.

Each directory holds:

| File               | What it is                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELEASE_NOTES.md` | The body the release will carry, generated from `CHANGELOG.md` exactly as the workflow generates it. Kept so it can be read before publishing rather than after. |
| `publish.sh`       | Creates the tag on the recorded commit and pushes it. Refuses if the tag exists, or if the commit is not on `origin/main`.                                       |

To publish:

```sh
./releases/v0.1.0/publish.sh
```

The tag is what the workflow watches. It re-runs the full gate against the tagged tree, builds
and pushes `linux/amd64` and `linux/arm64` images to GHCR, smoke-tests the published image
before anything can pull it, and creates the GitHub release. If the gate fails, nothing is
published.

**Delete a directory once its version is out.** A staged release that has already shipped is
a file that describes the present as the future, and the next person to read it will believe
it.
