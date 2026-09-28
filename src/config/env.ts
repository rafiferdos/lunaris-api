import { z } from 'zod';
export const envSchema = z.object({
  NODE_ENV:z.enum(['development','test','production']).default('development'),
  PORT:z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL:z.url().startsWith('postgres'),
  BETTER_AUTH_SECRET:z.string().min(32),
  BETTER_AUTH_URL:z.url(),
  FRONTEND_ORIGIN:z.url(),
  LOG_LEVEL:z.enum(['trace','debug','info','warn','error','fatal','silent']).default('info'),
  TEST_DATABASE_URL:z.url().optional(),
  SEED_PASSWORD:z.string().min(12).optional(),
}).superRefine((v,c)=>{
 if(v.NODE_ENV==='production' && (!v.BETTER_AUTH_URL.startsWith('https://') || !v.FRONTEND_ORIGIN.startsWith('https://') || v.BETTER_AUTH_SECRET.startsWith('replace-'))) c.addIssue({code:'custom',message:'Production requires HTTPS origins and a random auth secret.'});
 for(const key of ['FRONTEND_ORIGIN','BETTER_AUTH_URL'] as const){const u=new URL(v[key]);if(u.username||u.password||u.search||u.hash||u.pathname!=='/')c.addIssue({code:'custom',path:[key],message:'Use an origin without path, credentials, query, or fragment.'});}
});
export type Config=z.infer<typeof envSchema>;
export function loadConfig(source:NodeJS.ProcessEnv=process.env):Config {return envSchema.parse(source);}
