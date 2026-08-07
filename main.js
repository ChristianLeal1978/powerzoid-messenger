const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
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

  // Intenta mantenerse visible en todos los escritorios/espacios de trabajo.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function serializeMessage(msg) {
  // OJO: evitamos msg.getChat() a propósito. Internamente hace otra consulta
  // al Store (client.getChatById) que hoy está rota en whatsapp-web.js (ver
  // README, sección "Problema conocido"). El chatId ya viene en el propio
  // mensaje sin necesidad de esa consulta extra.
  return {
    id: msg.id._serialized,
    chatId: msg.fromMe ? msg.to : msg.from,
    fromMe: msg.fromMe,
    body: msg.body,
    timestamp: msg.timestamp,
    author: msg.author || null,
    hasMedia: msg.hasMedia,
    type: msg.type,
  };
}

let chatListRetries = 0;

async function pushChatList() {
  try {
    const chats = await client.getChats();
    chatListRetries = 0;
    const list = chats.slice(0, 60).map((c) => ({
      id: c.id._serialized,
      name: c.name || c.id.user,
      isGroup: c.isGroup,
      unreadCount: c.unreadCount,
      lastMessage: c.lastMessage ? c.lastMessage.body : '',
      timestamp: c.timestamp,
    }));
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

  client.on('message', (msg) => {
    send('wa:incoming', serializeMessage(msg));
    pushChatList();
  });

  client.on('message_create', (msg) => {
    if (msg.fromMe) {
      send('wa:incoming', serializeMessage(msg));
      pushChatList();
    }
  });

  client.initialize();
}

ipcMain.handle('wa:getMessages', async (_e, chatId) => {
  try {
    const chat = await client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: 50 });
    chat.sendSeen().catch(() => {});
    return { ok: true, messages: msgs.map(serializeMessage) };
  } catch (err) {
    console.error('[wa] getMessages() falló:', err.message || err);
    return { ok: false, messages: [] };
  }
});

ipcMain.handle('wa:sendMessage', async (_e, { chatId, text }) => {
  try {
    await client.sendMessage(chatId, text);
    return { ok: true };
  } catch (err) {
    console.error('[wa] sendMessage() falló:', err.message || err);
    return { ok: false };
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
