import { webcrypto } from 'node:crypto';

import { type DataQueryRequest } from '@grafana/data';

import { createTempoDatasource } from './test/mocks';
import { type TempoQuery } from './types';
import { prepareProtectedQueryModel } from './protectedAttributes/model';
import * as keyStore from './protectedAttributes/keyStore';

jest.mock('./protectedAttributes/keyStore', () => ({
  protectedKeyScope: jest.fn(),
  keyStorageAvailable: jest.fn(),
  subscribeStoredKeyChanges: jest.fn(),
  announceStoredKeyDeletion: jest.fn(),
  loadStoredKeys: jest.fn(),
  saveStoredKeys: jest.fn(),
  deleteStoredKey: jest.fn(),
  deleteAllStoredKeys: jest.fn(),
}));

const master = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const scope = 'test-tempo-scope';

function datasource() {
  return createTempoDatasource(undefined, {
    uid: 'tempo-persistent',
    jsonData: { protectedAttributesEnabled: true },
  });
}

async function prepare(ds: ReturnType<typeof datasource>, query: TempoQuery) {
  return (ds as unknown as { prepareTargets(request: DataQueryRequest<TempoQuery>): Promise<DataQueryRequest<TempoQuery>> })
    .prepareTargets({ targets: [query] } as DataQueryRequest<TempoQuery>);
}

describe('Tempo browser key persistence', () => {
  let records: Map<string, keyStore.StoredProtectedKey>;

  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  });

  afterAll(() => {
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      Reflect.deleteProperty(globalThis, 'crypto');
    }
  });

  beforeEach(() => {
    jest.resetAllMocks();
    records = new Map();
    jest.mocked(keyStore.protectedKeyScope).mockReturnValue(scope);
    jest.mocked(keyStore.keyStorageAvailable).mockReturnValue(true);
    jest.mocked(keyStore.subscribeStoredKeyChanges).mockReturnValue(() => undefined);
    jest.mocked(keyStore.announceStoredKeyDeletion).mockImplementation(() => undefined);
    jest.mocked(keyStore.loadStoredKeys).mockImplementation(async () => [...records.values()]);
    jest.mocked(keyStore.saveStoredKeys).mockImplementation(async (savedScope, keys) => {
      for (const { kid, key } of keys) {
        records.set(kid, { id: JSON.stringify([savedScope, kid]), scope: savedScope, kid, key });
      }
    });
    jest.mocked(keyStore.deleteStoredKey).mockImplementation(async (_, kid) => {
      records.delete(kid);
    });
    jest.mocked(keyStore.deleteAllStoredKeys).mockImplementation(async () => {
      records.clear();
    });
  });

  it('restores the key before compiling a saved protected query after navigation', async () => {
    const first = datasource();
    await first.whenProtectedKeysReady();
    const kid = await first.importProtectedKey(master);
    const saved = await prepareProtectedQueryModel(
      { refId: 'A', queryType: 'traceql', query: '{span.enc.password="abc"}', filters: [] },
      first.protectedKey!,
      first.uid
    );
    expect(records.get(kid)?.key.extractable).toBe(false);

    let finishLoad!: (records: keyStore.StoredProtectedKey[]) => void;
    jest.mocked(keyStore.loadStoredKeys).mockImplementationOnce(() => new Promise((resolve) => {
      finishLoad = resolve;
    }));
    const restored = datasource();
    const pending = prepare(restored, saved);
    let compiled = false;
    void pending.then(() => { compiled = true; });
    await Promise.resolve();
    expect(compiled).toBe(false);
    finishLoad([...records.values()]);

    const result = await pending;
    expect(restored.protectedKeys.map((key) => key.kid)).toEqual([kid]);
    expect(result.targets[0].query).toContain('span.enc.password="enc:v1:');
    expect(result.targets[0].query).not.toContain('"abc"');
  });

  it('waits for durable deletion before forgetting and does not reload the key', async () => {
    const first = datasource();
    await first.whenProtectedKeysReady();
    const kid = await first.importProtectedKey(master);
    let finishDelete!: () => void;
    jest.mocked(keyStore.deleteStoredKey).mockImplementationOnce(() => new Promise((resolve) => {
      finishDelete = () => {
        records.delete(kid);
        resolve();
      };
    }));

    const forgetting = first.clearProtectedKey(kid);
    expect(first.protectedKey?.kid).toBe(kid);
    finishDelete();
    await expect(forgetting).resolves.toBe(true);
    expect(first.protectedKey).toBeUndefined();

    const reloaded = datasource();
    await reloaded.whenProtectedKeysReady();
    expect(reloaded.protectedKeys).toEqual([]);
  });

  it('does not revive a key when Forget all wins a pending restore', async () => {
    const first = datasource();
    await first.whenProtectedKeysReady();
    await first.importProtectedKey(master);
    const prior = [...records.values()];
    let finishLoad!: (records: keyStore.StoredProtectedKey[]) => void;
    jest.mocked(keyStore.loadStoredKeys).mockImplementationOnce(() => new Promise((resolve) => {
      finishLoad = resolve;
    }));

    const restoring = datasource();
    await expect(restoring.clearAllProtectedKeys()).resolves.toBe(true);
    finishLoad(prior);
    await restoring.whenProtectedKeysReady();
    expect(restoring.protectedKeys).toEqual([]);
  });

  it('does not revive a key after a deletion broadcast races with restore or import', async () => {
    const first = datasource();
    await first.whenProtectedKeysReady();
    const kid = await first.importProtectedKey(master);
    const prior = [...records.values()];
    let receiveDeletion!: (change: { scope: string; kid?: string }) => void;
    jest.mocked(keyStore.subscribeStoredKeyChanges).mockImplementation((listener) => {
      receiveDeletion = listener;
      return () => undefined;
    });
    let finishLoad!: (records: keyStore.StoredProtectedKey[]) => void;
    jest.mocked(keyStore.loadStoredKeys).mockImplementationOnce(() => new Promise((resolve) => {
      finishLoad = resolve;
    }));

    const restoring = datasource();
    receiveDeletion({ scope, kid });
    finishLoad(prior);
    await restoring.whenProtectedKeysReady();
    expect(restoring.protectedKeys).toEqual([]);

    const pendingImport = restoring.importProtectedKey(master);
    receiveDeletion({ scope, kid });
    await expect(pendingImport).rejects.toThrow('superseded');
    expect(restoring.protectedKeys).toEqual([]);
  });

  it('removes a late saved record after another tab forgets the same key', async () => {
    let receiveDeletion!: (change: { scope: string; kid?: string }) => void;
    jest.mocked(keyStore.subscribeStoredKeyChanges).mockImplementation((listener) => {
      receiveDeletion = listener;
      return () => undefined;
    });
    const ds = datasource();
    await ds.whenProtectedKeysReady();
    let startSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => { startSave = resolve; });
    let finishSave!: () => void;
    jest.mocked(keyStore.saveStoredKeys).mockImplementationOnce((savedScope, keys) => new Promise((resolve) => {
      finishSave = () => {
        for (const { kid, key } of keys) {
          records.set(kid, { id: JSON.stringify([savedScope, kid]), scope: savedScope, kid, key });
        }
        resolve();
      };
      startSave();
    }));

    const pendingImport = ds.importProtectedKey(master);
    await saveStarted;
    receiveDeletion({ scope, kid: '630dcd2966c4336691125448bbb25b4f' });
    finishSave();
    await expect(pendingImport).rejects.toThrow('superseded');
    expect(ds.protectedKeys).toEqual([]);
    expect(records.size).toBe(0);
  });

  it('clears the in-memory key even if persistent deletion fails', async () => {
    const ds = datasource();
    await ds.whenProtectedKeysReady();
    const kid = await ds.importProtectedKey(master);
    jest.mocked(keyStore.deleteStoredKey).mockRejectedValueOnce(new Error('IndexedDB blocked'));
    await expect(ds.clearProtectedKey(kid)).resolves.toBe(false);
    expect(ds.protectedKeys).toEqual([]);
    expect(records.has(kid)).toBe(true);
  });
});
