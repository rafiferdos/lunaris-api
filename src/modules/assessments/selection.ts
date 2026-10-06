import { assert } from '../../core/errors.js';
import { randomInt } from 'node:crypto';
import type { Question } from '../questions/schema.js';
import type { Policy } from './policy.js';
export function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
// Largest remainder apportionment: exact count, zero-weight levels stay excluded.
export function difficultyTargets(policy: Policy) {
  const total = Object.values(policy.distribution).reduce((a, b) => a + b, 0);
  const entries = Object.entries(policy.distribution).map(([difficulty, weight], index) => {
    const exact = (policy.questionCount * weight) / total;
    return {
      difficulty: difficulty as Question['difficulty'],
      count: Math.floor(exact),
      remainder: exact % 1,
      index,
    };
  });
  let missing = policy.questionCount - entries.reduce((n, entry) => n + entry.count, 0);
  for (const entry of [...entries].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (missing-- <= 0) break;
    entry.count++;
  }
  return Object.fromEntries(entries.map(({ difficulty, count }) => [difficulty, count])) as Record<
    Question['difficulty'],
    number
  >;
}
export function hasCoverage(
  counts: Partial<Record<Question['difficulty'], number>>,
  policy: Policy,
) {
  return Object.entries(difficultyTargets(policy)).every(
    ([difficulty, count]) => (counts[difficulty as Question['difficulty']] ?? 0) >= count,
  );
}
export function selectQuestions<T extends { id: string; content: Question }>(
  pool: T[],
  policy: Policy,
  recent: Set<string>,
) {
  const order = shuffle(pool).sort((a, b) => Number(recent.has(a.id)) - Number(recent.has(b.id)));
  const selected: T[] = [];
  for (const [difficulty, target] of Object.entries(difficultyTargets(policy))) {
    const eligible = order.filter((q) => q.content.difficulty === difficulty);
    assert(
      eligible.length >= target,
      409,
      'INSUFFICIENT_QUESTIONS',
      'Not enough published questions at the required difficulty.',
    );
    selected.push(...eligible.slice(0, target));
  }
  return shuffle(selected);
}
