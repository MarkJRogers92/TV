import type { MediaKind, MovieRole } from "../domain/models.js";

export type ContinuityRole =
  | "next"
  | "next-later"
  | "tonight"
  | "weekend"
  | "after-dark"
  | "break"
  | "return"
  | "station-id"
  | "interruption";

/**
 * The four conceptual continuity families.
 *
 * They are presentation identities rather than separate systems: every family
 * reuses the same canonical logo, the same approved SVG templates and the same
 * deterministic selection, and only varies palette and layout accent.
 */
export type ContinuityFamily =
  | "syndication"
  | "local-cable"
  | "prime-time"
  | "overnight";

export const continuityFamilies: ContinuityFamily[] = [
  "syndication",
  "local-cable",
  "prime-time",
  "overnight",
];

/** The informational card types the director can plan into a break. */
export type ContinuityCardType =
  | "next"
  | "next-later"
  | "tonight"
  | "weekend"
  | "after-dark";

export type ContinuityFrequency = "low" | "normal" | "high";
export type ContinuityWeirdness = "off" | "low" | "normal";

export type ContinuityPersona = "network" | "local" | "overnight" | "odd" | "existing-unclassified";
export type ContinuityLifecycle =
  | "discovered"
  | "classified"
  | "script-only"
  | "queued"
  | "rendering"
  | "validated"
  | "registered"
  | "eligible"
  | "error"
  | "quarantined";

export type ContinuityAsset = {
  id: string;
  mediaId?: string;
  origin: "existing" | "generated" | "starter";
  contentHash: string;
  path?: string;
  durationMs?: number;
  role: ContinuityRole;
  personaId: ContinuityPersona;
  lifecycle: ContinuityLifecycle;
  scope: "evergreen" | "title" | "airing" | "schedule";
  targetSlug?: string;
  targetAiringIds?: string[];
  scheduleRevision?: string;
  validFrom?: string;
  validUntil?: string;
  available?: boolean;
  voicePresent?: boolean;
  /** Presentation family and wording identity, when the asset was generated. */
  family?: ContinuityFamily;
  wordingKey?: string;
  airReady: boolean;
  rejectReason?: RejectCode;
};

export type ContinuityAiring = {
  airingId: string;
  mediaId: string;
  title: string;
  showTitle?: string;
  start: string;
  kind: Extract<MediaKind, "episode" | "movie">;
  movieOccurrenceKey?: string;
  movieRole?: MovieRole;
  sameSeriesAsCurrent: boolean;
  /**
   * True when the entry is the tail of a feature that already started on an
   * adjacent broadcast day. It is real programming but it is not a new
   * premiere, so it must never be promoted as one.
   */
  alreadyStarted?: boolean;
};

export type ContinuityContext = {
  channelId: string;
  scheduleId: string;
  scheduleRevision: string;
  timezone: string;
  insertionInstant: string;
  current: ContinuityAiring | null;
  returnTarget: ContinuityAiring | null;
  next: ContinuityAiring | null;
  later: ContinuityAiring | null;
  tonight: ContinuityAiring[];
  weekendPair: [ContinuityAiring, ContinuityAiring] | null;
  presentationLabel: "COMING UP" | "TONIGHT" | "OVERNIGHT";
  allowTimeRelativePromos: boolean;
  managedLineup: boolean;
};

export type ContinuityHistoryEntry = {
  assetId: string;
  targetAiringId?: string;
  personaId: ContinuityPersona;
  airedAt: string;
  /** Card class, when recorded. Used for cadence, caps and family rotation. */
  cardType?: ContinuityCardType;
  targetKey?: string;
  family?: ContinuityFamily;
  /**
   * Whether the record is a real airing or a successful insertion that has been
   * planned into a published schedule. Both count for cadence; only `aired`
   * means the card actually played.
   */
  state?: "aired" | "planned";
};

export type RejectCode =
  | "STALE_SCHEDULE"
  | "TARGET_NOT_FUTURE"
  | "MISSING_SOURCE"
  | "WRONG_RESUME_TARGET"
  | "INVALID_TIME_LABEL"
  | "REPEAT_COOLDOWN"
  | "UNMANAGED_LINEUP_LOOP"
  | "BREAK_BUDGET"
  | "UNHEALTHY_PLAYBACK"
  | "UNSCOPED_CLOCK_CLAIM"
  | "TARGET_MISMATCH"
  | "FREQUENCY_GATE";

export type ContinuityConfig = {
  enabled: boolean;
  nextCards: boolean;
  nextLaterFrequency: ContinuityFrequency;
  tonightFrequency: ContinuityFrequency;
  overnightWeirdness: ContinuityWeirdness;
  /**
   * Legacy controls retained for the existing configuration API.
   *
   * `stagedInterruptionsEnabled` stays false: staged interruptions need a
   * separate playback-health gate. The remaining numbers are the rotation,
   * cooldown and per-break ceilings the composer already honours.
   */
  stagedInterruptionsEnabled: boolean;
  promoFrequency: number;
  clipCooldownMinutes: number;
  targetCooldownMinutes: number;
  oddPersonaCooldownHours: number;
  maximumSpokenElementsPerBreak: number;
  maximumContinuitySecondsPerBreak: number;
};

export const defaultContinuityConfig: ContinuityConfig = {
  enabled: true,
  nextCards: true,
  nextLaterFrequency: "normal",
  tonightFrequency: "normal",
  overnightWeirdness: "low",
  stagedInterruptionsEnabled: false,
  promoFrequency: 0.25,
  clipCooldownMinutes: 60,
  targetCooldownMinutes: 30,
  oddPersonaCooldownHours: 6,
  maximumSpokenElementsPerBreak: 2,
  maximumContinuitySecondsPerBreak: 20,
};
