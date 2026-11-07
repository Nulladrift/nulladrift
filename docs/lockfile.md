# The `mcp.lock` format

The lockfile is the product. Everything else is plumbing around it. The test it has to
pass: **a reviewer who has never run `nulladrift` can read the diff in a pull request and
say what the agent is now allowed to do that it was not allowed to do before.**

Every decision below follows from that.

## 1. Content, not just hashes

The obvious design is a map of tool name to hash. It is also useless in review: the diff
reads `- sha256:a7e4… + sha256:1f90…`, and the reviewer has to run a tool to learn
anything. So the lock stores the full capability surface as readable JSON, and uses
digests only as a *summary line* on top of visible content.

Digests still earn their place:

- A tool's input schema can be two hundred lines. A changed `digest` at the top of the
  entry tells the reviewer that something inside it moved, before they start reading.
- They are a stable identity for SARIF `partialFingerprints`, so GitHub code scanning
  dedupes a recurring finding instead of reopening it every run.
- They catch a lockfile edited by hand to make CI pass.

The cost is file size. A project with ten servers lands in the low hundreds of kilobytes.
That is acceptable for a file that is read by humans at review time and by one tool in CI.

## 2. Canonical form

Hashes are computed over **RFC 8785 (JSON Canonicalization Scheme)** of the covered
fields. JCS rather than a bespoke scheme because it already specifies the hard parts (key ordering, string escaping, number formatting), and a second implementation can
reproduce our digests from the spec alone.

Serialization rules for the file itself, chosen so that semantically identical answers
from a server produce byte-identical files:

| Rule | Reason |
| ---- | ------ |
| Structural keys in a declared order (`name`, `title`, `description`, `inputSchema`, … , `digest`) | The entry reads top-down: what the tool is called, what it claims to do, what it accepts, what it may do. Alphabetical order would put `digest` and `annotations` above the description. |
| Free-form subtrees sorted lexicographically. JSON Schemas, `capabilities`, `annotations`, `behavior`, `_meta` | They have no meaningful order, so sorting is what stops a server's reserialization from showing up as a diff. |
| `tools`, `resources`, `resourceTemplates`, `prompts` sorted by `name` | The spec only *recommends* deterministic ordering. A server that reorders would otherwise produce a whole-file diff that hides the one real change. |
| `required` arrays sorted | Order is semantically insignificant there, and it is the most common source of spurious diffs. |
| **All other arrays keep server order** | Order *is* significant in `prefixItems`, `allOf`, `icons`. Sorting them would be wrong, so we sort only where we can prove it is safe. |
| Two-space indent, LF, trailing newline | Plays well with `git diff` and every JSON formatter. |

Digests are unaffected by any of this: they are computed over JCS canonical form, which sorts
every key. The file's layout is for the reviewer; the canonical form is for the hash.

## 3. What is deliberately not pinned

Fields that change between two identical runs would make `check` fail constantly, and a
check that cries wolf gets `|| true`'d into irrelevance within a week.

- **`ttlMs` and `cacheScope`** (`CacheableResult`, new in revision 2026-07-28). Per-response
  cache hints. A server may vary them freely; they say nothing about capability.
- **`nextCursor`**, pagination state. `nulladrift` walks every page and pins the union.
- **`resultType`**, transport-level framing (`"complete"` vs `"input_required"`), not capability.
- **Credential values.** `env` values and header values are never written: only their key
  names, sorted. The lock is committed. HTTP URLs have their query string stripped, because
  query strings routinely carry tokens.
- **Timestamps, anywhere.** No `generatedAt`, no `capturedAt`. A timestamp dirties the file
  on every `init` and `review`, producing merge conflicts and training reviewers to skim
  past the diff. Git already records when the lock changed and who changed it, more
  reliably than we can.
- **`source`**, for digest purposes. The entry records which config file a server came from
  so a reviewer can find it, but moving a server from `.vscode/mcp.json` to `.mcp.json` is
  not a capability change and does not break the digest.

## 4. `behavior`: resolving non-neutral defaults

`ToolAnnotations` has four behavioural hints, and their spec defaults are asymmetric:

| Annotation | Default when absent |
| ---------- | ------------------- |
| `readOnlyHint` | `false` (may modify) |
| `destructiveHint` | `true` (may destroy) |
| `idempotentHint` | `false` (repeat calls compound) |
| `openWorldHint` | `true` (may reach arbitrary external systems) |

So a server that **deletes** `readOnlyHint: true` has escalated the tool from "cannot
modify" to "may modify and may destroy". If the lock pinned only what the server literally
sent, that escalation would appear in the diff as three deleted lines, which reads like
the server claiming *less*, the opposite of what happened.

The lock therefore carries both:

- `annotations`, verbatim, including absence. Exact fidelity for drift detection.
- `behavior`, the same four facts resolved against the defaults, always written in full.

An escalation then shows up the way it should:

```diff
   "behavior": {
-    "destructive": false,
-    "readOnly": true,
+    "destructive": true,
+    "readOnly": false,
```

This is the one place the format stores the same information twice. It is worth it: one
representation is correct, the other is legible, and review needs both.

## 5. Surfaces the brief did not anticipate

Three things in revision `2026-07-28` are part of the capability surface and are pinned:

- **`instructions`** (from `server/discover`). Natural-language guidance that clients place
  in the model's system prompt. It is the largest prompt-injection surface a server
  controls, and a server can change it without touching a single tool. Pinned verbatim.
- **`outputSchema`**. Clients validate structured results against it, and some route on it.
- **`x-mcp-header`**. New: a tool may mark an input property so its value is mirrored into
  an `Mcp-Param-*` HTTP header on Streamable HTTP, where proxies and WAFs can read it. A
  server adding this to an existing parameter moves that argument's data out of the request
  body with no visible change to the tool's signature. The lock derives a sorted
  `headerParams` list so the addition is a new line, not a buried schema key.

Also pinned: `capabilities` (including the `extensions` map, enabling an extension widens
what a server can do before any tool is listed), `icons` (URLs the client fetches; SVG can
carry script), and `_meta` (where extensions negotiate real capability), with
`policy.ignoreMetaPrefixes` as the escape hatch for servers that put build ids there.

## 6. Change taxonomy

`check` classifies each difference. The same identifiers are used in `--json`, as SARIF
rule ids, and as the `kind` field in opt-in telemetry.

| Kind | Note |
| ---- | ---- |
| `server.added` / `server.removed` | |
| `server.renamed` | See §7. |
| `server.transport.changed` | Same name, different command or URL. Treated as identity, not a field edit. |
| `server.identity.changed` | `serverInfo` moved, the postmark-mcp signal. |
| `server.artifact.changed` | The package, image or file behind the server is a different release. Medium. See §9. |
| `server.artifact.substituted` | The same npm version now has different bytes. High: npm never republishes a version. See §9. |
| `server.protocol.changed` | Era or revision changed between runs. |
| `server.instructions.changed` | |
| `server.capabilities.widened` / `.narrowed` / `.changed` | |
| `tool.added` / `tool.removed` | |
| `tool.description.changed` | |
| `tool.input_schema.widened` / `.narrowed` / `.changed` | |
| `tool.output_schema.changed` | |
| `tool.behavior.escalated` / `.relaxed` | Computed from `behavior`, not `annotations`. |
| `tool.header_params.changed` | |
| `tool.capability.gained` | The tool can now do something it could not, such as execute a process. Carries the capability and the evidence it was derived from, and takes its severity from the capability rather than from the schema change. A new tool names its capabilities on `tool.added` instead. |
| `tool.changed` | The catch-all. A tool's digest moved but none of the specific kinds fired, so the change is in `title`, `icons` or `_meta`. Reported rather than swallowed. |
| `resource.*`, `resource_template.*`, `prompt.*` | `added`, `removed`, `changed`. Resources are keyed by `uri` and templates by `uriTemplate`, so a changed URI is reported as an add plus a remove, the URI *is* the capability, and pretending otherwise would hide a widened template. |

**Every kind fails `check`.** The labels rank output and feed SARIF severity; they never
decide pass or fail. That distinction matters for `widened` in particular: deciding whether
one JSON Schema accepts a superset of another is not tractable in general, so `widened` is
a conservative heuristic, a new property, a dropped `required` entry, a relaxed `enum`, a
loosened bound, `additionalProperties` going from `false` to `true`. When the heuristic
cannot tell, the change is reported as `.changed`. A heuristic is fine for sorting a list;
it would not be fine for deciding whether CI goes green, which is why it does not.

Note that **a new optional field is drift.** It widens what the agent may be induced to
send. It is not a severe finding, and it is one `nulladrift review` keystroke to accept,
but it is not silence.

## 7. Rename detection

A server renamed in config would naively read as `server.removed` plus `server.added`, two alarming findings for a cosmetic edit. When a removed entry and an added entry have an
identical `transport` and an identical server `digest`, `check` reports a single
`server.renamed` instead.

Deliberately strict: identical transport **and** identical digest. A rename that also
changed capabilities is reported as a remove and an add, because that is what it is, and
collapsing it would hide the capability change inside a cosmetic one.

## 8. Known limits

- **The lock is scoped to the credentials that captured it.** The spec permits `tools/list`
  to vary with the authorization presented. A server may legitimately show your laptop more
  tools than it shows CI. When tools go missing, `check` names this as a likely cause before it
  names an attack. Pin from the same credential context CI will use, `nulladrift login` for an
  interactive grant, or `oauth.clientId` / `oauth.clientSecret` for an unattended one. A server
  that refuses the client is reported as needing credentials, not as drift and not as an
  outage, because an anonymous capture of a gated server pins a surface nobody uses.
- **Declaration is not behaviour.** The surface records what a server says about itself, and
  postmark-mcp is the standing counterexample. §9 closes half of this: new code behind an
  unchanged declaration is now detected, by pinning the artifact rather than reading it. What
  the new code *does* is still not something this tool can tell you.
- **Pagination is capped** at 64 pages per list, the SDK default. A server exceeding that is
  reported as an error rather than silently pinning a truncated surface.
- **A config whose credentials cannot be resolved is skipped, not guessed at.** `${input:…}`
  values come from the editor, and an unset `${VAR}` has no value to use. Connecting without
  them would not fail cleanly, since the tool list may vary by authorization, we would quietly
  pin a smaller surface than the one in use, so the server is reported as un-auditable, with
  the placeholder named, and the run counts as incomplete.
- **`lockfileVersion` is refused, not guessed.** An unknown version exits 2 with a message
  to upgrade, rather than reading the file optimistically. Version 1 is the exception: it is
  upgraded on read, for the reason in the next section.

## 9. Provenance: what actually ran

Everything above pins what a server *says*. `provenance` pins what it *is*: the artifact behind
a stdio invocation, by content address.

```json
"provenance": {
  "ecosystem": "npm",
  "name": "@modelcontextprotocol/server-filesystem",
  "version": "2.2.0",
  "integrity": "sha512-mNLj/qhV+P4kj1qP8...",
  "requested": "latest"
}
```

| Ecosystem | Read from | `integrity` |
| ---- | ---- | ---- |
| `npm` | `npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec` | The registry's `dist.integrity` for that version |
| `pypi` | `uvx`, `uv tool run`, `pipx run` | sha256 of the source distribution, else the first universal wheel |
| `oci` | `docker run`, `podman run` | The manifest digest the tag resolves to, read anonymously |
| `file` | `node index.js`, `python server.py`, `./bin/server` | sha256 of the file |

**Outside the server digest, compared on its own.** A lock written before this field existed,
or a run that could not reach a registry, has no provenance. Folding it into the digest would
turn every upgrade of this tool, and every offline run, into drift against servers nobody
touched. It is compared separately instead -- *before* the digest short-circuit, because the
case it exists for is new code behind a surface whose digest has not moved.

**Absence is not a change.** A missing record on either side produces nothing. A run that
could not establish what a server runs lists it as unverified beside the verdict, without
affecting the exit code: a registry being down is not the server's fault.

**A pin survives an outage only when it cannot be wrong.** If the configuration asks for an
exact npm or PyPI version, or an image by digest, the previous pin is kept when this run
could not re-establish it -- the registry's own rule guarantees it still means the same bytes.
A floating request (`latest`, a range, an image tag) is not carried forward, because that
would claim yesterday's version for code that may have moved since.

**Substitution is claimed only where it cannot be innocent.** npm refuses to republish a
version, so the same version with different bytes means something between here and the
registry served them: `server.artifact.substituted`, high, which the default policy blocks.
PyPI lets a maintainer add files to an existing release, and an image tag is a pointer by
design, so the same comparison there is the ordinary `server.artifact.changed`.

**What is not read, deliberately:**

- A command found on `PATH` by bare name. Which file that is depends on the machine, and a pin
  that means something different on every laptop is not a pin.
- `python -m module`. A module name does not say which package provides it.
- Private images. This tool holds no registry credentials and should not go looking for them.
- Anything past a script's entry point. `node dist/index.js` hashes `dist/index.js`, so a server
  split across many modules is covered only as far as its first file.

`--no-provenance` skips every lookup, for an air-gapped run. Exact pins are kept either way.

## Version 2: the root stopped naming a protocol

Version 1 keyed everything under `servers`. That made the format MCP's rather than the
product's: an agent's grants, an OpenAPI surface or a token's scopes had nowhere to live
without a second root key and a second diff path beside it. The pipeline was already general
by then, which is the awkward part. The diff engine does not contain the string "MCP", and
severity, policy, approval and the audit log have never cared what they were ruling on. One
word in one type was the only thing tying the product to one protocol.

So version 2 keys everything under `subjects`, each saying what it is:

```json
{
  "lockfileVersion": 2,
  "subjects": {
    "filesystem": { "kind": "mcp-server", "source": {...}, "tools": [...] }
  }
}
```

`LockedSubject` is a union of one today. A second kind is a new member of it, and every switch
over the result stops compiling until it handles the new branch, which is the behaviour worth
having: a surface that silently passed through unsealed would be the failure that mattered.

**A version 1 file is upgraded on read, not refused**, and the upgrade is lossless. `kind` sits
outside every digest, because `reseal()` covers a named list of fields rather than spreading
the entry. So an upgraded lock reseals to exactly the digests it already carried, and
`nulladrift check` against an unchanged server still exits 0. Nobody sees drift that is really
a rename.

That property is not incidental. It is why the change could be made silently, and it is worth
re-checking if the digest ever starts covering the whole entry instead of a named list.
