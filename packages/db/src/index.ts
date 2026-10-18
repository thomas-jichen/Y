/**
 * @paceline/db: database adapters (PGlite and `pg`), RLS-scoped transactions,
 * the migration runner, test helpers and the pgTAP runner.
 *
 * Typical use in apps/core:
 *
 *   const db = await createDb(process.env);
 *   await migrate(db);
 *   const rows = await db.asUser({ sub: userId, agent_id, via: 'install' }, (tx) =>
 *     tx.query('select * from activities where id = $1', [id]),
 *   );
 */
export type {
  AuthClaims,
  Db,
  DbErrorReporter,
  DbKind,
  JwtClaims,
  ListenOptions,
  NotificationHandler,
  QueryParams,
  QueryResult,
  Queryable,
  Row,
  Tx,
  Unlisten,
} from './types.js';
export {
  DbClosedError,
  DbError,
  InvalidClaimsError,
  NestedDbCallError,
  SQLSTATE,
  TransactionClosedError,
  isSqlState,
  sqlState,
} from './errors.js';
export {
  ANON_CLAIMS_JSON,
  MAX_NOTIFY_PAYLOAD_BYTES,
  NOTIFY_SQL,
  SERVICE_CLAIMS_JSON,
  SET_CLAIMS_SQL,
  anonContextStatements,
  assertChannel,
  assertPayload,
  listenSql,
  normalizeClaims,
  notifyIn,
  notifyStatement,
  quoteIdent,
  serializeClaims,
  serviceContextStatements,
  unlistenSql,
  userContextStatements,
  type Statement,
} from './sql.js';
export { createPgliteDb, pgliteExtensions, pgliteStartParams, type PgliteDb, type PgliteDbOptions } from './pglite.js';
export {
  ARRAY_TYPES_SQL,
  PgListener,
  PgTypeParsers,
  createPgDb,
  extendedQuery,
  parseDate,
  parseInt8,
  type PgDb,
  type PgDbOptions,
  type PgListenClientLike,
  type PgNotificationLike,
  type PgPoolClientLike,
  type PgPoolLike,
  type PgQueryConfig,
  type PgResultLike,
} from './pg.js';
export { createDb, envFlag, type CreateDbOptions, type DbEnv } from './create.js';
export { findWorkspaceRoot, paths, resolveDataDir } from './paths.js';
export {
  LOCAL_ONLY_MARKER,
  MIGRATION_LOCK_KEY,
  MigrationFailedError,
  MigrationHashMismatchError,
  MigrationTransactionControlError,
  applyLocalShims,
  ensureMigrationsTable,
  findTransactionControl,
  hashSql,
  isLocalOnlyMigration,
  listAppliedMigrations,
  loadMigrationFiles,
  migrate,
  migrationStatus,
  readLocalShims,
  type AppliedMigration,
  type HashMismatch,
  type MigrateOptions,
  type MigrateResult,
  type MigrationFile,
  type MigrationStatus,
} from './migrate.js';
export {
  claimsFor,
  createAuthUser,
  createTestDb,
  resetTestDbTemplates,
  testDbTemplate,
  testPaths,
  withAnon,
  withService,
  withTestDb,
  withUser,
  type AuthUserInput,
  type TestDbOptions,
} from './testing.js';
export { isTapLine, parseTap, type TapAssertion, type TapDirective, type TapPlan, type TapReport } from './tap.js';
export {
  formatSqlTestFile,
  formatSqlTestRun,
  listSqlTestFiles,
  runSqlTestFile,
  runSqlTests,
  type SqlTestError,
  type SqlTestFileResult,
  type SqlTestOptions,
  type SqlTestRunResult,
} from './sqltest.js';
export { runCli, parseArgs, loadEnvFile, type CliIo } from './cli.js';
