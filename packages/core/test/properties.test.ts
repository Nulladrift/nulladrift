/**
 * Properties of the diff engine and the lock's digests, checked against generated lockfiles rather
 * than hand-picked ones.
 *
 * The example tests beside this one pin what each change looks like. These pin what must hold for
 * every input: a lock compared with itself is clean, the order a file happens to list things in is
 * never a change, every change is one the taxonomy defines, and pinning a package to an exact
 * release is low while unpinning it is high. fast-check shrinks a failure to the smallest lock
 * that breaks the property and prints the seed that reproduces it.
 *
 * Every property's body is a block, never a bare `expect(...)` expression: Vitest's matchers return
 * a value that fast-check counts as a failure, so `(l) => expect(x).toEqual([])` fails on its first
 * input however correct x is.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diffLockfiles } from "../src/diff";
import { CHANGE_KINDS, SEVERITIES, sortChanges, type Change } from "../src/diff/types";
import { canonicalize, digest, toJson } from "../src/lock/canonical";
import type { JsonValue, LockedMcpServer, LockedProvenance, LockedTransport, Lockfile } from "../src/lock/types";
import { lock, server, tool } from "./builders";

// --- Generators -------------------------------------------------------------------------------

const word = fc.stringMatching(/^[a-z][a-z0-9_]{0,9}$/);
const semver = fc.tuple(fc.nat(40), fc.nat(40), fc.nat(40)).map(([a, b, c]) => `${a}.${b}.${c}`);
const npmName = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/),
  fc.tuple(fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/), fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/)).map(([scope, name]) => `@${scope}/${name}`),
);

const schema = fc
  .uniqueArray(fc.tuple(word, fc.constantFrom("string", "number", "integer", "boolean")), { maxLength: 3, selector: ([name]) => name })
  .chain((props) =>
    fc.subarray(props.map(([name]) => name)).map((required) => ({
      type: "object",
      properties: Object.fromEntries(props.map(([name, type]) => [name, { type }])),
      ...(required.length ? { required } : {}),
    })),
  );

const tools = fc.uniqueArray(
  fc.record({ name: word, description: fc.option(fc.lorem({ maxCount: 6 }), { nil: undefined }), inputSchema: schema, readOnly: fc.boolean() }),
  { maxLength: 4, selector: (t) => t.name },
);

const transport: fc.Arbitrary<LockedTransport> = fc.oneof(
  fc.record({ type: fc.constant("stdio" as const), command: fc.constantFrom("npx", "uvx", "node", "docker"), args: fc.array(fc.stringMatching(/^[a-z@./-][a-z0-9@./=-]{0,15}$/), { maxLength: 3 }) }),
  fc.record({ type: fc.constantFrom("http" as const, "sse" as const), url: fc.stringMatching(/^https:\/\/[a-z]{1,10}\.example\/[a-z]{0,8}$/) }),
);

// A server named after its key, so two servers in one lock never have the same contents.
const entry = (key: string) =>
  fc.record({ transport, version: semver, tools }).map(({ transport, version, tools }) =>
    server({
      transport,
      serverInfo: { name: key, version },
      tools: tools.map((t) => tool(t.name, { description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly } })),
    }),
  );

const lockfile: fc.Arbitrary<Lockfile> = fc
  .uniqueArray(word, { maxLength: 5 })
  .chain((keys) => fc.tuple(...keys.map(entry)).map((entries) => lock(Object.fromEntries(keys.map((key, i) => [key, entries[i]!])))));

// --- Helpers ----------------------------------------------------------------------------------

/** The changes as a comparable set: sortChanges leaves ties in input order, so sort them fully. */
const asSet = (changes: Change[]) => changes.map((c) => JSON.stringify([c.kind, c.severity, c.server, c.member ?? "", c.summary])).sort();

/** The same lock with its servers listed in another order. */
const reordered = (l: Lockfile, order: number[]): Lockfile => {
  const entries = Object.entries(l.subjects);
  return lock(Object.fromEntries(order.map((i) => entries[i]!)) as Record<string, LockedMcpServer>);
};

/** A permutation of 0..n-1. */
const permutation = (n: number) => fc.shuffledSubarray([...Array(n).keys()], { minLength: n, maxLength: n });

/** A JSON value with every object's keys put in another order, all the way down. */
function shuffleKeys(value: JsonValue, rotate: number): JsonValue {
  if (Array.isArray(value)) return value.map((v) => shuffleKeys(v, rotate));
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value);
  const turned = keys.map((_, i) => keys[(i + rotate) % keys.length]!).reverse();
  return Object.fromEntries(turned.map((k) => [k, shuffleKeys((value as Record<string, JsonValue>)[k]!, rotate)]));
}

// --- Properties -------------------------------------------------------------------------------

describe("comparing a lock", () => {
  it("with itself finds nothing", () => {
    fc.assert(
      fc.property(lockfile, (l) => {
        expect(diffLockfiles(l, l)).toEqual([]);
      }),
    );
  });

  it("with a copy of itself finds nothing: no change depends on object identity", () => {
    fc.assert(
      fc.property(lockfile, (l) => {
        expect(diffLockfiles(l, structuredClone(l))).toEqual([]);
      }),
    );
  });

  it("does not depend on the order either lock lists its servers in", () => {
    fc.assert(
      fc.property(
        lockfile.chain((a) => fc.tuple(fc.constant(a), permutation(Object.keys(a.subjects).length))),
        lockfile.chain((b) => fc.tuple(fc.constant(b), permutation(Object.keys(b.subjects).length))),
        ([a, aOrder], [b, bOrder]) => {
          expect(asSet(diffLockfiles(reordered(a, aOrder), reordered(b, bOrder)))).toEqual(asSet(diffLockfiles(a, b)));
        },
      ),
    );
  });

  it("finds nothing when only the order of a server's tools changed", () => {
    fc.assert(
      fc.property(
        lockfile.chain((l) => fc.tuple(fc.constant(l), fc.array(fc.nat(), { minLength: 5, maxLength: 5 }))),
        ([l, turns]) => {
          const turned = lock(
            Object.fromEntries(
              Object.entries(l.subjects).map(([key, s], i) => {
                const list = s.tools ?? [];
                const k = list.length ? turns[i]! % list.length : 0;
                return [key, server({ ...s, tools: [...list.slice(k), ...list.slice(0, k)] })];
              }),
            ),
          );
          expect(diffLockfiles(l, turned)).toEqual([]);
        },
      ),
    );
  });

  it("reports only changes the taxonomy defines, each on a server in one of the locks, each in one line, in order", () => {
    fc.assert(
      fc.property(lockfile, lockfile, (a, b) => {
        const changes = diffLockfiles(a, b);
        const servers = new Set([...Object.keys(a.subjects), ...Object.keys(b.subjects)]);
        for (const c of changes) {
          expect(CHANGE_KINDS).toContain(c.kind);
          expect(SEVERITIES).toContain(c.severity);
          expect(servers.has(c.server), `change on "${c.server}", which neither lock has`).toBe(true);
          expect(c.summary.trim().length).toBeGreaterThan(0);
          expect(c.summary).not.toMatch(/\n/);
        }
        expect(changes).toEqual(sortChanges(changes));
      }),
    );
  });

  it("against an empty lock adds or removes every server, and does nothing else", () => {
    fc.assert(
      fc.property(lockfile, (l) => {
        const keys = Object.keys(l.subjects).sort();
        const empty = lock({});
        expect(diffLockfiles(empty, l).map((c) => [c.kind, c.server]).sort()).toEqual(keys.map((k) => ["server.added", k]));
        expect(diffLockfiles(l, empty).map((c) => [c.kind, c.server]).sort()).toEqual(keys.map((k) => ["server.removed", k]));
      }),
    );
  });

  it("with one server moved to a new name, unchanged, reports that rename and nothing else", () => {
    fc.assert(
      fc.property(
        lockfile.filter((l) => Object.keys(l.subjects).length > 0).chain((l) => fc.tuple(fc.constant(l), fc.nat(), word.filter((w) => !(w in l.subjects)))),
        ([l, pick, fresh]) => {
          const keys = Object.keys(l.subjects);
          const old = keys[pick % keys.length]!;
          const moved = lock(Object.fromEntries(keys.map((k) => [k === old ? fresh : k, l.subjects[k]!])) as Record<string, LockedMcpServer>);
          expect(diffLockfiles(l, moved).map((c) => [c.kind, c.server, c.before])).toEqual([["server.renamed", fresh, old]]);
        },
      ),
    );
  });
});

describe("a command that names its own package", () => {
  const npm = (name: string, version: string, requested?: string): LockedProvenance => ({
    ecosystem: "npm",
    name,
    version,
    integrity: `sha512-${version}`,
    ...(requested === undefined ? {} : { requested }),
  });
  const pair = (name: string, was: string, now: string, version: string) =>
    diffLockfiles(
      lock({ s: server({ transport: { type: "stdio", command: "npx", args: ["-y", was] }, provenance: npm(name, version) }) }),
      lock({ s: server({ transport: { type: "stdio", command: "npx", args: ["-y", now] }, provenance: npm(name, version) }) }),
    ).find((c) => c.kind === "server.transport.changed");

  // How a command asks for a package without naming one exact release.
  const floating = (name: string) => fc.oneof(fc.constant(name), fc.constant(`${name}@latest`), semver.map((v) => `${name}@^${v}`), semver.map((v) => `${name}@~${v}`));

  it("is a low change when it comes to name one exact release, from any other spelling", () => {
    fc.assert(
      fc.property(npmName, semver, semver, (name, running, pinned) => {
        fc.assert(
          fc.property(floating(name), (was) => {
            expect(pair(name, was, `${name}@${pinned}`, running)?.severity).toBe("low");
          }),
          { numRuns: 4 },
        );
        // and an upgrade of a pin, to another exact release
        expect(pair(name, `${name}@${running}`, `${name}@${pinned}`, running)?.severity ?? "none").toBe(running === pinned ? "none" : "low");
      }),
    );
  });

  it("is a high change when it stops naming one exact release", () => {
    fc.assert(
      fc.property(npmName, semver, (name, version) => {
        fc.assert(
          fc.property(floating(name), (now) => {
            expect(pair(name, `${name}@${version}`, now, version)?.severity).toBe("high");
          }),
          { numRuns: 4 },
        );
      }),
    );
  });

  it("is a high change when the exact release it names is another package's", () => {
    fc.assert(
      fc.property(npmName, npmName, semver, (name, other, version) => {
        fc.pre(other !== name);
        expect(pair(name, name, `${other}@${version}`, version)?.severity).toBe("high");
      }),
    );
  });
});

describe("a lock's digest", () => {
  it("does not depend on the order an object's keys are written in", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), fc.nat(5), (value, rotate) => {
        const json = toJson(value);
        expect(canonicalize(shuffleKeys(json, rotate))).toBe(canonicalize(json));
        expect(digest(shuffleKeys(json, rotate))).toBe(digest(json));
      }),
    );
  });
});
