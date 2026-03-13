import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node18",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
