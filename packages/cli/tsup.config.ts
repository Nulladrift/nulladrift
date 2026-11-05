import { defineConfig } from "tsup";

export default defineConfig({
  // One entry: the whole product is `npx nulladrift`.
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
});
