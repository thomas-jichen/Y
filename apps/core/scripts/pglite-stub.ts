/** Serverless build stand-in for PGlite and @y/db's PGlite adapter (see build-vercel.ts). */
const fail = (): never => { throw new Error('PGlite is not available in the serverless build; set DATABASE_URL'); };
export const PGlite = new Proxy(function () {}, { construct: fail, get: fail }) as unknown as new () => never;
export const createPgliteDb = fail;
export const pgliteExtensions = {};
export const pgliteStartParams = {};
export const vector = {}, citext = {}, pg_trgm = {}, pgcrypto = {}, uuid_ossp = {}, pgtap = {};
export const protocol = {} as never;
