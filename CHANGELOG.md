# Changelog

Notable changes to `nulladrift`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

Two things in this project are versioned contracts, and a breaking change to either is a major
version: the **lockfile format** (`lockfileVersion`, and the JSON Schema in `schema/`) and the
**change taxonomy** (the `kind` identifiers that appear in `--json`, as SARIF rule ids, and in
telemetry). Renaming a change kind breaks every consumer that matched on it.

## [Unreleased]

Nothing yet.

## [0.1.6] - 2026-11-06

### Security

- **A lockfile path that is a symbolic link is refused rather than followed.** `init` in a freshly
  cloned repository is the ordinary way to use this tool, and git can carry a symlink. A
  repository shipping `mcp.lock` as a link to `~/.npmrc`, a CI script or any other file the user
  can write had that file written, and the run reported `Pinned 1 server(s)`. The dangling case
  needed no `--force` at all: the existence check followed the link, found nothing, concluded
  there was no lockfile, and created the target outside the project.
- **A credential passed to a server in `args` no longer ends up in the committed lockfile.**
  Environment values and header values were never written down, only their names, and a URL lost
  its query and fragment, all on the stated grounds that credentials usually sit there. `args`
  were written expanded, which undid it: a config keeps a secret out of the repository by writing
  `--token=${API_KEY}`, and `mcp.lock` -- the file you are told to commit -- then carried the
  expanded value. The configured form is written down now, so the lockfile holds `${API_KEY}`,
  the thing its author chose to put in version control. A config that changes which variable it
  reads is still drift and is still visible.
- **`--timeout` is a per-server budget, as documented, not a per-request one.** Capturing a
  surface takes several requests, so a server that accepted a connection and never answered held
  the audit for two and a half to three times the configured value -- `--timeout 2000` measured
  6.1s, `--timeout 4000` measured 10.1s. At the 30s default that is a minute and a half per
  server, decided by a server nobody controls. The per-request timeout stays; this is the
  ceiling on all of them together.
- **`sanitizeUrl` strips userinfo.** `https://alice:s3cr3t@host/mcp` survived untouched, because
  `URL.toString()` keeps it. The query string was already being stripped on the grounds that
  credentials usually sit there; userinfo is where one sits by definition.

## [0.1.5] - 2026-11-05

No code changes from 0.1.4.

The repository's history was rewritten to carry a single author, which changed every commit's
hash. Each published version's provenance attestation names the commit it was built from, so
0.1.0 through 0.1.4 now reference commits that no longer exist. Their attestations still verify
-- they are statements about builds that really happened -- but the source they point at cannot
be fetched.

This release is identical code built from the rewritten history, so the version anyone installs
has provenance that resolves. The earlier versions are deprecated in favour of it.

## [0.1.4] - 2026-11-05

### Security

- **A server can no longer drive the terminal of the person auditing it.** Every string this
  tool renders -- a tool description, a server's `instructions`, its name -- is written by the
  server under audit. A description ending `\u001b[2J\u001b[H\u001b[32m0 high · 0 medium · 0 low`
  cleared the screen and repainted a clean summary over the diff that was about to be read,
  which defeats the point of showing somebody what changed. `truncate` collapsed `\s+`, which in
  JavaScript covers carriage return and so neutralised the obvious overwrite, and covers no other
  control character.

  C0 and C1 controls, DEL, bidirectional overrides and zero-width characters are now escaped in
  the terminal report and in pull request comments. They are escaped rather than stripped: a
  description that gains a zero-width space has changed, and the reviewer is the one who should
  decide whether that matters.

  The lockfile was never affected -- JSON encoding already stored these as `\u001b` text rather
  than raw bytes -- so no pinned surface was wrong, only what a reader was shown.

## [0.1.3] - 2026-11-05

### Fixed

- **SARIF locations are expressed relative to the project.** `artifactLocation.uri` was the
  lockfile's absolute path, with no `uriBaseId`. GitHub code scanning resolves that URI against
  the repository root, so an absolute path matched no file and every alert arrived with nothing
  to click through to -- in the one feature whose pitch is that drift shows up in code scanning
  with no integration to write. It is now the path relative to the project, with
  `uriBaseId: "%SRCROOT%"`. A lockfile outside the project has no repository-relative form, so
  that case keeps the absolute path rather than inventing one.

## [0.1.2] - 2026-11-05

Found by running 0.1.1 across a matrix of real and synthetic projects covering every config
format, transport and exit path.

### Security

- **A lockfile read from disk is resealed before it is diffed.** The diff engine short-circuits
  on the subject digest, which is correct only when the lockfile and the reading came from the
  same process. A lockfile has not: it comes off disk, after git, merges and hands. Taking its
  digest at face value meant **any edit to a locked surface that left the digest alone compared
  as clean, indefinitely.** `check` reported `1 server(s) match` against a lock whose
  `browser_navigate` description had been rewritten to read `~/.aws/credentials`, and went on
  reporting it with the digest zeroed out. The control plane already reseals on ingest and
  `reseal.ts` explains why; the collector is in the same position with respect to its own
  lockfile and now does the same. An honest lock reseals to exactly the digests it arrived with.

### Fixed

- `push` names the argument that is missing. Supplying the API URL and omitting the token
  produced a message about the API URL, which was the part already correct.
- A lockfile that cannot be written reports why instead of printing Node's `ENOENT` and four
  frames of internals. `--lock` is resolved against `--cwd`, which the message now says.
- **`Looked in:` lists every path that was searched, each marked `read` or `absent`.** It listed
  only the files that existed, so a project with no config of its own reported two paths in the
  user's home directory and nothing else -- no way to tell the project itself had been searched.
  That is where somebody standing in a repository concludes the tool does not look locally. The
  message also now says that nothing was written and that `check` will fail until a config exists.
- `Drift in 1 of 0 server(s)` reads as a broken fraction. When a server is removed from the
  config there is nothing left to compare against, so the heading says that instead.

## [0.1.1] - 2026-11-05

Everything here was found by running 0.1.0 against real third-party servers rather than fixtures.

### Fixed

- **A relative `cwd` is resolved against the project, not the caller.** It was handed to the spawn
  verbatim, so Node resolved it against `process.cwd()`. Auditing from the project root hid this;
  auditing from anywhere else, which is what `--cwd` and most CI layouts do, started the server in
  the wrong directory and reported whatever it failed to find there.

- **A failed stdio server now shows why it failed.** The captured stderr was the *last* three
  lines, and a Node process that dies on startup ends with a closing brace, a blank line and its
  version banner. So the report reliably showed the three least useful lines it printed and cut
  off the reason above them. Against a server whose entry point had not been built, the operator
  saw `}` and `Node.js v26.7.0` instead of `Error: Cannot find module '.../dist/index.js'`.
- **`init` no longer writes a lockfile that pins nothing.** When every server failed it wrote an
  empty `mcp.lock` and said "Commit mcp.lock" -- and because `init` refuses to run over an
  existing lockfile, the next attempt was then blocked on a baseline that had never contained
  anything. It now writes no file and says what to do instead.

- **A 403 is no longer reported as a missing credential.** `check` collapsed 401 and 403 into one
  outcome and printed the same remediation for both: *run `nulladrift login`*. After a 403 that is
  a loop, because the credential was accepted and the identity is still not permitted. Found
  against Sentry's hosted server, where the configured URL named an organization the account did
  not belong to; re-authorizing four times could not have fixed it.
- `isAuthFailure` only ever read the outer error's message, so a transport that wrapped
  `403 Forbidden` in a sentence of its own was classified as an outage and sent people to check a
  network that was fine.

### Changed

- `unreachable[].kind` in `--json` gains a third value, `forbidden`, alongside `auth` and
  `unreachable`. A consumer matching `kind === "auth"` will no longer see refusals of an accepted
  identity; match both if you want every authorization outcome.

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
