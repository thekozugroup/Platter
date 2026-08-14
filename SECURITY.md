# Security policy

## Reporting a vulnerability

**Do not open a public issue.**

Report privately through GitHub's [Security
Advisories](https://github.com/thekozugroup/Platter/security/advisories/new), which opens a
thread visible only to the maintainers.

Include what an attacker can do and what they need to already have (an account? a valid API
key? LAN access?), steps to reproduce — ideally against a `DEFAULT_NODE_DRIVER=mock` instance
so nothing real is touched — and the commit or image tag you tested.

You can expect an acknowledgement, then either a fix or an explanation of why it is working as
intended, and credit in the release notes unless you would rather not have it. Please give a
reasonable window before disclosing publicly.

**[docs/SECURITY.md](docs/SECURITY.md) is the full policy**: the threat model, what is in and
out of scope, and the reasoning behind each boundary. Read it before reporting — several of the
most-reported behaviours are documented properties rather than bugs.

## Supported versions

Platter is pre-1.0. Fixes land on `main` and go out in the next release; there are no
backported patch branches yet.

| Version | Supported                     |
| ------- | ----------------------------- |
| 0.1.x   | Yes                           |
| < 0.1   | No — there is nothing earlier |

## Two things to know before you report

**The Docker socket is root on the host.** Platter manages game servers as sibling containers,
so it mounts `/var/run/docker.sock`, and anything that can write to that socket can start a
container that mounts the host filesystem. This is a documented property, not a vulnerability —
it is why `docs/SECURITY.md` covers rootless Docker and socket proxies at length. A report that
this mount is dangerous will be closed as working-as-intended; a report that some _other_ path
reaches the socket without going through the permission system will not.

**Approval is the trust boundary for mods.** An AI agent can propose a mod; it has no code path
to the installer, and that is enforced by the dependency graph and by a test that parses the MCP
source for banned imports. Once a human approves an install, the mod runs with the game server's
full privileges — an approved mod doing something unpleasant is the approval being wrong, not
Platter being broken. A way to install a file _without_ that approval is very much in scope.

In scope and genuinely wanted: anything that lets a caller act beyond their scopes or
permissions, any path that writes a file without a human approval, any way to read another
user's servers or secrets, any escape from the file-manager sandbox, any way to reach the MCP
surface with a browser session token, and anything that makes an audit entry wrong about who
did what.
