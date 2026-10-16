import { defineConfig } from "tsup";

// The SDK build cleans first; this second build adds the CLI without deleting SDK artifacts.
export default defineConfig({
  entry: ["src/mcp.ts"],
  format: ["esm"],
  target: "node20",
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  clean: false,
  external: ["./index.js"],
  noExternal: [/^@modelcontextprotocol\//, /^zod(?:\/|$)/],
  esbuildOptions(options) {
    // This process runs on Node only; browser user-agent detection is unreachable here.
    options.define = { ...options.define, navigator: "undefined" };
  },
});
