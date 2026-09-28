import pg from 'pg';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { z } from 'zod';
const scope=z.object({topicId:z.uuid(),category:z.enum(['TECHNICAL','INTERPERSONAL']),mode:z.enum(['EASY','MEDIUM','COMPETITIVE'])});
export function createLeaderboardEvents(url:string,logger:Logger){const bus=new EventEmitter();bus.setMaxListeners(0);let client:pg.Client|undefined,retry:NodeJS.Timeout|undefined,closed=false;
 async function connect(){if(closed)return;const connection=new pg.Client({connectionString:url,connectionTimeoutMillis:5000});client=connection;let failed=false;const reconnect=()=>{if(failed||closed)return;failed=true;void connection.end().catch(()=>{});retry=setTimeout(()=>void connect(),2000);retry.unref();};connection.on('error',()=>{logger.warn('Leaderboard listener disconnected; reconnecting');reconnect();});connection.on('end',reconnect);connection.on('notification',message=>{try{const parsed=scope.safeParse(JSON.parse(message.payload??''));if(parsed.success)bus.emit('updated',parsed.data);}catch{logger.warn('Ignored malformed leaderboard notification');}});try{await connection.connect();await connection.query('LISTEN lunaris_leaderboard');if(closed)await connection.end();else bus.emit('updated',{refresh:true});}catch{reconnect();}}
 return {start:connect,subscribe(listener:(scope:unknown)=>void){bus.on('updated',listener);return ()=>bus.off('updated',listener);},async close(){closed=true;if(retry)clearTimeout(retry);bus.removeAllListeners();await client?.end();}};
}
export type LeaderboardEvents=ReturnType<typeof createLeaderboardEvents>;
