/**
 * Everything a release changes, done in one commit on the release branch.
 *
 * The version used to be bumped in whichever feature branch happened to be open, which is how
 * twelve versions reached the registry in fourteen hours -- 0.3.0 and 0.3.1 ten minutes apart,
 * for work that was one change. A version number is a promise to whoever installs it, and a
 * feature branch is the wrong place to decide what to promise: the author of one change cannot
 * see what else is going out beside it.
 *
 * So feature branches add a note under `## [Unreleased]` and nothing else, and this reads those
 * notes to decide what the release is. A section that adds something is a minor; one that only
 * fixes things is a patch. Pre-1.0, so neither is breaking by itself.
 *
 *   node scripts/prepare-release.mjs --check   say what would happen, change nothing
 *   node scripts/prepare-release.mjs           write it
 */
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const CHANGELOG = `${ROOT}CHANGELOG.md`;
const MANIFESTS = ["packages/cli/package.json", "packages/core/package.json"];
const VERSION_TS = "packages/cli/src/lib/version.ts";

const read = (p) => readFileSync(`${ROOT}${p}`, "utf8");
const write = (p, s) => writeFileSync(`${ROOT}${p}`, s);

/** The notes a release is made of: everything between `## [Unreleased]` and the entry below it. */
function unreleased(changelog) {
  const start = changelog.indexOf("## [Unreleased]");
  if (start < 0) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const after = changelog.indexOf("\n## [", start + 1);
  const body = changelog.slice(start + "## [Unreleased]".length, after < 0 ? undefined : after).trim();
  return { start, after, body };
}

/*
 * Anything that adds, changes or removes surface is a minor; a release that only fixes things is
 * a patch. Read from the notes rather than passed in, so the number cannot disagree with what the
 * release says it contains.
 */
function nextVersion(current, body) {
  const [major, minor, patch] = current.split(".").map(Number);
  const widens = /^###\s+(Added|Changed|Removed|Deprecated)/m.test(body);
  return widens ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

const changelog = read("CHANGELOG.md");
const { start, after, body } = unreleased(changelog);
const current = JSON.parse(read(MANIFESTS[0])).version;

if (body === "" || /^Nothing yet\.?$/i.test(body)) {
  console.log("nothing to release: ## [Unreleased] is empty");
  process.exit(3);
}

/*
 * A version already ahead of the last tag was prepared and not yet shipped. Bumping again would
 * burn a number for a release nobody ever saw, and npm never lets a version be reused.
 */
const released = (process.env["LATEST_TAG"] ?? "").replace(/^v/, "");
const version = released && released !== current ? current : nextVersion(current, body);
const date = new Date().toISOString().slice(0, 10);

console.log(`current ${current} · last released ${released || "unknown"} · releasing ${version}`);
if (process.argv.includes("--check")) {
  if (process.env["GITHUB_OUTPUT"]) writeFileSync(process.env["GITHUB_OUTPUT"], `version=${version}\n`, { flag: "a" });
  process.exit(0);
}

for (const manifest of MANIFESTS) {
  write(manifest, read(manifest).replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));
}
// Asserted by a test, so a mismatch fails the build rather than shipping a CLI that misreports itself.
write(VERSION_TS, read(VERSION_TS).replace(/export const VERSION = "[^"]+";/, `export const VERSION = "${version}";`));

write(
  "CHANGELOG.md",
  `${changelog.slice(0, start)}## [Unreleased]\n\nNothing yet.\n\n## [${version}] - ${date}\n\n${body}\n${after < 0 ? "" : changelog.slice(after + 1)}`,
);

if (process.env["GITHUB_OUTPUT"]) writeFileSync(process.env["GITHUB_OUTPUT"], `version=${version}\n`, { flag: "a" });
console.log(`prepared ${version}; run \`pnpm --filter nulladrift example:emit\` before committing`);
