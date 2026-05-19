import fs from 'fs'
import path from 'node:path'
import { Client } from 'pg'

async function main() {
  const conn = process.env.PGCONN || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!conn) {
    console.error('Missing PG connection string. Set environment variable PGCONN (or SUPABASE_DB_URL/DATABASE_URL).')
    process.exit(1)
  }

  const schemaPath = path.join(process.cwd(), 'learnEnglish-master', 'learnEnglish-master', 'supabase', 'schema.sql')
  if (!fs.existsSync(schemaPath)) {
    console.error('Cannot find schema file at', schemaPath)
    process.exit(1)
  }

  const sql = fs.readFileSync(schemaPath, 'utf8')

  const client = new Client({ connectionString: conn })
  try {
    await client.connect()
    console.log('Connected to Postgres. Applying schema...')
    await client.query(sql)
    console.log('Schema applied successfully.')
  } catch (err) {
    console.error('Error applying schema:', err.message || err)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
