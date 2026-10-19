import { randomBytes } from 'node:crypto'

import pg from 'pg'

import type { DatabasePool } from './db.js'

const { Pool } = pg

export interface IsolatedDatabase {
  pool: DatabasePool
  close(): Promise<void>
}

export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!connectionString) throw new Error('No PostgreSQL test URL is configured.')
  const schema = `lockedin_test_${randomBytes(8).toString('hex')}`
  const administrator = new Pool({ connectionString, max: 1 })
  await administrator.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({
    connectionString,
    max: 2,
    options: `-c search_path=${schema}`,
  })
  return {
    pool,
    async close(): Promise<void> {
      await pool.end()
      await administrator.query(`DROP SCHEMA "${schema}" CASCADE`)
      await administrator.end()
    },
  }
}
