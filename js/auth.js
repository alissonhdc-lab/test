/* ==========================================================================
   auth.js
   Autenticação local (usuário/senha) e sessão. As senhas são armazenadas
   com hash SHA-256 + salt via Web Crypto API. Isto NÃO é um mecanismo de
   segurança de nível servidor (tudo roda no navegador do usuário) mas
   evita guardar a senha em texto puro e permite usar login/senha como
   assinatura eletrônica de aprovação dos testes de CQ.
   ========================================================================== */

(function (global) {
  "use strict";

  const SESSION_KEY = "rtqc_session_v1";

  function bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function hashPassword(password, salt) {
    const enc = new TextEncoder();
    const data = enc.encode(salt + ":" + password);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return bufToHex(digest);
  }

  function randomSalt() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return bufToHex(arr.buffer);
  }

  const Auth = {
    hasAnyUser() {
      return global.RTQC.store.get().users.length > 0;
    },

    async createUser({ username, fullName, password, role }) {
      const store = global.RTQC.store;
      if (store.findUserByUsername(username)) {
        throw new Error("Já existe um usuário com este nome de usuário.");
      }
      const salt = randomSalt();
      const passwordHash = await hashPassword(password, salt);
      const user = {
        id: store.uid(),
        username: username.trim(),
        fullName: fullName.trim(),
        role: role || "tecnico",
        salt,
        passwordHash,
        createdAt: store.nowIso(),
      };
      store.addUser(user);
      return user;
    },

    async verifyCredentials(username, password) {
      const user = global.RTQC.store.findUserByUsername(username);
      if (!user) return null;
      const hash = await hashPassword(password, user.salt);
      if (hash === user.passwordHash) return user;
      return null;
    },

    async login(username, password) {
      const user = await this.verifyCredentials(username, password);
      if (!user) throw new Error("Usuário ou senha inválidos.");
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
      const store = global.RTQC.store;
      const salt = randomSalt();
      const passwordHash = await hashPassword(newPassword, salt);
      store.updateUser(userId, { salt, passwordHash });
    },

    // Assinatura eletrônica: usada no botão "Aprovar" de um resultado.
    // Verifica usuário + senha (não depende de quem está logado no momento)
    // e retorna os dados a serem "carimbados" no resultado.
    async signApproval(username, password) {
      const user = await this.verifyCredentials(username, password);
      if (!user) throw new Error("Usuário ou senha inválidos para assinatura de aprovação.");
      return {
        userId: user.id,
        username: user.username,
        fullName: user.fullName,
        approvedAt: new Date().toISOString(),
      };
    },
  };

  global.RTQC = global.RTQC || {};
  global.RTQC.auth = Auth;
})(window);
