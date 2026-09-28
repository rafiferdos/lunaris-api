import { serve } from '@hono/node-server';
import { loadConfig } from './config/env.js';
import { createDatabase } from './db/client.js';
import { createLogger } from './core/logger.js';
import { createLeaderboardEvents } from './modules/leaderboard/events.js';
import { createApp } from './app.js';
const config=loadConfig(),logger=createLogger(config),{db,pool}=createDatabase(config.DATABASE_URL);
pool.on('error',()=>logger.error('Unexpected database pool error'));
const events=createLeaderboardEvents(config.DATABASE_URL,logger);await events.start();
const {app}=createApp(db,config,events);
const server=serve({fetch:app.fetch,port:config.PORT},()=>logger.info({port:config.PORT},'Lunaris API listening'));
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;logger.info('Graceful shutdown started');const deadline=setTimeout(()=>{logger.error('Shutdown deadline exceeded');process.exit(1);},10000);deadline.unref();server.close();if('closeIdleConnections' in server)server.closeIdleConnections();try{await events.close();await pool.end();}finally{clearTimeout(deadline);if('closeAllConnections' in server)server.closeAllConnections();}}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
