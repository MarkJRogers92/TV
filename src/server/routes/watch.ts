import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../context.js";

type WatchMapping = {
  url?: string;
  marktvChannelId?: string;
  channelId?: string;
};

function isLoopbackTunarrUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const ipv4Loopback = /^127(?:\.\d{1,3}){3}$/.test(hostname) &&
      hostname.split(".").every((octet) => Number(octet) <= 255);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      (hostname === "localhost" || hostname === "[::1]" || ipv4Loopback)
    );
  } catch {
    return false;
  }
}

function mappingFor(
  context: ServerContext,
  id: string,
): Required<WatchMapping> | undefined {
  const mapping = context.repositories.settings.get("tunarr-mapping")
    ?.value as WatchMapping | undefined;
  return mapping?.url &&
    mapping.channelId &&
    mapping.marktvChannelId === id &&
    isLoopbackTunarrUrl(mapping.url)
    ? {
        url: mapping.url,
        channelId: mapping.channelId,
        marktvChannelId: mapping.marktvChannelId,
      }
    : undefined;
}

function rewritePlaylist(
  playlist: string,
  upstreamUrl: string,
  channelId: string,
  localPrefix: string,
) {
  const upstreamOrigin = new URL(upstreamUrl).origin;
  const allowedPrefix = `/stream/channels/${encodeURIComponent(channelId)}/`;
  const rewriteResource = (value: string) => {
    const resource = new URL(value, upstreamUrl);
    if (
      resource.origin !== upstreamOrigin ||
      !resource.pathname.startsWith(allowedPrefix)
    ) {
      throw new Error("Tunarr returned an unexpected stream resource");
    }
    return `${localPrefix}${resource.pathname}${resource.search}`;
  };
  return playlist
    .split("\n")
    .map((line) => {
      if (!line) return line;
      if (line.startsWith("#")) {
        return line.replace(
          /URI="([^"]+)"/g,
          (_match, uri: string) => `URI="${rewriteResource(uri)}"`,
        );
      }
      return rewriteResource(line);
    })
    .join("\n");
}

async function proxyResponse(
  reply: FastifyReply,
  target: URL,
  mapping: Required<WatchMapping>,
  localPrefix: string,
) {
  try {
    const response = await fetch(target, { redirect: "error" });
    if (!response.ok)
      return reply.code(502).send({
        code: "LIVE_TV_UNAVAILABLE",
        message: "Tunarr could not provide the live stream",
      });
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    reply.header("content-type", contentType);
    reply.header("cache-control", "no-store");
    if (contentType.includes("mpegurl") || target.pathname.endsWith(".m3u8")) {
      const body = rewritePlaylist(
        await response.text(),
        target.toString(),
        mapping.channelId,
        localPrefix,
      );
      return reply.send(body);
    }
    return reply.send(Buffer.from(await response.arrayBuffer()));
  } catch {
    return reply.code(502).send({
      code: "LIVE_TV_UNAVAILABLE",
      message: "Tunarr could not provide the live stream",
    });
  }
}

export async function registerWatchRoutes(
  app: FastifyInstance,
  context: ServerContext,
) {
  app.get("/api/v1/watch/:id/marktv-live.m3u", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const mapping = mappingFor(context, id);
    if (!mapping) {
      return reply.code(409).send({
        code: "LIVE_TV_NOT_CONFIGURED",
        message: "Sync this MarkTV channel with Tunarr before watching live TV",
      });
    }
    const streamUrl = new URL(
      `/stream/channels/${encodeURIComponent(mapping.channelId)}.m3u8?mode=hls`,
      mapping.url,
    );
    reply.header("content-type", "audio/x-mpegurl; charset=utf-8");
    reply.header(
      "content-disposition",
      'attachment; filename="MarkTV-Live.m3u"',
    );
    reply.header("cache-control", "no-store");
    return reply.send(
      `#EXTM3U\n#EXTINF:-1,MarkTV Live\n${streamUrl.toString()}\n`,
    );
  });

  app.get("/api/v1/watch/:id/stream.m3u8", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const mapping = mappingFor(context, id);
    if (!mapping) {
      return reply.code(409).send({
        code: "LIVE_TV_NOT_CONFIGURED",
        message: "Sync this MarkTV channel with Tunarr before watching live TV",
      });
    }
    const localPrefix = `/api/v1/watch/${encodeURIComponent(id)}/media`;
    const target = new URL(
      `/stream/channels/${encodeURIComponent(mapping.channelId)}.m3u8?mode=hls`,
      mapping.url,
    );
    return proxyResponse(
      reply,
      target,
      mapping,
      localPrefix,
    );
  });

  app.get("/api/v1/watch/:id/media/*", async (request, reply) => {
    const { id, "*": resource } = request.params as {
      id: string;
      "*": string;
    };
    const mapping = mappingFor(context, id);
    if (!mapping) {
      return reply.code(409).send({
        code: "LIVE_TV_NOT_CONFIGURED",
        message: "Sync this MarkTV channel with Tunarr before watching live TV",
      });
    }
    const allowedPrefix = `stream/channels/${encodeURIComponent(mapping.channelId)}/`;
    if (!resource.startsWith(allowedPrefix))
      return reply.code(404).send({ code: "NOT_FOUND" });
    const search = new URL(request.raw.url ?? "/", "http://localhost").search;
    const target = new URL(`/${resource}${search}`, mapping.url);
    if (!target.pathname.startsWith(`/${allowedPrefix}`))
      return reply.code(404).send({ code: "NOT_FOUND" });
    return proxyResponse(
      reply,
      target,
      mapping,
      `/api/v1/watch/${encodeURIComponent(id)}/media`,
    );
  });
}
