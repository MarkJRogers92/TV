import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { StaleSeasonPackReason } from "../../acquisition/coordinator.js";
import {
  stremioMovieSearchUrl,
  stremioSearchUrl,
} from "../../acquisition/identity.js";
import {
  wantedEpisodeSchema,
  wantedMovieSchema,
  type AcquisitionJob,
  type AcquisitionProviderId,
  type AcquisitionReview,
  type AcquisitionReviewCandidate,
  type AcquisitionReviewKind,
  type TechnicalState,
  type WantedEpisode,
  type WantedMovie,
} from "../../acquisition/models.js";
import {
  AcquisitionConflictError,
  terminalJobStates,
  type AcquisitionRepository,
} from "../../acquisition/repository.js";
import type { ProviderErrorCode } from "../../integrations/acquisition/provider.js";
import type { ServerContext } from "../context.js";
import { notFound, validationError } from "../errors.js";

/**
 * The client supplies only human episode metadata: ids, timestamps, and the
 * initial `wanted` status are server-owned. Unknown keys are rejected so a
 * record can never smuggle in a token, status, or remote identity.
 */
const createWantedSchema = z.strictObject({
  seriesTitle: z.string().trim().min(1),
  season: z.number().int().nonnegative(),
  episode: z.number().int().nonnegative(),
  episodeTitle: z.string().trim().min(1).nullable().optional(),
});
/**
 * A movie is identified by title plus optional year, so `year` is the only
 * optional field. `.nullish()` lets a client send either `null` or omit it.
 */
const createWantedMovieSchema = z.strictObject({
  title: z.string().trim().min(1),
  year: z.number().int().positive().max(9999).nullish(),
});
const selectCandidateSchema = z.strictObject({
  candidateIndex: z.number().int().nonnegative(),
  reviewUpdatedAt: z.string().datetime({ offset: true }),
});

type ReviewCandidateView = {
  candidateIndex: number;
  provider: AcquisitionProviderId;
  filename: string;
  sizeBytes: number | null;
  resolution: string | null;
};

/**
 * Safe projection of one acquisition job. Local paths, remote locators, the
 * original provider filename, and the stored error detail are all omitted: the
 * projection carries only server-owned progress and state vocabulary.
 */
type JobView = {
  id: string;
  state: TechnicalState;
  provider: AcquisitionProviderId;
  attempt: number;
  maxAttempts: number;
  expectedBytes: number | null;
  receivedBytes: number;
  retryAfterMs: number | null;
  cancelRequested: boolean;
  updatedAt: string;
};

/**
 * Episode-scoped review projection. The review message is a fixed server
 * sentence chosen from the matcher's reason vocabulary.
 */
type ReviewView = {
  id: string;
  kind: AcquisitionReviewKind;
  message: string;
  candidateCount: number;
  candidates: ReviewCandidateView[];
  createdAt: string;
  updatedAt: string;
};

/** Wanted projection: the durable record, Stremio link, latest job, review. */
type WantedView = WantedEpisode & {
  stremioUrl: string;
  job: JobView | null;
  review: ReviewView | null;
};

/**
 * Movie projection: the durable record plus its Stremio link. Deliberately
 * carries no `job`/`review` keys rather than nulls — a movie has no acquisition
 * machinery yet, and a permanently-null field would imply one is coming without
 * a consumer existing.
 */
type WantedMovieView = WantedMovie & { stremioUrl: string };

type SeasonPackEpisodeView = {
  episode: number | null;
  sizeBytes: number | null;
  resolution: string | null;
  /** Durable status of the recognized episode, or null when it is not wanted. */
  status: TechnicalState | null;
};

/**
 * Durable season-pack offer projection. It is derived from the review row
 * alone, so it survives the anchor Wanted episode being imported or removed.
 */
type SeasonPackView = {
  id: string;
  provider: AcquisitionProviderId | null;
  seriesTitle: string | null;
  season: number | null;
  episodeCount: number | null;
  totalBytes: number | null;
  message: string;
  createdAt: string;
  updatedAt: string;
  episodes: SeasonPackEpisodeView[];
};

function jobView(job: AcquisitionJob): JobView {
  return {
    id: job.id,
    state: job.state,
    provider: job.provider,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    expectedBytes: job.expectedBytes,
    receivedBytes: job.receivedBytes,
    retryAfterMs: job.retryAfterMs,
    cancelRequested: job.cancelRequested,
    updatedAt: job.updatedAt,
  };
}

function reviewView(review: AcquisitionReview): ReviewView {
  return {
    id: review.id,
    kind: review.kind,
    message: review.message,
    candidateCount: review.candidates.length,
    candidates: review.kind === "season-pack" ? [] : review.candidates.map((candidate, candidateIndex) => ({
      candidateIndex,
      provider: candidate.provider,
      filename: candidate.filename,
      sizeBytes: candidate.sizeBytes,
      resolution: candidate.resolution,
    })),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };
}

/** The most recently updated job for one episode, or null when none exists. */
function latestJob(jobs: readonly AcquisitionJob[]): AcquisitionJob | null {
  return (
    [...jobs].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    )[0] ?? null
  );
}

/**
 * Season-pack offers belong to the independent season-packs projection, so the
 * Wanted projection only ever surfaces an episode-scoped review.
 */
function episodeReview(
  reviews: readonly AcquisitionReview[],
): AcquisitionReview | null {
  return reviews.find((review) => review.kind !== "season-pack") ?? null;
}

function movieView(movie: WantedMovie): WantedMovieView {
  return { ...movie, stremioUrl: stremioMovieSearchUrl(movie) };
}

function wantedView(
  repository: AcquisitionRepository,
  wanted: WantedEpisode,
): WantedView {
  const job = latestJob(repository.jobs.listByWanted(wanted.id));
  const review = episodeReview(repository.reviews.listByWanted(wanted.id));
  return {
    ...wanted,
    stremioUrl: stremioSearchUrl(wanted),
    job: job === null ? null : jobView(job),
    review: review === null ? null : reviewView(review),
  };
}

/**
 * The recognized episode's durable status. The completion ledger and a
 * nonterminal job always win over the Wanted row, because a Wanted status can
 * lag or be absent once the anchor episode leaves the list.
 */
function packEpisodeStatus(
  repository: AcquisitionRepository,
  offer: AcquisitionReview,
  candidate: AcquisitionReviewCandidate,
): TechnicalState | null {
  const seriesTitle = offer.packSeriesTitle;
  const season = offer.packSeason;
  const episode = candidate.episode;
  const identified = seriesTitle !== null && season !== null && episode !== null;
  if (identified && repository.imports.findByEpisode(seriesTitle, season, episode))
    return "imported";
  const job = repository.jobs.findRemote(
    candidate.provider,
    candidate.remoteItemId,
    candidate.remoteFileId,
  );
  if (job && !(terminalJobStates as readonly string[]).includes(job.state))
    return job.state;
  if (identified) {
    const wanted = repository.wanted.findByIdentity(seriesTitle, season, episode);
    if (wanted) return wanted.status;
  }
  return job ? job.state : null;
}

function seasonPackView(
  repository: AcquisitionRepository,
  offer: AcquisitionReview,
): SeasonPackView {
  const episodes: SeasonPackEpisodeView[] = [...offer.candidates]
    .sort(
      (left, right) =>
        (left.episode ?? Number.MAX_SAFE_INTEGER) -
          (right.episode ?? Number.MAX_SAFE_INTEGER) ||
        left.remoteFileId.localeCompare(right.remoteFileId),
    )
    .map((candidate) => ({
      episode: candidate.episode,
      sizeBytes: candidate.sizeBytes,
      resolution: candidate.resolution,
      status: packEpisodeStatus(repository, offer, candidate),
    }));
  return {
    id: offer.id,
    provider: offer.candidates[0]?.provider ?? null,
    seriesTitle: offer.packSeriesTitle,
    season: offer.packSeason,
    episodeCount: offer.packEpisodeCount,
    totalBytes: offer.packTotalBytes,
    message: offer.message,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
    episodes,
  };
}

/** Fixed, server-owned explanations for typed provider failures. */
const PROVIDER_MESSAGES: Record<ProviderErrorCode, string> = {
  AUTHENTICATION: "Authentication failed. Check the saved token and try again.",
  RATE_LIMITED: "Provider rate limit reached. Try again later.",
  UNAVAILABLE: "Provider is temporarily unavailable. Try again later.",
  UNSUPPORTED_SCHEMA: "Provider response is not supported.",
  PERMANENT: "Provider request was rejected.",
};

/** Fixed explanations for a season-pack offer that no longer revalidates. */
const STALE_PACK_MESSAGES: Record<StaleSeasonPackReason, string> = {
  "missing-identity": "The pack no longer has a verified series and season.",
  "empty-pack": "The pack no longer lists any episodes.",
  "mixed-locators": "The stored pack files no longer belong to one provider item.",
  "item-missing": "The provider no longer lists this pack.",
  "not-completed": "The provider reports this pack as not completed.",
  "missing-file": "The provider pack no longer contains a stored file.",
  "changed-pack": "The provider pack changed since it was offered.",
  "unknown-pack-bytes": "The pack no longer reports usable file sizes.",
};

function countBy<T extends string>(values: readonly T[]) {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * Thin Fastify surface over `context.repositories.acquisitions` and the single
 * shared coordinator. Every durable acquisition mutation is a coordinator
 * command; rows are only ever projected, never written, by a route.
 */
export async function registerAcquisitionRoutes(
  app: FastifyInstance,
  context: ServerContext,
) {
  const repository: AcquisitionRepository = context.repositories.acquisitions;
  const coordinator = context.coordinator;

  app.get("/api/v1/acquisitions/wanted", async () =>
    repository.wanted.list().map((record) => wantedView(repository, record)),
  );

  app.post("/api/v1/acquisitions/wanted", async (request, reply) => {
    let input: z.infer<typeof createWantedSchema>;
    try {
      input = createWantedSchema.parse(request.body);
    } catch (error) {
      return validationError(reply, error);
    }

    const existing = repository.wanted.findByIdentity(
      input.seriesTitle,
      input.season,
      input.episode,
    );
    if (existing) {
      return reply.code(409).send({
        code: "ALREADY_WANTED",
        message: "That episode is already on the Wanted list",
        wantedId: existing.id,
      });
    }
    if (repository.imports.findByEpisode(input.seriesTitle, input.season, input.episode)) {
      return reply.code(409).send({
        code: "ALREADY_IMPORTED",
        message: "This episode was already imported",
      });
    }

    const timestamp = context.now().toISOString();
    const record = wantedEpisodeSchema.parse({
      id: randomUUID(),
      seriesTitle: input.seriesTitle,
      season: input.season,
      episode: input.episode,
      episodeTitle: input.episodeTitle ?? null,
      status: "wanted",
      statusDetail: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    try {
      repository.wanted.create(record);
    } catch (error) {
      // Two concurrent adds of the same episode race on the unique identity;
      // the loser reports the same safe conflict as the lookup above.
      if (error instanceof AcquisitionConflictError) {
        return reply.code(409).send({
          code: "ALREADY_WANTED",
          message: "That episode is already on the Wanted list",
        });
      }
      throw error;
    }
    return reply.code(201).send(wantedView(repository, record));
  });

  app.delete("/api/v1/acquisitions/wanted/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    // A season-pack offer only uses this episode as the anchor that surfaced
    // the pack: the durable offer belongs to the season-packs projection and
    // must outlive the anchor leaving the Wanted list. The Wanted repository
    // removes every review anchored to the episode as part of one safe
    // transaction, so offers that survive are restored immediately after it.
    const durableOffers = repository.reviews
      .listByWanted(id)
      .filter((review) => review.kind === "season-pack");
    const result = repository.wanted.remove(id);
    if (result.kind === "not-found") return notFound(reply, "Wanted episode");
    if (result.kind === "active-job") {
      return reply.code(409).send({
        code: "ACTIVE_JOB",
        message:
          "Cancel the active acquisition job for this episode before removing it",
        jobId: result.job.id,
      });
    }
    for (const offer of durableOffers) repository.reviews.save(offer);
    const job = latestJob(repository.jobs.listByWanted(id));
    return reply.code(200).send({
      ...result.wanted,
      stremioUrl: stremioSearchUrl(result.wanted),
      job: job === null ? null : jobView(job),
      review: null,
    });
  });

  app.get("/api/v1/acquisitions/wanted-movies", async () =>
    repository.wantedMovies.list().map(movieView),
  );

  app.post("/api/v1/acquisitions/wanted-movies", async (request, reply) => {
    let input: z.infer<typeof createWantedMovieSchema>;
    try {
      input = createWantedMovieSchema.parse(request.body);
    } catch (error) {
      return validationError(reply, error);
    }
    const year = input.year ?? null;

    const existing = repository.wantedMovies.findByIdentity(input.title, year);
    if (existing) {
      return reply.code(409).send({
        code: "ALREADY_WANTED",
        message: "That movie is already on the Wanted list",
        wantedId: existing.id,
      });
    }

    const timestamp = context.now().toISOString();
    const record = wantedMovieSchema.parse({
      id: randomUUID(),
      title: input.title,
      year,
      status: "wanted",
      statusDetail: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    try {
      repository.wantedMovies.create(record);
    } catch (error) {
      // Two concurrent adds of the same title/year race on the unique identity;
      // the loser reports the same safe conflict as the lookup above.
      if (error instanceof AcquisitionConflictError) {
        return reply.code(409).send({
          code: "ALREADY_WANTED",
          message: "That movie is already on the Wanted list",
        });
      }
      throw error;
    }
    return reply.code(201).send(movieView(record));
  });

  app.delete("/api/v1/acquisitions/wanted-movies/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    // Unlike a wanted episode there is no job to guard against: nothing in the
    // acquisition pipeline references a movie, so removal is unconditional.
    const removed = repository.wantedMovies.remove(id);
    if (!removed) return notFound(reply, "Wanted movie");
    return reply.code(200).send(movieView(removed));
  });

  app.get("/api/v1/acquisitions/season-packs", async () =>
    repository.reviews
      .list()
      .filter((review) => review.kind === "season-pack")
      .map((offer) => seasonPackView(repository, offer)),
  );

  app.get("/api/v1/acquisitions/status", async () => {
    const wanted = repository.wanted.list();
    const jobs = repository.jobs.list();
    const reviews = repository.reviews.list();
    const activeJobs = jobs.filter(
      (job) => !(terminalJobStates as readonly string[]).includes(job.state),
    );
    return {
      wanted: {
        total: wanted.length,
        byStatus: countBy(wanted.map((record) => record.status)),
      },
      jobs: {
        total: jobs.length,
        active: activeJobs.length,
        byState: countBy(jobs.map((job) => job.state)),
      },
      reviews: { total: reviews.length },
    };
  });

  /**
   * One aggregated provider poll. Provider failures are already contained by
   * the coordinator, so the response only ever exposes typed state vocabulary.
   */
  app.post("/api/v1/acquisitions/poll", async () => {
    const outcome = await coordinator.pollOnce();
    return {
      providers: outcome.providers.map((state) => ({
        provider: state.provider,
        state: state.state,
        itemCount: state.itemCount,
        errorCode: state.errorCode,
      })),
      reservedJobIds: [...outcome.reservedJobIds],
      matchedWantedIds: [...outcome.matchedWantedIds],
      reviewId: outcome.reviewId,
      seasonPackReviewId: outcome.seasonPackReviewId,
    };
  });

  app.post("/api/v1/acquisitions/jobs/:id/retry", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const outcome = await coordinator.retry(id);
    switch (outcome.kind) {
      case "queued":
        // The durable reservation snapshot: the job is queued with a fresh
        // attempt budget and runs deterministically before this promise
        // settles. Callers re-read the Wanted projection for live progress
        // instead of this handler touching the database again during shutdown.
        return reply.code(200).send({ status: "queued", job: jobView(outcome.job) });
      case "not-found":
        return notFound(reply, "Acquisition job");
      case "already-imported":
        return reply.code(409).send({
          code: "ALREADY_IMPORTED",
          message: "This episode was already imported",
          job: jobView(outcome.job),
        });
      case "unavailable":
        // The historical job's Wanted episode no longer exists, so a retry can
        // never re-reserve it; the caller must add the episode again.
        return reply.code(409).send({
          code: "WANTED_MISSING",
          reason: "missing-wanted",
          message:
            "The Wanted episode for this job no longer exists; add the episode again before retrying",
          job: jobView(outcome.job),
        });
      case "active":
        return reply.code(409).send({
          code: "ACTIVE_JOB",
          message: "This acquisition job is already running",
          job: jobView(outcome.job),
        });
    }
  });

  app.post("/api/v1/acquisitions/jobs/:id/cancel", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const outcome = await coordinator.cancel(id);
    switch (outcome.kind) {
      case "cancelled":
        return reply.code(200).send({ status: "cancelled", job: jobView(outcome.job) });
      case "not-found":
        return notFound(reply, "Acquisition job");
      case "already-cancelled":
        return reply.code(409).send({
          code: "ALREADY_CANCELLED",
          message: "This acquisition job is already cancelled",
          job: jobView(outcome.job),
        });
      case "already-imported":
        return reply.code(409).send({
          code: "ALREADY_IMPORTED",
          message: "This episode was already imported",
          job: jobView(outcome.job),
        });
    }
  });

  app.post("/api/v1/acquisitions/reviews/:id/select-candidate", async (request, reply) => {
    let input: z.infer<typeof selectCandidateSchema>;
    try {
      input = selectCandidateSchema.parse(request.body);
    } catch (error) {
      return validationError(reply, error);
    }
    const id = (request.params as { id: string }).id;
    const outcome = await coordinator.selectCandidate(id, input.candidateIndex, input.reviewUpdatedAt);
    switch (outcome.kind) {
      case "scheduled":
        return reply.code(200).send({ status: "scheduled", job: jobView(outcome.job) });
      case "not-found":
        return notFound(reply, "Acquisition review");
      case "invalid-review":
        return reply.code(409).send({ code: "INVALID_REVIEW_KIND", message: "This review cannot select a single episode candidate" });
      case "stale-review":
        return reply.code(409).send({ code: "STALE_REVIEW", message: "This review changed; refresh and choose again" });
      case "invalid-candidate":
        return reply.code(409).send({ code: "INVALID_CANDIDATE", message: "That candidate cannot be safely selected" });
      case "no-credential":
        return reply.code(409).send({ code: "NO_CREDENTIAL", provider: outcome.provider, message: "No token saved for this provider. Save a token in Integrations first." });
      case "provider-error":
        return reply.code(502).send({ code: outcome.code, provider: outcome.provider, retryable: outcome.retryable, message: PROVIDER_MESSAGES[outcome.code] });
      case "stale-candidate":
        return reply.code(409).send({ code: "STALE_CANDIDATE", provider: outcome.provider, message: "The selected provider file changed or is no longer completed" });
      case "conflict":
        return reply.code(409).send({ code: "SELECTION_CONFLICT", message: "This episode can no longer reserve the selected candidate" });
    }
  });

  /**
   * Decline an offer without importing it.
   *
   * A season-pack offer is deliberately DURABLE: it outlives the wanted episode that
   * surfaced it, because the pack is the useful artefact and the anchor episode is only
   * what found it (see the delete route above, which re-saves offers for exactly this
   * reason). That durability is correct - but until now the only thing a review supported
   * was `import-season`, so the only ways to clear an unwanted offer were to import it, or
   * to edit the database by hand. This is the missing answer.
   *
   * Deliberately narrow: it removes the offer row and nothing else. No job is cancelled
   * (an offer with an active job is a separate concern - cancel that job first), no
   * wanted episode is touched, and no media already on disk is affected.
   */
  app.post("/api/v1/acquisitions/reviews/:id/dismiss", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!repository.reviews.remove(id)) return notFound(reply, "Offer");
    return reply.code(200).send({ dismissed: true, id });
  });

  /**
   * Manual Import Season. The coordinator re-lists the exact provider pack,
   * revalidates the stored identity, rechecks bytes/space/duplicates, and only
   * then creates the remaining episodes.
   */
  app.post(
    "/api/v1/acquisitions/reviews/:id/import-season",
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const outcome = await coordinator.importSeason(id);
      switch (outcome.kind) {
        case "scheduled":
          return reply.code(200).send({
            status: "scheduled",
            wantedIds: [...outcome.wantedIds],
            jobIds: [...outcome.jobIds],
            alreadyImported: outcome.alreadyImported,
            alreadyScheduled: outcome.alreadyScheduled,
          });
        case "not-found":
          return notFound(reply, "Season pack offer");
        case "invalid-offer":
          return reply.code(409).send({
            code: "INVALID_OFFER",
            message: "Only a season pack offer can be imported as a season",
          });
        case "no-credential":
          return reply.code(409).send({
            code: "NO_CREDENTIAL",
            provider: outcome.provider,
            message:
              "No token saved for this provider. Save a token in Integrations first.",
          });
        case "provider-error":
          return reply.code(502).send({
            code: outcome.code,
            provider: outcome.provider,
            retryable: outcome.retryable,
            message: PROVIDER_MESSAGES[outcome.code],
          });
        case "stale":
          return reply.code(409).send({
            code: "STALE_PACK",
            provider: outcome.provider,
            reason: outcome.reason,
            message: STALE_PACK_MESSAGES[outcome.reason],
          });
        case "insufficient-space":
          return reply.code(409).send({
            code: "INSUFFICIENT_SPACE",
            provider: outcome.provider,
            neededBytes: outcome.neededBytes,
            message:
              "Not enough free space for the remaining episodes in this pack",
          });
      }
    },
  );
}
