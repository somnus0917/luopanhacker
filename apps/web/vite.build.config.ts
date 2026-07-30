import { defineConfig } from "vite";

export default defineConfig({
  base: "/assets/",
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: "../../web/static",
    rollupOptions: {
      output: {
        assetFileNames: ({ name }) => name?.endsWith(".css") ? "style.css" : "[name][extname]",
        entryFileNames: "app.js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
