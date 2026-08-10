const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const https = require('https');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const WINDOW_WIDTH = 340; // ancho de la barra lateral. Ajusta a gusto.

let win;
let client;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: workArea.height,
    x: workArea.x,
    y: workArea.y,
    minWidth: 280,
    maxWidth: 480,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#12181b',
    title: 'WhatsApp Sidebar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- Nombres de contacto (autores en grupos) y fotos de perfil ---
// Cacheados en memoria por id: cambian poco durante una sesión y evitan
// repetir consultas al Store por cada mensaje/refresco de la lista.
const contactNameCache = new Map();
const avatarCache = new Map();

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

async function getReactionsSummary(msg) {
  if (!msg.hasReaction) return [];
  try {
    const list = await msg.getReactions();
    return (list || []).map((r) => ({ emoji: r.id, count: r.senders.length, byMe: r.hasReactionByMe }));
  } catch (err) {
    return [];
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
    hasMedia: msg.hasMedia,
    type: msg.type,
    sticker: msg.type === 'sticker' ? mediaDataUri : null,
    image: msg.type === 'image' ? mediaDataUri : null,
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
        .map(async (c) => ({
          id: c.id._serialized,
          name: c.name || c.id.user,
          isGroup: c.isGroup,
          unreadCount: c.unreadCount,
          lastMessage: c.lastMessage ? c.lastMessage.body : '',
          timestamp: c.timestamp,
          avatar: await getAvatar(c.id._serialized),
        }))
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

  client.on('ready', async () => {
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
}

ipcMain.handle('wa:regenerateQr', async () => {
  regenerateQr();
  return { ok: true };
});

ipcMain.handle('wa:getMessages', async (_e, chatId) => {
  try {
    const chat = await client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: 50 });
    chat.sendSeen().catch(() => {});
    return { ok: true, messages: await Promise.all(msgs.map(serializeMessage)) };
  } catch (err) {
    console.error('[wa] getMessages() falló:', err.message || err);
    return { ok: false, messages: [] };
  }
});

ipcMain.handle('wa:sendMessage', async (_e, { chatId, text, mentions }) => {
  try {
    await client.sendMessage(chatId, text, mentions && mentions.length ? { mentions } : {});
    return { ok: true };
  } catch (err) {
    console.error('[wa] sendMessage() falló:', err.message || err);
    return { ok: false };
  }
});

ipcMain.handle('wa:sendImage', async (_e, { chatId, base64, mimetype, filename, caption }) => {
  try {
    const media = new MessageMedia(mimetype, base64, filename);
    await client.sendMessage(chatId, media, caption ? { caption } : {});
    return { ok: true };
  } catch (err) {
    console.error('[wa] sendImage() falló:', err.message || err);
    return { ok: false };
  }
});

ipcMain.handle('wa:reactToMessage', async (_e, { messageId, emoji }) => {
  try {
    await client.sendReaction(messageId, emoji);
    return { ok: true };
  } catch (err) {
    console.error('[wa] reactToMessage() falló:', err.message || err);
    return { ok: false };
  }
});

ipcMain.handle('wa:getGroupParticipants', async (_e, chatId) => {
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
});

// Red de seguridad: si algo dentro de whatsapp-web.js rechaza una promesa
// que no atrapamos explícitamente, lo dejamos en el log en vez de que
// Electron lo derrame como warning sin control.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});

app.whenReady().then(() => {
  createWindow();
  createClient();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
