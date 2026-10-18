/**
 * Test helpers: fresh, fully migrated in-memory databases in ~100 ms each.
 *
 * The first `createTestDb()` in a process builds a template (PGlite + Supabase
 * shims + every migration), dumps its data directory, and caches the dump.
 * Every call then boots a new PGlite from that dump, so tests are isolated
 * and never pay for migrations twice.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { migrate } from './migrate.js';
import { paths } from './paths.js';
import { createPgliteDb, type PgliteDb } from './pglite.js';
import type { AuthClaims, Db, Tx } from './types.js';

/** Options for {@link createTestDb}. */
export interface TestDbOptions {
  /** Migrations to apply. Defaults to the repo's supabase/migrations. */
  migrationsDir?: string;
  /** Load and `create extension pgtap` (in schema `extensions`). Default false. */
  pgtap?: boolean;
}

const templates = new Map<string, Promise<Blob>>();

function templateKey(options: TestDbOptions): string {
  return JSON.stringify([options.migrationsDir ? resolve(options.migrationsDir) : null, options.pgtap ?? false]);
}

async function buildTemplate(options: TestDbOptions): Promise<Blob> {
  const db = await createPgliteDb({ dataDir: 'memory', pgtap: options.pgtap ?? false });
  try {
    await migrate(db, {
      local: true,
      ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {}),
    });
    if (options.pgtap) await db.exec('create extension if not exists pgtap with schema extensions');
    return await db.pglite.dumpDataDir('none');
  } finally {
    await db.close();
  }
}

/**
 * The cached data-directory dump for `options`, built on first use. A failed
 * build is not cached, so a fixed migration is picked up by the next call.
 */
export function testDbTemplate(options: TestDbOptions = {}): Promise<Blob> {
  const key = templateKey(options);
  let template = templates.get(key);
  if (!template) {
    template = buildTemplate(options);
    templates.set(key, template);
    template.catch(() => {
      if (templates.get(key) === template) templates.delete(key);
    });
  }
  return template;
}

/** Forgets cached templates (e.g. after editing migrations in a watch-mode run). */
export function resetTestDbTemplates(): void {
  templates.clear();
}

/**
 * A fresh in-memory PGlite database with the Supabase shims and all
 * migrations applied. Close it when done (or use {@link withTestDb}).
 */
export async function createTestDb(options: TestDbOptions = {}): Promise<PgliteDb> {
  const template = await testDbTemplate(options);
  return createPgliteDb({ dataDir: 'memory', loadDataDir: template, pgtap: options.pgtap ?? false });
}

/** Runs `fn` with a fresh test database and closes it afterwards. */
export async function withTestDb<T>(fn: (db: PgliteDb) => Promise<T>, options: TestDbOptions = {}): Promise<T> {
  const db = await createTestDb(options);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** Claims for `sub` (a UUID), plus optional agent/install/via claims. */
export function claimsFor(sub: string, extra: Omit<AuthClaims, 'sub' | 'role'> = {}): AuthClaims {
  return { sub, ...extra };
}

/**
 * Runs `fn` as a user (RLS applies, `auth.uid()` = the user's id).
 * @param user a user id, or full claims.
 */
export function withUser<T>(db: Db, user: string | AuthClaims, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.asUser(typeof user === 'string' ? claimsFor(user) : user, fn);
}

/** Runs `fn` as `service_role` (bypasses RLS). */
export function withService<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.asService(fn);
}

/** Runs `fn` as `anon` (signed out; RLS applies). */
export function withAnon<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.asAnon(fn);
}

/** Input for {@link createAuthUser}. */
export interface AuthUserInput {
  /** Defaults to a random UUID. */
  id?: string;
  email?: string | null;
  /** Stored in `raw_user_meta_data` (e.g. `{user_name: 'octocat'}` for GitHub). */
  userMetadata?: Record<string, unknown>;
  /** Stored in `raw_app_meta_data` (e.g. `{provider: 'github'}`). */
  appMetadata?: Record<string, unknown>;
}

/**
 * Inserts a row into `auth.users` (local shim) as the database owner, firing
 * any triggers migrations put on it, and returns the user id.
 */
export async function createAuthUser(db: Db, input: AuthUserInput = {}): Promise<string> {
  const id = input.id ?? randomUUID();
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
     values ($1, $2, $3::jsonb, $4::jsonb, now())`,
    [
      id,
      input.email === undefined ? `${id}@example.test` : input.email,
      JSON.stringify(input.userMetadata ?? {}),
      JSON.stringify(input.appMetadata ?? { provider: 'github', providers: ['github'] }),
    ],
  );
  return id;
}

/** Default locations, re-exported for test files. */
export const testPaths = { migrationsDir: paths.migrationsDir, sqlTestsDir: paths.sqlTestsDir };
