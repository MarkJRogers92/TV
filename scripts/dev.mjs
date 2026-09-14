import { spawn } from "node:child_process";
import { join } from "node:path";

const api = spawn(
  process.execPath,
  ["--watch", "--import", "tsx", "src/server/index.ts"],
  {
    env: { ...process.env, MARKTV_DEV: "1" },
    stdio: "inherit",
    cwd: process.cwd(),
  },
);
const vite = spawn(
  process.execPath,
  [join("node_modules", "vite", "bin", "vite.js")],
  {
    env: process.env,
    stdio: "inherit",
    cwd: process.cwd(),
  },
);
const children = [api, vite];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => {
    if (!child.killed) child.kill("SIGTERM");
  });
  process.exitCode = code;
};
children.forEach((child) => child.once("exit", (code) => stop(code ?? 0)));
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
