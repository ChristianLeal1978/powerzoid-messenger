const qrScreen = document.getElementById('qr-screen');
const qrImg = document.getElementById('qr-img');
const qrStatus = document.getElementById('qr-status');
const app = document.getElementById('app');
const rail = document.getElementById('rail');
const statusDot = document.getElementById('status-dot');
const chatListEl = document.getElementById('chat-list');
const chatListStatus = document.getElementById('chat-list-status');
const convEmpty = document.getElementById('conv-empty');
const convActive = document.getElementById('conv-active');
const convName = document.getElementById('conv-name');
const messagesEl = document.getElementById('messages');
const composer = document.getElementById('composer');
const composerInput = document.getElementById('composer-input');
const backBtn = document.getElementById('back-btn');
const divider = document.getElementById('divider');

let chats = [];
let selectedChatId = null;

function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}

function formatTime(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

function setConnectionState(state) {
  rail.className = 'rail' + (state === 'ready' ? '' : ` ${state}`);
  statusDot.className = 'dot' + (state === 'ready' ? '' : ` ${state}`);
}

// --- QR / estado ---
window.api.onQr((dataUrl) => {
  qrImg.src = dataUrl;
  qrStatus.textContent = 'Esperando código…';
  setConnectionState('reconnecting');
});

window.api.onStatus((status) => {
  if (status === 'ready') {
    qrScreen.classList.add('hidden');
    app.classList.remove('hidden');
    setConnectionState('ready');
  } else if (status === 'disconnected' || status === 'auth_failure') {
    setConnectionState('disconnected');
    qrStatus.textContent = 'Sesión desconectada. Reinicia la app.';
  }
});

// --- Lista de chats ---
window.api.onChats((list) => {
  chats = list;
  chatListStatus.classList.add('hidden');
  renderChatList();
});

window.api.onChatsError(({ attempt }) => {
  chatListStatus.textContent = `No se pudo cargar la lista de chats (intento ${attempt}). Reintentando…`;
  chatListStatus.classList.remove('hidden');
});

function renderChatList() {
  chatListEl.innerHTML = '';
  chats.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'chat-row' + (c.id === selectedChatId ? ' active' : '');
    row.innerHTML = `
      <div class="avatar">${initials(c.name)}</div>
      <div class="chat-meta">
        <div class="chat-name">${escapeHtml(c.name)}</div>
        <div class="chat-snippet">${escapeHtml(c.lastMessage || '')}</div>
      </div>
      <div class="chat-side">
        <span class="chat-time">${formatTime(c.timestamp)}</span>
        ${c.unreadCount ? `<span class="badge">${c.unreadCount}</span>` : ''}
      </div>
    `;
    row.addEventListener('click', () => openChat(c.id, c.name));
    chatListEl.appendChild(row);
  });
}

// --- Conversación activa ---
async function openChat(chatId, name) {
  selectedChatId = chatId;
  renderChatList();
  convEmpty.classList.add('hidden');
  convActive.classList.remove('hidden');
  convName.textContent = name;
  messagesEl.innerHTML = '<div class="status-text">Cargando…</div>';

  const res = await window.api.getMessages(chatId);
  messagesEl.innerHTML = '';
  if (!res.ok) {
    messagesEl.innerHTML = '<div class="status-text">No se pudieron cargar los mensajes. Puede ser el bug conocido de whatsapp-web.js — revisa el README.</div>';
    return;
  }
  res.messages.forEach(renderMessage);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // El proceso principal ya marcó el chat como leído (chat.sendSeen()) al
  // pedir los mensajes; reflejamos eso de inmediato en la lista en vez de
  // esperar al próximo pushChatList() (que solo llega con mensajes nuevos).
  const openedChat = chats.find((c) => c.id === chatId);
  if (openedChat && openedChat.unreadCount) {
    openedChat.unreadCount = 0;
    renderChatList();
  }
}

function renderMessage(msg) {
  const b = document.createElement('div');
  b.className = 'bubble' + (msg.fromMe ? ' mine' : '');
  b.innerHTML = `${escapeHtml(msg.body || (msg.hasMedia ? '📎 Adjunto' : ''))}<span class="t">${formatTime(msg.timestamp)}</span>`;
  messagesEl.appendChild(b);
}

window.api.onIncoming((msg) => {
  if (msg.chatId === selectedChatId) {
    renderMessage(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
});

backBtn.addEventListener('click', () => {
  selectedChatId = null;
  convActive.classList.add('hidden');
  convEmpty.classList.remove('hidden');
  renderChatList();
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = composerInput.value.trim();
  if (!text || !selectedChatId) return;
  composerInput.value = '';
  const res = await window.api.sendMessage(selectedChatId, text);
  if (!res.ok) {
    composerInput.value = text; // no perdemos lo escrito si falló el envío
  }
});

// --- Ajuste del alto de la lista de chats (arrastrando el divisor) ---
const SPLIT_STORAGE_KEY = 'whatsapp-sidebar:chatListHeight';
const MIN_CHAT_LIST_HEIGHT = 90;
const MIN_CONVERSATION_HEIGHT = 160;

function applySavedSplit() {
  const saved = Number(localStorage.getItem(SPLIT_STORAGE_KEY));
  if (saved && Number.isFinite(saved)) {
    chatListEl.style.flex = 'none';
    chatListEl.style.height = `${saved}px`;
  }
}
applySavedSplit();

let dragging = false;

divider.addEventListener('mousedown', (e) => {
  dragging = true;
  divider.classList.add('dragging');
  document.body.style.cursor = 'row-resize';
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const listTop = chatListEl.getBoundingClientRect().top;
  const maxHeight = window.innerHeight - listTop - MIN_CONVERSATION_HEIGHT;
  const newHeight = Math.max(MIN_CHAT_LIST_HEIGHT, Math.min(maxHeight, e.clientY - listTop));
  chatListEl.style.flex = 'none';
  chatListEl.style.height = `${newHeight}px`;
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  divider.classList.remove('dragging');
  document.body.style.cursor = '';
  localStorage.setItem(SPLIT_STORAGE_KEY, parseInt(chatListEl.style.height, 10));
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
