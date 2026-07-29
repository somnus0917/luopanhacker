import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: "../../web/static",
    lib: {
      entry: "src/main.ts",
      formats: ["iife"],
      name: "LuopanDashboard",
      fileName: () => "app.js",
    },
  },
});
