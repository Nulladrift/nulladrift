# Changelog

Notable changes to `nulladrift`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

Two things in this project are versioned contracts, and a breaking change to either is a major
version: the **lockfile format** (`lockfileVersion`, and the JSON Schema in `schema/`) and the
**change taxonomy** (the `kind` identifiers that appear in `--json`, as SARIF rule ids, and in
telemetry). Renaming a change kind breaks every consumer that matched on it.

## [Unreleased]

Nothing yet.

The entries that used to sit here described the control plane, the dashboard and
`@nulladrift/shared-types`. None of those are in this repository: it holds the collector and the
engine, and the rest moved to the application repository with its own changelog. The change
taxonomy they shared now lives in `@nulladrift/core`, where the engine that emits it is.

## [0.1.0] - unreleased

First release.

### Added

- `init`: discover MCP servers from the client configs a project already has (`.mcp.json`,
  `.vscode/mcp.json`, `.cursor/mcp.json`, `~/.claude.json`, `claude_desktop_config.json`,
  Windsurf, Copilot), capture each server's capability surface, and write `mcp.lock`.
- `check`: re-capture and diff against the lock. Exit `0` clean, `1` drift, `2` audit
  incomplete, with `--json` and SARIF 2.1.0 output.
- `review`: show each change and accept it into the lock, interactively or with `--accept-all`.
- `login` / `logout`: authorize a gated server once in a browser, or use
  `oauth.clientId` / `oauth.clientSecret` in CI. Tokens are stored owner-only outside the repo.
- `telemetry on|off|status`: anonymous drift counts, off unless turned on, never asked in CI.
- The lock records server identity, declared capabilities, the `instructions` string, and every
  tool, resource, resource template and prompt in readable form rather than as opaque digests,
  with tool annotations resolved against the spec's defaults so a *removed* annotation reads as
  the escalation it is.
- MCP revision `2026-07-28` via `server/discover`, falling back to the legacy `initialize`
  handshake for `2025-11-25` and earlier, with the negotiated era recorded in the lock.
- stdio and Streamable HTTP transports, and the deprecated HTTP+SSE transport where a config
  still declares one.
- `pnpm crawl`: the public-registry drift measurement behind the project's central question,
  with an optional container sandbox for stdio servers (`--include-stdio`).

### Security

- `init` refuses to overwrite an existing `mcp.lock` and points at `check` and `review`;
  `--force` re-pins from scratch. Without this, re-running `init` out of habit re-baselines a
  reviewed lock to whatever the servers answer at that moment, accepting every pending change
  without displaying one, which is exactly what `review` is careful not to do.
