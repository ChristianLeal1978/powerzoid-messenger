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

## Bloqueador activo — revisar esto antes de asumir que algo "no sirve"
`whatsapp-web.js` tiene un bug abierto, real y no resuelto por mí, provocado
por un cambio de WhatsApp Web de julio 2026 (dejaron Webpack). Rompe
`Client.getChats()` y `Client.getChatById()` con un error opaco `r: r`.
Reportes: github.com/wwebjs/whatsapp-web.js/issues/201845, /201838, /201833.

Antes de gastar tiempo debugueando esto como si fuera nuestro código:
1. `npm view whatsapp-web.js version` y compara con lo instalado — puede
   haber salido un parche desde la última vez.
2. Revisa el estado de esos issues y de la PR #201832 (parche comunitario
   temporal, con su propio bug conocido de mensajes de grupo sin descifrar).
3. Si sigue roto, evaluar plan B: migrar a `@whiskeysockets/baileys`
   (librería alternativa que habla el protocolo multi-device directo por
   WebSocket, sin Puppeteer ni scraping del DOM — no debería sufrir este
   tipo de rotura). Es un cambio grande (reimplementar auth, sesión, envío,
   recepción), tratarlo como su propia tarea, no como parche rápido.

Ya está aplicado el único workaround real disponible del lado nuestro:
`serializeMessage()` en `main.js` no llama a `msg.getChat()` (dispara el
mismo bug); deriva el chatId de `msg.from`/`msg.to`, que ya vienen sin
necesitar otra consulta al Store.

## Prioridades, en orden
1. Confirmar que la ventana se posiciona bien en la sesión real (Wayland vía
   XWayland vs. X11 nativo — ver README). No se pudo probar en el entorno
   donde se generó este proyecto: no hay entorno gráfico ahí.
2. Resolver o mitigar el bloqueador de arriba.
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
