import { defineConfig } from "tsup";

/*
 * Subpath entries, not a single bundle. The CLI and the control plane both import narrow paths
 * (`@nulladrift/core/lock/canonical`, `@nulladrift/core/diff/schema`), and collapsing those into
 * one entry would make every consumer pull the whole engine to canonicalize one object.
 *
 * `dts` is not optional here: the control plane consumes this from npm as compiled JavaScript,
 * and the types are the contract that keeps both sides reaching the same answer.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/changes.ts", "src/lock/*.ts", "src/diff/*.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
});
