import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { buildApp } from "./app.js";

const app = await buildApp();
if (process.env.MARKTV_DEV !== "1") {
  await app.register(fastifyStatic, {
    root: join(process.cwd(), "dist"),
    prefix: "/",
  });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/")
      ? reply.code(404).send({ code: "NOT_FOUND" })
      : reply.sendFile("index.html"),
  );
}

const host = process.env.MARKTV_HOST ?? "127.0.0.1";
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
