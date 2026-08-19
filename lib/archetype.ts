import type { GameSnapshotState } from "./game";

/**
 * The run's verdict, in one line.
 *
 * The score says how you did. It does not say what you ARE, and the brief this
 * game is built against asks for a result that can be *compared, explained or
 * roasted* — which a number cannot carry on its own. An archetype can: two
 * players can hold "HUMAN PELICAN" and "POISON CONTROL" up against each other
 * and immediately have something to say. The two ship together on the result
 * card: the number to compare, the title to argue about.
 *
 * Rules are ordered most-specific first and the first match wins, so the
 * unusual runs get the interesting labels and the ordinary run falls through
 * to the ordinary one.
 */
export interface Archetype {
  /** Short, uppercase, stamped across the result card. */
  title: string;
}

export function archetypeFor(s: {
  caught: number;
  caughtRare: number;
  gulps: number;
  score: number;
}): Archetype {
  const { caught, caughtRare, gulps, score } = s;

  if (caught === 0) return { title: "Skunked" };

  // A negative total takes precedence over everything: there is exactly one way
  // to get one, and it is far funnier than whatever else the run did.
  if (score < 0) return { title: "Poison Control" };

  if (gulps >= caught) return { title: "Human Pelican" };
  if (caught >= 5) return { title: "Commercial Trawler" };
  if (caughtRare === caught) return { title: "Gold Digger" };
  if (gulps > 0) return { title: "Raw Bar" };
  if (caughtRare > 0) return { title: "Lucky Nose" };
  return { title: "Weekend Angler" };
}

/** `3 fish · 1 rare · 2 eaten`, skipping the parts that are zero. */
export function tallyLine(s: Pick<GameSnapshotState, "caught" | "caughtRare" | "gulps">) {
  const parts = [`${s.caught} fish`];
  if (s.caughtRare > 0) parts.push(`${s.caughtRare} rare`);
  if (s.gulps > 0) parts.push(`${s.gulps} eaten`);
  return parts.join(" · ");
}
