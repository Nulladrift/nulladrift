# What else pins MCP capabilities, and what it covers

This category was empty when the project was scoped. It is not any more, and it filled faster
than this page did. This is what the alternatives actually cover, so the positioning rests on
something checkable.

**Re-measured 6 November 2026, and the result corrected two claims this project had been
making.** See [What is actually different](#what-is-actually-different). The October reading
found one serious competitor. There are now six.

**Updated 8 November 2026 for nulladrift 0.6.0**, which closed two gaps this page recorded
against it: it pins the artifact behind each stdio server, and a reading can carry the CI
provider's signed identity. Only nulladrift's column changed. The other tools were not
re-measured.

## Method

Each tool is measured against a fixture server that emits **one isolated change at a time**
([`packages/cli/test/fixtures/servers/wire-server.mjs`](../packages/cli/test/fixtures/servers/wire-server.mjs),
the `v-*` variants). A bundle of changes only tells you whether something was noticed, not which
of them did it.

| Variant | Field it changes |
| --- | --- |
| `v-desc` | tool `description` |
| `v-schema` | tool `inputSchema` |
| `v-annotation` | tool `annotations` (drops `destructiveHint`) |
| `v-output` | tool `outputSchema` |
| `v-title` | tool `title` |
| `v-header` | tool `inputSchema` (adds `x-mcp-header`) |
| `v-identity` | server `serverInfo.version` |
| `v-tooladded` | the tool set |
| `v-instructions` | server `instructions` |

**nulladrift and the Vercel AI SDK were run** against all nine. The AI SDK's `fingerprintTools`
is a library call, so it was driven directly with a `ToolSet` built the way its own MCP client
builds one.

**Every other tool is derived from its capture and comparison source**, not executed. The
derivation is mechanical rather than a guess: a tool cannot detect a change to a field it does
not capture, and each one states its captured set as a literal, a dataclass or a struct. Where a
tool diffs a whole canonical tree rather than a field list, it is credited with every field that
tree contains.

The method validates against itself: for the AI SDK, the one competitor that could be run, the
prediction from its hashed fields matched the measured result on all nine variants, including the
non-obvious one. That is the reason to trust the same derivation elsewhere, and the reason to
keep marking it as derived.

### What was measured, and at which commit

| Tool | Version / commit | Read |
| --- | --- | --- |
| `ai` (Vercel AI SDK) | `7.0.154` | `fingerprintTools`, `detectToolDrift` |
| `toolgate-pin` | `0.1.0` | `canon.py` |
| `mcpseal` | `0.1.4` | `cli-core/dist/hash.js` |
| `mcpdrift` (`calasdan-sketch`) | `71eb787`, 2026-10-21 | `canon.py`, `client.py` |
| `mcplock` (`xuange-hu`) | `f272cde`, 2026-11-02 | `snapshot.py`, `diff.py`, `capture.py` |
| `mcplock` (`nkwib`) | `34fb821`, 2026-10-11 | `hash.ts`, `canonicalize.ts` |
| `legion-lock` | `e594eb6`, 2026-10-12 | `legion_lock.py` |
| `MCPTrust` | `048aff0`, 2025-12-23 | `models/lockfile*.go`, `locker/hasher_v3.go` |

Nothing below was executed. No dependency of any cloned repository was installed.

## Not in this category

**`mcp-warden`** does not pin anything. Its own description is "Policy enforcement and guardrails
for MCP-compatible tool execution", and its modules are an interceptor, a rate limiter, a circuit
breaker, a PII redactor and an injection scanner. It contains no hashing primitives whatsoever.
Secondary coverage describing it as writing a `warden.lock` is simply wrong. It is a runtime
proxy, which is complementary rather than competing.

**`ftaakash/MCP-Lock`** (`26d9580`) is provenance, not drift. It reads npm attestations and PyPI
provenance documents to verify what a package *is* before install. That is the layer `npm audit`
and OSV occupy. Since 0.6.0 this project pins the same artifacts by content address and reports
when they change, but it verifies no attestation: MCP-Lock asks who built a package, nulladrift
asks whether it is still the bytes you approved. Worth watching anyway: see
[Provenance](#the-gap-that-runs-the-other-way).

## Coverage

✅ detected · ❌ missed. **Measured** for nulladrift and the AI SDK; **derived from source** for
the rest.

| Isolated change | nulladrift | mcpdrift | mcplock<br/>xuange | mcplock<br/>nkwib | toolgate-pin | AI SDK | mcpseal | legion-lock | MCPTrust |
| --- | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: | :--: |
| Tool description | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool input schema | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `x-mcp-header` on a parameter | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool added | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool title | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Tool output schema | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Tool annotations (dropped `destructiveHint`) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Server `serverInfo.version` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Server `instructions`** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Missed, of nine** | **0** | **1** | 2 | 2 | 2 | 4 | 5 | 5 | 5 |

`mcplock` (xuange-hu) and MCPTrust both compare `serverInfo.name` and neither compares
`serverInfo.version` — `_diff_protocol` ends at `server_name_changed`, and `builder_v3.go` reads
`report.ServerInfo.Name` alone. A server shipping a new version under the same name is invisible
to both, which is the postmark-mcp signal exactly.

Beyond the per-change table:

| | nulladrift | mcpdrift | mcplock<br/>xuange | mcplock<br/>nkwib | legion-lock | MCPTrust |
| --- | :--: | :--: | :--: | :--: | :--: | :--: |
| Prompts | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Resources | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Resource templates | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Declared capabilities | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Transport / launch command | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Protocol revision `2026-07-28` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Severity classification | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| SARIF | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Committed lockfile | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Readable content, not only digests | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| OAuth / credentialled servers | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Reads existing client configs | 7 formats | limited | limited | `.mcp.json` | ❌ | limited |
| **Signed readings** | **◐¹** | ❌ | ❌ | ❌ | **✅** | **✅** |
| **Third-party attestation** | **❌** | ❌ | ❌ | ❌ | **✅** | ❌ |
| **Artifact / provenance pinning** | **✅** | ❌ | ❌ | ❌ | ❌ | **✅** |
| Tool-poisoning scanner | ✅² | ❌ | ✅ | ❌ | ❌ | ❌ |
| Runtime enforcement | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

◐ partly. ¹ Since 0.6.0, `push` sends the CI provider's signed OpenID Connect token and the
control plane verifies it, so the repository, ref and commit are recorded as GitHub or GitLab
stated them. That proves which build sent a reading, not that its contents are what the server
declared: nothing signs the reading itself. See
[the gap that runs the other way](#the-gap-that-runs-the-other-way).
² The steering scan flags text in a declared surface that addresses the model: directives,
credential paths, exfiltration, hidden markup. It never fails a build and does not judge
intent.

## The ones worth reading properly

### `mcpdrift` — now the closest competitor

It does not hash a field list. `build_surface` folds `serverInfo.name`, `serverInfo.version`,
declared capabilities, every tool, every resource and every prompt into one canonical tree, and
`diff_surfaces` walks it. Anything in that tree is covered, which is why it misses exactly one of
the nine.

```python
"server": {
    "name": init.get("serverInfo", {}).get("name"),
    "version": init.get("serverInfo", {}).get("version"),
    "capabilities": init.get("capabilities", {}),
},
"tools": _index_by(tools, "name", "tool#"),
"resources": _index_by(resources or [], "uri", "resource#"),
"prompts": _index_by(prompts or [], "name", "prompt#"),
```

The one it misses is `instructions`, which is not in `build_surface`. It also has no severity
model, no SARIF, no resource templates and drives the connection with `initialize`.

In October this project recorded `mcp-drift` as "not published, 0 stars, nothing to compare
against." That was true of a different repository with a similar name, and it is not true of
this one. The lesson is in the method, not the result: a dismissal needs re-reading at the same
cadence as a comparison.

### `mcplock` (xuange-hu) — the most complete product

Captures tools with all six fields, plus prompts, resources, resource templates, declared
capabilities and protocol version. It classifies every change `BREAKING` / `RISKY` / `SAFE` /
`NEW`, defaults unknown changes to `BREAKING`, diffs schemas down to individual arguments
(`arg_type_widened`, `arg_enum_widened`, `arg_became_required`), emits SARIF 2.1.0, and ships a
prompt-injection scanner in `risk.py`.

It is the only other tool here with a severity model *and* SARIF, and its argument-level schema
diffing is finer-grained than this project's. What it does not have is `instructions`,
`serverInfo.version` and `2026-07-28`.

### `legion-lock` — the only one with outside evidence

Three fields, which is the weakest capture on this page:

```python
FIELDS = ("name", "description", "inputSchema")
```

The interesting part is not the capture. Fingerprints come from the LEGION transparency log, the
lockfile carries the inclusion proofs, and `verify` re-checks them offline against a pinned root.
So its answer to *how do I know this reading is real* is a signed record from somebody who is not
you, which is an answer this project does not have at all.

Its own README concedes the weakness: a single observer, run by LEGION, with Bitcoin anchoring
still pending. One observer you must trust is not the same as a witnessed log. It is still more
than nothing, and nothing is what we have.

### `MCPTrust` — the enforcement product

A Go runtime proxy. Its lockfile hashes two tool fields:

```go
type ToolLock struct {
	DescriptionHash string    `json:"description_hash"`
	InputSchemaHash string    `json:"input_schema_hash"`
	RiskLevel       RiskLevel `json:"risk_level"`
}
```

Thin on capture, and not really the point: it pins the artifact as well as the surface, signs
with Sigstore or Ed25519 including keyless CI signing through GitHub OIDC, evaluates CEL policy,
emits OpenTelemetry traces, and blocks any tool not in the lockfile at call time.

It normalizes line endings and trims trailing whitespace before hashing. Like `toolgate-pin`'s
NFC-plus-collapse, that is a reasonable anti-noise measure and also a gap: whitespace is a usable
obfuscation channel in text that reaches a model. This project hashes descriptions byte for byte.

## What is actually different

Two claims this project made in October are **wrong** and have been corrected here, in the README
and on the public site.

**Wrong: "resources, resource templates, prompts, declared capabilities and `serverInfo` are
pinned here and nowhere else."** `mcplock` captures all five. `mcpdrift` captures four of five.
MCPTrust captures prompts and resource templates. This was true when written and stopped being
true within about three weeks.

**Wrong: SARIF is unique.** `mcplock` emits SARIF 2.1.0 to the same consumer.

What survives, measured:

1. **`instructions`.** The text a client places in the model's *system prompt*, which a server can
   rewrite without touching a tool. **Nine tools examined, one captures it.** For a
   prompt-injection threat model it is the highest-value field on the wire, and it is unguarded
   everywhere else.
2. **Currency with the specification.** Revision `2026-07-28` removed `initialize`. Every other
   tool here drives the connection with it, so against a modern-only server they do not miss a
   field, they fail to connect. Nobody else has shipped `server/discover`.
3. **`serverInfo.version`**, which only `mcpdrift` also catches — and the two tools that do look
   at `serverInfo` compare the name and not the version, which is the postmark-mcp signal missed
   precisely.
4. **The diff is the output.** `mcpdrift`, both `mcplock`s and this project store readable
   content; `legion-lock` and MCPTrust store digests only. The resolved `behavior` block is the
   sharpest case: everyone detects a removed `readOnlyHint` as a changed hash, and only a resolved
   view shows it as `"destructive": false → true` rather than as a deleted line that reads like
   the server claiming *less*.

0.6.0 closed two gaps rather than opening a lead. Pinning the artifact and a CI-signed origin
are both things MCPTrust already did, which is why they appear in the table above and not in
this list.

Tool-definition hashing is solved several times over. The margin is now one field, one protocol
revision and the legibility of the artifact — and the first two are an afternoon's work for
anyone who reads this page.

## The gap that runs the other way

Three tools here answer a question this project cannot: **how do you know the reading is real?**

legion-lock has transparency-log proofs. MCPTrust has Sigstore and keyless CI signing.
`ftaakash/MCP-Lock` has npm and PyPI attestations. Since 0.6.0 nulladrift has half an answer: a
reading can carry the CI provider's signed identity, so *which build sent this* is GitHub's or
GitLab's statement rather than ours, and an organization can require every reading to come from a
build it trusts. The other half is still missing: no signature over the reading itself, no
attestation of the artifacts it pins, no external observer. What the server said is
self-observed and self-asserted: our collector reads it, our control plane re-digests it, our
code enforces append-only, our database holds the row.

That is tolerable for drift detection, where the lockfile sits in a repository the reader already
trusts. It is weaker for the thing the hosted product sells, which is evidence somebody hands an
auditor. The design for signing the reading itself, and the decision not to build it yet, are
recorded with the product documentation, which is not in this repository.

## Where an alternative is the better choice

- **Already on the Vercel AI SDK and only want tool drift:** use `fingerprintTools`. It is on the
  default path and costs nothing to adopt. You will need to store the baseline and decide what to
  do yourself.
- **Want enforcement at call time:** MCPTrust. This project observes and records by design and
  will not block a call; that is a standing decision, not an unbuilt feature.
- **Want evidence from somebody who is not the audited party:** legion-lock, with its single
  observer understood.
- **Want a scanner that judges whether a description is malicious:** `toolgate-pin` or `mcplock`.
  This project ranks severity by shape and flags text addressed to the model, but never fails a
  build on it and does not judge intent.
- **Want to verify who built a package, or whether it is vulnerable:** `ftaakash/MCP-Lock` for
  attestations, `npm audit` and OSV for advisories. This project pins the bytes a server runs and
  reports when they change; it checks neither.

## What follows from this

Two options worth weighing, neither taken.

- **Interoperate with the AI SDK** rather than compete. It is on the default path and has no
  baseline store; an importer between `fingerprintTools` maps and `mcp.lock` would turn the
  incumbent into an entry point.
- **Contribute `instructions` and `2026-07-28` upstream** to `mcpdrift` or `mcplock` and compete
  on the control plane instead. The field-coverage lead is the most copyable thing here and the
  least of what a customer pays for.
