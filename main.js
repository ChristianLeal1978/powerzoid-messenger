const { app, BrowserWindow, ipcMain, screen, safeStorage, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const whatsapp = require('./whatsapp');
const slack = require('./slack');

const WINDOW_WIDTH = 340; // ancho de la barra lateral. Ajusta a gusto.

// skipTaskbar la deja sin ícono en el dock/taskbar, así que sin este atajo
// no habría forma de traerla de vuelta después de ocultarla.
const TOGGLE_VISIBILITY_SHORTCUT = 'Control+Alt+W';

let win;

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
    skipTaskbar: true,
    backgroundColor: '#12181b',
    title: 'WhatsApp Sidebar',
    icon: path.join(__dirname, 'assets', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function toggleVisibility() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- Descargar adjuntos ---
// Común a wa:downloadAttachment y sl:downloadAttachment: cada módulo trae
// el archivo (base64) desde su proveedor; acá solo se pregunta dónde
// guardarlo y se escribe a disco.
async function saveAttachmentToDisk(base64, filename) {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: filename });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { ok: true, path: filePath };
  } catch (err) {
    console.error('[main] no se pudo guardar el adjunto:', err.message || err);
    return { ok: false };
  }
}

// --- Credenciales de Slack ---
// Guardadas en el mismo espíritu que wwebjs_auth: localmente, en
// userData, sin tocar ningún servidor propio. Se cifran con safeStorage
// (usa el keyring del sistema — en GNOME, gnome-keyring) cuando está
// disponible. Si no lo está (puede pasar en Linux sin keyring corriendo),
// caemos a texto plano con una advertencia en vez de romper el flujo,
// siguiendo el mismo patrón "{ ok, ... } en vez de lanzar" del resto de la
// app.
function slackCredentialsPath() {
  return path.join(app.getPath('userData'), 'slack-credentials.json');
}

function loadSlackCredentials() {
  try {
    const raw = fs.readFileSync(slackCredentialsPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data.encrypted) return data.payload;
    if (!safeStorage.isEncryptionAvailable()) return null; // cifrado, pero ya no hay cómo descifrarlo
    return JSON.parse(safeStorage.decryptString(Buffer.from(data.payload, 'base64')));
  } catch (err) {
    return null; // sin archivo, corrupto, o primera vez
  }
}

function saveSlackCredentials(creds) {
  const canEncrypt = safeStorage.isEncryptionAvailable();
  if (!canEncrypt) {
    console.error('[sl] safeStorage no disponible: guardando tokens de Slack en texto plano.');
  }
  const data = {
    encrypted: canEncrypt,
    payload: canEncrypt ? safeStorage.encryptString(JSON.stringify(creds)).toString('base64') : creds,
  };
  fs.writeFileSync(slackCredentialsPath(), JSON.stringify(data), { mode: 0o600 });
}

function clearSlackCredentials() {
  try {
    fs.unlinkSync(slackCredentialsPath());
  } catch (err) {
    // ya no había nada guardado
  }
}

// --- IPC: WhatsApp ---
ipcMain.handle('wa:regenerateQr', () => whatsapp.regenerateQr());
ipcMain.handle('wa:getMessages', (_e, chatId) => whatsapp.getMessages(chatId));
ipcMain.handle('wa:sendMessage', (_e, payload) => whatsapp.sendMessage(payload));
ipcMain.handle('wa:sendImage', (_e, payload) => whatsapp.sendImage(payload));
ipcMain.handle('wa:reactToMessage', (_e, payload) => whatsapp.reactToMessage(payload));
ipcMain.handle('wa:getGroupParticipants', (_e, chatId) => whatsapp.getGroupParticipants(chatId));
ipcMain.handle('wa:downloadAttachment', async (_e, payload) => {
  const res = await whatsapp.downloadAttachment(payload);
  return res.ok ? saveAttachmentToDisk(res.base64, res.filename) : res;
});

// --- IPC: Slack ---
ipcMain.handle('sl:getMessages', (_e, chatId) => slack.getMessages(chatId));
ipcMain.handle('sl:sendMessage', (_e, payload) => slack.sendMessage(payload));
ipcMain.handle('sl:sendImage', (_e, payload) => slack.sendImage(payload));
ipcMain.handle('sl:reactToMessage', (_e, payload) => slack.reactToMessage(payload));
ipcMain.handle('sl:getGroupParticipants', (_e, chatId) => slack.getGroupParticipants(chatId));
ipcMain.handle('sl:searchUsers', (_e, query) => slack.searchUsers(query));
ipcMain.handle('sl:openDirectMessage', (_e, userId) => slack.openDirectMessage(userId));
ipcMain.handle('sl:downloadAttachment', async (_e, payload) => {
  const res = await slack.downloadAttachment(payload);
  return res.ok ? saveAttachmentToDisk(res.base64, res.filename) : res;
});

ipcMain.handle('sl:connect', async (_e, { botToken, appToken, myUserId }) => {
  const res = await slack.connect({ botToken, appToken, myUserId });
  if (res.ok) saveSlackCredentials({ botToken, appToken, myUserId });
  return res;
});

ipcMain.handle('sl:disconnect', () => {
  slack.disconnect();
  clearSlackCredentials();
  return { ok: true };
});

// Red de seguridad: si algo dentro de whatsapp-web.js o del cliente de
// Slack rechaza una promesa que no atrapamos explícitamente, lo dejamos en
// el log en vez de que Electron lo derrame como warning sin control.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});

app.whenReady().then(() => {
  createWindow();
  whatsapp.init(send);
  slack.init(send);

  const registered = globalShortcut.register(TOGGLE_VISIBILITY_SHORTCUT, toggleVisibility);
  if (!registered) {
    console.error(`[main] no se pudo registrar el atajo global ${TOGGLE_VISIBILITY_SHORTCUT} (¿ya está tomado por otra app?)`);
  }

  // Esperamos a que el renderer termine de cargar (y registre sus
  // listeners onStatus) antes de mandar el primer estado de Slack — a
  // diferencia de WhatsApp (cuyo 'ready' tarda varios segundos por el
  // arranque de Puppeteer y nunca compite con la carga del renderer), una
  // reconexión con credenciales ya guardadas puede resolver en menos de un
  // segundo y perder la carrera contra did-finish-load.
  win.webContents.once('did-finish-load', () => {
    const creds = loadSlackCredentials();
    if (creds && creds.botToken && creds.appToken) {
      send('sl:status', 'connecting');
      slack.connect(creds);
    } else {
      send('sl:status', 'not-configured');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
