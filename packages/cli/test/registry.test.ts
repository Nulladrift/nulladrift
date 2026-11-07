/**
 * Building the corpus: which registry entries become targets, and what the ones that do not are
 * counted as. A miscount here does not fail anything -- it quietly changes the denominator of
 * the coverage figure the drift report publishes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCorpus } from "../src/crawl/registry";

function entry(name: string, server: Record<string, unknown>, isLatest = true): unknown {
  return {
    server: { name, version: "1.0.0", ...server },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest } },
  };
}

const PAGE = {
  servers: [
    entry("both-transports", {
      // Deliberately deprecated-first, which is how a publisher who added Streamable HTTP later writes it.
      remotes: [
        { type: "sse", url: "https://a.example/sse" },
        { type: "streamable-http", url: "https://a.example/mcp" },
      ],
    }),
    entry("npm-pinned", { packages: [{ registryType: "npm", identifier: "pkg-a", version: "1.0.0" }] }),
    entry("npm-unpinned", { packages: [{ registryType: "npm", identifier: "pkg-b" }] }),
    entry("pypi-packaged", { packages: [{ registryType: "pypi", identifier: "pkg-c", version: "1.0.0" }] }),
    entry("superseded", { remotes: [{ type: "streamable-http", url: "https://old.example/mcp" }] }, false),
  ],
  metadata: {},
};

function mockRegistry(page: unknown = PAGE) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response(JSON.stringify(page))));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the corpus", () => {
  it("prefers Streamable HTTP and keeps the rest as fallbacks", async () => {
    mockRegistry();
    const corpus = await fetchCorpus();

    // `remotes[0]` is publisher order. Dialling only that counted a live server as unreachable
    // whenever its deprecated endpoint happened to be listed first.
    expect(corpus.targets.map((target) => target.name)).toEqual(["both-transports"]);
    expect(corpus.targets[0]?.transport).toMatchObject({ type: "http", url: "https://a.example/mcp" });
    expect(corpus.targets[0]?.alternates).toEqual([{ type: "sse", url: "https://a.example/sse", headers: {} }]);
  });

  it("counts the stdio entries no sandbox can express, even when stdio is not being run", async () => {
    mockRegistry();
    const { stats } = await fetchCorpus();

    // The classification used to sit below the --include-stdio gate, so a default run reported
    // zero unsupported packages -- which reads as "all of them were fine", not "none were asked".
    expect(stats.stdioOnly).toBe(3);
    expect(stats.stdioUnsupported).toBe(2);
    expect(stats.stdioSandboxed).toBe(0);
  });

  it("takes the pinned npm package once stdio is included, and still refuses the others", async () => {
    mockRegistry();
    const corpus = await fetchCorpus({ includeStdio: true });

    expect(corpus.targets.map((target) => target.name).sort()).toEqual(["both-transports", "npm-pinned"]);
    expect(corpus.stats.stdioSandboxed).toBe(1);
    expect(corpus.stats.stdioUnsupported).toBe(2);
  });

  it("skips entries that are not the current version of their name", async () => {
    mockRegistry();
    expect((await fetchCorpus()).stats.latest).toBe(4);
  });

  it("identifies itself to the registry", async () => {
    const fetchMock = mockRegistry();
    await fetchCorpus();

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/^nulladrift\/\d+\.\d+\.\d+ \(\+https:\/\//);
  });

  it("records that paging stopped at the cap, so a short corpus is not read as a shrinking one", async () => {
    mockRegistry({ ...PAGE, metadata: { nextCursor: "more" } });
    expect((await fetchCorpus({ maxPages: 1 })).stats.truncated).toBe(true);
  });

  it("is not truncated when the walk reaches the end of the registry", async () => {
    mockRegistry();
    expect((await fetchCorpus()).stats.truncated).toBe(false);
  });
});
