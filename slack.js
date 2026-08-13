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
// Si está prendido, pushChatListOnce() deja afuera los canales normales
// donde el último mensaje no te menciona directamente. Los DMs y mensajes
// directos de grupo siempre se muestran, prendido o no (ver pushChatListOnce()).
let mentionFilter = false;

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

async function getFirstImage(msg) {
  if (!msg.files || !msg.files.length) return null;
  const file = msg.files.find((f) => f.mimetype && f.mimetype.startsWith('image/'));
  if (!file || !file.url_private) return null;
  // Los archivos de Slack viven en URLs privadas: hace falta el token
  // como Bearer para poder descargarlos (a diferencia de los avatares de
  // usuario, que sí son públicos).
  return fetchAsDataUri(file.url_private, userToken);
}

async function serializeMessage(msg, channelId) {
  const authorId = msg.user || null;
  const fromMe = !!myUserId && authorId === myUserId;
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
      byMe: !!(myUserId && r.users && r.users.includes(myUserId)),
    })),
  };
}

// last message + timestamp por canal, alimentado por los eventos en vivo de
// Socket Mode. Evita tener que pedir conversations.history por cada canal
// en cada refresco de la lista (son rate-limited por método) — solo se pide
// una vez, la primera vez que vemos ese canal.
const lastMessageCache = new Map();

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
  const cached = lastMessageCache.get(c.id);
  if (cached) {
    return { name, avatar, lastMessage: cached.text, timestamp: cached.ts, mentionsMe: cached.mentionsMe, online };
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
      lastMessageCache.set(c.id, { text: lastMessage, ts: timestamp, mentionsMe });
    }
  } catch (err) {
    // Canal sin historial accesible (el bot no es miembro todavía, etc.) —
    // se deja vacío en vez de reintentar en cada refresco.
  }
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
// nada con actividad reciente. Backfillear eso (aunque sea con tope y de a
// uno) no solo es lento, es ruido: el usuario reportó ver el mpim más
// viejo antes que cualquier cosa reciente, porque el orden que devuelve
// conversations.list no es por actividad. Decisión de producto confirmada
// con el usuario 2026-08-13: la barra solo le importa a DMs 1:1 (siempre)
// y a lo que efectivamente pasa en vivo durante la sesión — canales
// normales y mpim NO se backfillean nunca; entran a la lista recién
// cuando llega un mensaje real (wireSocketEvents ya cachea el body del
// evento sin pedir historial) o si ya estaban en lastMessageCache de esta
// misma sesión. Los DMs 1:1 sí se backfillean (con el mismo tope por si
// también son muchos) porque son lo que el usuario pidió ver siempre.
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
    const unknownIms = channels.filter((c) => c.is_im && !lastMessageCache.has(c.id));
    if (!unknownIms.length) return;
    const batch = unknownIms.slice(0, UNKNOWN_HISTORY_FETCH_CAP);
    if (unknownIms.length > UNKNOWN_HISTORY_FETCH_CAP) {
      console.error(
        `[sl] ${unknownIms.length} DMs sin preview todavía — pidiendo ${UNKNOWN_HISTORY_FETCH_CAP} más ahora, el resto se completa con el uso.`
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

async function pushChatListOnce() {
  if (!web) return;
  try {
    const channels = await getMemberChannels();
    // Solo lo ya conocido (lastMessageCache) — resolveConversationMeta()
    // corta directo ahí sin pedir nada a conversations.history, así que
    // esto siempre es rápido. Canales y mpim nunca backfilleados quedan
    // afuera hasta que entren por actividad en vivo (ver comentario
    // arriba); DMs todavía no vistos quedan afuera hasta que
    // backfillUnknownIms() los cubra.
    const known = channels.filter((c) => lastMessageCache.has(c.id));
    const withMeta = await Promise.all(
      known.map(async (c) => ({ channel: c, meta: await resolveConversationMeta(c) }))
    );
    backfillUnknownIms(); // en segundo plano, no bloquea el envío de arriba
    // Los DMs y mensajes directos de grupo son "conversación privada" por
    // definición — siempre se muestran. Los canales normales solo entran si
    // el filtro de menciones está apagado o si el último mensaje menciona
    // directamente a la persona (ver textMentionsUser()).
    const relevant = withMeta.filter(
      ({ channel, meta }) => channel.is_im || channel.is_mpim || !mentionFilter || meta.mentionsMe
    );
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
    // Cada paso en su propio try/catch: un fallo puntual (ej. rate-limit al
    // refrescar membresía) no debe cortar el resto del manejo del evento en
    // silencio — eso dejaba la conversación y/o la lista sin actualizar
    // hasta el próximo mensaje, en vez de solo perderse ese refresco puntual.
    try {
      const serialized = await serializeMessage(event, event.channel);
      lastMessageCache.set(event.channel, {
        text: serialized.body,
        ts: serialized.timestamp,
        mentionsMe: textMentionsUser(event.text, myUserId),
      });
      send('sl:incoming', serialized);
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

async function connect({ userToken: token, appToken, mentionFilter: filterOn }) {
  userToken = token;
  mentionFilter = !!filterOn;
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
  userToken = null;
  myUserId = null;
  mentionFilter = false;
  lastMessageCache.clear();
  userInfoCache.clear();
  mpimNameCache.clear();
  avatarCache.clear();
  avatarFailedAt.clear();
  presenceCache.clear();
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
    lastMessageCache.set(chatId, { text: serialized.body, ts: serialized.timestamp, mentionsMe: false });
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
    lastMessageCache.set(chatId, { text: caption || '📷 Imagen', ts: Math.floor(Date.now() / 1000), mentionsMe: false });
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
  downloadAttachment,
};
