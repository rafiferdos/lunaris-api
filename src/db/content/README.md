# Launch content v1

`launch-v1.json` contains 260 authored questions: ten per topic across the 26 catalog topics, with four foundational, three intermediate and three advanced questions per topic. Together with 25 original demonstration questions, `db:release` imports 285 immutable questions without demo accounts. Technical topics use single-choice answers; interpersonal topics use graded, weighted choices with explanations.

Coverage tests validate the strict import schema, distinct topic/prompt/context combinations, logical question keys and every default mode's difficulty distribution. These checks do not establish psychometric validity. Have subject-matter reviewers review correctness, difficulty and interpersonal scoring before using scores for high-stakes decisions. Publish revisions under higher versions of the same logical key so existing attempt snapshots remain unchanged.
