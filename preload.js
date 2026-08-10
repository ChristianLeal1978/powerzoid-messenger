const { contextBridge, ipcRenderer } = require('electron');

const wa = {
  onQr: (cb) => ipcRenderer.on('wa:qr', (_e, dataUrl) => cb(dataUrl)),
  onStatus: (cb) => ipcRenderer.on('wa:status', (_e, status) => cb(status)),
  onChats: (cb) => ipcRenderer.on('wa:chats', (_e, chats) => cb(chats)),
  onChatsError: (cb) => ipcRenderer.on('wa:chats-error', (_e, payload) => cb(payload)),
  onChatsSyncing: (cb) => ipcRenderer.on('wa:chats-syncing', (_e, payload) => cb(payload)),
  onIncoming: (cb) => ipcRenderer.on('wa:incoming', (_e, msg) => cb(msg)),
  onReactionUpdate: (cb) => ipcRenderer.on('wa:reactionUpdate', (_e, payload) => cb(payload)),
  getMessages: (chatId) => ipcRenderer.invoke('wa:getMessages', chatId),
  sendMessage: (chatId, text, mentions) => ipcRenderer.invoke('wa:sendMessage', { chatId, text, mentions }),
  sendImage: (chatId, base64, mimetype, filename, caption) =>
    ipcRenderer.invoke('wa:sendImage', { chatId, base64, mimetype, filename, caption }),
  getGroupParticipants: (chatId) => ipcRenderer.invoke('wa:getGroupParticipants', chatId),
  reactToMessage: (messageId, emoji, chatId) => ipcRenderer.invoke('wa:reactToMessage', { messageId, emoji, chatId }),
  regenerateQr: () => ipcRenderer.invoke('wa:regenerateQr'),
};

const sl = {
  onStatus: (cb) => ipcRenderer.on('sl:status', (_e, status) => cb(status)),
  onChats: (cb) => ipcRenderer.on('sl:chats', (_e, chats) => cb(chats)),
  onChatsError: (cb) => ipcRenderer.on('sl:chats-error', (_e, payload) => cb(payload)),
  onIncoming: (cb) => ipcRenderer.on('sl:incoming', (_e, msg) => cb(msg)),
  onReactionUpdate: (cb) => ipcRenderer.on('sl:reactionUpdate', (_e, payload) => cb(payload)),
  getMessages: (chatId) => ipcRenderer.invoke('sl:getMessages', chatId),
  sendMessage: (chatId, text) => ipcRenderer.invoke('sl:sendMessage', { chatId, text }),
  sendImage: (chatId, base64, mimetype, filename, caption) =>
    ipcRenderer.invoke('sl:sendImage', { chatId, base64, mimetype, filename, caption }),
  getGroupParticipants: (chatId) => ipcRenderer.invoke('sl:getGroupParticipants', chatId),
  reactToMessage: (messageId, emoji, chatId) => ipcRenderer.invoke('sl:reactToMessage', { messageId, emoji, chatId }),
  connect: (botToken, appToken) => ipcRenderer.invoke('sl:connect', { botToken, appToken }),
  disconnect: () => ipcRenderer.invoke('sl:disconnect'),
};

contextBridge.exposeInMainWorld('api', { wa, sl });
