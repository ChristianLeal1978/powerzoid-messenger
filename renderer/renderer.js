const qrScreen = document.getElementById('qr-screen');
const qrImg = document.getElementById('qr-img');
const qrStatus = document.getElementById('qr-status');
const qrRefreshBtn = document.getElementById('qr-refresh-btn');
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
const mentionListEl = document.getElementById('mention-list');
const emojiPickerEl = document.getElementById('emoji-picker');
const emojiBtn = document.getElementById('emoji-btn');
const attachBtn = document.getElementById('attach-btn');
const imageInput = document.getElementById('image-input');
const imagePreviewEl = document.getElementById('image-preview');
const imagePreviewImg = document.getElementById('image-preview-img');
const imagePreviewRemove = document.getElementById('image-preview-remove');
const lightboxEl = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const topbarTitle = document.getElementById('topbar-title');
const chatSearchInput = document.getElementById('chat-search-input');
const searchBtn = document.getElementById('search-btn');

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

let chats = [];
let selectedChatId = null;
const messageElements = new Map(); // msgId -> .bubble-wrap, para reacciones en vivo
const chatReactionAlerts = new Map(); // chatId -> emoji, para avisar en la lista
let openReactionBarWrap = null;
let currentChatIsGroup = false;
let groupParticipants = [];
let pendingMentions = new Map(); // id -> nombre, para el envío
let pendingImage = null; // { base64, mimetype, filename } de la imagen adjunta, antes de enviar
let reactingToMessageId = null; // id del mensaje al que se está por reaccionar desde el picker de "+"
let chatSearchQuery = ''; // filtro en vivo sobre nombre/último mensaje de la lista de chats
let mentionMatches = [];
let mentionActiveIndex = 0;
let mentionQueryStart = -1;

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
  qrRefreshBtn.disabled = false;
  qrRefreshBtn.textContent = 'Generar nuevo código';
});

qrRefreshBtn.addEventListener('click', async () => {
  qrRefreshBtn.disabled = true;
  qrRefreshBtn.textContent = 'Generando…';
  qrStatus.textContent = 'Generando nuevo código…';
  await window.api.regenerateQr();
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

window.api.onChatsSyncing(({ attempt }) => {
  chatListStatus.textContent = `Sincronizando chats desde tu teléfono… (intento ${attempt})`;
  chatListStatus.classList.remove('hidden');
});

function renderChatList() {
  chatListEl.innerHTML = '';
  const q = chatSearchQuery.trim().toLowerCase();
  const list = q
    ? chats.filter(
        (c) => c.name.toLowerCase().includes(q) || (c.lastMessage || '').toLowerCase().includes(q)
      )
    : chats;
  if (q && !list.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-search-empty';
    empty.textContent = 'Sin resultados';
    chatListEl.appendChild(empty);
    return;
  }
  list.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'chat-row' + (c.id === selectedChatId ? ' active' : '');
    const avatarHtml = c.avatar ? `<img src="${c.avatar}" alt="" />` : initials(c.name);
    row.innerHTML = `
      <div class="avatar">${avatarHtml}</div>
      <div class="chat-meta">
        <div class="chat-name">${escapeHtml(c.name)}</div>
        <div class="chat-snippet">${escapeHtml(c.lastMessage || '')}</div>
      </div>
      <div class="chat-side">
        <span class="chat-time">${formatTime(c.timestamp)}</span>
        ${chatReactionAlerts.has(c.id) ? `<span class="reaction-alert">${chatReactionAlerts.get(c.id)}</span>` : ''}
        ${c.unreadCount ? `<span class="badge">${c.unreadCount}</span>` : ''}
      </div>
    `;
    row.addEventListener('click', () => openChat(c.id, c.name));
    chatListEl.appendChild(row);
  });
}

// --- Buscador de chats ---
function openChatSearch() {
  topbarTitle.classList.add('hidden');
  chatSearchInput.classList.remove('hidden');
  searchBtn.classList.add('active');
  chatSearchInput.focus();
}

function closeChatSearch() {
  topbarTitle.classList.remove('hidden');
  chatSearchInput.classList.add('hidden');
  searchBtn.classList.remove('active');
  chatSearchInput.value = '';
  chatSearchQuery = '';
  renderChatList();
}

searchBtn.addEventListener('click', () => {
  if (chatSearchInput.classList.contains('hidden')) {
    openChatSearch();
  } else {
    closeChatSearch();
  }
});

chatSearchInput.addEventListener('input', () => {
  chatSearchQuery = chatSearchInput.value;
  renderChatList();
});

chatSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeChatSearch();
});

// --- Conversación activa ---
async function openChat(chatId, name) {
  selectedChatId = chatId;
  chatReactionAlerts.delete(chatId);
  pendingMentions = new Map();
  clearPendingImage();
  reactingToMessageId = null;
  hideMentionList();
  emojiPickerEl.classList.add('hidden');
  renderChatList();
  convEmpty.classList.add('hidden');
  convActive.classList.remove('hidden');
  convName.textContent = name;
  messagesEl.innerHTML = '<div class="status-text">Cargando…</div>';
  messageElements.clear();
  openReactionBarWrap = null;
  autoResizeComposer();

  const chatMeta = chats.find((c) => c.id === chatId);
  currentChatIsGroup = !!(chatMeta && chatMeta.isGroup);
  groupParticipants = [];
  if (currentChatIsGroup) {
    window.api.getGroupParticipants(chatId).then((res) => {
      if (res.ok && chatId === selectedChatId) groupParticipants = res.participants;
    });
  }

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
  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap' + (msg.fromMe ? ' mine' : '');

  const b = document.createElement('div');
  b.className = 'bubble' + (msg.fromMe ? ' mine' : '') + (msg.sticker ? ' sticker-bubble' : '');
  // authorName solo viene poblado para mensajes de grupo que no son míos
  // (ver serializeMessage() en main.js) — así identificamos quién escribió qué.
  const authorHtml = msg.authorName ? `<span class="author">${escapeHtml(msg.authorName)}</span>` : '';
  const bodyHtml = msg.sticker
    ? `<img class="sticker" src="${msg.sticker}" alt="sticker" />`
    : msg.image
    ? `<img class="msg-image" src="${msg.image}" alt="imagen" />${msg.body ? `<span class="image-caption">${escapeHtml(msg.body)}</span>` : ''}`
    : escapeHtml(msg.body || (msg.hasMedia ? '📎 Adjunto' : ''));
  b.innerHTML = `${authorHtml}${bodyHtml}<span class="t">${formatTime(msg.timestamp)}</span>`;
  b.addEventListener('click', () => toggleReactionBar(wrap, msg.id));
  if (msg.image) {
    // El click en la imagen abre el modo teatro y no debe además togglear la
    // barra de reacciones (que está en el listener del bubble, arriba).
    const imgEl = b.querySelector('.msg-image');
    if (imgEl) {
      imgEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openLightbox(msg.image);
      });
    }
  }
  wrap.appendChild(b);

  const reactionsEl = document.createElement('div');
  reactionsEl.className = 'reactions';
  renderReactions(reactionsEl, msg.reactions || []);
  wrap.appendChild(reactionsEl);

  messagesEl.appendChild(wrap);
  messageElements.set(msg.id, wrap);
}

// --- Modo teatro: vista ampliada de imágenes ---
function openLightbox(src) {
  lightboxImg.src = src;
  lightboxEl.classList.remove('hidden');
}

function closeLightbox() {
  lightboxEl.classList.add('hidden');
  lightboxImg.src = '';
}

lightboxEl.addEventListener('click', closeLightbox);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightboxEl.classList.contains('hidden')) closeLightbox();
});

// --- Reacciones ---
function renderReactions(el, reactions) {
  el.innerHTML = '';
  reactions.forEach((r) => {
    const pill = document.createElement('span');
    pill.className = 'reaction-pill' + (r.byMe ? ' mine' : '');
    pill.textContent = r.count > 1 ? `${r.emoji} ${r.count}` : r.emoji;
    el.appendChild(pill);
  });
}

function closeReactionBar() {
  if (!openReactionBarWrap) return;
  const bar = openReactionBarWrap.querySelector('.reaction-bar');
  if (bar) bar.remove();
  openReactionBarWrap = null;
}

function toggleReactionBar(wrap, msgId) {
  if (openReactionBarWrap === wrap) {
    closeReactionBar();
    return;
  }
  closeReactionBar();
  const bar = document.createElement('div');
  bar.className = 'reaction-bar';
  QUICK_REACTIONS.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = emoji;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeReactionBar();
      await window.api.reactToMessage(msgId, emoji);
    });
    bar.appendChild(btn);
  });
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'reaction-more-btn';
  moreBtn.textContent = '+';
  moreBtn.setAttribute('aria-label', 'Buscar otro emoji');
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeReactionBar();
    reactingToMessageId = msgId;
    hideMentionList();
    positionFloatingPanel(emojiPickerEl);
    emojiPickerEl.classList.remove('hidden');
  });
  bar.appendChild(moreBtn);
  wrap.appendChild(bar);
  openReactionBarWrap = wrap;
}

document.addEventListener('click', (e) => {
  if (openReactionBarWrap && !openReactionBarWrap.contains(e.target)) {
    closeReactionBar();
  }
});

window.api.onReactionUpdate(({ messageId, chatId, reactions, emoji }) => {
  const wrap = messageElements.get(messageId);
  if (wrap) {
    const el = wrap.querySelector('.reactions');
    if (el) renderReactions(el, reactions);
  }
  // Si la reacción es de un chat que no tengo abierto, la aviso en la lista
  // en vez de dejarla pasar en silencio (solo mensajes nuevos bumpean hoy).
  if (emoji && chatId && chatId !== selectedChatId) {
    chatReactionAlerts.set(chatId, emoji);
    renderChatList();
  }
});

window.api.onIncoming((msg) => {
  if (msg.chatId === selectedChatId) {
    renderMessage(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
});

backBtn.addEventListener('click', () => {
  selectedChatId = null;
  hideMentionList();
  emojiPickerEl.classList.add('hidden');
  convActive.classList.add('hidden');
  convEmpty.classList.remove('hidden');
  renderChatList();
});

// --- Adjuntar imagen ---
attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  imageInput.value = ''; // permite reelegir el mismo archivo después de quitarlo
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    pendingImage = { base64: dataUrl.split(',')[1], mimetype: file.type, filename: file.name };
    imagePreviewImg.src = dataUrl;
    imagePreviewEl.classList.remove('hidden');
    composerInput.focus();
  };
  reader.readAsDataURL(file);
});

function clearPendingImage() {
  pendingImage = null;
  imagePreviewImg.src = '';
  imagePreviewEl.classList.add('hidden');
}

imagePreviewRemove.addEventListener('click', clearPendingImage);

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = composerInput.value.trim();
  if (!selectedChatId || (!text && !pendingImage)) return;

  if (pendingImage) {
    const image = pendingImage;
    composerInput.value = '';
    pendingMentions = new Map();
    clearPendingImage();
    autoResizeComposer();
    hideMentionList();
    const res = await window.api.sendImage(selectedChatId, image.base64, image.mimetype, image.filename, text);
    if (!res.ok) {
      // no perdemos la imagen ni el texto si falló el envío
      pendingImage = image;
      imagePreviewImg.src = `data:${image.mimetype};base64,${image.base64}`;
      imagePreviewEl.classList.remove('hidden');
      composerInput.value = text;
      autoResizeComposer();
    }
    return;
  }

  const mentions = Array.from(pendingMentions.keys());
  composerInput.value = '';
  pendingMentions = new Map();
  autoResizeComposer();
  hideMentionList();
  const res = await window.api.sendMessage(selectedChatId, text, mentions);
  if (!res.ok) {
    composerInput.value = text; // no perdemos lo escrito si falló el envío
    autoResizeComposer();
  }
});

// --- Campo de escritura: crece con el texto, Enter envía, Shift+Enter salto de línea ---
function autoResizeComposer() {
  composerInput.style.height = 'auto';
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, 120)}px`;
}
// OJO: no se llama acá al arrancar. #conv-active empieza oculto
// (display:none), así que scrollHeight lee 0 y deja el textarea con
// altura 0 hasta el próximo evento 'input'. Se recalcula en openChat(),
// una vez que la conversación ya es visible y el layout es real.

composerInput.addEventListener('input', () => {
  autoResizeComposer();
  updateMentionDropdown();
});

composerInput.addEventListener('keydown', (e) => {
  if (!mentionListEl.classList.contains('hidden')) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionActiveIndex = (mentionActiveIndex + 1) % mentionMatches.length;
      renderMentionList();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionActiveIndex = (mentionActiveIndex - 1 + mentionMatches.length) % mentionMatches.length;
      renderMentionList();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectMention(mentionMatches[mentionActiveIndex]);
      return;
    }
    if (e.key === 'Escape') {
      hideMentionList();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

function positionFloatingPanel(el) {
  el.style.bottom = `${composer.offsetHeight + 6}px`;
}

function insertAtCursor(str) {
  const start = composerInput.selectionStart;
  const end = composerInput.selectionEnd;
  const text = composerInput.value;
  composerInput.value = text.slice(0, start) + str + text.slice(end);
  const newPos = start + str.length;
  composerInput.setSelectionRange(newPos, newPos);
  composerInput.focus();
  autoResizeComposer();
}

// --- Menciones (@) en grupos ---
function getMentionQuery() {
  const cursor = composerInput.selectionStart;
  const text = composerInput.value.slice(0, cursor);
  const at = text.lastIndexOf('@');
  if (at === -1) return null;
  const before = text[at - 1];
  if (at > 0 && before !== ' ' && before !== '\n') return null; // @ debe iniciar una palabra
  const query = text.slice(at + 1);
  if (/\s/.test(query)) return null; // ya se cerró la mención con un espacio
  return { query: query.toLowerCase(), start: at };
}

function updateMentionDropdown() {
  if (!currentChatIsGroup || !groupParticipants.length) {
    hideMentionList();
    return;
  }
  const q = getMentionQuery();
  if (!q) {
    hideMentionList();
    return;
  }
  mentionMatches = groupParticipants.filter((p) => p.name.toLowerCase().includes(q.query));
  if (!mentionMatches.length) {
    hideMentionList();
    return;
  }
  mentionActiveIndex = 0;
  mentionQueryStart = q.start;
  renderMentionList();
}

function renderMentionList() {
  mentionListEl.innerHTML = '';
  mentionMatches.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'mention-item' + (i === mentionActiveIndex ? ' active' : '');
    item.textContent = p.name;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault(); // no perder el foco del textarea
      selectMention(p);
    });
    mentionListEl.appendChild(item);
  });
  positionFloatingPanel(mentionListEl);
  mentionListEl.classList.remove('hidden');
}

function hideMentionList() {
  mentionListEl.classList.add('hidden');
  mentionMatches = [];
}

function selectMention(participant) {
  if (!participant) return;
  const text = composerInput.value;
  const cursor = composerInput.selectionStart;
  const before = text.slice(0, mentionQueryStart);
  const after = text.slice(cursor);
  // WhatsApp reconoce la mención por "@<número>" en el texto + el id en
  // `mentions`; el cliente receptor la muestra como "@Nombre" solo.
  const inserted = `@${participant.id.split('@')[0]} `;
  composerInput.value = before + inserted + after;
  const newCursor = before.length + inserted.length;
  composerInput.setSelectionRange(newCursor, newCursor);
  pendingMentions.set(participant.id, participant.name);
  hideMentionList();
  autoResizeComposer();
  composerInput.focus();
}

// --- Picker de emojis ---
const EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😜', '🤔', '😎',
  '🙂', '😉', '😇', '🥳', '😴', '🤗', '😅', '😬', '🙄', '😐',
  '😢', '😭', '😡', '🤯', '😱', '🤷', '🙌', '👏', '👍', '👎',
  '🙏', '💪', '👀', '✅', '❌', '🔥', '✨', '🎉', '❤️', '💀',
  '😈', '👿', '🤠', '🥲', '🫡', '🤌', '🖤', '💯', '🎊', '🍻',
  '⚡', '🌟', '🚀', '🎯', '🤙', '😏', '🫶', '🤝', '👋', '🥶',
];

function populateEmojiPicker() {
  emojiPickerEl.innerHTML = '';
  EMOJIS.forEach((emoji) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (reactingToMessageId) {
        const msgId = reactingToMessageId;
        reactingToMessageId = null;
        emojiPickerEl.classList.add('hidden');
        window.api.reactToMessage(msgId, emoji);
      } else {
        insertAtCursor(emoji);
      }
    });
    emojiPickerEl.appendChild(b);
  });
}
populateEmojiPicker();

emojiBtn.addEventListener('click', () => {
  if (emojiPickerEl.classList.contains('hidden')) {
    reactingToMessageId = null; // el botón de emojis del composer siempre inserta texto
    hideMentionList();
    positionFloatingPanel(emojiPickerEl);
    emojiPickerEl.classList.remove('hidden');
  } else {
    emojiPickerEl.classList.add('hidden');
  }
});

document.addEventListener('click', (e) => {
  if (
    !emojiPickerEl.classList.contains('hidden') &&
    !emojiPickerEl.contains(e.target) &&
    e.target !== emojiBtn
  ) {
    emojiPickerEl.classList.add('hidden');
    reactingToMessageId = null;
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
