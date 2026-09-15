import { join } from "node:path";
import { assertLoopbackHost, buildApp } from "./app.js";
import { registerStaticUi } from "./staticUi.js";

const app = await buildApp();
if (process.env.MARKTV_DEV !== "1") {
  await registerStaticUi(app, join(process.cwd(), "dist"));
}

const host = process.env.MARKTV_HOST ?? "127.0.0.1";
assertLoopbackHost(host);
const port = Number(process.env.MARKTV_PORT ?? 4177);
await app.listen({ host, port });

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  process.exitCode = 0;
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
