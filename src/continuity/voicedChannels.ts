const sharedChannelIds = ["marktv-movies", "marktv-cult-movies"] as const;

const sharedMapRoles: Record<string, string> = {
  MARKTV_ID_MAIN_001: "station-id",
  MARKTV_ID_NOSTALGIA_001: "station-id",
  MARKTV_ID_STAY_MARKED_001: "station-id",
  MARKTV_SLOGAN_NATURE_001: "station-id",
  MARKTV_BREAK_OUT_001: "break",
  MARKTV_RETURN_NOT_YOUR_PROBLEMS_001: "return",
  MARKTV_RETURN_APOLOGY_001: "return",
};

const values = (tags: string[], key: string) =>
  tags.filter((tag) => tag.startsWith(`${key}=`)).map((tag) => tag.slice(key.length + 1));

export type VoicedChannelScope = {
  valid: boolean;
  primaryChannel?: string;
  allowedChannels: string[];
  shared: boolean;
};

/** The one source of truth for channel-scoped voiced asset tags. */
export function parseVoicedChannelScope(tags: string[]): VoicedChannelScope {
  const primary = values(tags, "continuity-channel");
  const shared = values(tags, "continuity-shared-channels");
  const roles = values(tags, "continuity-role");
  const scopes = values(tags, "continuity-scope");
  const roleScopeValid = roles.length === 1 &&
    ["next", "next-later", "tonight", "weekend", "after-dark", "break", "return", "station-id", "interruption"].includes(roles[0]!) &&
    scopes.length === 1 && ["evergreen", "title", "airing", "schedule"].includes(scopes[0]!);
  if (primary.length !== 1 || !/^marktv-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(primary[0] ?? "") || !roleScopeValid)
    return { valid: false, allowedChannels: [], shared: shared.length > 0 };
  if (shared.length === 0)
    return { valid: true, primaryChannel: primary[0], allowedChannels: [primary[0]!], shared: false };
  if (
    shared.length !== 1 || shared[0] !== sharedChannelIds.join(",") ||
    primary[0] !== "marktv-laughs"
  ) return { valid: false, primaryChannel: primary[0], allowedChannels: [], shared: true };

  const maps = values(tags, "continuity-map");
  const role = roles[0];
  const map = maps[0];
  const noScopedClaim = !tags.some((tag) =>
    ["continuity-target=", "continuity-target-kind=", "continuity-local-time=",
      "continuity-target-local-time=", "continuity-daypart=", "continuity-last-before-target=",
      "continuity-requires-unstarted-target=", "continuity-requires-same-series-as-current=",
      "continuity-requires-same-local-date-as-target=", "continuity-staged-reason="]
      .some((prefix) => tag.startsWith(prefix)),
  );
  const stationId = maps.length === 1 && map !== undefined && sharedMapRoles[map] === "station-id";
  const roleAndMapMatch = maps.length === 1 && map !== undefined && sharedMapRoles[map] === role;
  const stationEligibilityMatches = stationId === tags.includes("continuity-hourly-ids-eligible");
  const valid = roles.length === 1 && scopes.length === 1 && scopes[0] === "evergreen" &&
    roleAndMapMatch && stationEligibilityMatches && noScopedClaim;
  return {
    valid,
    primaryChannel: primary[0],
    allowedChannels: valid ? [primary[0]!, ...sharedChannelIds] : [],
    shared: true,
  };
}

export function voicedChannelAllows(scope: VoicedChannelScope, targetChannel: string) {
  return scope.valid && scope.allowedChannels.includes(targetChannel);
}

export function voicedChannelAssetAllows(primary: string | undefined, shared: string[] | undefined, target: string) {
  if (!primary || !/^marktv-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(primary)) return false;
  if (!shared || shared.length === 0) return primary === target;
  return primary === "marktv-laughs" &&
    shared?.length === sharedChannelIds.length &&
    shared.every((channel, index) => channel === sharedChannelIds[index]) &&
    (primary === target || shared.includes(target));
}
