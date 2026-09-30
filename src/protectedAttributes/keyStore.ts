import { config } from '@grafana/runtime';

const databaseName = 'grafana-tempo-protected-keys';
const storeName = 'keys';
const channelName = 'grafana-tempo-protected-keys-change';

export interface StoredProtectedKey {
  id: string;
  scope: string;
  kid: string;
  key: CryptoKey;
}

type KeyChange = { scope: string; kid?: string };
const operations = new Map<string, Promise<void>>();
const listeners = new Set<(change: KeyChange) => void>();
let channel: BroadcastChannel | undefined;

export function protectedKeyScope(datasourceUid: string): string | undefined {
  const user = config.bootData?.user;
  if (!datasourceUid || !user || !Number.isSafeInteger(user.orgId) || user.orgId <= 0) {
    return undefined;
  }
  const identity = user.isSignedIn
    ? user.uid || (Number.isSafeInteger(user.id) && user.id > 0 ? String(user.id) : '')
    : 'anonymous';
  return identity ? JSON.stringify([user.orgId, user.isSignedIn ? 'user' : 'anonymous', identity, datasourceUid]) : undefined;
}

export function keyStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function recordId(scope: string, kid: string): string {
  return JSON.stringify([scope, kid]);
}

function serialize<T>(scope: string, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(scope) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  operations.set(scope, settled);
  void settled.then(() => {
    if (operations.get(scope) === settled) {
      operations.delete(scope);
    }
  });
  return result;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(databaseName, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(storeName, { keyPath: 'id' });
      store.createIndex('scope', 'scope');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Protected key storage is blocked.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, setResult: (value: T) => void) => void): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      let result!: T;
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(storeName, mode);
        work(transaction.objectStore(storeName), (value) => { result = value; });
      } catch (error) {
        try {
          transaction!.abort();
        } catch {
          // The transaction may already have ended.
        }
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Protected key storage aborted.'));
    });
  } finally {
    db.close();
  }
}

export function loadStoredKeys(scope: string): Promise<StoredProtectedKey[]> {
  return serialize(scope, () => withStore<StoredProtectedKey[]>('readonly', (store, setResult) => {
    const request = store.index('scope').getAll(scope);
    request.onsuccess = () => setResult(request.result as StoredProtectedKey[]);
  }));
}

export function saveStoredKeys(scope: string, keys: ReadonlyArray<{ kid: string; key: CryptoKey }>): Promise<void> {
  return serialize(scope, () => withStore<void>('readwrite', (store) => {
    for (const { kid, key } of keys) {
      store.put({ id: recordId(scope, kid), scope, kid, key } satisfies StoredProtectedKey);
    }
  }));
}

export function deleteStoredKey(scope: string, kid: string): Promise<void> {
  return serialize(scope, () => withStore<void>('readwrite', (store) => {
    store.delete(recordId(scope, kid));
  }));
}

export function deleteAllStoredKeys(scope: string): Promise<void> {
  return serialize(scope, () => withStore<void>('readwrite', (store) => {
    const request = store.index('scope').openKeyCursor(IDBKeyRange.only(scope));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  }));
}

function receive(change: KeyChange): void {
  if (typeof change?.scope !== 'string' || (change.kid !== undefined && typeof change.kid !== 'string')) {
    return;
  }
  for (const listener of listeners) {
    listener(change);
  }
}

export function subscribeStoredKeyChanges(listener: (change: KeyChange) => void): () => void {
  listeners.add(listener);
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(channelName);
      channel.onmessage = (event: MessageEvent<KeyChange>) => receive(event.data);
    } catch {
      // Browser storage still works when cross-tab messaging is unavailable.
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      channel?.close();
      channel = undefined;
    }
  };
}

export function announceStoredKeyDeletion(change: KeyChange): void {
  receive(change);
  channel?.postMessage(change);
}
