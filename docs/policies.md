# Versioned policy reference

An attempt snapshots its assessment configuration and `scoring/v1`, `xp/v1`, `rating/v1`, `integrity/v1` identifiers. Existing results are persisted and never recalculated on retrieval. Introduce a new engine version when changing formulas; do not silently reinterpret old snapshots.

## Scoring v1

| Mode        | Objective correct / partial / wrong | Weighted BEST / STRONG / ACCEPTABLE / WEAK |
| ----------- | ----------------------------------- | ------------------------------------------ |
| EASY        | 1 / 0.5 / 0                         | 1 / 1 / 0.5 / 0                            |
| MEDIUM      | 2 / 1 / -1                          | 5 / 2 / 1 / -1                             |
| COMPETITIVE | 3 / 1 / -2                          | 7 / 3 / 1 / -2                             |

Single choice is correct only for the sole correct option. Multiple-choice quality is `max(0, (truePositives - falsePositives) / correctOptionCount)`: quality 1 is CORRECT, between 0 and 1 is PARTIAL, and 0 is WRONG. Partial points are fixed by mode, not proportional to quality. Selecting every option cannot earn full credit. Skipped answers receive the lowest applicable score. Weighted questions accept one option and expose no objective correctness flag; weighted quality is BEST=1, STRONG=.75, ACCEPTABLE=.4, WEAK=0.

Normalized score is `clamp((rawScore - minimumPossibleScore) / (maximumPossibleScore - minimumPossibleScore) * 100, 0, 100)`. Objective accuracy counts fully correct objective answers; weighted-only accuracy is null. Weighted answer quality is reported separately. Negative raw scores are intentional; raw scores should never be displayed as percentages.

## XP v1

For fraction `p = normalizedScore / 100`, round:

`questionCount * 5 * (0.15 + 0.85 * p^1.35) * modeMultiplier * integrityMultiplier`

Mode multipliers: Easy 1, Medium 1.25, Competitive 1.5. Integrity multipliers: score >=90 gives 1, >=75 gives .9, >=60 gives .7, otherwise 0. Ineligible attempts receive zero XP. Academic results remain intact. One immutable ledger entry is written per finalization, including zero XP.

## Rating v1

Overall and per-topic ratings start at 1000. Mode references are 850 / 1000 / 1150. Expected performance is `1 / (1 + 10^((reference - currentRating)/400))`. The delta is rounded `K * modeFactor * (normalizedScore/100 - expected)`; K is 48 for the first 10 eligible assessments, 32 for the next 20 and 24 afterward. Mode factors are .8 / 1 / 1.2. Clamp the resulting rating to 0–3000. Ineligible/unranked attempts have zero delta. Store an event per overall/topic scope with before, after, delta and version.

Leaderboard tie order: XP descending, current overall rating descending, average normalized performance descending, eligible assessment count descending, user UUID ascending. Public-profile opt-out removes the user from public ranking. Weekly/monthly XP uses ledger timestamps; rating is current, not a period-only rating.

## Integrity v1

Start at 100. WINDOW_BLUR costs 3, TAB_HIDDEN 8, FULLSCREEN_EXIT 10. Focus events within 1500 ms are coalesced using server receipt time. Sustained SPEECH_ACTIVITY requires duration >=3000 ms; separate occurrences cost 10, 20, then 30. Scores clamp at zero. Scores below 90 return a warning; below 60 are ineligible.

Competitive TAB_HIDDEN immediately auto-submits and makes the result ineligible. Three sustained speech occurrences also auto-submit Competitive as a critical integrity event. Saved answers survive; unanswered questions receive skipped scoring. Other modes retain academic scoring and use the integrity eligibility/multiplier rules. MICROPHONE_UNAVAILABLE and INTEGRITY_HEARTBEAT are recorded without direct penalties. Browser timestamps and confidence are metadata, not trusted clocks or proof.

Event sequence numbers are unique within an attempt. Exact replay is idempotent; reusing a sequence with different contents fails. At most 2000 events are accepted per attempt. Events received after finalization cannot mutate the result. The server decides expiry using persisted `expiresAt`; a client countdown is only a presentation aid.
