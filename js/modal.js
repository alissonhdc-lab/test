/* ==========================================================================
   modal.js — sistema simples de modais/diálogos e toasts de notificação.
   ========================================================================== */

(function (global) {
  "use strict";

  let root;
  let toastRoot;

  function ensureRoots() {
    if (!root) {
      root = document.getElementById("modal-root");
    }
    if (!toastRoot) {
      toastRoot = document.getElementById("toast-root");
    }
  }

  function closeModal() {
    ensureRoots();
    root.innerHTML = "";
    root.classList.remove("open");
  }

  function openModal({ title, bodyHtml, wide }) {
    ensureRoots();
    root.classList.add("open");
    root.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal"></div>
      <div class="modal-panel ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h3>${title}</h3>
          <button type="button" class="icon-btn" data-action="close-modal" aria-label="Fechar">✕</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    `;
    const panel = root.querySelector(".modal-panel");
    return panel;
  }

  function confirmModal({ title, message, confirmLabel, danger, onConfirm }) {
    const body = `
      <p class="confirm-message">${message}</p>
      <div class="form-actions">
        <button type="button" class="btn" data-action="close-modal">Cancelar</button>
        <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" id="confirm-ok-btn">${confirmLabel || "Confirmar"}</button>
      </div>
    `;
    openModal({ title, bodyHtml: body });
    document.getElementById("confirm-ok-btn").addEventListener("click", () => {
      closeModal();
      onConfirm && onConfirm();
    });
  }

  function toast(message, type) {
    ensureRoots();
    const el = document.createElement("div");
    el.className = `toast toast-${type || "info"}`;
    el.textContent = message;
    toastRoot.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  global.RTQC = global.RTQC || {};
  global.RTQC.modal = { openModal, closeModal, confirmModal, toast };
})(window);
