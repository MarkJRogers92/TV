import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerContext } from "../context.js";

type WatchMapping = {
  url?: string;
  marktvChannelId?: string;
  channelId?: string;
};

/**
 * Runtime limits for the live proxy. Segments and playlists are finite and
 * small, so a single deadline covers header arrival and body drain; a hung
 * transcode must not hold a browser request open indefinitely. Exposed as a
 * mutable object so tests can shrink the deadline instead of waiting it out.
 */
export const watchProxyLimits = {
  upstreamDeadlineMs: 30_000,
};

/** Headers worth passing back to the player when proxying a media object. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-length",
  "content-range",
  "accept-ranges",
] as const;

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

function liveTvUnavailable(reply: FastifyReply) {
  return reply.code(502).send({
    code: "LIVE_TV_UNAVAILABLE",
    message: "Tunarr could not provide the live stream",
  });
}

function isPlaylist(contentType: string, pathname: string) {
  return contentType.includes("mpegurl") || pathname.endsWith(".m3u8");
}

async function proxyResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  target: URL,
  mapping: Required<WatchMapping>,
  localPrefix: string,
) {
  const controller = new AbortController();
  let settled = false;
  // Declared before `finish` uses it: the close listener below is registered
  // before the timer exists, and a disconnect in that window would otherwise
  // hit the temporal dead zone.
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    if (deadline !== null) clearTimeout(deadline);
    reply.raw.off("close", onDownstreamClose);
  };
  // A browser that navigates away mid-segment must not leave a transcode fetch
  // running. `writableEnded` distinguishes a genuine disconnect from the normal
  // close that follows a completed response.
  const onDownstreamClose = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on("close", onDownstreamClose);
  deadline = setTimeout(
    () => controller.abort(),
    watchProxyLimits.upstreamDeadlineMs,
  );

  try {
    const range = request.headers.range;
    const response = await fetch(target, {
      redirect: "error",
      signal: controller.signal,
      headers: range ? { range } : undefined,
    });

    // 206 and 416 are successful, meaningful answers to a range request and have
    // to survive the proxy rather than being flattened into a generic failure.
    const status = response.status;
    if (status !== 200 && status !== 206 && status !== 416) {
      finish();
      return liveTvUnavailable(reply);
    }

    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";

    if (status === 416) {
      // A refused range is a complete answer, not a gateway failure. Only the
      // range metadata carries meaning here: the body is re-sent as text, so
      // forwarding the upstream's content-length would describe something else.
      const contentRange = response.headers.get("content-range");
      if (contentRange) reply.header("content-range", contentRange);
      reply.header("cache-control", "no-store");
      const body = await response.text();
      settled = true;
      finish();
      return reply.code(416).send(body);
    }

    if (isPlaylist(contentType, target.pathname)) {
      // Rewrite before staging any header: a rewrite failure then still produces
      // a clean JSON error instead of a playlist-typed error body.
      const body = rewritePlaylist(
        await response.text(),
        target.toString(),
        mapping.channelId,
        localPrefix,
      );
      reply.header("content-type", contentType);
      reply.header("cache-control", "no-store");
      settled = true;
      finish();
      return reply.send(body);
    }

    reply.header("content-type", contentType);
    reply.header("cache-control", "no-store");
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) reply.header(name, value);
    }

    if (!response.body) {
      finish();
      return liveTvUnavailable(reply);
    }

    reply.code(status);
    // Streamed rather than buffered so a segment is forwarded under
    // backpressure instead of being held whole in the server's heap.
    const stream = Readable.fromWeb(
      response.body as Parameters<typeof Readable.fromWeb>[0],
    );
    stream.on("error", () => {
      // Headers are already on the wire by now; the only correct move is to drop
      // the connection rather than attempt a second response.
      finish();
      reply.raw.destroy();
    });
    stream.on("close", finish);
    settled = true;
    return reply.send(stream);
  } catch {
    finish();
    if (settled || reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    return liveTvUnavailable(reply);
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
      `/stream/channels/${encodeURIComponent(mapping.channelId)}.m3u8`,
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
      `/stream/channels/${encodeURIComponent(mapping.channelId)}.m3u8`,
      mapping.url,
    );
    return proxyResponse(request, reply, target, mapping, localPrefix);
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
      request,
      reply,
      target,
      mapping,
      `/api/v1/watch/${encodeURIComponent(id)}/media`,
    );
  });
}
