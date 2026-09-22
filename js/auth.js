/* ==========================================================================
   auth.js
   Autenticação via backend: login/senha e assinatura eletrônica de
   aprovação agora são verificados no servidor (banco SQLite), não mais no
   navegador. A sessão (qual usuário está "usando esta aba") continua sendo
   apenas um estado local leve em sessionStorage.
   ========================================================================== */

(function (global) {
  "use strict";

  const SESSION_KEY = "rtqc_session_v1";

  const Auth = {
    async hasAnyUser() {
      const { hasUsers } = await global.RTQC.store.api.apiGet("/api/auth/status");
      return hasUsers;
    },

    // Cria o primeiro usuário (administrador) — só funciona quando ainda
    // não existe nenhum usuário cadastrado.
    async setupFirstAdmin({ fullName, username, password }) {
      return global.RTQC.store.api.apiPost("/api/auth/setup", { fullName, username, password });
    },

    // Cria um novo usuário (tela Usuários) — usado quando já existe pelo
    // menos um administrador.
    async createUser({ fullName, username, password, role }) {
      return global.RTQC.store.api.apiPost("/api/usuarios", { fullName, username, password, role });
    },

    async login(username, password) {
      const user = await global.RTQC.store.api.apiPost("/api/auth/login", { username, password });
      const session = {
        userId: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        loginAt: new Date().toISOString(),
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      return session;
    },

    logout() {
      sessionStorage.removeItem(SESSION_KEY);
    },

    currentSession() {
      try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },

    async changePassword(userId, newPassword) {
      return global.RTQC.store.api.apiPost(`/api/usuarios/${userId}/reset-password`, { password: newPassword });
    },
  };

  global.RTQC = global.RTQC || {};
  global.RTQC.auth = Auth;
})(window);
