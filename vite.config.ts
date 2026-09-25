import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "web",
  // React DOM can resolve React from a neighboring worktree in this checkout.
  // A second bundled React instance makes every hook fail at runtime.
  resolve: { dedupe: ["react", "react-dom"] },
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.MARKTV_VITE_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${process.env.MARKTV_PORT ?? 4177}` },
  },
});
