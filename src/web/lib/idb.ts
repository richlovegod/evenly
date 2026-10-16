// Minimal IndexedDB key-value store (one object store), with a localStorage fallback when
// IndexedDB is missing. Several tabs share it: changes that must not clobber another tab's
// records read and write inside one transaction (idbUpdate, and 'update' steps in idbBatch).
// Writes report whether they landed. A connection the browser closed (Safari does after a long
// sleep) is opened again on the next call.

const DB_NAME = 'evenly';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase | null> | null = null;
/** IndexedDB worked at least once on this page (a later failure is trouble, not "missing"). */
let opened = false;
/** IndexedDB is missing or never opened: localStorage for this page. */
let lsOnly = false;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const p: Promise<IDBDatabase | null> = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => {
          if (dbPromise === p) dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
          if (dbPromise === p) dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  dbPromise = p;
  return p;
}

/** The database; null: use localStorage instead; undefined: IndexedDB is not answering right now. */
async function database(): Promise<IDBDatabase | null | undefined> {
  if (lsOnly) return null;
  const db = await open();
  if (db) {
    opened = true;
    return db;
  }
  if (!opened) {
    lsOnly = true;
    return null;
  }
  dbPromise = null;
  return undefined;
}

type TxResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Run one transaction. `work` issues the requests and returns a function that reads the result
 * once the transaction is complete. Resolves null when localStorage is in use instead.
 */
async function transact<T>(mode: IDBTransactionMode, work: (st: IDBObjectStore) => () => T): Promise<TxResult<T> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await database();
    if (db === null) return null;
    if (db === undefined) return { ok: false };
    let tx: IDBTransaction;
    let read: () => T;
    try {
      tx = db.transaction(STORE, mode);
      read = work(tx.objectStore(STORE));
    } catch {
      // The browser closed the connection under us: open a new one and try once more.
      dbPromise = null;
      continue;
    }
    return new Promise(resolve => {
      tx.oncomplete = () => {
        try {
          resolve({ ok: true, value: read() });
        } catch {
          resolve({ ok: false });
        }
      };
      tx.onerror = () => resolve({ ok: false });
      tx.onabort = () => resolve({ ok: false });
    });
  }
  return { ok: false };
}

// ---------- localStorage fallback ----------

function lsKey(key: string) {
  return 'evenly.kv.' + key;
}

function lsGet<T>(key: string): T | undefined {
  try {
    const s = localStorage.getItem(lsKey(key));
    return s ? (JSON.parse(s) as T) : undefined;
  } catch {
    return undefined;
  }
}

function lsSet(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(lsKey(key), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function lsDel(key: string): boolean {
  try {
    localStorage.removeItem(lsKey(key));
    return true;
  } catch {
    return false;
  }
}

function lsKeys(prefix: string): string[] {
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

/** Keys that start with `prefix` (they all sort between prefix and prefix + U+FFFF). */
function prefixRange(prefix: string): IDBKeyRange | undefined {
  if (!prefix) return undefined;
  try {
    return IDBKeyRange.bound(prefix, prefix + '\uffff');
  } catch {
    return undefined;
  }
}

// ---------- the API ----------

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const r = await transact('readonly', st => {
    const req = st.get(key);
    return () => req.result as T | undefined;
  });
  if (r === null) return lsGet<T>(key);
  return r.ok ? r.value : undefined;
}

/** Resolves whether the value was stored. */
export async function idbSet(key: string, value: unknown): Promise<boolean> {
  const r = await transact('readwrite', st => {
    st.put(value, key);
    return () => true;
  });
  if (r === null) return lsSet(key, value);
  return r.ok;
}

export async function idbDel(key: string): Promise<boolean> {
  const r = await transact('readwrite', st => {
    st.delete(key);
    return () => true;
  });
  if (r === null) return lsDel(key);
  return r.ok;
}

export async function idbKeys(prefix = ''): Promise<string[]> {
  const r = await transact('readonly', st => {
    const req = st.getAllKeys(prefixRange(prefix));
    return () => (req.result as IDBValidKey[]).map(String).filter(k => k.startsWith(prefix));
  });
  if (r === null) return lsKeys(prefix);
  return r.ok ? r.value : [];
}

/** Every record whose key starts with `prefix`, read in one transaction; null when the read failed. */
export async function idbTryEntries<T>(prefix: string): Promise<[string, T][] | null> {
  const r = await transact('readonly', st => {
    const range = prefixRange(prefix);
    const keysReq = st.getAllKeys(range);
    const valsReq = st.getAll(range);
    return () => {
      const keys = (keysReq.result as IDBValidKey[]).map(String);
      const vals = valsReq.result as T[];
      const out: [string, T][] = [];
      keys.forEach((k, i) => {
        if (k.startsWith(prefix)) out.push([k, vals[i]]);
      });
      return out;
    };
  });
  if (r === null) {
    const out: [string, T][] = [];
    for (const k of lsKeys(prefix)) {
      const v = lsGet<T>(k);
      if (v !== undefined) out.push([k, v]);
    }
    return out;
  }
  return r.ok ? r.value : null;
}

/** Every record whose key starts with `prefix` ([] when the read failed). */
export async function idbEntries<T>(prefix: string): Promise<[string, T][]> {
  return (await idbTryEntries<T>(prefix)) ?? [];
}

/**
 * One step of idbBatch. 'update' reads the record and writes what `fn` returns (undefined: leave
 * it), inside the same transaction as the other steps.
 */
export type IdbOp =
  | { type: 'put'; key: string; value: unknown }
  | { type: 'del'; key: string }
  | { type: 'update'; key: string; fn: (prev: unknown) => unknown };

/** Several steps in one transaction: all of them land, in order, or none. Resolves whether they landed. */
export async function idbBatch(ops: readonly IdbOp[]): Promise<boolean> {
  if (!ops.length) return true;
  const r = await transact('readwrite', st => {
    for (const op of ops) {
      if (op.type === 'put') st.put(op.value, op.key);
      else if (op.type === 'del') st.delete(op.key);
      else {
        const req = st.get(op.key);
        req.onsuccess = () => {
          const next = op.fn(req.result);
          if (next !== undefined) st.put(next, op.key);
        };
      }
    }
    return () => true;
  });
  if (r === null) {
    let ok = true;
    for (const op of ops) {
      if (op.type === 'put') ok = lsSet(op.key, op.value) && ok;
      else if (op.type === 'del') ok = lsDel(op.key) && ok;
      else {
        const next = op.fn(lsGet(op.key));
        if (next !== undefined) ok = lsSet(op.key, next) && ok;
      }
    }
    return ok;
  }
  return r.ok;
}

/**
 * Read-modify-write one record in a single transaction, so a change another tab made in
 * between is not overwritten. `fn` gets the stored value (undefined when there is none) and
 * returns the new value, or undefined to leave the record as it is. Resolves the value written
 * (undefined when nothing was written or the write failed).
 */
export async function idbUpdate<T>(key: string, fn: (prev: T | undefined) => T | undefined): Promise<T | undefined> {
  let written: T | undefined;
  const ok = await idbBatch([
    {
      type: 'update',
      key,
      fn: prev => {
        written = fn(prev as T | undefined);
        return written;
      },
    },
  ]);
  return ok ? written : undefined;
}

/** Remove everything (sign out), except the keys `keep` says to leave. Resolves whether it worked. */
export async function idbClear(keep?: (key: string) => boolean): Promise<boolean> {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('evenly.kv.') && !(keep && keep(k.slice(lsKey('').length)))) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
  const r = await transact('readwrite', st => {
    if (!keep) {
      st.clear();
    } else {
      const req = st.getAllKeys();
      req.onsuccess = () => {
        for (const k of req.result as IDBValidKey[]) if (!keep(String(k))) st.delete(k);
      };
    }
    return () => true;
  });
  return r === null ? true : r.ok;
}
