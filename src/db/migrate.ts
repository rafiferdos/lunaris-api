import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config/env.js';
import { createDatabase } from './client.js';
const {db,pool}=createDatabase(loadConfig().DATABASE_URL);
try{await migrate(db,{migrationsFolder:'src/db/migrations'});}finally{await pool.end();}
