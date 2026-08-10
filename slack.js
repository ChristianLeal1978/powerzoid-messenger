const https = require('https');
const { WebClient } = require('@slack/web-api');
const { SocketModeClient } = require('@slack/socket-mode');

let web; // WebClient, null hasta connect()
let socket; // SocketModeClient, null hasta connect()
let send; // (channel, payload) => void, inyectado desde main.js
let botToken = null;
let botUserId = null;
// Id de usuario de Slack de la persona (no del bot) — opcional. Si está
// seteado, la lista de chats deja afuera los canales normales donde el
// último mensaje no la menciona directamente (ver pushChatListOnce()). Los
// DMs y mensajes directos de grupo siempre se muestran, sean o no mención.
let myUserId = null;

function textMentionsUser(rawText, userId) {
  if (!userId || !rawText) return false;
  return rawText.includes(`<@${userId}>`);
}

// --- Mapa emoji Unicode <-> shortcode de Slack ---
// La lista de reacciones rápidas y el picker de emojis en renderer.js usan
// caracteres Unicode (👍, ❤️…), pero la API de reacciones de Slack solo
// acepta shortcodes (thumbsup, heart…) y los eventos entrantes solo traen
// el shortcode, nunca el carácter. Mapeamos únicamente el set fijo que usa
// la UI (EMOJIS en renderer.js) — para reacciones ajenas fuera de ese set,
// caemos a mostrar ":shortcode:" en vez de romper el render.
const EMOJI_TO_SLACK = {
  '😀': 'grinning', '😁': 'grin', '😂': 'joy', '🤣': 'rofl', '😊': 'blush',
  '😍': 'heart_eyes', '😘': 'kissing_heart', '😜': 'stuck_out_tongue_winking_eye',
  '🤔': 'thinking_face', '😎': 'sunglasses', '🙂': 'slightly_smiling_face',
  '😉': 'wink', '😇': 'innocent', '🥳': 'partying_face', '😴': 'sleeping',
  '🤗': 'hugging_face', '😅': 'sweat_smile', '😬': 'grimacing', '🙄': 'roll_eyes',
  '😐': 'neutral_face', '😢': 'cry', '😭': 'sob', '😡': 'rage',
  '🤯': 'exploding_head', '😱': 'scream', '🤷': 'shrug', '🙌': 'raised_hands',
  '👏': 'clap', '👍': 'thumbsup', '👎': 'thumbsdown', '🙏': 'pray',
  '💪': 'muscle', '👀': 'eyes', '✅': 'white_check_mark', '❌': 'x',
  '🔥': 'fire', '✨': 'sparkles', '🎉': 'tada', '❤️': 'heart', '💀': 'skull',
  '😈': 'smiling_imp', '👿': 'imp', '🤠': 'cowboy_hat_face',
  '🥲': 'smiling_face_with_tear', '🫡': 'saluting_face', '🤌': 'pinched_fingers',
  '🖤': 'black_heart', '💯': '100', '🎊': 'confetti_ball', '🍻': 'beers',
  '⚡': 'zap', '🌟': 'star2', '🚀': 'rocket', '🎯': 'dart',
  '🤙': 'call_me_hand', '😏': 'smirk', '🫶': 'heart_hands', '🤝': 'handshake',
  '👋': 'wave', '🥶': 'cold_face',
};
const SLACK_TO_EMOJI = Object.fromEntries(Object.entries(EMOJI_TO_SLACK).map(([e, s]) => [s, e]));

function emojiToSlackName(emoji) {
  return EMOJI_TO_SLACK[emoji] || null;
}
function slackNameToEmoji(name) {
  return SLACK_TO_EMOJI[name] || `:${name}:`;
}

// --- Nombres/avatares de usuario, cacheados igual que contactNameCache en
// whatsapp.js: cambian poco durante una sesión y evitan pegarle a
// users.info por cada mensaje/refresco de lista. ---
const userInfoCache = new Map();

async function getUserInfo(id) {
  if (!id) return { name: id, avatarUrl: null };
  if (userInfoCache.has(id)) return userInfoCache.get(id);
  let info = { name: id, avatarUrl: null };
  try {
    const res = await web.users.info({ user: id });
    if (res.ok && res.user) {
      const p = res.user.profile || {};
      info = {
        name: p.display_name || p.real_name || res.user.name || id,
        avatarUrl: p.image_192 || p.image_72 || null,
      };
    }
  } catch (err) {
    // Sin datos de usuario disponibles (bot sin permiso, usuario borrado…).
  }
  userInfoCache.set(id, info);
  return info;
}

function fetchAsDataUri(url, token) {
  return new Promise((resolve) => {
    const options = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
    https
      .get(url, options, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const mime = res.headers['content-type'] || 'image/jpeg';
          resolve(`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`);
        });
      })
      .on('error', () => resolve(null));
  });
}

// Mismo cooldown que AVATAR_RETRY_COOLDOWN_MS en whatsapp.js y por la misma
// razón: pushChatList() corre en cada mensaje entrante, y sin esto un
// avatar que falla se reintenta en cada refresco.
const AVATAR_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const avatarCache = new Map();
const avatarFailedAt = new Map();

async function getAvatar(id, avatarUrl) {
  if (!avatarUrl) return null;
  if (avatarCache.has(id)) return avatarCache.get(id);
  const lastFail = avatarFailedAt.get(id);
  if (lastFail && Date.now() - lastFail < AVATAR_RETRY_COOLDOWN_MS) return null;
  const dataUri = await fetchAsDataUri(avatarUrl);
  if (dataUri) {
    avatarCache.set(id, dataUri);
    avatarFailedAt.delete(id);
  } else {
    avatarFailedAt.set(id, Date.now());
  }
  return dataUri;
}

// --- Texto de mensajes: Slack deja menciones/enlaces "en crudo" en el
// texto (<@U123>, <#C123|general>, <https://url|label>) — los resolvemos a
// texto legible, igual que resolveMentionsInBody() hace con "@<número>" en
// whatsapp.js. ---
async function formatSlackText(text) {
  if (!text) return '';
  const mentionIds = new Set();
  const mentionRegex = /<@([A-Z0-9]+)(\|[^>]*)?>/g;
  let m;
  while ((m = mentionRegex.exec(text))) mentionIds.add(m[1]);
  const names = new Map();
  await Promise.all(
    Array.from(mentionIds).map(async (id) => {
      const info = await getUserInfo(id);
      names.set(id, info.name);
    })
  );
  let out = text.replace(mentionRegex, (_, id) => `@${names.get(id) || id}`);
  out = out.replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_, name) => `#${name}`);
  out = out.replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, (_, url, label) => `${label} (${url})`);
  out = out.replace(/<(https?:\/\/[^>]+)>/g, (_, url) => url);
  out = out.replace(/<!(here|channel|everyone)>/g, (_, kw) => `@${kw}`);
  return out;
}

async function getFirstImage(msg) {
  if (!msg.files || !msg.files.length) return null;
  const file = msg.files.find((f) => f.mimetype && f.mimetype.startsWith('image/'));
  if (!file || !file.url_private) return null;
  // Los archivos de Slack viven en URLs privadas: hace falta el bot token
  // como Bearer para poder descargarlos (a diferencia de los avatares de
  // usuario, que sí son públicos).
  return fetchAsDataUri(file.url_private, botToken);
}

async function serializeMessage(msg, channelId) {
  const authorId = msg.user || null;
  const fromMe = !!botUserId && authorId === botUserId;
  const authorName = authorId && !fromMe ? (await getUserInfo(authorId)).name : null;
  const image = await getFirstImage(msg);
  return {
    id: msg.ts,
    chatId: channelId,
    fromMe,
    body: await formatSlackText(msg.text),
    timestamp: Math.floor(parseFloat(msg.ts)) || 0,
    author: authorId,
    authorName,
    hasMedia: !!(msg.files && msg.files.length),
    type: image ? 'image' : 'text',
    sticker: null,
    image,
    reactions: (msg.reactions || []).map((r) => ({
      emoji: slackNameToEmoji(r.name),
      count: r.count,
      byMe: !!(botUserId && r.users && r.users.includes(botUserId)),
    })),
  };
}

// last message + timestamp por canal, alimentado por los eventos en vivo de
// Socket Mode. Evita tener que pedir conversations.history por cada canal
// en cada refresco de la lista (son rate-limited por método) — solo se pide
// una vez, la primera vez que vemos ese canal.
const lastMessageCache = new Map();

async function resolveConversationMeta(c) {
  let name;
  let avatar = null;
  if (c.is_im) {
    const info = await getUserInfo(c.user);
    name = info.name;
    avatar = await getAvatar(c.user, info.avatarUrl);
  } else {
    name = c.name || c.id;
  }
  const cached = lastMessageCache.get(c.id);
  if (cached) return { name, avatar, lastMessage: cached.text, timestamp: cached.ts, mentionsMe: cached.mentionsMe };
  let lastMessage = '';
  let timestamp = 0;
  let mentionsMe = false;
  try {
    const hist = await web.conversations.history({ channel: c.id, limit: 1 });
    const last = hist.messages && hist.messages[0];
    if (last) {
      lastMessage = await formatSlackText(last.text);
      timestamp = Math.floor(parseFloat(last.ts)) || 0;
      mentionsMe = textMentionsUser(last.text, myUserId);
      lastMessageCache.set(c.id, { text: lastMessage, ts: timestamp, mentionsMe });
    }
  } catch (err) {
    // Canal sin historial accesible (el bot no es miembro todavía, etc.) —
    // se deja vacío en vez de reintentar en cada refresco.
  }
  return { name, avatar, lastMessage, timestamp, mentionsMe };
}

// conversations.list devuelve, para canales públicos, TODOS los del
// workspace (no solo los del bot) — en un workspace grande eso son varias
// páginas. Sin paginar, los canales a los que el bot sí pertenece pueden
// quedar fuera de la primera página si hay muchos otros antes en el orden
// que usa Slack (no es orden de membresía). Techo de páginas como red de
// seguridad, no un límite pensado para pegarle en uso normal.
const CONVERSATIONS_LIST_PAGE_SIZE = 200;
const CONVERSATIONS_LIST_MAX_PAGES = 25; // hasta 5000 canales

async function listAllConversations() {
  const channels = [];
  let cursor;
  let pages = 0;
  do {
    const res = await web.conversations.list({
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: true,
      limit: CONVERSATIONS_LIST_PAGE_SIZE,
      cursor,
    });
    channels.push(...(res.channels || []));
    cursor = res.response_metadata && res.response_metadata.next_cursor;
    pages += 1;
  } while (cursor && pages < CONVERSATIONS_LIST_MAX_PAGES);
  if (cursor) {
    console.error('[sl] conversations.list(): se alcanzó el techo de páginas, puede haber canales sin listar.');
  }
  return channels;
}

// La membresía del bot (a qué canales pertenece) cambia poco — solo cuando
// alguien lo invita o lo saca. Paginar el workspace completo en cada
// mensaje entrante sería carísimo en un workspace grande, así que se
// cachea con el mismo criterio de cooldown que ya usa el resto de la app
// (ver AVATAR_RETRY_COOLDOWN_MS): se refresca solo, como mucho, cada 5
// minutos, salvo pedido explícito de refresco.
const MEMBER_CHANNELS_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
let memberChannelsCache = null;
let memberChannelsFetchedAt = 0;

async function getMemberChannels(forceRefresh) {
  const stale = Date.now() - memberChannelsFetchedAt > MEMBER_CHANNELS_REFRESH_COOLDOWN_MS;
  if (memberChannelsCache && !forceRefresh && !stale) return memberChannelsCache;
  const all = await listAllConversations();
  memberChannelsCache = all.filter((c) => c.is_im || c.is_mpim || c.is_member);
  memberChannelsFetchedAt = Date.now();
  return memberChannelsCache;
}

let pushChatListInFlight = false;
let pushChatListQueued = false;

// Mismo mutex que pushChatList() en whatsapp.js y por la misma razón: cada
// evento de Socket Mode dispara un refresco fire-and-forget, y sin
// coordinación una ráfaga de mensajes generaría llamadas concurrentes a
// conversations.list/history que Slack rate-limita por método.
async function pushChatList() {
  if (pushChatListInFlight) {
    pushChatListQueued = true;
    return;
  }
  pushChatListInFlight = true;
  try {
    await pushChatListOnce();
  } finally {
    pushChatListInFlight = false;
    if (pushChatListQueued) {
      pushChatListQueued = false;
      pushChatList();
    }
  }
}

async function pushChatListOnce() {
  if (!web) return;
  try {
    const channels = await getMemberChannels();
    const withMeta = await Promise.all(
      channels.map(async (c) => ({ channel: c, meta: await resolveConversationMeta(c) }))
    );
    // Los DMs y mensajes directos de grupo son "conversación privada" por
    // definición — siempre se muestran. Los canales normales solo entran si
    // no hay filtro configurado (myUserId vacío) o si el último mensaje
    // menciona directamente a la persona (ver textMentionsUser()).
    const relevant = withMeta.filter(
      ({ channel, meta }) => channel.is_im || channel.is_mpim || !myUserId || meta.mentionsMe
    );
    const list = relevant.slice(0, 60).map(({ channel, meta }) => ({
      id: channel.id,
      name: meta.name,
      isGroup: !channel.is_im,
      // La Web API no expone conteo real de no-leídos para bots de forma
      // simple — se deja en 0 (ver limitación conocida en README).
      unreadCount: 0,
      lastMessage: meta.lastMessage,
      timestamp: meta.timestamp,
      avatar: meta.avatar,
    }));
    list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    send('sl:chats', list);
  } catch (err) {
    console.error('[sl] conversations.list() falló:', err.message || err);
    send('sl:chats-error', {});
  }
}

async function safeAck(args) {
  if (args && typeof args.ack === 'function') {
    try {
      await args.ack();
    } catch (err) {
      // El ack solo importa para que Slack no reintente el envío del
      // evento; un fallo acá no debe tumbar el manejo del mensaje.
    }
  }
}

function eventFromArgs(args) {
  return (args && args.event) || (args && args.body && args.body.event) || null;
}

async function handleReactionEvent(args) {
  const event = eventFromArgs(args);
  if (!event || !event.item) return;
  const channelId = event.item.channel;
  try {
    const result = await web.conversations.history({
      channel: channelId,
      latest: event.item.ts,
      inclusive: true,
      limit: 1,
    });
    const msg = result.messages && result.messages[0];
    if (!msg) return;
    send('sl:reactionUpdate', {
      messageId: msg.ts,
      chatId: channelId,
      reactions: (msg.reactions || []).map((r) => ({
        emoji: slackNameToEmoji(r.name),
        count: r.count,
        byMe: !!(botUserId && r.users && r.users.includes(botUserId)),
      })),
      emoji: event.reaction ? slackNameToEmoji(event.reaction) : null,
    });
  } catch (err) {
    console.error('[sl] no se pudo refrescar reacciones:', err.message || err);
  }
}

function wireSocketEvents() {
  socket.on('error', (err) => {
    console.error('[sl] socket error:', err && err.message ? err.message : err);
  });
  socket.on('disconnected', () => send('sl:status', 'disconnected'));
  socket.on('connected', () => send('sl:status', 'ready'));

  socket.on('message', async (args) => {
    await safeAck(args);
    const event = eventFromArgs(args);
    if (!event || !event.channel) return;
    if (event.subtype === 'message_changed' || event.subtype === 'message_deleted') return;
    const serialized = await serializeMessage(event, event.channel);
    lastMessageCache.set(event.channel, {
      text: serialized.body,
      ts: serialized.timestamp,
      mentionsMe: textMentionsUser(event.text, myUserId),
    });
    send('sl:incoming', serialized);
    pushChatList();
  });

  socket.on('reaction_added', async (args) => {
    await safeAck(args);
    await handleReactionEvent(args);
  });
  socket.on('reaction_removed', async (args) => {
    await safeAck(args);
    await handleReactionEvent(args);
  });
}

async function connect({ botToken: bt, appToken, myUserId: uid }) {
  botToken = bt;
  myUserId = uid || null;
  web = new WebClient(botToken);
  try {
    const auth = await web.auth.test();
    botUserId = auth.user_id;
  } catch (err) {
    console.error('[sl] auth.test() falló:', err.message || err);
    web = null;
    send('sl:status', 'auth_failure');
    return { ok: false };
  }

  socket = new SocketModeClient({ appToken });
  wireSocketEvents();
  try {
    await socket.start();
  } catch (err) {
    console.error('[sl] socket.start() falló:', err.message || err);
    socket = null;
    web = null;
    send('sl:status', 'auth_failure');
    return { ok: false };
  }

  send('sl:status', 'ready');
  pushChatList();
  return { ok: true };
}

// --- Directorio de usuarios del workspace, para "buscar persona" cuando
// todavía no hay un DM abierto con ella. La Web API no tiene un método de
// búsqueda por nombre para bots — hay que traer users.list() completo (con
// el mismo criterio de paginación y techo de páginas que
// listAllConversations()) y filtrar acá. Cambia poco durante una sesión,
// así que se cachea más tiempo que la membresía de canales.
const USER_DIRECTORY_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
let userDirectoryCache = null;
let userDirectoryFetchedAt = 0;

async function listAllUsers() {
  const users = [];
  let cursor;
  let pages = 0;
  do {
    const res = await web.users.list({ limit: CONVERSATIONS_LIST_PAGE_SIZE, cursor });
    users.push(...(res.members || []));
    cursor = res.response_metadata && res.response_metadata.next_cursor;
    pages += 1;
  } while (cursor && pages < CONVERSATIONS_LIST_MAX_PAGES);
  if (cursor) {
    console.error('[sl] users.list(): se alcanzó el techo de páginas, puede haber personas sin listar.');
  }
  return users;
}

async function getUserDirectory(forceRefresh) {
  const stale = Date.now() - userDirectoryFetchedAt > USER_DIRECTORY_REFRESH_COOLDOWN_MS;
  if (userDirectoryCache && !forceRefresh && !stale) return userDirectoryCache;
  const all = await listAllUsers();
  userDirectoryCache = all.filter(
    (u) => !u.deleted && !u.is_bot && u.id !== botUserId && u.id !== 'USLACKBOT'
  );
  userDirectoryFetchedAt = Date.now();
  return userDirectoryCache;
}

async function searchUsers(query) {
  if (!web) return { ok: false, users: [] };
  const q = (query || '').trim().toLowerCase();
  if (!q) return { ok: true, users: [] };
  try {
    const directory = await getUserDirectory();
    const matches = directory
      .filter((u) => {
        const p = u.profile || {};
        const name = (p.display_name || p.real_name || u.name || '').toLowerCase();
        return name.includes(q);
      })
      .slice(0, 20);
    const users = await Promise.all(
      matches.map(async (u) => {
        const p = u.profile || {};
        const name = p.display_name || p.real_name || u.name || u.id;
        const avatar = await getAvatar(u.id, p.image_192 || p.image_72 || null);
        return { id: u.id, name, avatar };
      })
    );
    return { ok: true, users };
  } catch (err) {
    console.error('[sl] searchUsers() falló:', err.message || err);
    return { ok: false, users: [] };
  }
}

async function openDirectMessage(userId) {
  if (!web) return { ok: false };
  try {
    const res = await web.conversations.open({ users: userId });
    const channelId = res.channel && res.channel.id;
    if (!channelId) return { ok: false };
    const info = await getUserInfo(userId);
    const avatar = await getAvatar(userId, info.avatarUrl);
    const chat = {
      id: channelId,
      name: info.name,
      isGroup: false,
      unreadCount: 0,
      lastMessage: '',
      timestamp: Math.floor(Date.now() / 1000),
      avatar,
    };
    // Para que aparezca en la lista sin esperar el próximo refresco
    // completo — getMemberChannels() tiene su propio cooldown de 5 min.
    if (memberChannelsCache && !memberChannelsCache.some((c) => c.id === channelId)) {
      memberChannelsCache.push({ id: channelId, user: userId, is_im: true, is_mpim: false, is_member: true });
    }
    pushChatList();
    return { ok: true, chat };
  } catch (err) {
    console.error('[sl] openDirectMessage() falló:', err.message || err);
    return { ok: false };
  }
}

function disconnect() {
  if (socket) {
    try {
      socket.disconnect();
    } catch (err) {
      // no-op: el socket puede ya estar caído
    }
  }
  socket = null;
  web = null;
  botUserId = null;
  botToken = null;
  myUserId = null;
  lastMessageCache.clear();
  userInfoCache.clear();
  avatarCache.clear();
  avatarFailedAt.clear();
  memberChannelsCache = null;
  memberChannelsFetchedAt = 0;
  userDirectoryCache = null;
  userDirectoryFetchedAt = 0;
  send('sl:status', 'not-configured');
}

async function getMessages(channelId) {
  if (!web) return { ok: false, messages: [] };
  try {
    const hist = await web.conversations.history({ channel: channelId, limit: 50 });
    const msgs = (hist.messages || []).slice().reverse();
    const messages = await Promise.all(msgs.map((m) => serializeMessage(m, channelId)));
    return { ok: true, messages };
  } catch (err) {
    console.error('[sl] getMessages() falló:', err.message || err);
    return { ok: false, messages: [] };
  }
}

async function sendMessage({ chatId, text }) {
  if (!web) return { ok: false };
  try {
    await web.chat.postMessage({ channel: chatId, text });
    return { ok: true };
  } catch (err) {
    console.error('[sl] sendMessage() falló:', err.message || err);
    return { ok: false };
  }
}

async function sendImage({ chatId, base64, mimetype, filename, caption }) {
  if (!web) return { ok: false };
  try {
    await web.filesUploadV2({
      channel_id: chatId,
      file: Buffer.from(base64, 'base64'),
      filename: filename || 'imagen',
      initial_comment: caption || undefined,
    });
    return { ok: true };
  } catch (err) {
    console.error('[sl] sendImage() falló:', err.message || err);
    return { ok: false };
  }
}

async function reactToMessage({ messageId, emoji, chatId }) {
  if (!web) return { ok: false };
  const name = emojiToSlackName(emoji);
  if (!name || !chatId) return { ok: false };
  try {
    await web.reactions.add({ channel: chatId, timestamp: messageId, name });
    return { ok: true };
  } catch (err) {
    if (err.data && err.data.error === 'already_reacted') return { ok: true };
    console.error('[sl] reactToMessage() falló:', err.message || err);
    return { ok: false };
  }
}

async function getGroupParticipants(channelId) {
  if (!web) return { ok: false, participants: [] };
  try {
    const res = await web.conversations.members({ channel: channelId, limit: 200 });
    const ids = (res.members || []).filter((id) => id !== botUserId);
    const participants = await Promise.all(
      ids.map(async (id) => ({ id, name: (await getUserInfo(id)).name }))
    );
    return { ok: true, participants };
  } catch (err) {
    console.error('[sl] getGroupParticipants() falló:', err.message || err);
    return { ok: false, participants: [] };
  }
}

function init(sendFn) {
  send = sendFn;
  // A diferencia de whatsapp.js, acá no conecta solo al iniciar — main.js
  // llama a connect() una vez que hay credenciales (guardadas o recién
  // pegadas en la pantalla de emparejamiento).
}

module.exports = {
  init,
  connect,
  disconnect,
  getMessages,
  sendMessage,
  sendImage,
  reactToMessage,
  getGroupParticipants,
  searchUsers,
  openDirectMessage,
};
