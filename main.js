const { app, BrowserWindow, ipcMain, screen, safeStorage, dialog, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const whatsapp = require('./whatsapp');
const slack = require('./slack');

const WINDOW_WIDTH = 340; // ancho de la barra lateral. Ajusta a gusto.

// La ventana ya no queda pegada al borde izquierdo (x=0): tapaba/quedaba
// tapada por el dash de GNOME (el dock vertical de la izquierda, a veces
// llamado "menú de Fedora"). Estos márgenes la corren después del dock y le
// dejan aire arriba/abajo. Son valores a ojo del ancho típico del dash —
// ajústalos acá si en tu escritorio el dock queda más ancho/angosto o si
// querés más/menos aire.
const WINDOW_LEFT_MARGIN = 76; // deja libre el dash de GNOME a la izquierda
const WINDOW_TOP_MARGIN = 16; // margen extra bajo la barra superior de GNOME
const WINDOW_BOTTOM_MARGIN = 24; // no llega hasta el borde inferior de la pantalla

// skipTaskbar la deja sin ícono en el dock/taskbar, así que sin este atajo
// no habría forma de traerla de vuelta después de ocultarla.
const TOGGLE_VISIBILITY_SHORTCUT = 'Control+Alt+W';

let win;

// Bounds originales (posición anclada + tamaño de barra) guardados mientras
// el modo teatro está expandido a pantalla completa; null cuando no lo está.
// Sirve también de guarda para no pisar el guardado si el renderer llama a
// expandir dos veces seguidas (ej. dos imágenes abiertas rápido).
let savedBoundsForLightbox = null;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: workArea.height - WINDOW_TOP_MARGIN - WINDOW_BOTTOM_MARGIN,
    x: workArea.x + WINDOW_LEFT_MARGIN,
    y: workArea.y + WINDOW_TOP_MARGIN,
    minWidth: 280,
    maxWidth: 480,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: '#12181b',
    title: 'Powerzoid Messenger',
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

// La carpeta del último adjunto guardado, para que el diálogo abra ahí la
// próxima vez en vez de volver siempre a la carpeta de descargas por
// defecto del sistema. Un archivo aparte y no algo dentro de las
// credenciales de Slack porque esto es transversal a ambos proveedores.
function lastDownloadDirPath() {
  return path.join(app.getPath('userData'), 'last-download-dir.json');
}

function loadLastDownloadDir() {
  try {
    return JSON.parse(fs.readFileSync(lastDownloadDirPath(), 'utf8')).dir || null;
  } catch (err) {
    return null; // sin archivo, corrupto, o primera vez
  }
}

function saveLastDownloadDir(dir) {
  try {
    fs.writeFileSync(lastDownloadDirPath(), JSON.stringify({ dir }));
  } catch (err) {
    console.error('[main] no se pudo guardar la última carpeta de descargas:', err.message || err);
  }
}

// Extensión -> mimetype para los archivos que se pueden adjuntar. Cubre lo
// mismo que aceptaba el <input type="file"> que reemplazó
// ui:selectAttachment (ver más abajo): imágenes comunes + PDF/DOC/DOCX.
const ATTACHMENT_MIMETYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

async function saveAttachmentToDisk(base64, filename) {
  const lastDir = loadLastDownloadDir();
  const defaultPath = lastDir ? path.join(lastDir, filename) : filename;
  // Sin `win` como parent: la ventana vive angosta y corrida hacia la
  // izquierda (ver WINDOW_LEFT_MARGIN arriba), así que un diálogo nativo
  // centrado sobre ella queda con la mitad izquierda fuera de pantalla. Sin
  // parent, GTK lo centra en la pantalla completa en vez de sobre la
  // ventana.
  const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    saveLastDownloadDir(path.dirname(filePath));
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

// --- IPC: modo teatro (imágenes) ---
// La ventana vive anclada al borde izquierdo con un ancho fijo angosto
// (WINDOW_WIDTH, además limitado por maxWidth). Un <img> con
// position:fixed;inset:0 solo llena esa ventana angosta, no la pantalla —
// para que una imagen realmente se vea "a pantalla completa" hay que
// expandir la ventana misma mientras dura el modo teatro y devolverla a su
// tamaño/posición de barra al cerrar.
ipcMain.handle('win:expandForLightbox', () => {
  if (!win || win.isDestroyed()) return { ok: false };
  if (savedBoundsForLightbox) return { ok: true }; // ya expandida
  savedBoundsForLightbox = { bounds: win.getBounds(), maxSize: win.getMaximumSize() };
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  win.setMaximumSize(workArea.width, workArea.height);
  win.setBounds(workArea);
  return { ok: true };
});

ipcMain.handle('win:collapseFromLightbox', () => {
  if (!win || win.isDestroyed() || !savedBoundsForLightbox) return { ok: false };
  const { bounds, maxSize } = savedBoundsForLightbox;
  win.setBounds(bounds);
  win.setMaximumSize(maxSize[0], maxSize[1]);
  savedBoundsForLightbox = null;
  return { ok: true };
});

// --- IPC: abrir links en el navegador por defecto ---
// Los links vienen de texto de mensajes (WhatsApp/Slack), o sea de
// contenido ajeno — solo se abren esquemas http/https, nunca file:// ni
// esquemas custom que podrían invocar otra app instalada sin que el
// usuario lo pidiera.
ipcMain.handle('ui:openExternal', (_e, url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false };
  } catch (err) {
    return { ok: false };
  }
  shell.openExternal(url);
  return { ok: true };
});

// --- IPC: elegir archivo para adjuntar ---
// Antes esto era un <input type="file"> en el renderer: Chromium abre el
// selector nativo parenteado a `win`, y como la ventana quedó angosta y
// corrida hacia la izquierda (ver WINDOW_LEFT_MARGIN), el diálogo centrado
// sobre ella salía con la mitad izquierda fuera de pantalla (bug real,
// reportado por el usuario). Usar dialog.showOpenDialog() sin `win` como
// parent lo centra en la pantalla completa en vez de sobre la ventana.
ipcMain.handle('ui:selectAttachment', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Imágenes y documentos', extensions: Object.keys(ATTACHMENT_MIMETYPES).map((ext) => ext.slice(1)) },
    ],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const filePath = filePaths[0];
  const mimetype = ATTACHMENT_MIMETYPES[path.extname(filePath).toLowerCase()];
  if (!mimetype) return { ok: false }; // extensión fuera del filtro (ej. eligió "Todos los archivos")
  try {
    const base64 = fs.readFileSync(filePath).toString('base64');
    return { ok: true, base64, mimetype, filename: path.basename(filePath) };
  } catch (err) {
    console.error('[main] no se pudo leer el archivo adjunto:', err.message || err);
    return { ok: false };
  }
});

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
ipcMain.handle('sl:searchChannels', (_e, query) => slack.searchChannels(query));
ipcMain.handle('sl:openChannel', (_e, channelId) => slack.openChannel(channelId));
ipcMain.handle('sl:unpinChannel', (_e, channelId) => slack.unpinChannel(channelId));
ipcMain.handle('sl:downloadAttachment', async (_e, payload) => {
  const res = await slack.downloadAttachment(payload);
  return res.ok ? saveAttachmentToDisk(res.base64, res.filename) : res;
});

ipcMain.handle('sl:connect', async (_e, { userToken, appToken }) => {
  const res = await slack.connect({ userToken, appToken });
  if (res.ok) saveSlackCredentials({ userToken, appToken });
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
    if (creds && creds.userToken && creds.appToken) {
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
