// Local save (IndexedDB): the album survives a page reload.
// The original files stay in the browser itself — nothing leaves the computer.
const DB_NAME = 'vento';
const DB_VERSION = 1;
let dbp;

function open() {
  return (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function tx(storeName, mode, fn) {
  return open().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const putAsset = (a) => tx('assets', 'readwrite', (s) => s.put(a));
export const getAllAssets = () => tx('assets', 'readonly', (s) => s.getAll());
export const deleteAsset = (id) => tx('assets', 'readwrite', (s) => s.delete(id));
export const saveProject = (p) => tx('meta', 'readwrite', (s) => s.put(p, 'project'));
export const loadProject = () => tx('meta', 'readonly', (s) => s.get('project'));
export const clearAll = () =>
  Promise.all([tx('assets', 'readwrite', (s) => s.clear()), tx('meta', 'readwrite', (s) => s.clear())]);
