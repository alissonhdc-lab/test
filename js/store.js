/* ==========================================================================
   store.js
   Camada de persistência (localStorage) e utilitários de dados.
   Toda a aplicação roda no navegador, sem backend: os dados ficam salvos
   apenas neste computador/navegador. Use o menu "Backup" para exportar e
   importar o arquivo JSON de dados.
   ========================================================================== */

(function (global) {
  "use strict";

  const DB_KEY = "rtqc_db_v1";
  const BACKEND_URL_KEY = "rtqc_backend_url_v1";

  function uid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function emptyDb() {
    return {
      version: 1,
      users: [],
      equipments: [],
      routines: [],
      results: [],
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (!raw) return emptyDb();
      const db = JSON.parse(raw);
      return Object.assign(emptyDb(), db);
    } catch (e) {
      console.error("Falha ao carregar base de dados local:", e);
      return emptyDb();
    }
  }

  function save(db) {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  }

  // ------------------------------------------------------------------
  // CRUD genérico
  // ------------------------------------------------------------------
  const Store = {
    uid,
    nowIso,

    get() {
      return load();
    },

    replaceAll(db) {
      save(db);
    },

    reset() {
      save(emptyDb());
    },

    // ---- users ----
    addUser(user) {
      const db = load();
      db.users.push(user);
      save(db);
      return user;
    },
    updateUser(id, patch) {
      const db = load();
      const u = db.users.find((x) => x.id === id);
      if (u) Object.assign(u, patch);
      save(db);
      return u;
    },
    deleteUser(id) {
      const db = load();
      db.users = db.users.filter((x) => x.id !== id);
      save(db);
    },
    findUserByUsername(username) {
      const db = load();
      const uname = (username || "").trim().toLowerCase();
      return db.users.find((u) => u.username.toLowerCase() === uname) || null;
    },

    // ---- equipments ----
    addEquipment(eq) {
      const db = load();
      db.equipments.push(eq);
      save(db);
      return eq;
    },
    updateEquipment(id, patch) {
      const db = load();
      const e = db.equipments.find((x) => x.id === id);
      if (e) Object.assign(e, patch);
      save(db);
      return e;
    },
    deleteEquipment(id) {
      const db = load();
      const routineIds = db.routines.filter((r) => r.equipmentId === id).map((r) => r.id);
      db.results = db.results.filter((r) => !routineIds.includes(r.routineId));
      db.routines = db.routines.filter((r) => r.equipmentId !== id);
      db.equipments = db.equipments.filter((x) => x.id !== id);
      save(db);
    },

    // ---- routines ----
    addRoutine(routine) {
      const db = load();
      db.routines.push(routine);
      save(db);
      return routine;
    },
    updateRoutine(id, patch) {
      const db = load();
      const r = db.routines.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
      save(db);
      return r;
    },
    deleteRoutine(id) {
      const db = load();
      db.results = db.results.filter((r) => r.routineId !== id);
      db.routines = db.routines.filter((x) => x.id !== id);
      save(db);
    },
    routinesByEquipment(equipmentId) {
      return load().routines.filter((r) => r.equipmentId === equipmentId);
    },

    // ---- results ----
    addResult(result) {
      const db = load();
      db.results.push(result);
      save(db);
      return result;
    },
    updateResult(id, patch) {
      const db = load();
      const r = db.results.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
      save(db);
      return r;
    },
    deleteResult(id) {
      const db = load();
      db.results = db.results.filter((x) => x.id !== id);
      save(db);
    },
    resultsByRoutine(routineId) {
      return load()
        .results.filter((r) => r.routineId === routineId)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    },
  };

  // ------------------------------------------------------------------
  // Cálculo de próxima data / status de vencimento de rotina
  // ------------------------------------------------------------------
  function addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d;
  }

  function routineDueStatus(routine, results) {
    const freq = global.RTQC.catalog.FREQUENCIES[routine.frequency];
    const relevant = results.filter((r) => r.routineId === routine.id).sort((a, b) => new Date(b.date) - new Date(a.date));
    const last = relevant[0] || null;
    const baseDate = last ? last.date : routine.createdAt;
    const nextDue = freq ? addDays(baseDate, freq.days) : null;
    const today = new Date();
    let status = "ok";
    if (nextDue) {
      const diffDays = Math.floor((nextDue - today) / (1000 * 60 * 60 * 24));
      if (diffDays < 0) status = "overdue";
      else if (diffDays <= 3) status = "soon";
      else status = "ok";
    } else {
      status = "unknown";
    }
    return { last, nextDue, status };
  }

  Store.getBackendUrl = function () {
    return localStorage.getItem(BACKEND_URL_KEY) || "http://localhost:8420";
  };
  Store.setBackendUrl = function (url) {
    localStorage.setItem(BACKEND_URL_KEY, url.trim().replace(/\/+$/, ""));
  };

  global.RTQC = global.RTQC || {};
  global.RTQC.store = Store;
  global.RTQC.util = { addDays, routineDueStatus };
})(window);
