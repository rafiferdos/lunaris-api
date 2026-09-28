import { defineConfig } from 'drizzle-kit';
import { loadEnvFile } from 'node:process';
try{loadEnvFile('.env');}catch(error){if(!(error instanceof Error && 'code' in error && error.code==='ENOENT'))throw error;}
export default defineConfig({schema:'./src/db/schema/*.ts',out:'./src/db/migrations',dialect:'postgresql',dbCredentials:{url:process.env.DATABASE_URL??''}});
