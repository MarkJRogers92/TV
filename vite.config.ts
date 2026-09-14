import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.MARKTV_VITE_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${process.env.MARKTV_PORT ?? 4177}` },
  },
});
