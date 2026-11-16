/**
 * The on-device database (IndexedDB). Projects, experiments and discovery candidates each have a
 * store; every record is keyed by its `id`.
 */

const DB_NAME = 'matterlab';
const DB_VERSION = 2;

export type StoreName = 'projects' | 'experiments' | 'candidates';
const STORES: readonly StoreName[] = ['projects', 'experiments', 'candidates'];

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      // Version 1 had only `projects`; later versions add stores and never remove data.
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The on-device library could not be opened.'));
    request.onblocked = () => reject(new Error('The on-device library is in use by another tab running an older version of MATTER LAB. Close it and try again.'));
  });
}

/** Runs one request against a store and resolves with its result. */
export async function withStore<T>(name: StoreName, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(name, mode);
      const request = run(transaction.objectStore(name));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('The on-device library request failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('The on-device library transaction was aborted.'));
    });
  } finally {
    db.close();
  }
}

export function getAll<T>(name: StoreName): Promise<T[]> {
  return withStore<T[]>(name, 'readonly', (store) => store.getAll() as IDBRequest<T[]>);
}

export function getOne<T>(name: StoreName, id: string): Promise<T | undefined> {
  return withStore<T | undefined>(name, 'readonly', (store) => store.get(id) as IDBRequest<T | undefined>);
}

export async function putOne<T extends { readonly id: string }>(name: StoreName, record: T): Promise<void> {
  await withStore(name, 'readwrite', (store) => store.put(record));
}

export async function deleteOne(name: StoreName, id: string): Promise<void> {
  await withStore(name, 'readwrite', (store) => store.delete(id));
}
