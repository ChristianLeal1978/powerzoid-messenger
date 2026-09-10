const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');

let client;
let send; // (channel, payload) => void, inyectado desde main.js

// --- Nombres de contacto (autores en grupos) y fotos de perfil ---
// Cacheados en memoria por id: cambian poco durante una sesión y evitan
// repetir consultas al Store por cada mensaje/refresco de la lista.
const contactNameCache = new Map();
const avatarCache = new Map();

// Nombre mostrado en la lista de chats, cacheado por chat id y persistido a
// disco. Bug real reportado por el usuario: al reabrir la app, los
// contactos con los que no había actividad ESE día se veían como número en
// vez de nombre — solo los chats con mensajes recientes tenían nombre. Causa:
// c.name sale del Store interno de WhatsApp Web, que recién arranca a
// sincronizarse cuando dispara 'ready'; pushChatListOnce() llama a
// getChats() ahí mismo, así que para un chat sin actividad reciente (que el
// Store tarda más en hidratar/no prioriza) c.name todavía viene vacío en
// ese primer push, y sin caché entre sesiones caía directo al número sin
// forma de recuperarse hasta que ese chat tuviera un mensaje nuevo. Con el
// caché persistido, el nombre visto en una sesión anterior sobrevive al
// reinicio y tapa ese hueco de sincronización.
const chatNameCache = new Map();
let chatNameCacheDirty = false;
let chatNameCacheSaveTimer = null;

function chatNameCachePath() {
  return path.join(app.getPath('userData'), 'chat-name-cache.json');
}

// Lazy: app.getPath('userData') no es seguro llamarlo en tiempo de carga
// del módulo, y whatsapp.js se require()ea antes de app.whenReady() en
// main.js. Se carga una sola vez, en el primer uso real (dentro de
// createClient(), que ya corre después de 'ready').
let chatNameCacheLoaded = false;

function loadChatNameCache() {
  if (chatNameCacheLoaded) return;
  chatNameCacheLoaded = true;
  try {
    const data = JSON.parse(fs.readFileSync(chatNameCachePath(), 'utf8'));
    for (const [id, name] of Object.entries(data)) chatNameCache.set(id, name);
  } catch (err) {
    // Primera vez, o archivo inexistente/corrupto: arrancamos con caché vacío.
  }
}

// Debounced: pushChatListOnce() corre en cada mensaje, y sin agrupar las
// escrituras cada mensaje dispararía su propio fs.writeFileSync.
function scheduleChatNameCacheSave() {
  chatNameCacheDirty = true;
  if (chatNameCacheSaveTimer) return;
  chatNameCacheSaveTimer = setTimeout(() => {
    chatNameCacheSaveTimer = null;
    if (!chatNameCacheDirty) return;
    chatNameCacheDirty = false;
    try {
      fs.writeFileSync(chatNameCachePath(), JSON.stringify(Object.fromEntries(chatNameCache)));
    } catch (err) {
      console.error('[wa] no se pudo guardar el caché de nombres de chat:', err.message || err);
    }
  }, 5000);
}

async function getContactName(id) {
  if (!id) return null;
  if (contactNameCache.has(id)) return contactNameCache.get(id);
  let name = id.split('@')[0];
  try {
    const contact = await client.getContactById(id);
    name = contact.name || contact.pushname || contact.number || name;
  } catch (err) {
    // Sin datos de contacto disponibles; nos quedamos con el número.
  }
  contactNameCache.set(id, name);
  return name;
}

function fetchAsDataUri(url) {
  return new Promise((resolve) => {
    https
      .get(url, (res) => {
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

// pushChatList() corre en cada mensaje entrante/saliente. Si no cacheáramos
// nunca los fallos (como se hizo en un intento anterior), un chat cuya foto
// falla se reintenta con un round-trip a Puppeteer + descarga HTTPS en
// *cada* mensaje del chat — eso fue lo que causó el pico de CPU/memoria que
// se sentía como lag al escribir y cortes de audio. Este cooldown deja que
// un fallo transitorio se recupere solo, sin martillar en cada mensaje.
const AVATAR_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const avatarFailedAt = new Map();

async function getAvatar(id) {
  if (avatarCache.has(id)) return avatarCache.get(id);
  const lastFail = avatarFailedAt.get(id);
  if (lastFail && Date.now() - lastFail < AVATAR_RETRY_COOLDOWN_MS) return null;
  let dataUri = null;
  try {
    const url = await client.getProfilePicUrl(id);
    if (url) dataUri = await fetchAsDataUri(url);
  } catch (err) {
    // Sin foto de perfil (o privacidad la bloquea), o el bug intermitente
    // de whatsapp-web.js — cualquiera de los dos cae al mismo cooldown.
  }
  if (dataUri) {
    avatarCache.set(id, dataUri);
    avatarFailedAt.delete(id);
  } else {
    avatarFailedAt.set(id, Date.now());
  }
  return dataUri;
}

// whatsapp-web.js normaliza msg.id vía Base._normalizeId, pero los ids que
// vienen sueltos en eventos como message_reaction (reaction.msgId) no pasan
// por ahí — replicamos el mismo fallback _serialized/$1 (ver nota sobre el
// cambio de WhatsApp Web de julio 2026 más arriba).
function normalizeId(id) {
  if (!id) return null;
  return id._serialized || id.$1 || null;
}

// Igual que con los stickers: bajamos el contenido inline solo para los
// tipos livianos que queremos previsualizar (sticker, imagen). Video/audio/
// documentos se quedan en el placeholder "📎 Adjunto" — descargarlos todos
// en cada fetchMessages() sería el mismo tipo de martillazo a Puppeteer que
// causó los picos de CPU documentados en pushChatList().
async function getMediaDataUri(msg) {
  if (!msg.hasMedia || (msg.type !== 'sticker' && msg.type !== 'image')) return null;
  try {
    const media = await msg.downloadMedia();
    return media ? `data:${media.mimetype};base64,${media.data}` : null;
  } catch (err) {
    return null; // la UI cae al placeholder de "Adjunto"
  }
}

// --- Tarjetas de contacto (vcard/multi_vcard) ---
// msg.vCards (poblado por la librería para type 'vcard'/'multi_vcard') trae
// el texto crudo del vCard tal cual lo manda WhatsApp — lo parseamos acá
// para no mostrarle al usuario el BEGIN:VCARD/END:VCARD sin procesar.
function parseVCard(vcard) {
  const lines = String(vcard).split(/\r\n|\n|\r/);
  let name = null;
  const phones = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).split(';')[0].toUpperCase();
    const value = line.slice(colonIdx + 1).trim();
    if (key === 'FN' && !name) {
      name = value;
    } else if (key === 'TEL' && value) {
      phones.push(value);
    }
  }
  return { name: name || 'Contacto', phones };
}

function getContacts(msg) {
  if (msg.type !== 'vcard' && msg.type !== 'multi_vcard') return null;
  const vCards = msg.vCards || [];
  if (!vCards.length) return null;
  return vCards.map(parseVCard);
}

async function getReactionsSummary(msg) {
  if (!msg.hasReaction) return [];
  try {
    const list = await msg.getReactions();
    return (list || []).map((r) => ({ emoji: r.id, count: r.senders.length, byMe: r.hasReactionByMe }));
  } catch (err) {
    return [];
  }
}

async function getQuotedSummary(msg) {
  if (!msg.hasQuotedMsg) return null;
  try {
    // getQuotedMessage() hace un round-trip extra a Puppeteer, pero contra la
    // colección `Msg` (por mensaje), no `Chat`/`getChatById` — la que está
    // rota por el bug de julio 2026 documentado en CLAUDE.md. Se paga el
    // costo solo cuando el mensaje es efectivamente una respuesta.
    const quoted = await msg.getQuotedMessage();
    if (!quoted) return null;
    const authorId = quoted.fromMe ? null : quoted.author || quoted.from;
    return {
      body: quoted.body || (quoted.hasMedia ? '📎 Adjunto' : ''),
      authorName: quoted.fromMe ? 'Tú' : authorId ? await getContactName(authorId) : null,
    };
  } catch (err) {
    console.error('[wa] getQuotedMessage() falló:', err.message || err);
    return null;
  }
}

async function resolveMentionsInBody(msg) {
  // WhatsApp deja las menciones en el texto como "@<número>" (el nombre
  // solo vive en mentionedIds); si no las resolvemos acá, la UI muestra el
  // número pelado en vez de "@Nombre".
  if (!msg.mentionedIds || !msg.mentionedIds.length) return msg.body;
  let body = msg.body || '';
  const ids = msg.mentionedIds.map((m) => (typeof m === 'string' ? m : m._serialized));
  // Reemplazamos del número más largo al más corto: si un número mencionado
  // es prefijo de otro, resolver el corto primero corrompería la ocurrencia
  // del largo.
  const withNumbers = await Promise.all(
    ids.map(async (id) => ({ number: id.split('@')[0], name: await getContactName(id) }))
  );
  withNumbers.sort((a, b) => b.number.length - a.number.length);
  for (const { number, name } of withNumbers) {
    body = body.split(`@${number}`).join(`@${name}`);
  }
  return body;
}

async function serializeMessage(msg) {
  // OJO: evitamos msg.getChat() a propósito. Internamente hace otra consulta
  // al Store (client.getChatById) que hoy está rota en whatsapp-web.js (ver
  // README, sección "Problema conocido"). El chatId ya viene en el propio
  // mensaje sin necesidad de esa consulta extra.
  const mediaDataUri = await getMediaDataUri(msg);
  return {
    id: msg.id._serialized,
    chatId: msg.fromMe ? msg.to : msg.from,
    fromMe: msg.fromMe,
    body: await resolveMentionsInBody(msg),
    timestamp: msg.timestamp,
    author: msg.author || null,
    // OJO: `author` viene poblado en mensajes de grupo tanto míos como
    // ajenos (no solo ajenos, pese a lo que sugiere la doc de la librería).
    // Solo resolvemos/mostramos el nombre cuando no es un mensaje propio.
    authorName: msg.author && !msg.fromMe ? await getContactName(msg.author) : null,
    quoted: await getQuotedSummary(msg),
    forwarded: !!msg.isForwarded,
    hasMedia: msg.hasMedia,
    type: msg.type,
    sticker: msg.type === 'sticker' ? mediaDataUri : null,
    image: msg.type === 'image' ? mediaDataUri : null,
    contacts: getContacts(msg),
    reactions: await getReactionsSummary(msg),
  };
}

let chatListRetries = 0;
let emptyListRetries = 0;
let pushChatListInFlight = false;
let pushChatListQueued = false;

// pushChatList() se dispara en cada mensaje entrante/saliente sin esperar
// (fire-and-forget). En un grupo activo, varios mensajes pueden llegar
// dentro de la misma ráfaga, y sin coordinación cada uno lanzaba su propio
// client.getChats() (round-trip completo a Puppeteer sobre todo el Store)
// en paralelo — eso apilaba llamadas concurrentes y generaba los picos de
// memoria/CPU. Con este mutex, una ráfaga colapsa en como mucho una llamada
// en curso más una de cola (no se pierde el refresco, pero no se duplica).
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
  try {
    const chats = await client.getChats();
    chatListRetries = 0;
    const list = await Promise.all(
      chats
        .filter((c) => !c.archived)
        .slice(0, 60)
        .map(async (c) => {
          if (c.name && chatNameCache.get(c.id._serialized) !== c.name) {
            chatNameCache.set(c.id._serialized, c.name);
            scheduleChatNameCacheSave();
          }
          return {
            id: c.id._serialized,
            name: chatNameCache.get(c.id._serialized) || c.id.user,
            isGroup: c.isGroup,
            unreadCount: c.unreadCount,
            lastMessage: c.lastMessage ? c.lastMessage.body : '',
            timestamp: c.timestamp,
            avatar: await getAvatar(c.id._serialized),
          };
        })
    );
    if (!list.length && emptyListRetries < 8) {
      // Justo después de vincular un dispositivo nuevo, el cliente puede
      // quedar "ready" antes de que WhatsApp termine de sincronizar el
      // historial de chats — getChats() devuelve [] sin error. Reintentamos
      // antes de asumir que la cuenta realmente no tiene chats.
      emptyListRetries += 1;
      send('wa:chats-syncing', { attempt: emptyListRetries });
      setTimeout(pushChatList, Math.min(4000 * emptyListRetries, 20000));
      return;
    }
    emptyListRetries = 0;
    send('wa:chats', list);
  } catch (err) {
    // client.getChats() está afectado por un bug conocido, en curso, de
    // whatsapp-web.js tras la actualización de WhatsApp Web de julio 2026
    // (github.com/wwebjs/whatsapp-web.js/issues/201845). No es recuperable
    // desde acá; avisamos a la UI y reintentamos con backoff.
    chatListRetries += 1;
    console.error(`[wa] getChats() falló (intento ${chatListRetries}):`, err.message || err);
    send('wa:chats-error', { attempt: chatListRetries });
    if (chatListRetries <= 8) {
      setTimeout(pushChatList, Math.min(5000 * chatListRetries, 30000));
    }
  }
}

function createClient() {
  loadChatNameCache();
  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(app.getPath('userData'), 'wwebjs_auth'),
    }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', async (qr) => {
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
    send('wa:qr', dataUrl);
  });

  // Bug real, encontrado el 2026-08-28: tras un 'authenticated' válido,
  // WhatsApp Web queda completamente cargado y sincronizado adentro de
  // Puppeteer (confirmado inspeccionando la página en vivo: chats reales,
  // socket CONNECTED, window.WWebJS ya inyectado) pero el evento 'ready' de
  // whatsapp-web.js nunca se dispara — se cuelga para siempre sin lanzar
  // ningún error, en algún punto interno entre 'authenticated' y el
  // 'ready' final de Client.js (mismo terreno que el bug de WhatsApp de
  // julio 2026 ya documentado en CLAUDE.md, pero bloqueando el propio
  // 'ready' en vez de getChats()/getChatById()). Reproducido 3 veces con
  // reinicios limpios, 5+ minutos de espera cada vez.
  // Mitigación: si 'ready' no llega SEGUNDOS_ESPERA_READY después de
  // 'authenticated', chequeamos a mano si WhatsApp Web ya está listo
  // adentro de la página (mismo chequeo que hace la librería) y si es así
  // completamos el enganche que la librería se salteó — attachEventListeners()
  // es idempotente (expone funciones "IfAbsent", no duplica nada si ya
  // estaban) — y disparamos 'ready' nosotros. client.info/client.interface
  // quedan sin poblar en este camino; no se usan en ningún lado de este
  // archivo, así que no rompen nada hoy, pero si en el futuro se necesita
  // alguno de los dos, hay que construirlos acá también.
  const SEGUNDOS_ESPERA_READY = 20;
  let readyFired = false;
  let readyWatchdogTimer = null;

  client.on('authenticated', () => {
    readyWatchdogTimer = setTimeout(async () => {
      if (readyFired) return;
      try {
        const wwebjsListo = await client.pupPage.evaluate(() => typeof window.WWebJS !== 'undefined');
        if (!wwebjsListo || readyFired) return;
        console.error(
          `[wa] 'ready' no llegó ${SEGUNDOS_ESPERA_READY}s después de 'authenticated' pese a que WhatsApp Web ya está sincronizado — forzando el enganche a mano (ver comentario en attachEventListeners más arriba).`
        );
        await client.attachEventListeners();
        if (!readyFired) client.emit('ready');
      } catch (err) {
        console.error('[wa] watchdog de ready falló:', err.message || err);
      }
    }, SEGUNDOS_ESPERA_READY * 1000);
  });

  client.on('ready', async () => {
    readyFired = true;
    if (readyWatchdogTimer) clearTimeout(readyWatchdogTimer);
    send('wa:status', 'ready');
    await pushChatList();
  });

  client.on('auth_failure', () => send('wa:status', 'auth_failure'));
  client.on('disconnected', () => send('wa:status', 'disconnected'));

  client.on('message', async (msg) => {
    send('wa:incoming', await serializeMessage(msg));
    pushChatList();
  });

  client.on('message_create', async (msg) => {
    if (msg.fromMe) {
      send('wa:incoming', await serializeMessage(msg));
      pushChatList();
    }
  });

  client.on('message_reaction', async (reaction) => {
    const messageId = normalizeId(reaction.msgId);
    if (!messageId) return;
    try {
      const msg = await client.getMessageById(messageId);
      send('wa:reactionUpdate', {
        messageId,
        chatId: msg.fromMe ? msg.to : msg.from,
        reactions: await getReactionsSummary(msg),
        // reaction.reaction viene vacío cuando se retira una reacción; en
        // ese caso no hay nada nuevo que avisar en la lista de chats.
        emoji: reaction.reaction || null,
      });
    } catch (err) {
      console.error('[wa] no se pudo refrescar reacciones:', err.message || err);
    }
  });

  client.initialize();
}

async function regenerateQr() {
  // client.destroy() cierra Puppeteer con browser.close() (cierre normal,
  // no un kill) antes de reemplazar el cliente — evita el mismo tipo de
  // corrupción de perfil que ya nos pasó factura con kills abruptos.
  try {
    if (client) await client.destroy();
  } catch (err) {
    console.error('[wa] destroy() falló al regenerar QR:', err.message || err);
  }
  chatListRetries = 0;
  emptyListRetries = 0;
  createClient();
  return { ok: true };
}

async function getMessages(chatId) {
  try {
    const chat = await client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: 50 });
    chat.sendSeen().catch(() => {});
    return { ok: true, messages: await Promise.all(msgs.map(serializeMessage)) };
  } catch (err) {
    console.error('[wa] getMessages() falló:', err.message || err);
    return { ok: false, messages: [] };
  }
}

async function sendMessage({ chatId, text, mentions, quotedMessageId }) {
  try {
    const options = {};
    if (mentions && mentions.length) options.mentions = mentions;
    if (quotedMessageId) options.quotedMessageId = quotedMessageId;
    await client.sendMessage(chatId, text, options);
    return { ok: true };
  } catch (err) {
    console.error('[wa] sendMessage() falló:', err.message || err);
    return { ok: false };
  }
}

async function sendImage({ chatId, base64, mimetype, filename, caption, quotedMessageId }) {
  try {
    const media = new MessageMedia(mimetype, base64, filename);
    const options = {};
    if (caption) options.caption = caption;
    if (quotedMessageId) options.quotedMessageId = quotedMessageId;
    await client.sendMessage(chatId, media, options);
    return { ok: true };
  } catch (err) {
    console.error('[wa] sendImage() falló:', err.message || err);
    return { ok: false };
  }
}

async function reactToMessage({ messageId, emoji }) {
  try {
    await client.sendReaction(messageId, emoji);
    return { ok: true };
  } catch (err) {
    console.error('[wa] reactToMessage() falló:', err.message || err);
    return { ok: false };
  }
}

async function downloadAttachment({ messageId }) {
  try {
    const msg = await client.getMessageById(messageId);
    if (!msg || !msg.hasMedia) return { ok: false };
    const media = await msg.downloadMedia();
    if (!media) return { ok: false };
    // whatsapp-web.js no siempre trae filename (sobre todo en fotos/videos
    // sacados directo desde la cámara) — armamos uno a partir del mimetype
    // en ese caso.
    const ext = media.mimetype ? media.mimetype.split('/')[1].split(';')[0] : '';
    const filename = media.filename || `whatsapp-adjunto-${messageId.slice(-8)}${ext ? `.${ext}` : ''}`;
    return { ok: true, base64: media.data, mimetype: media.mimetype, filename };
  } catch (err) {
    console.error('[wa] downloadAttachment() falló:', err.message || err);
    return { ok: false };
  }
}

async function getGroupParticipants(chatId) {
  try {
    const chat = await client.getChatById(chatId);
    if (!chat.isGroup) return { ok: true, participants: [] };
    const participants = await Promise.all(
      chat.participants.map(async (p) => ({
        id: p.id._serialized,
        name: await getContactName(p.id._serialized),
      }))
    );
    return { ok: true, participants };
  } catch (err) {
    console.error('[wa] getGroupParticipants() falló:', err.message || err);
    return { ok: false, participants: [] };
  }
}

function init(sendFn) {
  send = sendFn;
  createClient();
}

module.exports = {
  init,
  regenerateQr,
  getMessages,
  sendMessage,
  sendImage,
  reactToMessage,
  getGroupParticipants,
  downloadAttachment,
};
