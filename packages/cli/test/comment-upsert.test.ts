/**
 * Which comment `check --comment` replaces.
 *
 * It took the first comment starting with its marker, whoever wrote it. Anybody can comment on a
 * public pull request, so the marker posted first by somebody else meant the edit was refused and
 * the findings never appeared -- or the edit was allowed and the findings landed in a comment that
 * person could rewrite afterwards. Found in a security review.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { upsertComment } from "../src/report/comment";

const MARKER = "<!-- nulladrift:surface -->";

interface Seen {
  method: string;
  path: string;
}

async function github(options: { self?: string; comments: Array<{ id: number; body: string; user: { login: string; type: string } }>; patchStatus?: number }) {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    seen.push({ method: request.method ?? "GET", path });
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    request.resume();
    request.on("end", () => {
      if (path === "/user") return options.self ? json(200, { login: options.self }) : json(403, { message: "Resource not accessible by integration" });
      if (request.method === "GET" && path.startsWith("/repos/acme/web/issues/7/comments")) return json(200, options.comments);
      if (request.method === "PATCH") return json(options.patchStatus ?? 200, {});
      if (request.method === "POST") return json(201, { id: 999 });
      return json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const target = { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, repo: "acme/web", issue: 7, token: "t" };
  return { seen, target };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const writes = (seen: Seen[]) => seen.filter((request) => request.method === "PATCH" || request.method === "POST");

describe("the comment it replaces", () => {
  it("leaves a marked comment somebody else wrote alone, and posts its own", async () => {
    const { seen, target } = await github({ comments: [{ id: 99, body: `${MARKER}\nnothing to see`, user: { login: "drive-by-commenter", type: "User" } }] });

    expect(await upsertComment(target, "findings")).toBe("created");
    expect(writes(seen)).toEqual([{ method: "POST", path: "/repos/acme/web/issues/7/comments" }]);
  });

  it("replaces its own, as the workflow's bot", async () => {
    const { seen, target } = await github({
      comments: [
        { id: 99, body: `${MARKER}\nplanted`, user: { login: "drive-by-commenter", type: "User" } },
        { id: 100, body: `${MARKER}\nlast run`, user: { login: "github-actions[bot]", type: "Bot" } },
      ],
    });

    expect(await upsertComment(target, "findings")).toBe("updated");
    expect(writes(seen)).toEqual([{ method: "PATCH", path: "/repos/acme/web/issues/comments/100" }]);
  });

  it("replaces its own, as the person a personal token belongs to", async () => {
    const { seen, target } = await github({ self: "release-bot", comments: [{ id: 5, body: `${MARKER}\nlast run`, user: { login: "release-bot", type: "User" } }] });

    expect(await upsertComment(target, "findings")).toBe("updated");
    expect(writes(seen)).toEqual([{ method: "PATCH", path: "/repos/acme/web/issues/comments/5" }]);
  });

  it("posts a new comment when its own can no longer be edited", async () => {
    const { seen, target } = await github({ comments: [{ id: 100, body: `${MARKER}\nlast run`, user: { login: "github-actions[bot]", type: "Bot" } }], patchStatus: 403 });

    expect(await upsertComment(target, "findings")).toBe("created");
    expect(writes(seen).map((request) => request.method)).toEqual(["PATCH", "POST"]);
  });
});

/*
 * Only the first page of comments was read (`?per_page=100`), so on a pull request with more than a
 * hundred, the comment this tool posted earlier was not found and a second one was posted, then a
 * third, one per run. Found in an audit.
 */
describe("a busy pull request", () => {
  async function paged(pages: Array<Array<{ id: number; body: string; user: { login: string; type: string } }>>) {
    const seen: Seen[] = [];
    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      seen.push({ method: request.method ?? "GET", path: `${url.pathname}${url.search}` });
      const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      request.resume();
      request.on("end", () => {
        if (url.pathname === "/user") return json(403, {});
        if (request.method === "GET") return json(200, pages[Number(url.searchParams.get("page") ?? "1") - 1] ?? []);
        return json(request.method === "POST" ? 201 : 200, {});
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return { seen, target: { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, repo: "acme/web", issue: 7, token: "t" } };
  }
  const others = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: from + index, body: "lgtm", user: { login: "reviewer", type: "User" } }));

  it("finds its own comment past the first hundred, and replaces it", async () => {
    const { seen, target } = await paged([others(1, 100), [...others(101, 20), { id: 500, body: `${MARKER}\nlast run`, user: { login: "github-actions[bot]", type: "Bot" } }]]);
    expect(await upsertComment(target, "findings")).toBe("updated");
    expect(writes(seen)).toEqual([{ method: "PATCH", path: "/repos/acme/web/issues/comments/500" }]);
  });

  it("stops reading after a bounded number of pages", async () => {
    const { seen, target } = await paged(Array.from({ length: 50 }, (_, page) => others(page * 100 + 1, 100)));
    expect(await upsertComment(target, "findings")).toBe("created");
    expect(seen.filter((request) => request.method === "GET" && request.path.includes("/comments")).length).toBeLessThanOrEqual(10);
  });
});
