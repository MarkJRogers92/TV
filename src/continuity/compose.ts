import type { ContinuityRole } from "./types.js";

export type BreakEntry = {
  id: string;
  durationMs: number;
  kind: "commercial" | "filler" | "continuity";
  role?: Exclude<ContinuityRole, "interruption">;
  spoken: boolean;
  informational: boolean;
};

type Input = {
  original: BreakEntry[];
  promo?: BreakEntry;
  returnClip?: BreakEntry;
  existingSpokenCount?: number;
  maximumSpokenElements?: number;
  maximumContinuityMs?: number;
};

type RemovalCandidate = {
  indexes: number[];
  continuityMs: number;
  spoken: number;
  informational: number;
};

function dominates(a: RemovalCandidate, b: RemovalCandidate) {
  return (
    a.continuityMs >= b.continuityMs &&
    a.spoken >= b.spoken &&
    a.informational >= b.informational
  );
}

function removableSubsets(entries: BreakEntry[], targetMs: number) {
  const reachable = new Map<number, RemovalCandidate[]>([
    [
      0,
      [{ indexes: [], continuityMs: 0, spoken: 0, informational: 0 }],
    ],
  ]);
  for (const [index, entry] of entries.entries()) {
    for (const [total, candidates] of [...reachable.entries()].sort(
      ([a], [b]) => b - a,
    )) {
      const next = total + entry.durationMs;
      if (next > targetMs) continue;
      const frontier = reachable.get(next) ?? [];
      for (const selected of candidates) {
        const candidate: RemovalCandidate = {
          indexes: [...selected.indexes, index],
          continuityMs:
            selected.continuityMs +
            (entry.kind === "continuity" ? entry.durationMs : 0),
          spoken:
            selected.spoken +
            (entry.kind === "continuity" && entry.spoken ? 1 : 0),
          informational:
            selected.informational +
            (entry.kind === "continuity" && entry.informational ? 1 : 0),
        };
        if (frontier.some((existing) => dominates(existing, candidate)))
          continue;
        for (let cursor = frontier.length - 1; cursor >= 0; cursor -= 1) {
          if (dominates(candidate, frontier[cursor]!)) frontier.splice(cursor, 1);
        }
        frontier.push(candidate);
      }
      reachable.set(next, frontier);
    }
  }
  return (reachable.get(targetMs) ?? []).map(
    (candidate) => new Set(candidate.indexes),
  );
}

function tryComposition(
  original: BreakEntry[],
  additions: BreakEntry[],
  existingSpokenCount: number,
  maximumSpokenElements: number,
  maximumContinuityMs: number,
) {
  const addedDurationMs = additions.reduce((sum, entry) => sum + entry.durationMs, 0);
  let best:
    | { entries: BreakEntry[]; removedCommercials: number; removedContinuity: number }
    | undefined;
  for (const remove of removableSubsets(original, addedDurationMs)) {
    const retained = original.filter((_, index) => !remove.has(index));
    const combined = [...retained, ...additions];
    const continuityMs = combined
      .filter((entry) => entry.kind === "continuity")
      .reduce((sum, entry) => sum + entry.durationMs, 0);
    const spoken = combined.filter(
      (entry) => entry.kind === "continuity" && entry.spoken,
    ).length;
    const informational = combined.filter(
      (entry) => entry.kind === "continuity" && entry.informational,
    ).length;
    if (
      continuityMs > maximumContinuityMs ||
      existingSpokenCount + spoken > maximumSpokenElements ||
      informational > 1
    )
      continue;
    const returnClip = additions.find((entry) => entry.role === "return");
    const beforeReturn = additions.filter((entry) => entry !== returnClip);
    const removed = [...remove].map((index) => original[index]!);
    const removedCommercials = removed.filter((entry) => entry.kind === "commercial").length;
    const removedContinuity = removed.filter((entry) => entry.kind === "continuity").length;
    // Commercials stay the majority of a break: when two whole-item swaps both
    // preserve the exact duration, the one that gives up the fewest commercials
    // (and the most existing continuity) wins. Ties keep the first subset, so
    // the result stays deterministic.
    const better =
      !best ||
      removedCommercials < best.removedCommercials ||
      (removedCommercials === best.removedCommercials &&
        removedContinuity > best.removedContinuity);
    if (better)
      best = {
        entries: [...retained, ...beforeReturn, ...(returnClip ? [returnClip] : [])],
        removedCommercials,
        removedContinuity,
      };
  }
  return best?.entries;
}

/**
 * Reserve continuity by replacing complete existing break items only.
 *
 * If the replacement cannot preserve the exact original duration, the original
 * validated break is returned byte-for-byte in the same order. A return clip is
 * always last so playback resumes immediately after it.
 */
export function composeContinuityBreak(input: Input): {
  entries: BreakEntry[];
  usedContinuity: boolean;
  reason?: "BREAK_BUDGET";
} {
  const existingSpokenCount = input.existingSpokenCount ?? 0;
  const maximumSpokenElements = input.maximumSpokenElements ?? 2;
  const maximumContinuityMs = input.maximumContinuityMs ?? 20_000;
  const preferred = [input.promo, input.returnClip].filter(
    (entry): entry is BreakEntry => Boolean(entry),
  );
  const attempts = [
    preferred,
    ...(input.returnClip && input.promo ? [[input.returnClip]] : []),
    ...(input.promo && !input.returnClip ? [[input.promo]] : []),
  ];
  for (const additions of attempts) {
    if (!additions.length) continue;
    const entries = tryComposition(
      input.original,
      additions,
      existingSpokenCount,
      maximumSpokenElements,
      maximumContinuityMs,
    );
    if (entries) return { entries, usedContinuity: true };
  }
  return { entries: input.original, usedContinuity: false, reason: "BREAK_BUDGET" };
}

export type RemovalPlan = {
  indexes: number[];
  total: number;
  commercials: number;
  continuity: number;
};

/**
 * Whole-item removal subsets that free at least `minimumMs`, cheapest first.
 *
 * This is the bridge between the exact-swap composer and the bounded refill: a
 * real break rarely contains a single item of exactly five or ten seconds, so a
 * card is made room for by removing the smallest set of whole items that still
 * covers the card, then refilling the released remainder from the channel's own
 * interstitial pool. Every candidate keeps whole items only - nothing is
 * trimmed, retimed or split - so the break boundary stays exact.
 */
export function reserveRemovalPlans(
  entries: BreakEntry[],
  minimumMs: number,
  limit = 32,
): RemovalPlan[] {
  const hardCap = entries.reduce((sum, entry) => sum + entry.durationMs, 0);
  const better = (candidate: RemovalPlan, existing: RemovalPlan) =>
    candidate.commercials < existing.commercials ||
    (candidate.commercials === existing.commercials &&
      candidate.continuity > existing.continuity) ||
    (candidate.commercials === existing.commercials &&
      candidate.continuity === existing.continuity &&
      candidate.indexes.length < existing.indexes.length);
  const byTotal = new Map<number, RemovalPlan>([
    [0, { indexes: [], total: 0, commercials: 0, continuity: 0 }],
  ]);
  const stateCap = 5_000;
  for (const [index, entry] of entries.entries()) {
    for (const [total, plan] of [...byTotal.entries()].sort(([a], [b]) => a - b)) {
      const next = total + entry.durationMs;
      if (next > hardCap) continue;
      const candidate: RemovalPlan = {
        indexes: [...plan.indexes, index],
        total: next,
        commercials: plan.commercials + (entry.kind === "commercial" ? 1 : 0),
        continuity: plan.continuity + (entry.kind === "continuity" ? 1 : 0),
      };
      const existing = byTotal.get(next);
      if (
        !existing ||
        better(candidate, existing) ||
        byTotal.size > stateCap
      )
        byTotal.set(next, candidate);
    }
  }
  return [...byTotal.values()]
    .filter((plan) => plan.total >= minimumMs)
    .sort(
      (left, right) =>
        left.total - right.total ||
        left.commercials - right.commercials ||
        right.continuity - left.continuity,
    )
    .slice(0, limit);
}
