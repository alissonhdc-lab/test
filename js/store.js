/* ==========================================================================
   store.js
   Cliente da API do backend (substitui o antigo armazenamento local do
   navegador). Todos os dados — usuários, equipamentos, rotinas e resultados
   — agora vivem no banco do backend, para que o observador de pastas possa
   gravar resultados automaticamente mesmo sem nenhum navegador aberto.
   ========================================================================== */

(function (global) {
  "use strict";

  const BACKEND_URL_KEY = "rtqc_backend_url_v1";

  function getBackendUrl() {
    return localStorage.getItem(BACKEND_URL_KEY) || "http://localhost:8420";
  }
  function setBackendUrl(url) {
    localStorage.setItem(BACKEND_URL_KEY, url.trim().replace(/\/+$/, ""));
  }

  async function apiFetch(path, options) {
    let resp;
    try {
      resp = await fetch(getBackendUrl() + path, options);
    } catch (err) {
      const e = new Error(
        `Não foi possível conectar ao servidor (${getBackendUrl()}). Verifique se o backend está rodando (veja backend/README.md) e a URL configurada em Backup.`
      );
      e.isNetworkError = true;
      throw e;
    }
    let data = null;
    const text = await resp.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = null;
      }
    }
    if (!resp.ok) {
      const msg = data && data.detail ? data.detail : `Erro ${resp.status} ao comunicar com o servidor.`;
      const e = new Error(msg);
      e.status = resp.status;
      throw e;
    }
    return data;
  }

  function apiGet(path) {
    return apiFetch(path);
  }
  function apiPost(path, body) {
    return apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  function apiPut(path, body) {
    return apiFetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  function apiDelete(path) {
    return apiFetch(path, { method: "DELETE" });
  }

  const Store = {
    getBackendUrl,
    setBackendUrl,
    api: { apiGet, apiPost, apiPut, apiDelete },

    async healthCheck() {
      return apiGet("/api/health");
    },

    async get() {
      const [users, equipments, routines, results] = await Promise.all([
        apiGet("/api/usuarios"),
        apiGet("/api/equipamentos"),
        apiGet("/api/rotinas"),
        apiGet("/api/resultados"),
      ]);
      return { users, equipments, routines, results };
    },

    async replaceAll(data) {
      return apiPost("/api/backup/import", data);
    },

    // ---- equipamentos ----
    addEquipment(eq) {
      return apiPost("/api/equipamentos", eq);
    },
    updateEquipment(id, patch) {
      return apiPut(`/api/equipamentos/${id}`, patch);
    },
    deleteEquipment(id) {
      return apiDelete(`/api/equipamentos/${id}`);
    },

    // ---- rotinas ----
    addRoutine(routine) {
      return apiPost("/api/rotinas", routine);
    },
    updateRoutine(id, patch) {
      return apiPut(`/api/rotinas/${id}`, patch);
    },
    deleteRoutine(id) {
      return apiDelete(`/api/rotinas/${id}`);
    },
    routinesByEquipment(equipmentId) {
      return apiGet(`/api/rotinas?equipment_id=${encodeURIComponent(equipmentId)}`);
    },

    // ---- resultados ----
    addResult(result) {
      return apiPost("/api/resultados", result);
    },
    deleteResult(id) {
      return apiDelete(`/api/resultados/${id}`);
    },
    resultsByRoutine(routineId) {
      return apiGet(`/api/resultados?routine_id=${encodeURIComponent(routineId)}`);
    },
    approveResult(id, username, password) {
      return apiPost(`/api/resultados/${id}/approve`, { username, password });
    },

    // ---- usuários ----
    deleteUser(id) {
      return apiDelete(`/api/usuarios/${id}`);
    },

    // ---- pastas observadas ----
    listWatchFolders(routineId) {
      const qs = routineId ? `?routine_id=${encodeURIComponent(routineId)}` : "";
      return apiGet(`/api/watch-folders${qs}`);
    },
    addWatchFolder(routineId, folderPath) {
      return apiPost("/api/watch-folders", { routineId, folderPath });
    },
    setWatchFolderActive(id, active) {
      return apiPut(`/api/watch-folders/${id}`, { active });
    },
    deleteWatchFolder(id) {
      return apiDelete(`/api/watch-folders/${id}`);
    },

    // ---- backup ----
    exportBackup() {
      return apiGet("/api/backup/export");
    },

    // ---- backup automático de segurança ----
    getAutoBackupSetting() {
      return apiGet("/api/settings/auto-backup");
    },
    setAutoBackupDir(dir) {
      return apiPost("/api/settings/auto-backup", { autoBackupDir: dir });
    },
    runAutoBackupNow() {
      return apiPost("/api/settings/auto-backup/run-now");
    },
  };

  // ------------------------------------------------------------------
  // Cálculo de próxima data / status de vencimento de rotina (client-side,
  // não depende do backend — recebe os dados já carregados).
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

  global.RTQC = global.RTQC || {};
  global.RTQC.store = Store;
  global.RTQC.util = { addDays, routineDueStatus };
})(window);
