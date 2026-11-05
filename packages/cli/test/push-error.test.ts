/**
 * What a refused push says.
 *
 * Its own test because the case that matters is the one nobody is watching for: the project
 * limit is checked only when a reading names a project that does not exist yet, so the build
 * that meets it is a new repository's first build, run by somebody who has never seen this tool.
 * A message they cannot act on sends them looking for a bug that is not there.
 */
import { describe, expect, it } from "vitest";
import { describeRefusal } from "../src/report/push-error";

const planLimit = JSON.stringify({
  error: {
    code: "plan_limit",
    message: "The team plan allows 10 projects. Remove one you are no longer using, or change plan at https://app.example/settings/billing.",
  },
});

describe("a reading refused by the plan", () => {
  it("is told apart from a failure", () => {
    expect(describeRefusal(402, planLimit).planLimit).toBe(true);
  });

  it("keeps the sentence the server wrote, which names the plan and where to change it", () => {
    const { text } = describeRefusal(402, planLimit);

    expect(text).toContain("The team plan allows 10 projects");
    expect(text).toContain("https://app.example/settings/billing");
  });

  it("says the build is not at fault, because the person reading it cannot fix the plan", () => {
    expect(describeRefusal(402, planLimit).text).toContain("Nothing is wrong with this build");
  });

  it("does not make the reader parse JSON to find the message", () => {
    const { text } = describeRefusal(402, planLimit);

    expect(text).not.toContain('"code"');
    expect(text).not.toContain("{");
  });
});

describe("every other refusal", () => {
  it("names a rejected token as a token problem", () => {
    const body = JSON.stringify({ error: { code: "unauthorized", message: "No such token" } });
    const { text, planLimit: isPlan } = describeRefusal(401, body);

    expect(isPlan).toBe(false);
    expect(text).toContain("refused this token");
    expect(text).toContain("No such token");
  });

  it("unwraps the envelope rather than printing it", () => {
    const body = JSON.stringify({ error: { code: "internal", message: "Internal server error" } });

    expect(describeRefusal(500, body).text).toBe("control plane answered 500: Internal server error");
  });

  it("survives a body that is not ours at all", () => {
    // A proxy, a load balancer or a captive portal answering with HTML.
    const { text, planLimit: isPlan } = describeRefusal(502, "<html><body>Bad Gateway</body></html>");

    expect(isPlan).toBe(false);
    expect(text).toContain("502");
    expect(text).toContain("Bad Gateway");
  });

  it("survives an empty body", () => {
    expect(() => describeRefusal(503, "")).not.toThrow();
  });

  it("does not mistake some other 402 for a plan limit", () => {
    const body = JSON.stringify({ error: { code: "payment_required", message: "Card declined" } });

    expect(describeRefusal(402, body).planLimit).toBe(false);
  });
});
