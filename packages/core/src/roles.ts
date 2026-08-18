/**
 * The dashboard's read-only database role.
 *
 * The dashboard only ever reads. Giving it a role that physically cannot write
 * means a bug or an injection in a metrics query cannot damage the wiki, rather
 * than relying on every query being careful.
 *
 * Its password is its own secret, set in the environment. That is what lets the
 * dashboard container run without the Postgres admin password at all: it is
 * given only the credential it actually needs.
 */

import type { Sql } from './db.ts'

export const READONLY_ROLE = 'athena_readonly'

/** Postgres identifiers cannot be parameterised, so they are quoted by hand. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Create or update the role and grant it SELECT across one database.
 *
 * Called once per database, by whichever service runs migrations. Safe to run
 * repeatedly and safe to run concurrently: everything here is idempotent, and
 * the caller holds the migration advisory lock.
 *
 * The default privileges matter as much as the grants. Wiki.js creates its
 * tables after this has already run, so without them the dashboard would be
 * able to read nothing it did not already know about.
 */
export async function ensureReadOnlyRole(
  sql: Sql,
  options: { password: string; database: string; owner: string },
): Promise<void> {
  const role = quoteIdent(READONLY_ROLE)
  const password = quoteLiteral(options.password)

  // CREATE ROLE has no IF NOT EXISTS, so this is the documented idiom.
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(READONLY_ROLE)}) THEN
        CREATE ROLE ${role} LOGIN PASSWORD ${password};
      ELSE
        ALTER ROLE ${role} LOGIN PASSWORD ${password};
      END IF;
    END
    $$;
  `)

  await sql.unsafe(`GRANT CONNECT ON DATABASE ${quoteIdent(options.database)} TO ${role}`)
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
  await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
  await sql.unsafe(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`)

  // Tables created from now on, by the service that owns the schema.
  await sql.unsafe(`
    ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(options.owner)} IN SCHEMA public
      GRANT SELECT ON TABLES TO ${role}
  `)

  // Explicitly deny everything else, in case the database grants PUBLIC by
  // default on an older server.
  await sql.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${role}`).catch(() => {})
}
