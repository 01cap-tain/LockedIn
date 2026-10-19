import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DatabasePool } from './db.js'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const adjacentMigrationDirectory = path.join(moduleDirectory, 'migrations')
const migrationDirectory = existsSync(adjacentMigrationDirectory)
  ? adjacentMigrationDirectory
  : path.resolve(moduleDirectory, '../src/migrations')

export async function runMigrations(pool: DatabasePool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  const files = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort()
  const applied: string[] = []
  for (const file of files) {
    const exists = await pool.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [file],
    )
    if (exists.rowCount !== 0) continue
    const sql = await readFile(path.join(migrationDirectory, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query(sql)
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
        [file],
      )
      applied.push(file)
    } finally {
      client.release()
    }
  }
  return applied
}
