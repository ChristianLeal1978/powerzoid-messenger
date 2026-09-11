const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { WebClient } = require('@slack/web-api');
const { SocketModeClient } = require('@slack/socket-mode');

let web; // WebClient, null hasta connect()
let socket; // SocketModeClient, null hasta connect()
let send; // (channel, payload) => void, inyectado desde main.js
// Token de USUARIO (xoxp-), no de bot — así conversations.list/history ven
// tus propios DMs y canales en vez de solo los que hablan con un bot (ver
// README, sección "Conectar Slack", para la razón de este cambio).
let userToken = null;
// Tu propio ID de usuario, resuelto de auth.test() al conectar — ya no hace
// falta pedírselo al usuario a mano porque el token ya es el suyo.
let myUserId = null;
// Los canales normales solo entran a la lista si el último mensaje te
// menciona directamente (ver pushChatListOnce()) — a diferencia de los DMs y
// los mensajes directos de grupo (mpim), que siempre se muestran porque son
// conversación privada por definición. Antes esto era un checkbox opcional
// en la pantalla de emparejamiento; el usuario pidió que "canales solo con
// @mención" fuera siempre así, sin depender de un ajuste (2026-08-26).
//
// Elegido a mano por el usuario con el buscador de canales (searchChannels()
// + openChannel()), para comentar en un canal sin esperar una @mención (ej.
// #editorial). Una vez elegido, se queda visible aunque su último mensaje no
// te mencione — igual que un DM, es una elección explícita de "quiero ver
// esto", no algo que deba desaparecer solo. Persistido a disco (ver
// loadPinnedChannels()/savePinnedChannels() más abajo) — pedido explícito
// del usuario, 2026-09-11 ("dejar anclado #editorial"): antes esto vivía
// solo en memoria y se vaciaba en cada reinicio, así que un canal elegido a
// mano había que volver a elegirlo cada vez que se abría la app. Se
// repuebla en connect() (loadPinnedChannels()) y se vuelve a mostrar con
// restorePinnedChannels(). unpinChannel() es la contraparte para sacar uno
// (ícono 📌 en la fila del chat, ver renderer.js) — sin eso, un canal
// anclado por error quedaría pegado para siempre.
const manuallyOpenedChannels = new Set();

function textMentionsUser(rawText, userId) {
  if (!userId || !rawText) return false;
  return rawText.includes(`<@${userId}>`);
}

// Para búsquedas/menciones "César" == "Cesar" (pedido del usuario,
// 2026-09-11): quita diacríticos antes de comparar, en vez de exigir que el
// usuario tipee la tilde exacta.
function normalizeForSearch(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
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

// Los mensajes directos de grupo (mpim) no tienen nombre propio en Slack —
// el campo `name` que devuelve la API es el slug crudo interno
// (`mpdm-fulano--mengano--zutano-1`), no algo para mostrarle a nadie.
// Resolvemos a los nombres reales de los participantes, como hace
// cualquier cliente de Slack real.
const mpimNameCache = new Map();

async function getMpimName(channelId) {
  if (mpimNameCache.has(channelId)) return mpimNameCache.get(channelId);
  let name = channelId;
  try {
    const res = await web.conversations.members({ channel: channelId, limit: 200 });
    const ids = (res.members || []).filter((id) => id !== myUserId);
    const infos = await Promise.all(ids.map((id) => getUserInfo(id)));
    const names = infos.map((i) => i.name);
    name = names.length > 3 ? `${names.slice(0, 3).join(', ')} y ${names.length - 3} más` : names.join(', ');
  } catch (err) {
    // Sin acceso a la membresía del grupo — mejor el slug crudo que romper.
  }
  mpimNameCache.set(channelId, name);
  return name;
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

async function fetchAsBase64(url, token) {
  const dataUri = await fetchAsDataUri(url, token);
  if (!dataUri) return null;
  const idx = dataUri.indexOf(',');
  return idx === -1 ? null : dataUri.slice(idx + 1);
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

function findFirstFile(msg, mimePrefix) {
  if (!msg.files || !msg.files.length) return null;
  return msg.files.find((f) => f.mimetype && f.mimetype.startsWith(mimePrefix)) || null;
}

async function getFirstImage(msg) {
  const file = findFirstFile(msg, 'image/');
  if (!file || !file.url_private) return null;
  // Los archivos de Slack viven en URLs privadas: hace falta el token
  // como Bearer para poder descargarlos (a diferencia de los avatares de
  // usuario, que sí son públicos).
  return fetchAsDataUri(file.url_private, userToken);
}

// Igual que getFirstImage(), pero para notas de audio/adjuntos de audio —
// pedido del usuario (2026-09-11): en vez de solo "📎 Adjunto" + botón de
// descarga (lo único que había hasta acá para cualquier adjunto que no sea
// imagen, ver renderMessage() en renderer.js), un audio se puede escuchar
// directo en la burbuja con un <audio controls>. Mismo criterio que las
// imágenes: se resuelve siempre al traer el mensaje (no on-demand al hacer
// click), embebido como data URI — las notas de voz de Slack son livianas,
// no debería pesar como para justificar un flujo lazy aparte.
async function getFirstAudio(msg) {
  const file = findFirstFile(msg, 'audio/');
  if (!file || !file.url_private) return null;
  return fetchAsDataUri(file.url_private, userToken);
}

// Resumen del mensaje raíz de un hilo, para la vista previa citada
// (renderer.js, `.quoted-preview` — mismo bloque visual que ya usa WhatsApp
// para "responder a un mensaje puntual", ver CLAUDE.md). Solo se llama para
// respuestas a hilos que SÍ se dejan pasar (mensaje raíz tuyo, ver
// getThreadParentInfo() y getMessages()) — no hace falta resolver esto para
// hilos ajenos, que se siguen ignorando.
async function buildQuotedSummary(parentMsg) {
  if (!parentMsg) return null;
  const authorId = parentMsg.user || null;
  const fromMe = !!myUserId && authorId === myUserId;
  const authorName = fromMe ? 'Tú' : authorId ? (await getUserInfo(authorId)).name : null;
  const body = (await formatSlackText(parentMsg.text)) || (parentMsg.files && parentMsg.files.length ? '📎 Adjunto' : '');
  return { authorName, body };
}

async function serializeMessage(msg, channelId, quoted) {
  const authorId = msg.user || null;
  const fromMe = !!myUserId && authorId === myUserId;
  const authorName = authorId && !fromMe ? (await getUserInfo(authorId)).name : null;
  const image = await getFirstImage(msg);
  // Un mensaje no trae imagen Y audio a la vez en la práctica — si algún
  // día pasara, la imagen gana (mismo orden que el resto de esta función).
  const audio = image ? null : await getFirstAudio(msg);
  return {
    id: msg.ts,
    chatId: channelId,
    fromMe,
    body: await formatSlackText(msg.text),
    timestamp: Math.floor(parseFloat(msg.ts)) || 0,
    author: authorId,
    authorName,
    hasMedia: !!(msg.files && msg.files.length),
    type: image ? 'image' : audio ? 'audio' : 'text',
    sticker: null,
    image,
    audio,
    quoted: quoted || null,
    reactions: (msg.reactions || []).map((r) => ({
      emoji: slackNameToEmoji(r.name),
      count: r.count,
      byMe: !!(myUserId && r.users && r.users.includes(myUserId)),
    })),
  };
}

// last message + timestamp por canal, alimentado por los eventos en vivo de
// Socket Mode. Evita tener que pedir conversations.history por cada canal
// en cada refresco de la lista (son rate-limited por método) — solo se pide
// una vez, la primera vez que vemos ese canal.
//
// Persistido a disco (bug real reportado por el usuario, 2026-09-08): este
// caché vive solo en memoria, así que en cada reinicio queda vacío y
// pushChatListOnce() no tiene "conocidos" que mostrar de entrada — todo pasa
// por backfillUnknownIms(), que es lento a propósito (lotes con pausa +
// reintentos de rate-limit, ver nota del 2026-08-26 en CLAUDE.md sobre el
// caso real de 687 conversaciones desconocidas tardando varios minutos).
// Guardando lo último conocido, el próximo arranque muestra de inmediato lo
// que ya se vio en la sesión anterior mientras el backfill (si hace falta)
// sigue corriendo atrás para ponerse al día.
const lastMessageCache = new Map();
let lastMessageCacheLoaded = false;
let lastMessageCacheDirty = false;
let lastMessageCacheSaveTimer = null;

function lastMessageCachePath() {
  return path.join(app.getPath('userData'), 'slack-chat-cache.json');
}

// Lazy, igual que el caché de nombres de chat de whatsapp.js: se carga una
// sola vez, en connect() — no al cargar el módulo, porque slack.js se
// require()ea antes de app.whenReady() en main.js y app.getPath() no es
// seguro llamarlo tan temprano.
function loadLastMessageCache() {
  if (lastMessageCacheLoaded) return;
  lastMessageCacheLoaded = true;
  try {
    const data = JSON.parse(fs.readFileSync(lastMessageCachePath(), 'utf8'));
    for (const [id, entry] of Object.entries(data)) {
      // Formato viejo (2026-09-08, antes de guardar name/avatar acá): sin
      // nombre, resolveConversationMeta() lo trataría igual como "conocido"
      // pero necesitaría pedir nombre/avatar a la API de todos modos — mejor
      // dejarlo afuera del todo y que entre por backfillUnknownIms() (que sí
      // reparte esos pedidos con pausa) en vez de en el fan-out sin límite
      // de pushChatListOnce().
      if (entry && entry.name !== undefined) lastMessageCache.set(id, entry);
    }
  } catch (err) {
    // Primera vez, o archivo inexistente/corrupto: arrancamos con caché vacío.
  }
}

// Debounced: los eventos en vivo de Socket Mode pueden llegar varios por
// segundo en un canal activo, y sin agrupar las escrituras cada uno
// dispararía su propio fs.writeFileSync.
function scheduleLastMessageCacheSave() {
  lastMessageCacheDirty = true;
  if (lastMessageCacheSaveTimer) return;
  lastMessageCacheSaveTimer = setTimeout(() => {
    lastMessageCacheSaveTimer = null;
    if (!lastMessageCacheDirty) return;
    lastMessageCacheDirty = false;
    try {
      fs.writeFileSync(lastMessageCachePath(), JSON.stringify(Object.fromEntries(lastMessageCache)));
    } catch (err) {
      console.error('[sl] no se pudo guardar el caché de últimos mensajes:', err.message || err);
    }
  }, 5000);
}

// --- Canales anclados a mano (manuallyOpenedChannels), persistidos a disco
// — ver el comentario junto a esa constante más arriba. Un archivo aparte
// de lastMessageCachePath()/slackCredentialsPath(): son pocos ítems que
// cambian poco (un pin/unpin ocasional, no un evento por mensaje), así que
// no hace falta el mismo debounce que el caché de últimos mensajes —
// escribir en el momento es simple y suficientemente barato acá.
function pinnedChannelsPath() {
  return path.join(app.getPath('userData'), 'slack-pinned-channels.json');
}

let pinnedChannelsLoaded = false;

function loadPinnedChannels() {
  if (pinnedChannelsLoaded) return;
  pinnedChannelsLoaded = true;
  try {
    const ids = JSON.parse(fs.readFileSync(pinnedChannelsPath(), 'utf8'));
    if (Array.isArray(ids)) ids.forEach((id) => manuallyOpenedChannels.add(id));
  } catch (err) {
    // Primera vez, o archivo inexistente/corrupto: arrancamos sin nada anclado.
  }
}

function savePinnedChannels() {
  try {
    fs.writeFileSync(pinnedChannelsPath(), JSON.stringify(Array.from(manuallyOpenedChannels)));
  } catch (err) {
    console.error('[sl] no se pudo guardar los canales anclados:', err.message || err);
  }
}

// Presencia (online/away) de contactos de DM. Cambia mucho más seguido que
// el nombre/avatar/membresía, así que el cooldown es bastante más corto que
// el resto de los cachés de este archivo — igual evita pedirla de nuevo en
// cada refresco disparado por un mensaje entrante.
const PRESENCE_REFRESH_COOLDOWN_MS = 30 * 1000;
const presenceCache = new Map(); // userId -> { online, fetchedAt }

async function getPresence(userId) {
  if (!userId) return null;
  const cached = presenceCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < PRESENCE_REFRESH_COOLDOWN_MS) return cached.online;
  let online = null;
  try {
    const res = await web.users.getPresence({ user: userId });
    online = res.presence === 'active';
  } catch (err) {
    // Sin datos de presencia disponibles — no mostramos el punto en vez de
    // reintentar en cada refresco.
  }
  presenceCache.set(userId, { online, fetchedAt: Date.now() });
  return online;
}

async function resolveConversationMeta(c) {
  // Camino rápido: si ya tenemos nombre/avatar cacheados (de esta sesión o
  // persistidos de una anterior, ver scheduleLastMessageCacheSave()), no se
  // pide NADA a la API — ni users.info, ni users.getPresence, ni
  // conversations.history. Bug real (2026-09-08): antes esto solo cortaba
  // el pedido de historial, pero seguía resolviendo nombre/avatar/presencia
  // por canal en cada llamada. Con el caché persistido a disco, el primer
  // pushChatListOnce() tras reconectar puede tener cientos de canales "ya
  // conocidos" a la vez, y sin este atajo eso disparaba cientos de llamadas
  // en paralelo sin límite — Slack las rate-limitaba en bloque y la lista
  // no se mandaba hasta que TODAS (con sus reintentos) terminaban: la app
  // tardaba más en mostrar los chats que sin caché en absoluto. La
  // presencia de un DM cacheado así queda en null (sin punto de "conectado")
  // hasta que algo más dispare getPresence() para esa persona — mejor eso
  // que bloquear el primer render.
  const cached = lastMessageCache.get(c.id);
  if (cached && cached.name !== undefined) {
    const online = c.is_im ? presenceCache.get(c.user)?.online ?? null : null;
    return { name: cached.name, avatar: cached.avatar, lastMessage: cached.text, timestamp: cached.ts, mentionsMe: cached.mentionsMe, online };
  }
  let name;
  let avatar = null;
  let online = null;
  if (c.is_im) {
    const info = await getUserInfo(c.user);
    name = info.name;
    avatar = await getAvatar(c.user, info.avatarUrl);
    online = await getPresence(c.user);
  } else if (c.is_mpim) {
    name = await getMpimName(c.id);
  } else {
    name = c.name || c.id;
  }
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
    }
  } catch (err) {
    // Canal sin historial accesible (el bot no es miembro todavía, etc.) —
    // se deja vacío.
  }
  // Se cachea siempre, incluso vacío (sin mensajes o sin acceso) — si no,
  // ese canal queda "desconocido" para siempre y backfillUnknownIms() lo
  // vuelve a pedir en CADA lote sin avanzar nunca. Bug real (2026-08-26,
  // al meter mpim al backfill): de 687 conversaciones desconocidas en un
  // caso real, una parte importante eran mpim sin un solo mensaje jamás —
  // sin este cache el backfill se quedaba reintentando ese mismo lote para
  // siempre, y la lista de Slack no cargaba nada. timestamp 0 marca "sin
  // mensaje real"; pushChatListOnce() lo usa para no mostrar estos chats
  // vacíos en la lista.
  lastMessageCache.set(c.id, { text: lastMessage, ts: timestamp, mentionsMe, name, avatar });
  scheduleLastMessageCacheSave();
  return { name, avatar, lastMessage, timestamp, mentionsMe, online };
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
// Si ya hay una paginación en curso, todo el mundo espera esa misma
// promesa en vez de disparar la suya — evita que una ráfaga de mensajes de
// varios canales nuevos a la vez (ej. te escriben tres personas nuevas
// seguidas) dispare varias paginaciones completas del workspace en
// paralelo. Mismo espíritu que el mutex de pushChatList().
let memberChannelsRefreshPromise = null;

async function getMemberChannels(forceRefresh) {
  const stale = Date.now() - memberChannelsFetchedAt > MEMBER_CHANNELS_REFRESH_COOLDOWN_MS;
  if (memberChannelsCache && !forceRefresh && !stale) return memberChannelsCache;
  if (memberChannelsRefreshPromise) return memberChannelsRefreshPromise;
  memberChannelsRefreshPromise = (async () => {
    const all = await listAllConversations();
    memberChannelsCache = all.filter((c) => c.is_im || c.is_mpim || c.is_member);
    memberChannelsFetchedAt = Date.now();
    return memberChannelsCache;
  })();
  try {
    return await memberChannelsRefreshPromise;
  } finally {
    memberChannelsRefreshPromise = null;
  }
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

// resolveConversationMeta() le pega a conversations.history una vez por
// canal nuevo (ver el cache en esa función) — con un token de bot eso era
// un puñado de canales, pero con un token de usuario es toda tu membresía
// real, que en un workspace grande puede ser decenas o cientos. Pedirlos
// en paralelo (incluso con un límite de concurrencia moderado, probado en
// vivo con 8) los manda en ráfaga, Slack rate-limita casi todos a la vez,
// y como todos reintentan al mismo tiempo (retry-after del SDK) el bug
// real que causó esto (encontrado 2026-08-13) es que nunca converge —
// queda reintentando en bucle indefinidamente. Un solo pedido en vuelo
// más una pausa entre cada uno es lo único que lo hace converger de
// verdad: más lento en el primer load de un workspace grande, pero
// termina. Los refrescos siguientes son baratos por el cache de arriba.
const HISTORY_FETCH_DELAY_MS = 300;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapSequentialWithDelay(items, delayMs, fn) {
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    results[i] = await fn(items[i]);
    if (i < items.length - 1) await delay(delayMs);
  }
  return results;
}

// En un workspace grande la membresía real (getMemberChannels()) puede ser
// de cientos de conversaciones (caso real visto en vivo: 725) — y la
// abrumadora mayoría resultaron ser mensajes directos de grupo (mpim)
// viejos y muertos (con gente ya desactivada hace años), no DMs 1:1 ni
// nada con actividad reciente. Decisión de producto tomada el 2026-08-13:
// para no ahogar la lista en ese ruido, mpim quedó afuera del backfill —
// solo entraba cuando llegaba un mensaje real en vivo durante la sesión.
// Revertido el 2026-08-26: el usuario pidió explícitamente ver siempre sus
// conversaciones de grupo (mpim), no solo las que reciben un mensaje
// *después* de abrir la app — y reportó en vivo que una conversación mpim
// activa había desaparecido de la lista tras reiniciar, justo por este
// motivo. mpim vuelve a backfillearse junto con los DMs 1:1, con el mismo
// tope por lote (UNKNOWN_HISTORY_FETCH_CAP) para no disparar todo de una:
// el orden de conversations.list no es por actividad, así que el primer
// lote puede traer mpim viejos antes que el activo, pero cada lote
// dispara pushChatList() de nuevo y, al llegar el turno del mpim activo,
// su timestamp real lo sube al tope de la lista (pushChatListOnce()
// ordena por timestamp descendente) — converge solo en un par de lotes,
// no hace falta esperar a que termine todo el backfill. Canales normales
// siguen sin backfillear: ahí el filtro es "solo con @mención", así que
// rellenar canales viejos sin mención no aportaría nada.
const UNKNOWN_HISTORY_FETCH_CAP = 80;

// backfillUnknownIms() y pushChatListOnce() están separadas a propósito —
// no una corriendo "en paralelo pero adentro de la misma función" (eso fue
// un intento anterior, bug real encontrado el mismo día: aunque el cálculo
// de lo ya conocido corriera rápido, pushChatListOnce() igual esperaba a
// que TERMINARA el lote lento de lo desconocido antes de mandar
// 'sl:chats' — un mensaje en un chat ya conocido seguía sin reflejarse
// mientras hubiera backfill pendiente, que con 154 DMs por cubrir podía
// ser la mayor parte de la sesión). Ahora pushChatListOnce() manda
// SIEMPRE con lo que ya está cacheado, sin esperar nada — y el backfill
// corre aparte, con su propio mutex, y dispara pushChatList() de nuevo
// cuando encuentra algo nuevo.
let backfillInFlight = false;

async function backfillUnknownIms() {
  if (backfillInFlight || !web) return;
  backfillInFlight = true;
  // Solo redispara pushChatList() si de verdad se pidió algo nuevo — si no,
  // con 0 DMs pendientes esto y pushChatListOnce() (que llama a
  // backfillUnknownIms() al final) se llamarían entre sí para siempre.
  let fetchedSomething = false;
  try {
    const channels = await getMemberChannels();
    const unknownIms = channels.filter((c) => (c.is_im || c.is_mpim) && !lastMessageCache.has(c.id));
    if (!unknownIms.length) return;
    const batch = unknownIms.slice(0, UNKNOWN_HISTORY_FETCH_CAP);
    if (unknownIms.length > UNKNOWN_HISTORY_FETCH_CAP) {
      console.error(
        `[sl] ${unknownIms.length} DMs/grupos sin preview todavía — pidiendo ${UNKNOWN_HISTORY_FETCH_CAP} más ahora, el resto se completa en lotes siguientes.`
      );
    }
    await mapSequentialWithDelay(batch, HISTORY_FETCH_DELAY_MS, (c) => resolveConversationMeta(c));
    fetchedSomething = true;
  } catch (err) {
    console.error('[sl] backfillUnknownIms() falló:', err.message || err);
  } finally {
    backfillInFlight = false;
    if (fetchedSomething) pushChatList();
  }
}

// Repone en lastMessageCache los canales anclados (manuallyOpenedChannels,
// cargados de disco en connect() vía loadPinnedChannels()) que todavía no
// se conocen en esta sesión — sin esto, un canal anclado sin actividad
// reciente ni mensajes en lastMessageCache no entra a `known` en
// pushChatListOnce() y el bypass de "canal elegido a mano" de ahí nunca
// llega a evaluarse. Mismo patrón que backfillUnknownIms() (mutex propio,
// dispara pushChatList() de nuevo solo si de verdad resolvió algo) pero
// sin tope de lote: son canales que el usuario eligió a propósito, no
// debería haber cientos.
let restorePinnedInFlight = false;

async function restorePinnedChannels() {
  if (restorePinnedInFlight || !web || !manuallyOpenedChannels.size) return;
  restorePinnedInFlight = true;
  let fetchedSomething = false;
  try {
    const channels = await getMemberChannels();
    const toRestore = channels.filter((c) => manuallyOpenedChannels.has(c.id) && !lastMessageCache.has(c.id));
    if (!toRestore.length) return;
    await mapSequentialWithDelay(toRestore, HISTORY_FETCH_DELAY_MS, (c) => resolveConversationMeta(c));
    fetchedSomething = true;
  } catch (err) {
    console.error('[sl] restorePinnedChannels() falló:', err.message || err);
  } finally {
    restorePinnedInFlight = false;
    if (fetchedSomething) pushChatList();
  }
}

async function pushChatListOnce() {
  if (!web) return;
  try {
    const channels = await getMemberChannels();
    // Solo lo ya conocido (lastMessageCache) — resolveConversationMeta()
    // corta directo ahí sin pedir nada a conversations.history, así que
    // esto siempre es rápido. Canales normales nunca backfilleados quedan
    // afuera hasta que entren por actividad en vivo (el filtro es "solo con
    // @mención", rellenarlos sin eso no aportaría nada); DMs y mpim
    // todavía no vistos quedan afuera hasta que backfillUnknownIms() los
    // cubra (ver comentario arriba).
    const known = channels.filter((c) => lastMessageCache.has(c.id));
    const withMeta = await Promise.all(
      known.map(async (c) => ({ channel: c, meta: await resolveConversationMeta(c) }))
    );
    backfillUnknownIms(); // en segundo plano, no bloquea el envío de arriba
    // timestamp 0 marca un chat sin un solo mensaje real (ver
    // resolveConversationMeta()) — se cachea para no trabarse reintentando,
    // pero no tiene sentido mostrarlo (sería un mpim muerto sin nada que
    // ver). Los DMs y mensajes directos de grupo con actividad real son
    // "conversación privada" por definición — siempre se muestran. Los
    // canales normales solo entran si el último mensaje menciona
    // directamente a la persona (ver textMentionsUser()).
    const relevant = withMeta.filter(({ channel, meta }) => {
      // Un canal elegido a mano se muestra igual, aunque no tenga un solo
      // mensaje todavía (recién abierto para escribir el primero) — el resto
      // de los casos sí exige timestamp > 0 (ver comentario en
      // resolveConversationMeta() sobre por qué existe esa marca).
      if (manuallyOpenedChannels.has(channel.id)) return true;
      return meta.timestamp > 0 && (channel.is_im || channel.is_mpim || meta.mentionsMe);
    });
    const list = relevant.slice(0, 60).map(({ channel, meta }) => ({
      id: channel.id,
      name: meta.name,
      isGroup: !channel.is_im,
      // La Web API no expone conteo real de no-leídos de forma simple —
      // se deja en 0 (ver limitación conocida en README).
      unreadCount: 0,
      lastMessage: meta.lastMessage,
      timestamp: meta.timestamp,
      avatar: meta.avatar,
      // Solo tiene sentido para DMs (un canal no tiene un único "usuario");
      // resolveConversationMeta() lo deja en null para el resto.
      online: meta.online,
      // Para el ícono 📌 de "desanclar" en renderer.js — solo aplica a
      // canales elegidos a mano (nunca a DMs/mpim, que no pasan por
      // openChannel()).
      pinned: manuallyOpenedChannels.has(channel.id),
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
        byMe: !!(myUserId && r.users && r.users.includes(myUserId)),
      })),
      emoji: event.reaction ? slackNameToEmoji(event.reaction) : null,
    });
  } catch (err) {
    console.error('[sl] no se pudo refrescar reacciones:', err.message || err);
  }
}

// Respuestas de hilo cuyo mensaje raíz es tuyo — el resto sigue ignorado
// (ver comentario en wireSocketEvents()/getMessages() sobre por qué). El
// mensaje raíz no cambia, así que cachear evita pedir el mismo
// conversations.history por cada reply nueva de un hilo activo — se
// cachea tanto de quién es (`mine`) como el resumen para la vista previa
// citada (`quoted`, ver buildQuotedSummary()), no solo el booleano, para no
// tener que volver a pedirlo aparte al renderizar la respuesta.
const threadParentInfoCache = new Map(); // "canal:thread_ts" -> { mine, quoted }

async function getThreadParentInfo(channelId, threadTs) {
  const key = `${channelId}:${threadTs}`;
  if (threadParentInfoCache.has(key)) return threadParentInfoCache.get(key);
  let info = { mine: false, quoted: null };
  try {
    const result = await web.conversations.history({
      channel: channelId,
      latest: threadTs,
      inclusive: true,
      limit: 1,
    });
    const parent = result.messages && result.messages[0];
    if (parent && myUserId && parent.user === myUserId) {
      info = { mine: true, quoted: await buildQuotedSummary(parent) };
    }
  } catch (err) {
    // Sin acceso al mensaje raíz del hilo — mejor tratarlo como ajeno
    // (se ignora, como cualquier otra respuesta de hilo) que romper.
  }
  threadParentInfoCache.set(key, info);
  return info;
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
    // Respuesta en un hilo (thread_ts != ts): la app no tiene UI de hilos
    // (ver CLAUDE.md, sección Slack) y getMessages() solo trae
    // conversations.history, que no incluye replies de hilo por defecto.
    // Sin ningún filtro, cada reply prendía el punto ámbar de "mensaje
    // nuevo" pero al abrir la conversación no aparecía nada — bug real,
    // reportado por el usuario como aviso sostenido sin mensaje visible.
    // Ahora se deja pasar (y se muestra plano en la conversación, mezclado
    // por orden de tiempo, con una vista previa citada del mensaje raíz —
    // ver quotedSummary abajo) solo cuando el mensaje raíz del hilo es
    // TUYO — pedido explícito del usuario, 2026-09-11: no veía cuándo
    // alguien le respondía a su propia publicación en un canal, y luego
    // (mismo día) pidió que esa respuesta se viera vinculada visualmente al
    // mensaje original, como en WhatsApp. getMessages() trae estas mismas
    // respuestas al reabrir el chat (ver getThreadParentInfo() ahí) para
    // que no desaparezcan como antes. Respuestas a hilos ajenos se siguen
    // ignorando — eso sí sería threading completo, fuera de alcance de
    // este cambio.
    let isReplyToMyMessage = false;
    let quotedSummary = null;
    if (event.thread_ts && event.thread_ts !== event.ts) {
      const parentInfo = await getThreadParentInfo(event.channel, event.thread_ts);
      isReplyToMyMessage = parentInfo.mine;
      quotedSummary = parentInfo.quoted;
      if (!isReplyToMyMessage) return;
    }
    // Cada paso en su propio try/catch: un fallo puntual (ej. rate-limit al
    // refrescar membresía) no debe cortar el resto del manejo del evento en
    // silencio — eso dejaba la conversación y/o la lista sin actualizar
    // hasta el próximo mensaje, en vez de solo perderse ese refresco puntual.
    try {
      const mentionsMe = textMentionsUser(event.text, myUserId);
      const serialized = await serializeMessage(event, event.channel, quotedSummary);
      lastMessageCache.set(event.channel, {
        ...lastMessageCache.get(event.channel), // conserva name/avatar ya resueltos, si los hay
        text: serialized.body,
        ts: serialized.timestamp,
        // Una respuesta a mi propio mensaje cuenta como "me interesa" igual
        // que una @mención directa, aunque el texto de la respuesta no me
        // mencione — así el canal también entra a la lista por este motivo
        // (ver filtro de pushChatListOnce()).
        mentionsMe: mentionsMe || isReplyToMyMessage,
      });
      scheduleLastMessageCacheSave();
      // Mismo criterio de visibilidad que pushChatListOnce(): un canal
      // normal (ni DM ni mpim) sin mención directa no entra a la lista —
      // pero este handler prendía el punto ámbar de "mensaje nuevo" para
      // CUALQUIER mensaje en CUALQUIER canal del que soy miembro, sin mirar
      // la mención. Resultado: alerta sostenida sin nada nuevo visible al
      // abrir Slack (bug real, reportado por el usuario, seguía después de
      // filtrar replies de hilo). Si el canal todavía no está en el cache de
      // membresía (recién llegó) se deja pasar — el refresco de abajo lo
      // resuelve para la próxima vez.
      const channelInfo = memberChannelsCache && memberChannelsCache.find((c) => c.id === event.channel);
      const alwaysVisible = !channelInfo || channelInfo.is_im || channelInfo.is_mpim;
      if (alwaysVisible || mentionsMe || isReplyToMyMessage) {
        send('sl:incoming', serialized);
      }
    } catch (err) {
      console.error('[sl] no se pudo procesar el mensaje entrante:', err.message || err);
    }
    try {
      // Canal que la membresía cacheada todavía no conoce (ej. primer DM de
      // alguien nuevo, o recién invitaron al bot a un canal) — forzamos el
      // refresco ahora en vez de esperar el cooldown de 5 min, si no
      // aparecería tarde en la lista pese a haber un mensaje nuevo.
      if (memberChannelsCache && !memberChannelsCache.some((c) => c.id === event.channel)) {
        await getMemberChannels(true);
      }
    } catch (err) {
      console.error('[sl] no se pudo refrescar la membresía de canales:', err.message || err);
    }
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

async function connect({ userToken: token, appToken }) {
  loadLastMessageCache();
  loadPinnedChannels();
  userToken = token;
  web = new WebClient(userToken);
  try {
    const auth = await web.auth.test();
    myUserId = auth.user_id;
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
  restorePinnedChannels(); // en segundo plano, no bloquea el envío de arriba
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
    (u) => !u.deleted && !u.is_bot && u.id !== myUserId && u.id !== 'USLACKBOT'
  );
  userDirectoryFetchedAt = Date.now();
  return userDirectoryCache;
}

async function searchUsers(query) {
  if (!web) return { ok: false, users: [] };
  const q = normalizeForSearch((query || '').trim());
  if (!q) return { ok: true, users: [] };
  try {
    const directory = await getUserDirectory();
    const matches = directory
      .filter((u) => {
        const p = u.profile || {};
        const name = normalizeForSearch(p.display_name || p.real_name || u.name || '');
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

// --- Buscador de canales, para abrir uno sin esperar a que aparezca solo
// por @mención (ver comentario de manuallyOpenedChannels más arriba) — ej.
// comentar algo en #editorial sin que nadie te haya mencionado ahí. Solo
// busca en canales normales (públicos/privados) donde ya eres miembro; DMs
// van por searchUsers() y mpim no tienen nombre propio para buscar por texto
// (ver getMpimName()).
async function searchChannels(query) {
  if (!web) return { ok: false, channels: [] };
  const q = normalizeForSearch((query || '').trim().replace(/^#/, ''));
  if (!q) return { ok: true, channels: [] };
  try {
    const channels = await getMemberChannels();
    const matches = channels
      .filter((c) => !c.is_im && !c.is_mpim && normalizeForSearch(c.name || '').includes(q))
      .slice(0, 20)
      .map((c) => ({ id: c.id, name: c.name }));
    return { ok: true, channels: matches };
  } catch (err) {
    console.error('[sl] searchChannels() falló:', err.message || err);
    return { ok: false, channels: [] };
  }
}

async function openChannel(channelId) {
  if (!web) return { ok: false };
  try {
    const channels = await getMemberChannels();
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) return { ok: false };
    manuallyOpenedChannels.add(channelId);
    savePinnedChannels();
    const meta = await resolveConversationMeta(channel);
    const chat = {
      id: channel.id,
      name: meta.name,
      isGroup: true,
      unreadCount: 0,
      lastMessage: meta.lastMessage,
      timestamp: meta.timestamp || Math.floor(Date.now() / 1000),
      avatar: meta.avatar,
      pinned: true,
    };
    pushChatList();
    return { ok: true, chat };
  } catch (err) {
    console.error('[sl] openChannel() falló:', err.message || err);
    return { ok: false };
  }
}

// Contraparte de openChannel(): saca un canal de manuallyOpenedChannels y lo
// persiste (ver ícono 📌 en la fila del chat, renderer.js). No hace falta
// tocar lastMessageCache — si el canal sigue teniendo actividad real
// (timestamp > 0) y cumple el filtro normal (mención directa, o es DM/mpim),
// se sigue mostrando igual; si no, simplemente deja de aparecer, que es el
// punto de desanclarlo.
async function unpinChannel(channelId) {
  manuallyOpenedChannels.delete(channelId);
  savePinnedChannels();
  pushChatList();
  return { ok: true };
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
  userToken = null;
  myUserId = null;
  // Si había una escritura debounced pendiente (ver scheduleLastMessageCacheSave()),
  // la escribimos ahora mismo antes de limpiar el Map — si no, ese timeout
  // dispararía DESPUÉS del clear() de acá abajo y pisaría el archivo con un
  // objeto vacío, perdiendo todo lo que se quería persistir para el próximo
  // arranque.
  clearTimeout(lastMessageCacheSaveTimer);
  lastMessageCacheSaveTimer = null;
  if (lastMessageCacheDirty) {
    lastMessageCacheDirty = false;
    try {
      fs.writeFileSync(lastMessageCachePath(), JSON.stringify(Object.fromEntries(lastMessageCache)));
    } catch (err) {
      console.error('[sl] no se pudo guardar el caché de últimos mensajes al desconectar:', err.message || err);
    }
  }
  lastMessageCache.clear();
  userInfoCache.clear();
  mpimNameCache.clear();
  avatarCache.clear();
  avatarFailedAt.clear();
  presenceCache.clear();
  threadParentInfoCache.clear();
  memberChannelsCache = null;
  memberChannelsFetchedAt = 0;
  manuallyOpenedChannels.clear();
  // Sin resetear esto, un reconector dentro del mismo proceso (desconectar
  // y volver a pegar credenciales sin cerrar la app) dejaría
  // loadPinnedChannels() como no-op en el próximo connect() — los pines
  // seguirían en el archivo, pero manuallyOpenedChannels quedaría vacío
  // para siempre en esta sesión del proceso.
  pinnedChannelsLoaded = false;
  userDirectoryCache = null;
  userDirectoryFetchedAt = 0;
  send('sl:status', 'not-configured');
}

async function getMessages(channelId) {
  if (!web) return { ok: false, messages: [] };
  try {
    const hist = await web.conversations.history({ channel: channelId, limit: 50 });
    const msgs = (hist.messages || []).slice();
    // conversations.history no trae replies de hilo — wireSocketEvents()
    // ya deja pasar en vivo las respuestas a MIS mensajes (ver
    // getThreadParentInfo()), pero sin esto desaparecían de nuevo al
    // reabrir la conversación. Se muestran planas, mezcladas por orden de
    // tiempo con el resto, con una vista previa citada del mensaje raíz
    // (`quotedByTs`, mismo bloque visual `.quoted-preview` de WhatsApp) —
    // la app sigue sin UI de hilos como tal (ver CLAUDE.md), pero así queda
    // claro a qué mensaje responde cada una. Hilos ajenos siguen sin
    // traerse — mismo alcance que en vivo.
    const myThreadParents = msgs.filter((m) => m.user === myUserId && m.reply_count > 0);
    const quotedByTs = new Map(); // ts de la respuesta -> resumen del mensaje raíz
    const replyBatches = await Promise.all(
      myThreadParents.map(async (parent) => {
        try {
          const res = await web.conversations.replies({ channel: channelId, ts: parent.ts, limit: 100 });
          const replies = (res.messages || []).filter((m) => m.ts !== parent.ts);
          if (replies.length) {
            const quoted = await buildQuotedSummary(parent);
            for (const r of replies) quotedByTs.set(r.ts, quoted);
          }
          return replies;
        } catch (err) {
          return [];
        }
      })
    );
    for (const replies of replyBatches) msgs.push(...replies);
    msgs.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
    const messages = await Promise.all(msgs.map((m) => serializeMessage(m, channelId, quotedByTs.get(m.ts) || null)));
    return { ok: true, messages };
  } catch (err) {
    console.error('[sl] getMessages() falló:', err.message || err);
    return { ok: false, messages: [] };
  }
}

// Slack no hace eco por Socket Mode de los mensajes que uno mismo manda
// con su propio token de usuario (bug real, reportado por el usuario
// 2026-08-13: le respondían y el chat subía al tope de la lista; cuando
// respondía él, no pasaba nada). wireSocketEvents() solo se entera de
// mensajes ajenos, así que hay que reflejar el propio a mano, en vez de
// esperar un evento que nunca llega.
async function recordOwnMessage(chatId, ts, text) {
  if (!ts) return;
  try {
    const serialized = await serializeMessage({ ts, user: myUserId, text }, chatId);
    lastMessageCache.set(chatId, {
      ...lastMessageCache.get(chatId), // conserva name/avatar ya resueltos, si los hay
      text: serialized.body,
      ts: serialized.timestamp,
      mentionsMe: false,
    });
    scheduleLastMessageCacheSave();
    send('sl:incoming', serialized);
    pushChatList();
  } catch (err) {
    console.error('[sl] no se pudo reflejar el mensaje propio en la lista:', err.message || err);
  }
}

async function sendMessage({ chatId, text }) {
  if (!web) return { ok: false };
  try {
    const res = await web.chat.postMessage({ channel: chatId, text });
    await recordOwnMessage(chatId, res.ts, text);
    return { ok: true };
  } catch (err) {
    console.error('[sl] sendMessage() falló:', err.message || err);
    return { ok: false };
  }
}

async function sendImage({ chatId, base64, mimetype, filename, caption }) {
  if (!web) return { ok: false };
  try {
    const res = await web.filesUploadV2({
      channel_id: chatId,
      file: Buffer.from(base64, 'base64'),
      filename: filename || 'imagen',
      initial_comment: caption || undefined,
    });
    // filesUploadV2() no devuelve un ts de mensaje de canal tan directo como
    // chat.postMessage — al menos actualizamos el preview de la lista con
    // la hora actual, aunque no dispare sl:incoming (la imagen ya se ve en
    // el picker antes de mandarla, no es tan crítico como el texto).
    lastMessageCache.set(chatId, {
      ...lastMessageCache.get(chatId), // conserva name/avatar ya resueltos, si los hay
      text: caption || '📷 Imagen',
      ts: Math.floor(Date.now() / 1000),
      mentionsMe: false,
    });
    scheduleLastMessageCacheSave();
    pushChatList();
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

async function downloadAttachment({ messageId, chatId }) {
  if (!web || !chatId) return { ok: false };
  try {
    const result = await web.conversations.history({
      channel: chatId,
      latest: messageId,
      inclusive: true,
      limit: 1,
    });
    const msg = result.messages && result.messages[0];
    const file = msg && msg.files && msg.files[0];
    if (!file || !file.url_private) return { ok: false };
    const base64 = await fetchAsBase64(file.url_private, userToken);
    if (!base64) return { ok: false };
    return {
      ok: true,
      base64,
      mimetype: file.mimetype || 'application/octet-stream',
      filename: file.name || `slack-adjunto-${messageId}`,
    };
  } catch (err) {
    console.error('[sl] downloadAttachment() falló:', err.message || err);
    return { ok: false };
  }
}

async function getGroupParticipants(channelId) {
  if (!web) return { ok: false, participants: [] };
  try {
    const res = await web.conversations.members({ channel: channelId, limit: 200 });
    const ids = (res.members || []).filter((id) => id !== myUserId);
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
  searchChannels,
  openChannel,
  unpinChannel,
  downloadAttachment,
};
