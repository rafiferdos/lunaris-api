import { sql } from 'drizzle-orm';
import { loadConfig } from '../config/env.js';
import { createDatabase } from '../db/client.js';
import { createAttemptService } from '../modules/attempts/service.js';
import { createLogger } from '../core/logger.js';
const config=loadConfig(),{db,pool}=createDatabase(config.DATABASE_URL);
try{const result=await createAttemptService(db).expire();await db.execute(sql`delete from request_limits where expires_at<now()-interval '1 day'`);createLogger(config).info(result,'Expired attempt sweep complete');}finally{await pool.end();}
