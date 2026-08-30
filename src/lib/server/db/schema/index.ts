// Better Auth core tables, one file per table. The exported const names (`user`,
// `session`, `account`, `verification`) and the camelCase property keys are what the
// Drizzle adapter looks up by, so they must stay as-is. The snake_case strings are
// just the DB column names.
//
// Re-exported here so `import * as schema from './schema'` keeps working for both
// drizzle(client, { schema }) and better-auth's drizzleAdapter.

export * from './user';
export * from './session';
export * from './account';
export * from './verification';
