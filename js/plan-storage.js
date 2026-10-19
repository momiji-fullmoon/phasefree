var PlanStorage = (() => {
  "use strict";
  function open(factory = globalThis.indexedDB) {
    return new Promise((resolve, reject) => {
      if (!factory) { reject(new Error("IndexedDBを利用できません。JSON書出しで記録を保存できます")); return; }
      let abandoned = false;
      const request = factory.open("kumamoto-phase-free-p1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("workspace");
      request.onerror = () => reject(request.error || new Error("保存領域を開けません"));
      request.onblocked = () => { abandoned = true; reject(new Error("他の画面で保存領域を使用中です")); };
      request.onsuccess = () => {
        const db = request.result;
        if (abandoned) { db.close(); return; }
        db.onversionchange = () => db.close();
        const transact = (mode, action) => new Promise((ok, fail) => {
          let result;
          const tx = db.transaction("workspace", mode), store = tx.objectStore("workspace");
          const req = action(store);
          req.onsuccess = () => { result = req.result; };
          tx.oncomplete = () => ok(result);
          tx.onerror = tx.onabort = () => fail(tx.error || req.error || new Error("保存処理に失敗しました"));
        });
        resolve({ load: () => transact("readonly", store => store.get("current")),
          save: value => transact("readwrite", store => store.put(value, "current")), close: () => db.close() });
      };
    });
  }
  return { open };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PlanStorage;
