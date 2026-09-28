import pino from 'pino';
import type { Config } from '../config/env.js';
export const createLogger=(config:Config)=>pino({level:config.LOG_LEVEL,redact:['password','token','cookie','authorization','req.headers.cookie','req.headers.authorization']});
