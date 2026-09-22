import type { Channel, Daypart, MediaItem, Pool } from "./models.js";

export type ConfigurationIssue = {
  code:
    | "DAYPART_OVERLAP"
    | "MISSING_DAYPART"
    | "MISSING_POOL"
    | "MISSING_MEDIA_ITEM"
    | "MISSING_DURATION"
    | "POOL_KIND_MISMATCH"
    | "INVALID_BREAK_POLICY"
    | "INVALID_CONFIGURATION";
  path: string;
  message: string;
};

export function validatePoolRecords(
  pools: Pool[],
  items: MediaItem[],
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const itemsById = new Map(items.map((item) => [item.id, item]));
  for (const pool of pools) {
    for (const mediaId of pool.mediaIds) {
      const item = itemsById.get(mediaId);
      if (!item) {
        issues.push({
          code: "MISSING_MEDIA_ITEM",
          path: `pools.${pool.id}.mediaIds`,
          message: `Media item ${mediaId} is missing`,
        });
      } else if (!item.durationMs || item.durationStatus === "missing") {
        issues.push({
          code: "MISSING_DURATION",
          path: `pools.${pool.id}.mediaIds`,
          message: `${item.title} has no usable duration`,
        });
      } else if (!pool.kinds.includes(item.kind)) {
        issues.push({
          code: "POOL_KIND_MISMATCH",
          path: `pools.${pool.id}.mediaIds`,
          message: `${item.title} has kind ${item.kind}, which pool ${pool.id} does not allow`,
        });
      }
    }
  }
  return issues;
}

const minutes = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

function weeklyIntervals(daypart: Daypart): Array<[number, number]> {
  const start = minutes(daypart.start);
  const end = minutes(daypart.end);
  return daypart.days.map((day) => [
    day * 1_440 + start,
    (day + (start >= end ? 1 : 0)) * 1_440 + end,
  ]);
}

function overlaps(first: Daypart, second: Daypart) {
  const week = 7 * 1_440;
  return weeklyIntervals(first).some(([firstStart, firstEnd]) =>
    weeklyIntervals(second).some(([secondStart, secondEnd]) =>
      [-week, 0, week].some(
        (offset) =>
          firstStart < secondEnd + offset && secondStart + offset < firstEnd,
      ),
    ),
  );
}

export function validateChannelConfiguration(
  channel: Channel,
  pools: Pool[],
  items: MediaItem[],
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const poolsById = new Map(pools.map((pool) => [pool.id, pool]));
  const daypartIds = new Set(channel.dayparts.map((daypart) => daypart.id));
  issues.push(...validatePoolRecords(pools, items));

  for (let first = 0; first < channel.dayparts.length; first += 1) {
    for (
      let second = first + 1;
      second < channel.dayparts.length;
      second += 1
    ) {
      const a = channel.dayparts[first];
      const b = channel.dayparts[second];
      if (a.priority === b.priority && overlaps(a, b)) {
        issues.push({
          code: "DAYPART_OVERLAP",
          path: "dayparts",
          message: `${a.name} overlaps ${b.name}`,
        });
      }
    }
  }

  const requirePool = (poolId: string, path: string) => {
    if (!poolsById.has(poolId))
      issues.push({
        code: "MISSING_POOL",
        path,
        message: `Pool ${poolId} is missing`,
      });
  };
  for (const slot of channel.slots) {
    if (slot.daypartId && !daypartIds.has(slot.daypartId)) {
      issues.push({
        code: "MISSING_DAYPART",
        path: `slots.${slot.id}.daypartId`,
        message: `Daypart ${slot.daypartId} is missing`,
      });
    }
    slot.poolIds.forEach((poolId) =>
      requirePool(poolId, `slots.${slot.id}.poolIds`),
    );
    slot.fallbackPoolIds.forEach((poolId) =>
      requirePool(poolId, `slots.${slot.id}.fallbackPoolIds`),
    );
    for (const poolId of [...slot.poolIds, ...slot.fallbackPoolIds]) {
      const pool = poolsById.get(poolId);
      if (pool && !pool.kinds.includes(slot.kind)) {
        issues.push({
          code: "POOL_KIND_MISMATCH",
          path: `slots.${slot.id}.poolIds`,
          message: `Pool ${poolId} does not allow ${slot.kind}`,
        });
      }
    }
    const policy = slot.movieMidroll;
    if (
      policy &&
      (policy.intervalMinutes <= 0 ||
        policy.breakMinutes <= 0 ||
        policy.minimumMinutes < 0 ||
        !Number.isInteger(policy.maxBreaks) ||
        policy.maxBreaks < 0 ||
        policy.tailBufferMinutes < 0)
    ) {
      issues.push({
        code: "INVALID_BREAK_POLICY",
        path: `slots.${slot.id}.movieMidroll`,
        message:
          "Movie mid-roll values must be valid non-negative durations and counts",
      });
    }
    if (slot.movieMidroll && slot.kind !== "movie") {
      issues.push({
        code: "INVALID_BREAK_POLICY",
        path: `slots.${slot.id}.movieMidroll`,
        message: "Movie mid-roll policies may only be used by movie slots",
      });
    }
    if (slot.episodeMidroll && slot.kind !== "episode") {
      issues.push({
        code: "INVALID_BREAK_POLICY",
        path: `slots.${slot.id}.episodeMidroll`,
        message: "Episode mid-roll policies may only be used by episode slots",
      });
    }
  }
  channel.breakPolicy.poolIds.forEach((poolId) =>
    requirePool(poolId, "breakPolicy.poolIds"),
  );
  channel.breakPolicy.stationIdPoolIds.forEach((poolId) =>
    requirePool(poolId, "breakPolicy.stationIdPoolIds"),
  );
  const fillerKinds = new Set(["commercial", "filler", "bumper"]);
  for (const poolId of channel.breakPolicy.poolIds) {
    const pool = poolsById.get(poolId);
    if (pool && pool.kinds.some((kind) => !fillerKinds.has(kind))) {
      issues.push({
        code: "INVALID_BREAK_POLICY",
        path: "breakPolicy.poolIds",
        message: `Pool ${poolId} contains a non-filler media kind`,
      });
    }
  }
  for (const poolId of channel.breakPolicy.stationIdPoolIds) {
    const pool = poolsById.get(poolId);
    if (pool && (pool.kinds.length !== 1 || pool.kinds[0] !== "station-id")) {
      issues.push({
        code: "INVALID_BREAK_POLICY",
        path: "breakPolicy.stationIdPoolIds",
        message: `Pool ${poolId} is not a station-ID pool`,
      });
    }
  }

  // The movie-programming feature schedules against pools of its own, so a
  // misconfigured id has to fail here rather than at generation time - a channel
  // that says it has movie programming but cannot find its movies should not be
  // allowed to look healthy.
  const movieProgramming = channel.movieProgramming;
  if (movieProgramming) {
    // Enabled with nothing to draw from is the one configuration that looks
    // healthy and can never work: the feature would report "on" and schedule no
    // films at all. Refused here rather than discovered at generation time.
    if (movieProgramming.enabled && !movieProgramming.poolIds.length) {
      issues.push({
        code: "INVALID_CONFIGURATION",
        path: "movieProgramming.poolIds",
        message:
          "Movie programming needs at least one movie pool to draw its rotation from",
      });
    }
    if (movieProgramming.enabled && !movieProgramming.rootPath) {
      issues.push({
        code: "INVALID_CONFIGURATION",
        path: "movieProgramming.rootPath",
        message: "Movie programming needs the folder its films are scanned from",
      });
    }
    movieProgramming.poolIds.forEach((poolId) =>
      requirePool(poolId, "movieProgramming.poolIds"),
    );
    movieProgramming.bridgePoolIds.forEach((poolId) =>
      requirePool(poolId, "movieProgramming.bridgePoolIds"),
    );
    for (const poolId of movieProgramming.poolIds) {
      const pool = poolsById.get(poolId);
      if (pool && !pool.kinds.includes("movie")) {
        issues.push({
          code: "POOL_KIND_MISMATCH",
          path: "movieProgramming.poolIds",
          message: `Pool ${poolId} does not allow movie`,
        });
      }
    }
    // A bridge is whole spots or nothing: a pool of episodes or films cannot fill
    // it, and asking Tunarr for a duration the library cannot make is dead air.
    for (const poolId of movieProgramming.bridgePoolIds) {
      const pool = poolsById.get(poolId);
      if (
        pool &&
        !pool.kinds.some((kind) =>
          ["commercial", "filler", "bumper"].includes(kind),
        )
      ) {
        issues.push({
          code: "POOL_KIND_MISMATCH",
          path: "movieProgramming.bridgePoolIds",
          message: `Pool ${poolId} holds no whole spots a bridge can be built from`,
        });
      }
    }
    if (movieProgramming.bridgeMinSeconds > movieProgramming.bridgeMaxSeconds) {
      issues.push({
        code: "INVALID_BREAK_POLICY",
        path: "movieProgramming.bridgeMinSeconds",
        message: "The movie bridge minimum cannot exceed its maximum",
      });
    }
    if (
      movieProgramming.breakPolicy.targetMinutes >
      movieProgramming.breakPolicy.maxMinutes
    ) {
      issues.push({
        code: "INVALID_BREAK_POLICY",
        path: "movieProgramming.breakPolicy.targetMinutes",
        message: "The target movie break cannot exceed the maximum break",
      });
    }
  }

  if (
    !Number.isInteger(channel.breakPolicy.boundaryMinutes) ||
    channel.breakPolicy.boundaryMinutes <= 0 ||
    60 % channel.breakPolicy.boundaryMinutes !== 0
  ) {
    issues.push({
      code: "INVALID_BREAK_POLICY",
      path: "breakPolicy.boundaryMinutes",
      message: "Boundary must be a positive whole number that divides an hour",
    });
  }
  if (channel.breakPolicy.cooldownMinutes < 0) {
    issues.push({
      code: "INVALID_BREAK_POLICY",
      path: "breakPolicy.cooldownMinutes",
      message: "Cooldown cannot be negative",
    });
  }
  return issues;
}
