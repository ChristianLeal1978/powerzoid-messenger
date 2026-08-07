const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onQr: (cb) => ipcRenderer.on('wa:qr', (_e, dataUrl) => cb(dataUrl)),
  onStatus: (cb) => ipcRenderer.on('wa:status', (_e, status) => cb(status)),
  onChats: (cb) => ipcRenderer.on('wa:chats', (_e, chats) => cb(chats)),
  onChatsError: (cb) => ipcRenderer.on('wa:chats-error', (_e, payload) => cb(payload)),
  onIncoming: (cb) => ipcRenderer.on('wa:incoming', (_e, msg) => cb(msg)),
  getMessages: (chatId) => ipcRenderer.invoke('wa:getMessages', chatId),
  sendMessage: (chatId, text) => ipcRenderer.invoke('wa:sendMessage', { chatId, text }),
});
