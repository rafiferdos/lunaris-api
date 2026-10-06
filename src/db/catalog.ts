import { z } from 'zod';
import catalogData from './catalog-data.json' with { type: 'json' };
import type { Database } from './client.js';
import { topics, configs } from './schema/domain.js';
import { policies } from '../modules/assessments/policy.js';
import { categorySchema } from '../modules/questions/schema.js';
export async function seedCatalog(db: Database) {
  const input = z
    .array(
      z.object({
        slug: z.string(),
        name: z.string(),
        description: z.string(),
        category: categorySchema,
      }),
    )
    .parse(catalogData);
  await db.insert(topics).values(input).onConflictDoNothing();
  const rows = await db.select().from(topics);
  await db
    .insert(configs)
    .values(
      rows.flatMap((topic) =>
        (Object.keys(policies) as (keyof typeof policies)[]).map((mode) => ({
          topicId: topic.id,
          mode,
          policy: policies[mode],
        })),
      ),
    )
    .onConflictDoNothing();
}
