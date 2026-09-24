import Database from "better-sqlite3";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createPreparationRepository } from "../../src/preparation/repository.js";
import type { PreparationSourceVersion } from "../../src/preparation/models.js";

const data = workerData as {
  dataDir: string;
  barrier: SharedArrayBuffer;
  source: PreparationSourceVersion;
};
const gate = new Int32Array(data.barrier);
Atomics.add(gate, 1, 1);
Atomics.notify(gate, 1);
if (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0);

const database = new Database(join(data.dataDir, "marktv.sqlite"));
database.pragma("busy_timeout = 5000");
try {
  const job = createPreparationRepository(database).claimNext(() => data.source);
  parentPort?.postMessage({ kind: "result", jobId: job?.id ?? null });
} catch (error) {
  parentPort?.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
} finally {
  database.close();
}
