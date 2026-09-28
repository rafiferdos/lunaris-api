import { loadConfig } from '../config/env.js';
import { createDatabase } from '../db/client.js';
import { user } from '../db/schema/auth.js';
import { rebuildUser } from '../modules/stats/rebuild.js';
import { createLogger } from '../core/logger.js';
const config=loadConfig(),{db,pool}=createDatabase(config.DATABASE_URL);
try{const users=await db.select({id:user.id}).from(user);for(const u of users)await rebuildUser(db,u.id);createLogger(config).info({users:users.length},'Metrics rebuilt');}finally{await pool.end();}
