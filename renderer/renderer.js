const qrScreen = document.getElementById('qr-screen');
const qrImg = document.getElementById('qr-img');
const qrStatus = document.getElementById('qr-status');
const qrRefreshBtn = document.getElementById('qr-refresh-btn');
const slackPairingScreen = document.getElementById('slack-pairing-screen');
const slackPairingForm = document.getElementById('slack-pairing-form');
const slackUserTokenInput = document.getElementById('slack-user-token');
const slackAppTokenInput = document.getElementById('slack-app-token');
const slackMentionFilterInput = document.getElementById('slack-mention-filter');
const slackConnectBtn = document.getElementById('slack-connect-btn');
const slackPairingStatus = document.getElementById('slack-pairing-status');
const slackDisconnectBtn = document.getElementById('slack-disconnect-btn');
const tabButtons = document.querySelectorAll('.tab-btn');
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

// --- Color por persona en grupos/canales ---
// Paleta separada de --accent/--unread/--danger (que ya tienen significado
// propio: mío/alerta/error) para no confundir. Se elige de forma
// determinística por id de autor, así la misma persona siempre tiene el
// mismo color entre mensajes y al reabrir la conversación.
const AUTHOR_COLORS = ['#6fa8dc', '#b58fd1', '#5fc9d6', '#e07bb0', '#8888e0', '#c9a86a'];
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
function colorForAuthor(id) {
  if (!id) return null;
  return AUTHOR_COLORS[hashString(id) % AUTHOR_COLORS.length];
}

// --- Multi-proveedor (WhatsApp / Slack) ---
// Ambos proveedores comparten un único set de DOM para lista de chats +
// conversación + composer (ver CLAUDE.md). Solo se guarda por proveedor lo
// que de verdad necesita sobrevivir en segundo plano mientras el otro está
// a la vista: la lista de chats y el estado de conexión. Todo lo demás
// (chat abierto, borrador, menciones, imagen adjunta…) describe "la
// conversación actualmente abierta", que solo puede pertenecer al
// proveedor activo — cambiar de pestaña la cierra, igual que el botón
// "volver".
const PROVIDER_CONFIG = {
  wa: {
    label: 'WhatsApp',
    // WhatsApp reconoce la mención por "@<número>" en el texto (más el id
    // en `mentions` al enviar); el chat lo muestra como "@Nombre" solo.
    formatMentionInsert: (p) => `@${p.id.split('@')[0]} `,
  },
  sl: {
    label: 'Slack',
    // Slack reconoce la mención por "<@ID>" directo en el texto — no hace
    // falta ningún parámetro aparte al enviar.
    formatMentionInsert: (p) => `<@${p.id}> `,
  },
};
const providerData = {
  wa: { chats: [], status: undefined, railState: null, everReady: false, hasUnseenActivity: false },
  sl: { chats: [], status: undefined, railState: null, everReady: false, hasUnseenActivity: false },
};
let activeProvider = 'wa';

function activeApi() {
  return window.api[activeProvider];
}

let chats = [];
let selectedChatId = null;
const messageElements = new Map(); // msgId -> .bubble-wrap, para reacciones en vivo
const chatReactionAlerts = new Map(); // chatId -> emoji, para avisar en la lista
const chatMessageAlerts = new Set(); // chatId con mensaje nuevo sin ver, aunque sea en la pestaña activa
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

function setConnectionState(railState) {
  const cls = !railState || railState === 'ready' ? '' : ` ${railState}`;
  rail.className = 'rail' + cls;
  statusDot.className = 'dot' + cls;
}

// --- Pantallas: QR (WhatsApp) / emparejamiento (Slack) / app compartida ---
function renderActiveScreen() {
  const pd = providerData[activeProvider];
  topbarTitle.textContent = PROVIDER_CONFIG[activeProvider].label;
  setConnectionState(pd.railState);

  // Una vez que un proveedor estuvo listo alguna vez, se queda mostrando la
  // app aunque se caiga la conexión (mismo criterio que ya tenía WhatsApp:
  // un 'disconnected' solo cambia el color del punto, no oculta la app) —
  // excepto si el estado es explícitamente 'not-configured' (Slack
  // desconectado a propósito desde el botón de engranaje).
  const showApp = pd.status === 'ready' || (pd.everReady && pd.status !== 'not-configured');

  qrScreen.classList.toggle('hidden', !(activeProvider === 'wa' && !showApp));
  slackPairingScreen.classList.toggle('hidden', !(activeProvider === 'sl' && !showApp));
  app.classList.toggle('hidden', !showApp);
  slackDisconnectBtn.classList.toggle('hidden', !(activeProvider === 'sl' && showApp));

  if (activeProvider === 'sl' && !showApp) {
    slackPairingStatus.textContent = slackStatusMessage(pd.status);
  }

  if (showApp) {
    chats = pd.chats;
    renderChatList();
  }
}

function slackStatusMessage(status) {
  if (status === 'connecting') return 'Conectando…';
  if (status === 'auth_failure') return 'No se pudo conectar. Revisa los tokens y que Socket Mode esté habilitado.';
  if (status === 'disconnected') return 'Desconectado. Ingresa los tokens de nuevo.';
  return '';
}

function railStateForStatus(status) {
  if (status === 'ready') return 'ready';
  if (status === 'disconnected' || status === 'auth_failure') return 'disconnected';
  return 'reconnecting';
}

function handleStatus(provider, status) {
  const pd = providerData[provider];
  pd.status = status;
  pd.railState = railStateForStatus(status);
  if (status === 'ready') pd.everReady = true;
  if (provider === activeProvider) renderActiveScreen();
}

function closeConversation() {
  selectedChatId = null;
  hideMentionList();
  emojiPickerEl.classList.add('hidden');
  convActive.classList.add('hidden');
  convEmpty.classList.remove('hidden');
  renderChatList();
}

// Punto amarillo en la pestaña: avisa que llegó un mensaje al proveedor que
// no estás mirando ahora mismo (ej. te escriben por WhatsApp mientras
// tienes abierta la pestaña de Slack). Se apaga al cambiar a esa pestaña.
function updateTabDots() {
  tabButtons.forEach((btn) => {
    const dot = btn.querySelector('.tab-dot');
    if (dot) dot.classList.toggle('hidden', !providerData[btn.dataset.provider].hasUnseenActivity);
  });
}

function switchProvider(provider) {
  if (provider === activeProvider) return;
  closeChatSearch();
  closeConversation();
  activeProvider = provider;
  providerData[provider].hasUnseenActivity = false;
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.provider === provider));
  updateTabDots();
  renderActiveScreen();
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => switchProvider(btn.dataset.provider));
});

// --- QR de WhatsApp ---
window.api.wa.onQr((dataUrl) => {
  qrImg.src = dataUrl;
  qrStatus.textContent = 'Esperando código…';
  providerData.wa.railState = 'reconnecting';
  if (activeProvider === 'wa') setConnectionState('reconnecting');
  qrRefreshBtn.disabled = false;
  qrRefreshBtn.textContent = 'Generar nuevo código';
});

qrRefreshBtn.addEventListener('click', async () => {
  qrRefreshBtn.disabled = true;
  qrRefreshBtn.textContent = 'Generando…';
  qrStatus.textContent = 'Generando nuevo código…';
  await window.api.wa.regenerateQr();
});

window.api.wa.onStatus((status) => {
  handleStatus('wa', status);
  if (status === 'disconnected' || status === 'auth_failure') {
    qrStatus.textContent = 'Sesión desconectada. Reinicia la app.';
  }
});

// --- Emparejamiento de Slack ---
slackPairingForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userToken = slackUserTokenInput.value.trim();
  const appToken = slackAppTokenInput.value.trim();
  const mentionFilter = slackMentionFilterInput.checked;
  if (!userToken || !appToken) return;
  slackConnectBtn.disabled = true;
  slackConnectBtn.textContent = 'Conectando…';
  handleStatus('sl', 'connecting');
  const res = await window.api.sl.connect(userToken, appToken, mentionFilter);
  slackConnectBtn.disabled = false;
  slackConnectBtn.textContent = 'Conectar';
  if (!res.ok) {
    // El estado definitivo (ready/auth_failure) llega también por
    // sl:status — esto solo evita dejar el botón colgado si la promesa
    // tarda.
    handleStatus('sl', 'auth_failure');
  }
});

window.api.sl.onStatus((status) => handleStatus('sl', status));

slackDisconnectBtn.addEventListener('click', async () => {
  const confirmed = window.confirm('¿Desconectar Slack? Vas a tener que volver a pegar los tokens para reconectar.');
  if (!confirmed) return;
  await window.api.sl.disconnect();
  slackUserTokenInput.value = '';
  slackAppTokenInput.value = '';
  slackMentionFilterInput.checked = false;
  providerData.sl.chats = [];
  providerData.sl.everReady = false;
  closeConversation();
});

// --- Lista de chats ---
function handleChats(provider, list) {
  providerData[provider].chats = list;
  if (provider === activeProvider) {
    chats = list;
    chatListStatus.classList.add('hidden');
    renderChatList();
  }
}
window.api.wa.onChats((list) => handleChats('wa', list));
window.api.sl.onChats((list) => handleChats('sl', list));

function handleChatsError(provider, { attempt }) {
  if (provider !== activeProvider) return;
  chatListStatus.textContent = `No se pudo cargar la lista de chats (intento ${attempt}). Reintentando…`;
  chatListStatus.classList.remove('hidden');
}
window.api.wa.onChatsError((p) => handleChatsError('wa', p));
window.api.sl.onChatsError((p) => handleChatsError('sl', p));

window.api.wa.onChatsSyncing(({ attempt }) => {
  if (activeProvider !== 'wa') return;
  chatListStatus.textContent = `Sincronizando chats desde tu teléfono… (intento ${attempt})`;
  chatListStatus.classList.remove('hidden');
});

function renderChatList() {
  chatListEl.innerHTML = '';
  const q = chatSearchQuery.trim().toLowerCase();
  const list = q ? chats.filter((c) => c.name.toLowerCase().includes(q)) : chats;
  if (q && !list.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-search-empty';
    empty.textContent = 'Sin resultados';
    chatListEl.appendChild(empty);
  } else {
    list.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'chat-row' + (c.id === selectedChatId ? ' active' : '');
      const avatarHtml = c.avatar ? `<img src="${c.avatar}" alt="" />` : initials(c.name);
      // c.online solo viene poblado para DMs de Slack (ver resolveConversationMeta()
      // en slack.js) — WhatsApp y los canales de Slack no tienen "un" usuario.
      const presenceDotHtml = c.online ? '<span class="presence-dot" title="Conectado"></span>' : '';
      row.innerHTML = `
        <div class="avatar-wrap">
          <div class="avatar">${avatarHtml}</div>
          ${presenceDotHtml}
        </div>
        <div class="chat-meta">
          <div class="chat-name">${escapeHtml(c.name)}</div>
          <div class="chat-snippet">${escapeHtml(c.lastMessage || '')}</div>
        </div>
        <div class="chat-side">
          <span class="chat-time">${formatTime(c.timestamp)}</span>
          ${chatReactionAlerts.has(c.id) ? `<span class="reaction-alert">${chatReactionAlerts.get(c.id)}</span>` : ''}
          ${chatMessageAlerts.has(c.id) ? '<span class="message-alert-dot"></span>' : ''}
          ${c.unreadCount ? `<span class="badge">${c.unreadCount}</span>` : ''}
        </div>
      `;
      row.addEventListener('click', () => openChat(c.id, c.name));
      chatListEl.appendChild(row);
    });
  }
  // Slack: si hay una búsqueda activa y ya trajimos resultados de personas
  // del workspace (ver updateSlackPeopleSearch()), se re-pintan acá porque
  // chatListEl.innerHTML se acaba de vaciar arriba. No dispara un nuevo
  // pedido — solo redibuja lo último que ya llegó.
  if (activeProvider === 'sl' && chatSearchQuery.trim() && lastPeopleResults.length) {
    renderPeopleResults(lastPeopleResults);
  }
}

// --- Slack: buscar personas del workspace cuando la búsqueda de chats no
// encuentra nada (o para abrir un DM nuevo con alguien sin conversación
// previa) ---
let peopleSearchTimer = null;
let peopleSearchToken = 0;
let lastPeopleResults = [];

function scheduleSlackPeopleSearch() {
  if (activeProvider !== 'sl') return;
  clearTimeout(peopleSearchTimer);
  peopleSearchTimer = setTimeout(updateSlackPeopleSearch, 300);
}

async function updateSlackPeopleSearch() {
  const q = chatSearchQuery.trim();
  if (activeProvider !== 'sl' || !q) {
    lastPeopleResults = [];
    removePeopleResults();
    return;
  }
  const token = ++peopleSearchToken;
  const res = await window.api.sl.searchUsers(q);
  // Si mientras esperábamos la respuesta cambiaron de pestaña o siguieron
  // escribiendo, este resultado ya es viejo — no lo pintamos.
  if (token !== peopleSearchToken || activeProvider !== 'sl' || chatSearchQuery.trim() !== q) return;
  lastPeopleResults = res.ok ? res.users : [];
  if (lastPeopleResults.length) renderPeopleResults(lastPeopleResults);
  else removePeopleResults();
}

function removePeopleResults() {
  const existing = chatListEl.querySelector('.people-results');
  if (existing) existing.remove();
}

function renderPeopleResults(users) {
  removePeopleResults();
  const section = document.createElement('div');
  section.className = 'people-results';
  const header = document.createElement('div');
  header.className = 'people-results-header';
  header.textContent = 'Personas';
  section.appendChild(header);
  users.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'chat-row';
    const avatarHtml = u.avatar ? `<img src="${u.avatar}" alt="" />` : initials(u.name);
    row.innerHTML = `
      <div class="avatar">${avatarHtml}</div>
      <div class="chat-meta">
        <div class="chat-name">${escapeHtml(u.name)}</div>
        <div class="chat-snippet">Iniciar mensaje directo</div>
      </div>
    `;
    row.addEventListener('click', () => startSlackDirectMessage(u.id, u.name));
    section.appendChild(row);
  });
  chatListEl.appendChild(section);
}

async function startSlackDirectMessage(userId, name) {
  lastPeopleResults = [];
  const res = await window.api.sl.openDirectMessage(userId);
  if (!res.ok) {
    chatListStatus.textContent = 'No se pudo abrir el mensaje directo — revisa que la app de Slack tenga el scope im:write (ver README) y que esté reinstalada.';
    chatListStatus.classList.remove('hidden');
    return;
  }
  chatListStatus.classList.add('hidden');
  closeChatSearch();
  if (!providerData.sl.chats.some((c) => c.id === res.chat.id)) {
    providerData.sl.chats = [res.chat, ...providerData.sl.chats];
    if (activeProvider === 'sl') chats = providerData.sl.chats;
  }
  openChat(res.chat.id, name);
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
  clearTimeout(peopleSearchTimer);
  lastPeopleResults = [];
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
  scheduleSlackPeopleSearch();
});

chatSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeChatSearch();
});

// --- Conversación activa ---
async function openChat(chatId, name) {
  selectedChatId = chatId;
  chatReactionAlerts.delete(chatId);
  chatMessageAlerts.delete(chatId);
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
    activeApi().getGroupParticipants(chatId).then((res) => {
      if (res.ok && chatId === selectedChatId) groupParticipants = res.participants;
    });
  }

  const res = await activeApi().getMessages(chatId);
  messagesEl.innerHTML = '';
  if (!res.ok) {
    messagesEl.innerHTML = '<div class="status-text">No se pudieron cargar los mensajes.</div>';
    return;
  }
  res.messages.forEach(renderMessage);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // El proceso principal ya marcó el chat como leído (WhatsApp: chat.sendSeen())
  // al pedir los mensajes; reflejamos eso de inmediato en la lista en vez de
  // esperar al próximo refresco (que solo llega con mensajes nuevos).
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
  // authorName solo viene poblado para mensajes de grupo/canal que no son
  // míos (ver serializeMessage() en whatsapp.js/slack.js) — así identificamos
  // quién escribió qué.
  const authorColor = colorForAuthor(msg.author);
  const authorHtml = msg.authorName
    ? `<span class="author"${authorColor ? ` style="color:${authorColor}"` : ''}>${escapeHtml(msg.authorName)}</span>`
    : '';
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
  if (msg.hasMedia) {
    // Cubre también los adjuntos que no se previsualizan acá (video, audio,
    // documentos — ver el placeholder "📎 Adjunto" arriba): el click pide el
    // archivo recién ahí, no antes (mismo criterio que ya evita bajar todo
    // en cada fetchMessages(), ver getMediaDataUri() en whatsapp.js).
    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'attachment-download-btn';
    downloadBtn.title = 'Descargar adjunto';
    downloadBtn.setAttribute('aria-label', 'Descargar adjunto');
    downloadBtn.textContent = '⭳';
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadAttachment(msg);
    });
    b.appendChild(downloadBtn);
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

// --- Descargar adjuntos ---
async function downloadAttachment(msg) {
  const res = await activeApi().downloadAttachment(msg.id, selectedChatId);
  if (!res.ok && !res.canceled) {
    window.alert('No se pudo descargar el adjunto.');
  }
}

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
      await activeApi().reactToMessage(msgId, emoji, selectedChatId);
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

function handleReactionUpdate(provider, { messageId, chatId, reactions, emoji }) {
  if (provider === activeProvider) {
    const wrap = messageElements.get(messageId);
    if (wrap) {
      const el = wrap.querySelector('.reactions');
      if (el) renderReactions(el, reactions);
    }
  }
  // Si la reacción es de un chat que no tengo abierto, la aviso en la lista
  // en vez de dejarla pasar en silencio (solo mensajes nuevos bumpean hoy).
  if (emoji && chatId && chatId !== selectedChatId) {
    chatReactionAlerts.set(chatId, emoji);
    if (provider === activeProvider) renderChatList();
  }
}
window.api.wa.onReactionUpdate((p) => handleReactionUpdate('wa', p));
window.api.sl.onReactionUpdate((p) => handleReactionUpdate('sl', p));

function handleIncoming(provider, msg) {
  if (provider === activeProvider && msg.chatId === selectedChatId) {
    renderMessage(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }
  // Mensaje en un chat que no tengo abierto — antes esto solo se avisaba si
  // era de la otra pestaña (punto en "WhatsApp"/"Slack"); un mensaje nuevo
  // en OTRO chat de la misma pestaña activa no dejaba ningún rastro (bug
  // real, reportado por el usuario: le respondieron y no hubo ningún
  // aviso). Ahora siempre queda marcado en la fila de ese chat en la
  // lista, esté o no en la pestaña que estoy mirando.
  chatMessageAlerts.add(msg.chatId);
  if (provider === activeProvider) {
    renderChatList();
  } else {
    providerData[provider].hasUnseenActivity = true;
    updateTabDots();
  }
}
window.api.wa.onIncoming((msg) => handleIncoming('wa', msg));
window.api.sl.onIncoming((msg) => handleIncoming('sl', msg));

backBtn.addEventListener('click', closeConversation);

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
    const res = await activeApi().sendImage(selectedChatId, image.base64, image.mimetype, image.filename, text);
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
  const res = await activeApi().sendMessage(selectedChatId, text, mentions);
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

// --- Menciones (@) en grupos/canales ---
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
  const inserted = PROVIDER_CONFIG[activeProvider].formatMentionInsert(participant);
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
        activeApi().reactToMessage(msgId, emoji, selectedChatId);
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
