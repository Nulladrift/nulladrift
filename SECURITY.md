# Security policy

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository.
That opens a draft advisory only the maintainers can see. Please do not open a public issue
for a vulnerability first.

Include what you did, what happened, and what you expected. A lockfile, a config and a server
that reproduces it is worth more than a description.

Expect an acknowledgement within a week. If a report is valid, the fix and the advisory go out
together, and you are credited unless you ask otherwise.

## What counts as a vulnerability here

`nulladrift` exists to answer one question, *did the capability surface I approved change?*, so the security bugs that matter most are the ones that make it answer "no" when the truth is
"yes":

- **A missed change.** Any edit to a server's declared surface that `check` reports as clean,
  or, for a stdio server whose artifact was established, a different artifact running behind it.
  Treat a false clean as the highest-severity class in this project.
- **Credential material reaching the lock.** `mcp.lock` is committed. Environment values,
  headers, query strings and OAuth tokens are supposed to be reduced to names before they are
  written, and a credential a config writes literally, in `args` or in a URL's path or userinfo,
  is supposed to be replaced; a path that lands a value in the file is a vulnerability, not a
  formatting bug. So is one that lands it in the reading `push` sends, which is the same data.
- **Weak handling of stored tokens.** `nulladrift login` writes to the user's config directory
  owner-only. Anything that widens that, or leaks a token into output or logs, is in scope.
- **The CI identity token.** `push` sends the job's OpenID Connect token so the control plane can
  verify which build sent a reading. For the life of the job it is a credential: anything that
  writes it to output, logs or the lock, or sends it anywhere but the control plane it was asked
  for, is in scope.
- **A server affecting the machine that audits it,** beyond being audited. The crawl runs
  registry packages in a container with no host mounts, no host environment, no privileges and
  a read-only root; an escape from that is in scope, as is any way a hostile server's responses
  can reach a shell, a file path, or the audit process itself.
- **Script injection in the shipped workflows,** or any other path by which a pull request can
  make CI run attacker-controlled code or exfiltrate a secret.

## What does not count

- **Vulnerabilities in the MCP servers you audit.** Report those to their maintainers.
- **A server that declares one thing and does another.** This is the documented limit of the
  tool, not a defect in it: the lock pins what a server *declares* and which artifact it runs,
  not what the code does. See the Postmark discussion in the README. A backdoor that shipped as a
  new release should be reported as `server.artifact.changed`, and that report going missing is
  in scope. One in a remote server, or behind an artifact whose provenance could not be
  established (listed as unverified), going undetected while the tool definitions were unchanged
  is working as described.
- **Drift that `check` reports and a human then accepts.** Accepting a change you did not read
  is a process problem; the tool can refuse to make it silent, which is what `review` and
  `init --force` are for, but it cannot refuse to be overridden.

## Supported versions

Pre-1.0: only the latest published version is supported. Fixes go out as a new release rather
than as patches to older ones.
