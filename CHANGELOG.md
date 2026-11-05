# Changelog

Notable changes to `nulladrift`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

Two things in this project are versioned contracts, and a breaking change to either is a major
version: the **lockfile format** (`lockfileVersion`, and the JSON Schema in `schema/`) and the
**change taxonomy** (the `kind` identifiers that appear in `--json`, as SARIF rule ids, and in
telemetry). Renaming a change kind breaks every consumer that matched on it.

## [Unreleased]

### Added

- **Control plane** (`server/`, `client/`): inventory across projects keyed by derived server
  identity, approval recorded against a named person, policy evaluated server-side, and an
  append-only audit log. `nulladrift push` sends a reading and takes its exit code from the
  server's verdict, so a pull request cannot widen what its own build is allowed to do.
- `@nulladrift/core`: the lockfile model and drift engine, extracted from the CLI so the
  collector and the control plane run one implementation rather than two.
- `@nulladrift/shared-types`: the change taxonomy and API contract, shared by all three.

### Security

- The control plane recomputes every digest in a submitted surface before diffing it. The engine
  short-circuits on digests, so trusting the collector's would have let a reading whose text
  changed -- while its digests stayed still -- compare as clean.
- Server identity is derived on the control plane, never taken from the collector. The identity
  key is what an approval attaches to, so a machine that could choose its own would be able to
  present an unreviewed server under an approved one's identity.
- A collector token cannot rule on drift, whatever scope it holds.

### Fixed

- Project summaries reported no last reading and no open drift. Drizzle renders column
  references unqualified in a single-table select, so the correlated subqueries bound `id` to
  the subquery's own table and silently matched nothing.

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
