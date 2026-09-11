# Security

This skill and its bundled CLI handle OAuth tokens for Relaynote and run inside
AI coding agents. Please report vulnerabilities privately.

- Use GitHub's private vulnerability reporting on this repository, or
- email security@relaynote.dev

Do not open a public issue for a security problem. We aim to acknowledge reports
within 3 business days.

## Scope

- `skills/relaynote/scripts/` (feedback CLI, shared runtime, adapters)
- Token storage under `~/.local/share/relaynote*`
- Instructions in `SKILL.md` and `references/` that could be abused to make an
  agent act outside the reviewer's authorization

The Relaynote server is a separate repository; report server issues there.
