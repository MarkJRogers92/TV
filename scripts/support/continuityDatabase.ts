import Database from "better-sqlite3";
import { createRepositories, type Repositories } from "../../src/db/repositories.js";

export type ReadOnlyDatabase = {
  repositories: Repositories;
  close: () => void;
};

/**
 * Open a MarkTV SQLite file for reading only.
 *
 * The continuity tooling is deliberately incapable of writing to the database
 * it inspects: it is handed a snapshot (or the operator accepts that a mistake
 * cannot mutate live state), never migrations, syncs or service restarts.
 */
export function openReadOnlyRepositories(path: string): ReadOnlyDatabase {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  database.pragma("query_only = ON");
  return {
    repositories: createRepositories(database),
    close: () => database.close(),
  };
}
