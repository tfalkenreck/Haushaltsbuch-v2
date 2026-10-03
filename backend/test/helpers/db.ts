import { openDatabase, type Db } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';

/** Frische, vollständig migrierte In-Memory-Datenbank. */
export function createTestDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}
