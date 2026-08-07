# WhatsApp Sidebar

Barra lateral vertical de WhatsApp para Linux, pensada para vivir anclada en el
borde izquierdo del escritorio: una sola columna, con la lista de chats arriba
y la conversación seleccionada abajo, en la misma columna.

Es un proyecto inicial funcional, no un producto terminado — pensado para que
lo probemos y lo ajustemos juntos.

## Cómo funciona

- **Electron** crea la ventana sin bordes, angosta (340px por defecto), pegada
  a `x=0, y=0` y con el alto de la pantalla.
- **whatsapp-web.js** controla una sesión real de WhatsApp Web en segundo
  plano (usa su propio Chromium vía Puppeteer) y expone chats/mensajes como
  eventos, que el proceso principal reenvía al renderer por IPC.
- El renderer es HTML/CSS/JS plano: no hay build step.

## Funcionalidades

- **Autor en mensajes de grupo:** se resuelve el nombre de quien escribió
  cada mensaje ajeno vía `client.getContactById()`, cacheado en memoria
  (`contactNameCache` en `main.js`). Los mensajes propios nunca muestran
  autor, aunque WhatsApp también rellena `msg.author` en esos casos.
- **Fotos de perfil:** se piden con `client.getProfilePicUrl()` y se
  descargan a `data:` URI en el proceso principal (`getAvatar()` en
  `main.js`), cacheadas por chat — así el CSP del renderer (`img-src 'self'
  data:`) no necesita permitir dominios externos. Si un contacto no tiene
  foto o la privacidad la bloquea, cae a las iniciales de siempre.
- **Campo de escritura:** crece con el texto (hasta 120px) y Enter envía;
  Shift+Enter agrega salto de línea.
- **Menciones (@) en grupos:** al escribir `@` se ofrece autocompletar con
  los participantes del grupo (`wa:getGroupParticipants` en `main.js`).
  Internamente el texto lleva `@<número>` (formato que WhatsApp requiere
  para reconocer la mención) aunque el chat lo muestre como "@Nombre".
- **Picker de emojis:** set fijo de emojis Unicode en `renderer.js`
  (`EMOJIS`), sin librería externa.

## Instalación (Fedora)

```bash
cd whatsapp-sidebar
npm install
npm start
```

La primera vez se abrirá con un código QR — escanéalo desde tu teléfono en
**WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo**.
La sesión queda guardada localmente (`~/.config/whatsapp-sidebar/wwebjs_auth`),
así que no tendrás que volver a escanear en cada inicio.

> `whatsapp-web.js` descarga Chromium al hacer `npm install` (puede tardar
> unos minutos la primera vez).

## Problema conocido (agosto 2026): `r: r` al cargar chats o mensajes

Bug real, abierto y activo en `whatsapp-web.js` mismo (no de este proyecto),
provocado por un cambio que WhatsApp Web hizo en julio de 2026 (dejaron de
usar Webpack y renombraron cómo se serializan los IDs internos). Rompe
`Client.getChats()`, `Client.getChatById()` y `Message.downloadMedia()` para
prácticamente todo el mundo que usa la librería, no solo acá.

Reportes relevantes en el repo oficial (`wwebjs/whatsapp-web.js`), todos
seguían **abiertos** al 2026-08-07:
- [#201845](https://github.com/wwebjs/whatsapp-web.js/issues/201845) — `getChats()`/`getState()` lanzan `r: r`.
- [#201838](https://github.com/wwebjs/whatsapp-web.js/issues/201838) — mismo error en `getChatById()`.
- [#201833](https://github.com/wwebjs/whatsapp-web.js/issues/201833) — mismo error al descargar medios.
- [#201832](https://github.com/wwebjs/whatsapp-web.js/pull/201832) — parche temporal de la comunidad, tampoco mergeado todavía.

**Estado actual: mitigado.** Este proyecto usa desde el 2026-08-07 el fork
con el parche de la PR #201832, fijado en `package.json`:
```
"whatsapp-web.js": "github:wwebjs/whatsapp-web.js#f4ea1e3cf4076e44e36dfe5f81ea57048d2f7761"
```
Probado en vivo: la lista de chats carga y las conversaciones abren su
historial normalmente. Caveat conocido (reportado por el autor del parche,
no verificado acá): los mensajes de grupo podrían no descifrar bien en el
teléfono principal — si notas eso en un chat de grupo, avisa.

Además, ya está aplicado en el código el workaround de nuestro lado: dejé de
llamar a `msg.getChat()` en cada mensaje entrante (esa llamada también
dispara el bug) y derivo el chat directamente de los datos que ya trae el
mensaje.

Cuando la PR #201832 se mergee o salga un release oficial que la incluya,
conviene volver a `"whatsapp-web.js": "^1.x.x"` apuntando a npm en vez de al
fork — revisa [github.com/wwebjs/whatsapp-web.js/releases](https://github.com/wwebjs/whatsapp-web.js/releases)
de vez en cuando.

## Sobre el anclaje al borde (importante)

Fedora Workstation trae **GNOME sobre Wayland** por defecto. Bajo Wayland
nativo, ninguna aplicación puede fijar su propia posición en pantalla — eso lo
decide el compositor, por diseño y por seguridad. Electron, sin embargo, se
ejecuta por defecto vía **XWayland**, y ahí sí funciona `x/y` como cualquier
ventana X11 normal, que es lo que usa este proyecto. En la práctica, para la
mayoría debería posicionarse correctamente sin hacer nada más.

Si notas que la ventana no queda pegada al borde:

- Prueba forzar XWayland explícitamente: `npm start -- --ozone-platform=x11`.
- O inicia sesión en **GNOME on Xorg** (selector de sesión en la pantalla de
  login) — ahí el posicionamiento es 100% confiable.

**Una limitación real:** esta primera versión deja la ventana *encima* de
otras (`alwaysOnTop`), pero no reserva el espacio como lo hace un panel/dock
real (para que otras ventanas no se superpongan). Eso requiere hablarle a las
hints `_NET_WM_STRUT_PARTIAL` de X11, que Electron no expone de forma nativa.
Es un paso 2 razonable si te sirve el resultado de esta primera versión: se
puede resolver con un pequeño binario auxiliar en C o con `xdotool`/`wmctrl`
después de crear la ventana.

## Iniciar automáticamente al iniciar sesión

Crea `~/.config/autostart/whatsapp-sidebar.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=WhatsApp Sidebar
Exec=/ruta/absoluta/a/whatsapp-sidebar/node_modules/.bin/electron /ruta/absoluta/a/whatsapp-sidebar
X-GNOME-Autostart-enabled=true
```

## Acceso desde el lanzador de aplicaciones (GNOME)

El proyecto trae un ícono propio en `assets/icon.svg` (y variantes `.png` ya
generadas en varios tamaños). Para que aparezca junto al resto de tus apps:

```bash
# 1. Instalar el ícono en el tema de iconos del usuario
for size in 16 32 48 64 128 256 512; do
  mkdir -p ~/.local/share/icons/hicolor/${size}x${size}/apps
  cp assets/icon-${size}.png ~/.local/share/icons/hicolor/${size}x${size}/apps/whatsapp-sidebar.png
done
mkdir -p ~/.local/share/icons/hicolor/scalable/apps
cp assets/icon.svg ~/.local/share/icons/hicolor/scalable/apps/whatsapp-sidebar.svg
gtk-update-icon-cache -f -t ~/.local/share/icons/hicolor

# 2. Crear el lanzador (ajusta la ruta absoluta si tu checkout está en otro lugar)
cat > ~/.local/share/applications/whatsapp-sidebar.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=WhatsApp Sidebar
Comment=Barra lateral vertical de WhatsApp para Linux
Exec=/ruta/absoluta/a/whatsapp-sidebar/node_modules/.bin/electron /ruta/absoluta/a/whatsapp-sidebar
Icon=whatsapp-sidebar
Terminal=false
Categories=Network;Chat;InstantMessaging;
StartupWMClass=whatsapp-sidebar
EOF

update-desktop-database ~/.local/share/applications
```

Después de esto debería aparecer como "WhatsApp Sidebar" al buscar en
Actividades de GNOME. Esto ya se hizo en esta máquina.

## Personalizar

- **Ancho de la ventana:** constante `WINDOW_WIDTH` en `main.js`.
- **Colores/tipografía:** variables al inicio de `renderer/styles.css`.
- **Proporción lista de chats / conversación:** ahora se ajusta arrastrando
  el divisor entre ambas zonas (línea entre la lista y la conversación); la
  altura elegida queda guardada en `localStorage` del propio proceso de la
  app. El valor por defecto (42% / 58%, en `.chat-list`/`.conversation` de
  `styles.css`) sigue aplicando hasta la primera vez que se arrastra.
- **Cantidad de chats mostrados / mensajes cargados:** `pushChatList` y
  `wa:getMessages` en `main.js`.

## Próximos pasos posibles

- Reservar espacio en pantalla como un panel real (ver nota de Wayland/X11).
- Notificaciones de escritorio nativas al llegar un mensaje.
- Envío/recepción de imágenes y notas de voz (hoy solo texto).
- Atajo de teclado global para mostrar/ocultar la barra.
