import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const dataDir = await mkdtemp(`${tmpdir()}/marktv-production-restart-`);

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a verification port.");
  return port;
}

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;

function startServer() {
  return spawn(process.execPath, ["dist-server/src/server/index.js"], {
    env: {
      ...process.env,
      MARKTV_DATA_DIR: dataDir,
      MARKTV_PORT: String(port),
      // The background schedule refresh writes schedules and export files. This
      // script asserts that a generated schedule survives a restart, so a refresh
      // running underneath it would replace the schedule under test.
      MARKTV_SCHEDULE_REFRESH: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer(child) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(
        `MarkTV exited before becoming ready (${child.exitCode}).`,
      );
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`MarkTV did not become ready: ${String(lastError)}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("MarkTV did not stop cleanly.")),
      5_000,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 || signal === "SIGTERM") resolve();
      else
        reject(
          new Error(`MarkTV stopped with code ${code}, signal ${signal}.`),
        );
    });
  });
}

let server;
try {
  server = startServer();
  await waitForServer(server);
  const health = await (await fetch(`${baseUrl}/api/v1/health`)).json();
  const ui = await (await fetch(baseUrl)).text();
  if (health.status !== "ok" || !ui.includes('<div id="root"></div>')) {
    throw new Error("Production health or UI response was invalid.");
  }

  const generatedResponse = await fetch(
    `${baseUrl}/api/v1/schedules/generate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: "marktv-laughs", date: "2026-09-13" }),
    },
  );
  if (!generatedResponse.ok)
    throw new Error(
      `Schedule generation failed (${generatedResponse.status}).`,
    );
  const generated = (await generatedResponse.json()).schedule;
  await stopServer(server);

  server = startServer();
  await waitForServer(server);
  const reopened = await (
    await fetch(`${baseUrl}/api/v1/schedules/latest?channelId=marktv-laughs`)
  ).json();
  if (
    generated.id !== reopened.id ||
    generated.entries.length !== reopened.entries.length
  ) {
    throw new Error("Restarted server did not preserve the latest schedule.");
  }
  console.log(
    JSON.stringify({
      dataSeeded: true,
      health: health.status,
      uiServed: true,
      scheduleId: reopened.id,
      entryCount: reopened.entries.length,
      restartPersisted: true,
      cleanShutdown: true,
    }),
  );
} finally {
  if (server) await stopServer(server).catch(() => server.kill("SIGKILL"));
  await rm(dataDir, { recursive: true, force: true });
}
