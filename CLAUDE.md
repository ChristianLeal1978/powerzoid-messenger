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

## Pestaña de Slack (agregada 2026-08-10)

Segunda pestaña arriba de todo, repite la misma figura de WhatsApp (lista
arriba, conversación abajo) sobre datos reales de Slack — no es una
maqueta. `main.js` quedó como orquestador delgado; la lógica de cada
proveedor vive en `whatsapp.js` y `slack.js`, ambos con la misma interfaz
(`init`, `getMessages`, `sendMessage`, `sendImage`, `reactToMessage`,
`getGroupParticipants`) y ambos normalizando sus mensajes/chats a la misma
forma genérica, para que `renderer/renderer.js` no necesite saber cuál de
los dos está activo salvo en un puñado de puntos (título, mapeo de
menciones, qué `window.api.*` llamar).

- **Conexión:** Socket Mode (`@slack/socket-mode` + `@slack/web-api`), no
  OAuth con redirect — el usuario genera un token de usuario (`xoxp-`) y un
  app-level token (`xapp-`) a mano siguiendo el manifiesto en README.md,
  sección "Conectar Slack", y los pega en la pantalla de emparejamiento
  (equivalente al QR de WhatsApp).
- **Token de usuario, no de bot (cambiado 2026-08-13):** al principio
  `slack.js` leía con un token de bot (`xoxb-`). Con eso,
  `conversations.list`/`.history` solo devuelven conversaciones donde el
  *bot* es miembro — un colega tendría que escribirle al bot directamente
  para aparecer acá, lo cual hacía la barra inútil como espejo del Slack
  real del usuario (bug real, reportado por el usuario: un mensaje de un
  colega nunca aparecía, ni en vivo ni reintentando). El fix fue cambiar a
  un token de usuario (`xoxp-`, scopes bajo `oauth_config.scopes.user` en
  el manifiesto, eventos bajo `event_subscriptions.user_events` en vez de
  `bot_events`) — así la API ve los mismos DMs/canales que el usuario, sin
  que nadie tenga que invitar ni escribirle a nada. El `bot_user` del
  manifiesto se mantiene solo porque Slack lo exige para emitir el
  app-level token; no se usa para leer ni escribir. `myUserId` en
  `slack.js` ya no viene de un campo que el usuario llena a mano — se
  resuelve solo de `auth.test()` al conectar, porque el token ya es el
  suyo.
- **Credenciales:** guardadas en `~/.config/whatsapp-sidebar/slack-credentials.json`,
  cifradas con `safeStorage` de Electron cuando el keyring del sistema está
  disponible; si no, caen a texto plano con una advertencia en consola
  (`main.js`, `saveSlackCredentials()`) — no bloquea el arranque.
- **Limitaciones conocidas, no bugs a "arreglar" sin avisar primero:** sin
  hilos (todo se postea plano al canal), sin conteo real de no-leídos (la
  Web API no lo expone simple ni con token de usuario — se usa el mismo
  aviso de reacciones para no dejarlo pasar en silencio), y el picker de
  reacciones
  solo cubre el set fijo de emojis que ya usaba WhatsApp (mapeado a
  shortcodes de Slack en `slack.js`, `EMOJI_TO_SLACK`) — reaccionar con
  otro emoji no está soportado desde acá.
- Igual que con whatsapp-web.js: aplica el mismo criterio de mutex/cooldown
  en `pushChatList()`/`getAvatar()` de `slack.js` que ya existía para
  WhatsApp (ver comentarios ahí) — Slack también rate-limita por método, y
  Socket Mode dispara un evento por mensaje.
- **`conversations.list` pagina todo el workspace** (`listAllConversations()`
  en `slack.js`) — en un workspace grande devuelve TODOS los canales
  públicos, no solo los del usuario, así que sin paginar los canales del
  usuario podían quedar fuera de la primera página (bug real, encontrado y
  corregido 2026-08-10). La membresía resultante se cachea 5 minutos
  (`getMemberChannels()`) para no repetir esa paginación en cada mensaje —
  pero eso significaba que un canal nuevo (primer DM de alguien, invitación
  a un canal) no aparecía hasta que venciera el cooldown (otro bug real,
  mismo día): el handler de `message` en `wireSocketEvents()` ahora fuerza
  un refresco cuando el canal del mensaje no está en la membresía ya
  conocida, coalescido con `memberChannelsRefreshPromise` para no disparar
  paginaciones paralelas si llegan varios canales nuevos a la vez.
- **`pushChatListOnce()` solo backfillea DMs 1:1 al conectar; canales y
  mpim entran solo con actividad en vivo** (`slack.js`) — bug real y
  decisión de producto, ambos encontrados/tomados 2026-08-13 al pasar a
  token de usuario. Historia completa:
  1. Con token de bot la membresía era un puñado de canales invitados a
     mano. Con token de usuario es toda la membresía real — caso real
     visto en vivo: **725** conversaciones.
  2. Pedirle a Slack el último mensaje de las 725 con `Promise.all` (o
     incluso con concurrencia limitada tipo pool de 8) las manda en
     ráfaga, Slack rate-limita casi todas a la vez, y como reintentan al
     mismo `retry-after` nunca converge (loop de rate limit infinito,
     visto en vivo). Primer fix: `mapSequentialWithDelay()` (de a una,
     `HISTORY_FETCH_DELAY_MS` = 300ms de pausa) más un tope
     (`UNKNOWN_HISTORY_FETCH_CAP` = 80) sobre cuántas conversaciones
     *nunca vistas* se piden por refresco — arregló el rate limit, pero
     no alcanzaba solo: el orden que devuelve `conversations.list` no es
     por actividad, así que los primeros 80 en salir eran básicamente al
     azar.
  3. Con ese primer fix funcionando, el usuario reportó ver puros `mpdm-`
     (mensajes directos de grupo) con nombres crudos e ilegibles, varios
     con gente desactivada hace años — de los 725, la abrumadora mayoría
     eran mpim viejos y muertos, no DMs 1:1 ni nada reciente. El usuario
     solo quiere ver DMs 1:1 (siempre) y lo que efectivamente le llega en
     vivo, mencionándolo o no. Fix final: **canales normales y mpim ya no
     se backfillean nunca** — solo entran a la lista cuando llega un
     mensaje real durante la sesión (`wireSocketEvents()` ya cachea el
     body del evento sin pedir historial) o si ya estaban en
     `lastMessageCache` de esta misma sesión. Los DMs 1:1 sí siguen
     backfilleándose al conectar (con el mismo tope, por si también son
     muchos), porque esos el usuario los quiere ver siempre, tengan
     actividad reciente o no.
  4. Los mpim también tenían el nombre roto: Slack no les da nombre
     propio, el campo `name` es el slug interno crudo
     (`mpdm-fulano--mengano--zutano-1`). `getMpimName()` lo resuelve a
     los nombres reales de los participantes (vía `conversations.members`
     + `getUserInfo()`, cacheado en `mpimNameCache`) — solo importa ahora
     para los mpim que sí entran por actividad en vivo, no para los 725.
  5. Con el tope puesto, seguía sin verse la actualización en vivo: le
     respondían a un DM ya conocido y la lista no se movía de lugar ni
     cambiaba el preview (bug real, encontrado y corregido el mismo día).
     La causa: `mapSequentialWithDelay()` aplicaba la pausa de
     `HISTORY_FETCH_DELAY_MS` (300ms) entre **todos** los ítems de
     `pushChatListOnce()`, no solo entre los que de verdad pegan contra
     `conversations.history` — con 154 DMs ya cacheados (que no piden nada,
     `resolveConversationMeta()` corta por `lastMessageCache`), eso son
     ~46s de demora artificial antes de mandar la lista, en cada mensaje
     entrante. Fix: lo ya conocido (`knownIms`/`knownRest`) se resuelve en
     paralelo sin pausa; la pausa secuencial solo aplica al lote de
     conversaciones nunca vistas (`toFetchNow`, con el tope de arriba).
- **Filtro opcional de menciones:** checkbox en la pantalla de
  emparejamiento (`mentionFilter`, guardado en las credenciales). Cuando
  está prendido, `pushChatListOnce()` en `slack.js` deja afuera los
  canales/mpim cuyo último mensaje no menciona directamente al usuario
  (`<@ID>` crudo, vía `textMentionsUser()`, contra el `myUserId` resuelto
  de `auth.test()`); los DMs 1:1 siempre se muestran. Apagado por default
  (comportamiento sin filtrar). Ojo: desde el punto anterior, esto solo
  importa para canales/mpim que ya entraron a la lista por actividad en
  vivo — los que nunca se backfillean tampoco pasan por este filtro, ni
  falta que hace. Mira solo el último mensaje de cada canal, no todo el
  historial reciente (ver limitación en README).

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
