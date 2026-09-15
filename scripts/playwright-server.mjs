import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "marktv-playwright-"));
const port = process.env.MARKTV_PLAYWRIGHT_PORT ?? "4177";
const server = spawn(process.execPath, ["dist-server/src/server/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, MARKTV_DATA_DIR: dataDir, MARKTV_PORT: port },
  stdio: "inherit",
});
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  if (!server.killed) server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await rm(dataDir, { recursive: true, force: true });
  process.exit(code);
};
server.once("exit", async (code) => {
  if (!stopping) {
    await rm(dataDir, { recursive: true, force: true });
    process.exit(code ?? 1);
  }
});
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
