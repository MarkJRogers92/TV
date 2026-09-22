import { DateTime } from "luxon";
import type { MediaItem, Schedule, ScheduleEntry } from "../domain/models.js";
import { deriveContinuityContext } from "./context.js";
import { candidateFamilies, selectFamily } from "./families.js";
import { continuityPlanContentHash, seededIndex } from "./identity.js";
import {
  overnightSecondaryLine,
  wordContinuityCard,
} from "./wording.js";
import type {
  ContinuityAiring,
  ContinuityCardType,
  ContinuityConfig,
  ContinuityFamily,
  ContinuityFrequency,
  ContinuityHistoryEntry,
  ContinuityRole,
} from "./types.js";

export type ContinuityCardPlan = {
  id: string;
  channelId: string;
  broadcastDate: string;
  scheduleRevision: string;
  /** Identity of the whole completed schedule the card is bound to. */
  contentHash: string;
  cardType: ContinuityCardType;
  role: Exclude<ContinuityRole, "interruption">;
  family: ContinuityFamily;
  label: string;
  title: string;
  details: string[];
  footer: string;
  durationMs: number;
  insertionInstant: string;
  breakEntryId: string;
  target: {
    airingIds: string[];
    titles: string[];
    times: string[];
  };
  wordingKey: string;
};

export type PlanRejection = {
  breakEntryId: string;
  insertionInstant: string;
  cardType: ContinuityCardType;
  reason:
    | "NOT_DUE"
    | "DAILY_CAP"
    | "TARGET_CAP"
    | "REPEAT_COOLDOWN"
    | "NO_TARGET"
    | "NO_ASSET";
};

export type PlanResult = {
  contentHash: string;
  plans: ContinuityCardPlan[];
  rejections: PlanRejection[];
};

const editorial = (entry: ScheduleEntry) =>
  entry.kind === "episode" || entry.kind === "movie";

export const cardDurationMs = (cardType: ContinuityCardType) =>
  cardType === "next" ? 5_000 : 10_000;

/** Cadence band, in minutes, for one frequency level. */
export function frequencyIntervalMinutes(
  frequency: ContinuityFrequency,
  seed: string,
): number {
  const [minimum, maximum] =
    frequency === "low" ? [90, 120] : frequency === "high" ? [30, 60] : [60, 90];
  return minimum + seededIndex(`${seed}:cadence`, maximum - minimum + 1);
}

/** Approximate per-day ceiling for one class of card at a frequency level. */
export function frequencyDailyCap(frequency: ContinuityFrequency): number {
  return frequency === "low" ? 2 : frequency === "high" ? 8 : 5;
}

/** Repeat cooldown for the same promoted target, 60-90 minutes. */
export function targetRepeatCooldownMinutes(seed: string): number {
  return 60 + seededIndex(`${seed}:target-cooldown`, 31);
}

/**
 * The daily ceiling bucket a card type belongs to.
 *
 * TONIGHT and the weekend double feature are one promotional bucket: they say
 * the same thing about the same evening, so a busy night cannot spend five
 * TONIGHT cards and then five more weekend ones. NEXT and NEXT/LATER are
 * deliberately uncapped; their cadence is an interval, and NEXT is the fallback
 * on any suitable transition.
 */
export const dailyCapBucket = (
  cardType: ContinuityCardType,
): ContinuityCardType => (cardType === "weekend" ? "tonight" : cardType);

const localOf = (instant: string, timezone: string) =>
  DateTime.fromISO(instant, { setZone: true }).setZone(timezone);

const localHour = (airing: ContinuityAiring, timezone: string) =>
  localOf(airing.start, timezone).hour;

const timeLabel = (instant: string, timezone: string) =>
  localOf(instant, timezone).toFormat("h:mm a");

const isMovieTarget = (airing: ContinuityAiring) => airing.kind === "movie";

type PlannedTarget = {
  cardType: ContinuityCardType;
  title: string;
  second?: string;
  startTime?: string;
  airings: ContinuityAiring[];
  targetKey: string;
  movieWindow: boolean;
};

/**
 * The TONIGHT-family target for one insertion point.
 *
 * Preference is the brief's: a weekend double feature that is actually tonight
 * first (both films and the real first start), then the evening film, then the
 * near-2-AM film, then a distinct evening programme, then any other meaningful
 * programme. Every choice is future-only because the context window is.
 */
function pickTonight(context: ReturnType<typeof deriveContinuityContext>): PlannedTarget | undefined {
  const timezone = context.timezone;
  const tonightIds = new Set(context.tonight.map((airing) => airing.airingId));
  const display = (airing: ContinuityAiring) => airing.showTitle ?? airing.title;
  // The programme already on is never promoted, and an ordinary episode that
  // NEXT already names is not repeated as TONIGHT. The exception is a film: a
  // configured double feature opens with the very film that is next, and
  // TONIGHT is where that promotion belongs.
  const eligible = context.tonight.filter(
    (airing) =>
      airing.airingId !== context.current?.airingId &&
      (airing.airingId !== context.next?.airingId || airing.kind === "movie"),
  );
  const movieWindow = (airing: ContinuityAiring) => {
    const minutesAhead = (Date.parse(airing.start) - Date.parse(context.insertionInstant)) / 60_000;
    return isMovieTarget(airing) && minutesAhead >= 30 && minutesAhead <= 210;
  };

  if (
    context.weekendPair &&
    tonightIds.has(context.weekendPair[0].airingId) &&
    eligible.some((airing) => airing.airingId === context.weekendPair![0].airingId)
  ) {
    const [first, second] = context.weekendPair;
    return {
      cardType: "weekend",
      title: display(first),
      second: display(second),
      startTime: timeLabel(first.start, timezone),
      airings: [first, second],
      targetKey: `${first.airingId}+${second.airingId}`,
      movieWindow: true,
    };
  }
  const movies = eligible.filter(isMovieTarget);
  const eveningMovie = movies.find((airing) => localHour(airing, timezone) >= 18);
  const lateMovie = movies.find((airing) => localHour(airing, timezone) < 4);
  const movie = eveningMovie ?? lateMovie;
  if (movie)
    return {
      cardType: "tonight",
      title: display(movie),
      startTime: timeLabel(movie.start, timezone),
      airings: [movie],
      targetKey: movie.airingId,
      movieWindow: movieWindow(movie),
    };

  const program = eligible.find((airing) => airing.kind === "episode") ?? eligible[0];
  if (program)
    return {
      cardType: "tonight",
      title: display(program),
      startTime: timeLabel(program.start, timezone),
      airings: [program],
      targetKey: program.airingId,
      movieWindow: false,
    };
  return undefined;
}

function pickNextLater(context: ReturnType<typeof deriveContinuityContext>): PlannedTarget | undefined {
  if (!context.next || !context.later) return undefined;
  const display = (airing: ContinuityAiring) => airing.showTitle ?? airing.title;
  return {
    cardType: "next-later",
    title: display(context.next),
    second: display(context.later),
    startTime: timeLabel(context.next.start, context.timezone),
    airings: [context.next, context.later],
    targetKey: `${context.next.airingId}+${context.later.airingId}`,
    movieWindow: false,
  };
}

function pickNext(context: ReturnType<typeof deriveContinuityContext>): PlannedTarget | undefined {
  if (!context.next) return undefined;
  const display = (airing: ContinuityAiring) => airing.showTitle ?? airing.title;
  return {
    cardType: "next",
    title: display(context.next),
    startTime: timeLabel(context.next.start, context.timezone),
    airings: [context.next],
    targetKey: context.next.airingId,
    movieWindow: false,
  };
}

type State = {
  lastCardAt: Map<ContinuityCardType, number>;
  cardsToday: Map<ContinuityCardType, number>;
  lastTargetAt: Map<string, number>;
  targetsToday: Map<string, number>;
  recentFamilies: ContinuityFamily[];
};

function dayBounds(schedule: Schedule) {
  const start = DateTime.fromISO(schedule.date, { zone: schedule.timezone }).startOf("day");
  return { start: start.toMillis(), end: start.plus({ days: 1 }).toMillis() };
}

function seedState(
  schedule: Schedule,
  history: ContinuityHistoryEntry[],
): State {
  const { start, end } = dayBounds(schedule);
  const state: State = {
    lastCardAt: new Map(),
    cardsToday: new Map(),
    lastTargetAt: new Map(),
    targetsToday: new Map(),
    recentFamilies: [],
  };
  const ordered = [...history].sort((left, right) => left.airedAt.localeCompare(right.airedAt));
  for (const entry of ordered) {
    const at = Date.parse(entry.airedAt);
    if (!Number.isFinite(at)) continue;
    if (entry.cardType) {
      // TONIGHT and the weekend pair spend one bucket, exactly like live plans.
      const bucket = dailyCapBucket(entry.cardType);
      state.lastCardAt.set(bucket, at);
      if (at >= start && at < end)
        state.cardsToday.set(bucket, (state.cardsToday.get(bucket) ?? 0) + 1);
    }
    if (entry.targetKey) {
      state.lastTargetAt.set(entry.targetKey, at);
      if (at >= start && at < end)
        state.targetsToday.set(entry.targetKey, (state.targetsToday.get(entry.targetKey) ?? 0) + 1);
    }
    if (entry.family) {
      state.recentFamilies = [
        entry.family,
        ...state.recentFamilies.filter((family) => family !== entry.family),
      ];
    }
  }
  return state;
}

function targetCap(airing: ContinuityAiring) {
  return isMovieTarget(airing) ? 3 : 2;
}

type Gate = "DUE" | PlanRejection["reason"];

function gate(
  choice: PlannedTarget,
  context: ReturnType<typeof deriveContinuityContext>,
  config: ContinuityConfig,
  state: State,
  seedBase: string,
): Gate {
  if (
    !config.nextCards &&
    (choice.cardType === "next" || choice.cardType === "next-later")
  )
    return "NO_TARGET";
  const bucket = dailyCapBucket(choice.cardType);
  const frequency =
    bucket === "tonight" ? config.tonightFrequency : config.nextLaterFrequency;
  const now = Date.parse(context.insertionInstant);
  const interval = frequencyIntervalMinutes(frequency, `${seedBase}:${bucket}`);
  const last = state.lastCardAt.get(bucket);
  if (last !== undefined && now - last < interval * 60_000) return "NOT_DUE";
  // Only the TONIGHT/weekend bucket has a daily ceiling. NEXT is the fallback on
  // suitable transitions and NEXT/LATER is interval-limited, so neither is
  // silenced by a five-a-day rule the brief never asked for.
  if (bucket === "tonight" && (state.cardsToday.get(bucket) ?? 0) >= frequencyDailyCap(frequency))
    return "DAILY_CAP";
  const cap = targetCap(choice.airings[0]!);
  if ((state.targetsToday.get(choice.targetKey) ?? 0) >= cap) return "TARGET_CAP";
  const lastTarget = state.lastTargetAt.get(choice.targetKey);
  if (
    lastTarget !== undefined &&
    now - lastTarget < targetRepeatCooldownMinutes(`${seedBase}:${choice.targetKey}`) * 60_000
  )
    return "REPEAT_COOLDOWN";
  return "DUE";
}

/**
 * Plan the informational cards for one completed schedule.
 *
 * Pure and deterministic: the same schedule, media, history and configuration
 * always produce the same plans, and the director only ever names programs that
 * are actually in the finalized lineup. It does not render, register or write
 * anything - publication is a separate, fail-open step.
 */
export function planContinuityCards(input: {
  schedule: Schedule;
  media: MediaItem[];
  config: ContinuityConfig;
  history?: ContinuityHistoryEntry[];
  /**
   * Completed adjacent schedules whose airings a card may legitimately name.
   *
   * Supplying yesterday's stored schedule is what lets a post-midnight card
   * promote a film that actually started the previous evening; the content hash
   * binds the card to that evidence too.
   */
  adjacentSchedules?: Schedule[];
  /** When true, after-midnight cards may carry a secondary humour line. */
  allowOvernightHumour?: boolean;
  /**
   * Optional acceptance predicate.
   *
   * The director only advances cadence, caps and family rotation for a plan the
   * caller can actually publish, so a card rejected at the render or exact-fit
   * stage never spends a slot. A candidate the predicate refuses is skipped in
   * favour of the next candidate for that break.
   */
  isAvailable?: (plan: ContinuityCardPlan) => boolean;
}): PlanResult {
  const { schedule, config } = input;
  const contentHash = continuityPlanContentHash(schedule, input.adjacentSchedules);
  const seedBase = `${schedule.channelId}:${schedule.date}:${contentHash}`;
  const allowOvernightHumour = input.allowOvernightHumour ?? true;
  if (!config.enabled) return { contentHash, plans: [], rejections: [] };
  const state = seedState(schedule, input.history ?? []);
  const plans: ContinuityCardPlan[] = [];
  const rejections: PlanRejection[] = [];
  const entries = schedule.entries;

  for (let index = 0; index < entries.length; index += 1) {
    if (editorial(entries[index]!)) continue;
    const start = index;
    while (index < entries.length && !editorial(entries[index]!)) index += 1;
    const end = index;
    index -= 1;
    if (start === 0 || end >= entries.length) continue;
    const breakEntries = entries.slice(start, end);
    if (!breakEntries.length || breakEntries.some((entry) => entry.kind === "flex")) continue;
    const insertionInstant = breakEntries[0]!.start;
    const context = deriveContinuityContext({
      schedules: [schedule, ...(input.adjacentSchedules ?? [])],
      media: input.media,
      insertionInstant,
      managedLineup: true,
    });
    const tonight = context.allowTimeRelativePromos ? pickTonight(context) : undefined;
    const nextLater = pickNextLater(context);
    const next = pickNext(context);
    // Movie promo window promotes the film first; otherwise the brief's normal
    // priority of a due NEXT/LATER, then a due TONIGHT, then NEXT applies.
    const movieFirst = Boolean(tonight?.movieWindow);
    const ordered = (
      movieFirst ? [tonight, nextLater, next] : [nextLater, tonight, next]
    ).filter((choice): choice is PlannedTarget => Boolean(choice));
    if (!ordered.length)
      rejections.push({
        breakEntryId: breakEntries[0]!.id,
        insertionInstant,
        cardType: "next",
        reason: "NO_TARGET",
      });
    for (const choice of ordered) {
      const decision = gate(choice, context, config, state, seedBase);
      if (decision !== "DUE") {
        rejections.push({
          breakEntryId: breakEntries[0]!.id,
          insertionInstant,
          cardType: choice.cardType,
          reason: decision,
        });
        continue;
      }
      const family = selectFamily(
        choice.cardType,
        `${seedBase}:${choice.targetKey}`,
        state.recentFamilies,
        candidateFamilies(choice.cardType, context.presentationLabel === "OVERNIGHT"),
      );
      const cardSeed = `${seedBase}:${choice.cardType}:${choice.targetKey}`;
      const overnight = context.presentationLabel === "OVERNIGHT";
      const wording = wordContinuityCard({
        cardType: choice.cardType,
        title: choice.title,
        sameSeries: choice.airings[0]!.sameSeriesAsCurrent,
        second: choice.second,
        startTime: choice.startTime,
        seed: cardSeed,
        overnight,
        movie: choice.airings[0]!.kind === "movie",
      });
      const details = [...wording.details];
      if (
        allowOvernightHumour &&
        overnight &&
        config.overnightWeirdness !== "off"
      ) {
        const secondary = overnightSecondaryLine(config.overnightWeirdness, cardSeed);
        if (secondary && details.length < 4 && !details.includes(secondary))
          details.push(secondary);
      }
      const plan: ContinuityCardPlan = {
        id: [schedule.channelId, schedule.date, choice.cardType, choice.targetKey, family]
          .join(":")
          .replace(/[^A-Za-z0-9:._-]+/gu, "-"),
        channelId: schedule.channelId,
        broadcastDate: schedule.date,
        scheduleRevision: schedule.id,
        contentHash,
        cardType: choice.cardType,
        role: choice.cardType,
        family,
        label: wording.label,
        title: wording.title,
        details,
        footer: "MARKTV",
        durationMs: cardDurationMs(choice.cardType),
        insertionInstant,
        breakEntryId: breakEntries[0]!.id,
        target: {
          airingIds: choice.airings.map((airing) => airing.airingId),
          titles: choice.airings.map((airing) => airing.showTitle ?? airing.title),
          times: choice.airings.map((airing) => airing.start),
        },
        wordingKey: cardSeed,
      };
      if (input.isAvailable && !input.isAvailable(plan)) {
        rejections.push({
          breakEntryId: breakEntries[0]!.id,
          insertionInstant,
          cardType: choice.cardType,
          reason: "NO_ASSET",
        });
        continue;
      }
      plans.push(plan);
      const at = Date.parse(insertionInstant);
      const bucket = dailyCapBucket(choice.cardType);
      state.lastCardAt.set(bucket, at);
      state.cardsToday.set(bucket, (state.cardsToday.get(bucket) ?? 0) + 1);
      state.lastTargetAt.set(choice.targetKey, at);
      state.targetsToday.set(choice.targetKey, (state.targetsToday.get(choice.targetKey) ?? 0) + 1);
      state.recentFamilies = [family, ...state.recentFamilies.filter((item) => item !== family)];
      break;
    }
  }

  return { contentHash, plans, rejections };
}
