# Security policy

Mongoster holds the credentials of MongoDB deployments, opens SSH tunnels and serves an MCP server on the local
machine, so a weakness in it can expose data. Reports are welcome.

## Supported versions

| Version | Gets security fixes |
| --- | --- |
| The latest release (0.8.x) | Yes |
| Older releases | No: update to the latest |

The extension (Marketplace) and the desktop app (the installers on the Releases page) of the same version get the same
fixes.

## Reporting a vulnerability

**Do not open a public issue.** The private channel for reports is not set yet
([Q7](docs/08-decisions.md#open-questions)).

Say what you found, how to reproduce it, which version, and whether it concerns the extension, the desktop app or
both.

## What happens next

You get an answer saying whether the report is accepted. A fix is released as a new version, with the vulnerability
described in the CHANGELOG once the release is out, and the reporter credited unless they ask not to be.

What Mongoster defends against, and what it does not, is in [docs/10-security.md](docs/10-security.md).
