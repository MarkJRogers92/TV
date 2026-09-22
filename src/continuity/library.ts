import { isAbsolute, relative, sep } from "node:path";
import type { Repositories } from "../db/repositories.js";
import type { MediaItem } from "../domain/models.js";
import { TunarrClient, normalizeLocalPath } from "../integrations/tunarr/client.js";
import { unusableInventoryReason } from "../integrations/tunarr/plan.js";
import { normalizeLibraryIds } from "../integrations/tunarr/types.js";
import { readTunarrMappingForChannel } from "../server/tunarrAutoSync.js";

export function insideLibrary(root: string, file: string) {
  const child = relative(root, file);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

type LocalLibrary = { sourceId: string; id: string; path: string };
export type ContinuityLibrary = {
  client: Pick<TunarrClient, "inventory" | "scanLibrary">;
  libraries: LocalLibrary[];
};

/** Use the existing mapping and local-library API; never change playback settings. */
export async function continuityLibrary(repositories: Repositories, channelId: string): Promise<ContinuityLibrary | undefined> {
  const mapping = readTunarrMappingForChannel(repositories, channelId);
  if (!mapping?.url) return undefined;
  const ids = new Set(normalizeLibraryIds(mapping.libraryIds ?? mapping.libraryId));
  const client = new TunarrClient(mapping.url);
  const sources = await client.mediaSources() as Array<{
    id: string;
    type?: string;
    libraries?: Array<{ id: string; type?: string; externalKey?: string }>;
  }>;
  const libraries = sources.flatMap((source) => (source.libraries ?? []).flatMap((library) =>
    ids.has(library.id) && (library.type === "local" || source.type === "local")
      && typeof library.externalKey === "string" && isAbsolute(library.externalKey)
      ? [{ sourceId: source.id, id: library.id, path: library.externalKey }]
      : [],
  ));
  return libraries.length ? { client, libraries } : undefined;
}

/** One bounded library scan, then exclude anything Tunarr still cannot play. */
export async function confirmContinuityMedia(
  library: ContinuityLibrary,
  media: MediaItem[],
  settle: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 45_000)),
): Promise<MediaItem[]> {
  const relevant = library.libraries.filter((root) => media.some((item) => item.path && insideLibrary(root.path, item.path)));
  if (!relevant.length) return [];
  const ids = relevant.map((root) => root.id);
  let inventory = await library.client.inventory(ids);
  const ready = () => media.filter((item) => {
    const matches = inventory.filter((entry) => item.path
      && entry.path === normalizeLocalPath(item.path) && !unusableInventoryReason(entry));
    return matches.length === 1;
  });
  if (ready().length === media.length) return media;
  let scanned = false;
  for (const root of relevant) scanned = await library.client.scanLibrary(root.sourceId, root.id) || scanned;
  if (scanned) {
    await settle();
    inventory = await library.client.inventory(ids);
    // Local library scans are asynchronous and a real commercial library can
    // take over a minute. Give the single requested scan one final bounded
    // window, without resubmitting it or retrying during playback.
    if (ready().length !== media.length) {
      await settle();
      inventory = await library.client.inventory(ids);
    }
  }
  return ready();
}
