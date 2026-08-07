const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onQr: (cb) => ipcRenderer.on('wa:qr', (_e, dataUrl) => cb(dataUrl)),
  onStatus: (cb) => ipcRenderer.on('wa:status', (_e, status) => cb(status)),
  onChats: (cb) => ipcRenderer.on('wa:chats', (_e, chats) => cb(chats)),
  onChatsError: (cb) => ipcRenderer.on('wa:chats-error', (_e, payload) => cb(payload)),
  onChatsSyncing: (cb) => ipcRenderer.on('wa:chats-syncing', (_e, payload) => cb(payload)),
  onIncoming: (cb) => ipcRenderer.on('wa:incoming', (_e, msg) => cb(msg)),
  onReactionUpdate: (cb) => ipcRenderer.on('wa:reactionUpdate', (_e, payload) => cb(payload)),
  getMessages: (chatId) => ipcRenderer.invoke('wa:getMessages', chatId),
  sendMessage: (chatId, text, mentions) => ipcRenderer.invoke('wa:sendMessage', { chatId, text, mentions }),
  getGroupParticipants: (chatId) => ipcRenderer.invoke('wa:getGroupParticipants', chatId),
  reactToMessage: (messageId, emoji) => ipcRenderer.invoke('wa:reactToMessage', { messageId, emoji }),
});
