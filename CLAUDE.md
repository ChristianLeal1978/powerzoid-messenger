# CLAUDE.md

## Qué es esto
Barra lateral de WhatsApp para Linux (Fedora/GNOME), en Electron +
whatsapp-web.js. Una sola columna: lista de chats arriba, conversación abajo.
Vive anclada al borde izquierdo de la pantalla (x=0, ancho fijo, alto completo).

## Cómo correrla
```
npm install && npm start
```
Primera vez: escanear el QR desde el teléfono. La sesión queda guardada en
`~/.config/whatsapp-sidebar/wwebjs_auth`.

## Bloqueador — mitigado con un parche comunitario no oficial (2026-08-07)
`whatsapp-web.js` tuvo (tiene, en npm) un bug abierto, real y no resuelto por
mí, provocado por un cambio de WhatsApp Web de julio 2026 (dejaron Webpack).
Rompe `Client.getChats()` y `Client.getChatById()` con un error opaco `r: r`.
Reportes: github.com/wwebjs/whatsapp-web.js/issues/201845, /201838, /201833
— **todos seguían abiertos** al aplicar el parche, y la versión de npm
(`1.34.7`) seguía siendo la misma que tenía el bug.

`package.json` ya no apunta a npm para esta dependencia: apunta al fork con
el parche de la PR #201832, fijado a un commit concreto:
```
"whatsapp-web.js": "github:wwebjs/whatsapp-web.js#f4ea1e3cf4076e44e36dfe5f81ea57048d2f7761"
```
Probado en vivo (2026-08-07): `getChats()` y `getChatById()` funcionan,
la lista de chats carga y las conversaciones se abren con historial.
Caveat conocido y no verificado por mí: el autor del parche reportó mensajes
de grupo que no descifran bien en el teléfono principal — vigilar eso si se
usan chats de grupo.

Antes de asumir que este parche sigue haciendo falta o de tocar esto:
1. `npm view whatsapp-web.js version` — si ya alcanzó o superó lo que trae
   el parche, evaluar volver a la versión oficial de npm.
2. Revisa el estado de esos issues y de la PR #201832 — si se mergeó, volver
   a `"whatsapp-web.js": "^1.x.x"` apuntando a npm.
3. Si en algún momento este tipo de parche deja de alcanzar, evaluar plan B:
   migrar a `@whiskeysockets/baileys` (librería alternativa que habla el
   protocolo multi-device directo por WebSocket, sin Puppeteer ni scraping
   del DOM). Es un cambio grande (reimplementar auth, sesión, envío,
   recepción), tratarlo como su propia tarea, no como parche rápido.

Se mantiene además el workaround del lado nuestro: `serializeMessage()` en
`main.js` no llama a `msg.getChat()` (dispara el mismo bug); deriva el
chatId de `msg.from`/`msg.to`, que ya vienen sin necesitar otra consulta al
Store.

## Prioridades, en orden
1. ~~Confirmar que la ventana se posiciona bien en la sesión real~~ — hecho
   el 2026-08-07: en GNOME/Wayland vía XWayland, la ventana queda en x=0,
   ancho 340px, alto = pantalla menos la barra superior (y=32 por el panel
   de GNOME, no un bug). No probado todavía en GNOME on Xorg nativo.
2. ~~Resolver o mitigar el bloqueador de arriba~~ — mitigado el 2026-08-07
   con el parche comunitario (ver sección de arriba). No es una solución
   definitiva: sigue pendiente de un fix oficial mergeado.
3. Reservar espacio de pantalla como un panel real (`_NET_WM_STRUT_PARTIAL`
   vía X11) para que otras ventanas no se monten encima.
4. Notificaciones nativas, soporte de medios, atajo para mostrar/ocultar.

## Convenciones del proyecto
- Sin build step: el renderer es HTML/CSS/JS plano, cargado directo por
  Electron. No introducir bundlers salvo que se vuelva imprescindible.
- IPC: todo pasa por `preload.js` -> `contextBridge`. No activar
  `nodeIntegration`.
- Paleta y tipografía en `renderer/styles.css` (`:root`). Si se rediseña
  algo, no volver a los defaults genéricos de IA (cream+serif o
  dark+acid-green); mantener la dirección ya tomada (jade/ámbar, IBM Plex
  Sans/Mono).
- Los handlers de `main.js` devuelven `{ ok, ... }` en vez de lanzar, para
  que el renderer muestre estado en vez de crashear. Mantener ese patrón al
  agregar funciones nuevas.

## Contexto completo
Ver `README.md`: instalación, anclaje al borde, autostart, personalización,
detalle completo del bug conocido.
