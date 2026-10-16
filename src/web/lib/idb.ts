// Minimal IndexedDB key-value store (one object store), with a localStorage fallback.

const DB_NAME = 'evenly';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function lsKey(key: string) {
  return 'evenly.kv.' + key;
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) {
    try {
      const s = localStorage.getItem(lsKey(key));
      return s ? (JSON.parse(s) as T) : undefined;
    } catch {
      return undefined;
    }
  }
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await open();
  if (!db) {
    try {
      localStorage.setItem(lsKey(key), JSON.stringify(value));
    } catch {
      /* full or unavailable */
    }
    return;
  }
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function idbDel(key: string): Promise<void> {
  const db = await open();
  if (!db) {
    try {
      localStorage.removeItem(lsKey(key));
    } catch {
      /* ignore */
    }
    return;
  }
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function idbKeys(prefix = ''): Promise<string[]> {
  const db = await open();
  if (!db) {
    const out: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(lsKey(prefix))) out.push(k.slice(lsKey('').length));
      }
    } catch {
      /* ignore */
    }
    return out;
  }
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String).filter(k => k.startsWith(prefix)));
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** Remove everything (sign out). */
export async function idbClear(): Promise<void> {
  const db = await open();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('evenly.kv.')) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
  if (!db) return;
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
