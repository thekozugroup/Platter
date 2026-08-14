<!--
CONTRIBUTING.md has the long version of all of this. The four headings below are the four
things a reviewer needs and cannot get from the diff on its own.

Delete any section that genuinely does not apply — an empty heading is worse than no heading.
-->

## What changed and why

<!--
The "why" is the expensive part to recover later, so spend the words there. Link the issue if
there is one: "Fixes #123".
-->

## How I know it works

<!--
Paste real output, not a claim about it. `pnpm verify` runs typecheck, lint and the tests.

A false green is worse than a known gap — if part of this is untested, or you could not verify
something in your environment, say so plainly here. That is not a mark against the PR.
-->

```
$ pnpm verify

```

## Screenshots

<!--
UI changes only. Light and dark, and both states of anything that has states — loading, empty,
error, and the thing actually populated.
-->

## What I decided not to do

<!--
Often the most useful part of the description: the alternative you rejected, the edge case you
left, the follow-up this makes possible. Write it down while you still remember it.
-->

---

- [ ] `pnpm verify` passes
- [ ] Comments explain _why_, not _what_ — matching the surrounding code
- [ ] `packages/shared` schema changes, if any, are reflected on both sides
- [ ] No new dependency, or the description says what it does that the existing surface cannot
- [ ] Nothing here claims a status the code cannot actually verify

<!--
Two boundaries that are permanent, so a PR crossing either will be pushed back regardless of how
good the code is:

  • Nothing may reimplement part of a game server. Platter runs the same community images you
    would run by hand — docs/ARCHITECTURE.md §1.
  • No MCP tool may install, update or remove a file. An agent proposes; a human approves. This
    is enforced by the dependency graph and by a test that parses the MCP source for banned
    imports — docs/SECURITY.md.
-->
