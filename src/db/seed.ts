import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import seedData from './seed-data.json' with {type:'json'};
import { createDatabase,type Database } from './client.js';
import { user } from './schema/auth.js';
import { topics,configs,profiles,attempts } from './schema/domain.js';
import { policies } from '../modules/assessments/policy.js';
import { categorySchema,importSchema } from '../modules/questions/schema.js';
import { createAuth } from '../modules/auth/auth.js';
import { createAdminService } from '../modules/admin/service.js';
import { createAttemptService } from '../modules/attempts/service.js';
import { loadConfig,type Config } from '../config/env.js';
import { createLogger } from '../core/logger.js';
export const seedDocument=importSchema.parse(seedData.document);
export async function seedCatalog(db:Database){const input=z.array(z.object({slug:z.string(),name:z.string(),description:z.string(),category:categorySchema})).parse(seedData.topics);await db.insert(topics).values(input).onConflictDoNothing();const rows=await db.select().from(topics);await db.insert(configs).values(rows.flatMap(topic=>(Object.keys(policies) as (keyof typeof policies)[]).map(mode=>({topicId:topic.id,mode,policy:policies[mode]})))).onConflictDoNothing();}
export async function seedDevelopment(db:Database,config:Config){if(config.NODE_ENV==='production')throw new Error('Development seed is disabled in production.');if(!config.SEED_PASSWORD)throw new Error('Set SEED_PASSWORD for development seed accounts.');await seedCatalog(db);const auth=createAuth(db,config);const accounts=[{email:'admin@lunaris.local',name:'Lunaris Admin',username:'lunaris_admin',role:'ADMIN' as const},{email:'sofia@lunaris.local',name:'Sofia Chen',username:'sofia_chen',role:'USER' as const},{email:'arjun@lunaris.local',name:'Arjun Mehta',username:'arjun_mehta',role:'USER' as const}];const ids:string[]=[];
 for(const account of accounts){let [identity]=await db.select().from(user).where(eq(user.email,account.email));if(!identity){await auth.api.signUpEmail({body:{email:account.email,password:config.SEED_PASSWORD,name:account.name}});[identity]=await db.select().from(user).where(eq(user.email,account.email));}if(!identity)throw new Error('Seed identity could not be created.');await db.update(user).set({role:account.role}).where(eq(user.id,identity.id));await db.insert(profiles).values({userId:identity.id,username:account.username,bio:'Development sample account',timezone:'UTC'}).onConflictDoNothing();ids.push(identity.id);}
 const imported=await createAdminService(db).import(ids[0]!,seedDocument);
 for(const [i,id] of ids.entries()){if(i===0)continue;const existing=await db.select({id:attempts.id}).from(attempts).where(eq(attempts.userId,id)).limit(1);if(existing.length)continue;const time=new Date();time.setUTCDate(time.getUTCDate()-1);const service=createAttemptService(db,()=>time);const a=await service.start(id,{topicSlug:i===1?'javascript':'communication',mode:'MEDIUM',requestKey:randomUUID()});for(const q of a.questions){await service.answer(id,a.id,q.id,{selected:[q.options[i%q.options.length]!.id],responseTimeMs:25000});}await service.submit(id,a.id);}
 return {users:ids.length,questions:imported};
}
if(import.meta.url===new URL(process.argv[1]??'', 'file://').href){const config=loadConfig(),{db,pool}=createDatabase(config.DATABASE_URL);try{createLogger(config).info(await seedDevelopment(db,config),'Development seed complete');}finally{await pool.end();}}
