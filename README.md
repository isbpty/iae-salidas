# IAE Salidas · Demo funcional

**Demo en vivo:** <https://isbpty.github.io/iae-salidas/> · **Código:** <https://github.com/isbpty/iae-salidas>

Demo de una plataforma de **salidas tempranas y excusas** para una escuela, con tres caras:

| Vista | Qué muestra |
|---|---|
| 📱 **App Padres** | El padre/madre ve sus hijos, crea solicitudes de salida y excusas, registra personas autorizadas y recibe avisos. |
| 💬 **WhatsApp** | Simulador de chat con el bot de la escuela. Entiende frases como "Necesito retirar a Joseph hoy a las 4:45 pm" o "Lo retira la abuela". |
| 🏫 **Escuela** | Dashboard con roles: Administración, Recepción, Profesor (solo sus grados) y Garita de salida. |

Todo corre en el navegador, sin instalar nada. Los datos viven en `localStorage`; el botón **Reiniciar** vuelve a los datos de ejemplo.

## Cómo abrirlo

Opción rápida: doble clic en `index.html`.

Opción recomendada (evita restricciones de algunos navegadores con archivos locales):

```bash
python -m http.server 8765
```

y abrir <http://localhost:8765>.

## Reglas implementadas

- **Familias**: un estudiante tiene hasta 2 titulares; una familia puede tener varios hijos.
- **Autorizados**: `siempre`, `por tiempo` (rango de fechas) o `una vez (con confirmación)`. Un autorizado puede ser otro padre con cuenta; en su app ve "Autorizado para retirar otros niños".
- **Solicitud de salida**: la crea un titular por WhatsApp o app. Se notifica al otro titular.
- **Auto-aprobación** (configurable): titular + anticipación mínima (60 min por defecto) + persona que retira titular o autorizada siempre/por tiempo + sin rechazos recientes. Si no cumple, pasa a Recepción.
- **Aprobación manual**: Recepción/Administración eligen el punto de retiro; el padre recibe punto y código.
- **Garita**: ve solo las salidas aprobadas de hoy, verifica cédula y marca el retiro. Ambos titulares reciben "fue retirado a las …".
- **Una vez con confirmación**: cuando la persona llega a la garita, se pide confirmación por WhatsApp a los titulares; sin confirmación no se entrega.
- **Excusas**: ausencia o tardanza, con adjunto opcional. Recepción acepta/rechaza; el profesor del grado la ve.
- **Permisos**: matriz editable por rol en *Personal y permisos*. Profesores sin "todos los niveles" ven solo sus grados; las monitoras solo su ruta.
- **Bus escolar**: rutas con paradas, horarios de ida y vuelta, conductor y monitora. Cada estudiante tiene ruta y parada. El GPS es un simulador con la forma de una API real (modo demo en Configuración: "el bus de vuelta está en ruta ahora").
- **Rol Monitora**: ve solo su ruta, inicia/finaliza el viaje y marca Abordó / Bajó / No abordó por estudiante.
- **"¿Dónde está mi hijo?"** por WhatsApp o app: responde según el estado real del día (ya salió por garita y quién lo confirmó · va en el bus con próxima parada, tiempo de llegada y mapa · bajó en su parada · no fue marcado a bordo · está en el plantel · fuera de horario). Solo a titulares y dentro del horario de la ruta.
- **"Hoy no va en bus"**: el padre avisa por WhatsApp o app y la monitora lo ve marcado en su lista.
- **Aviso proactivo**: solo cuando retira una persona nueva (menos de N días registrada), por tiempo o de una sola vez; los titulares reciben "Es correcto / NO" y con NO se cancela la salida y se avisa a garita.
- **Código y QR de retiro**: la salida aprobada muestra un QR y un código en la app; garita lo escanea (o lo escribe) y ve la foto o cédula del autorizado antes de marcar el retiro.
- **Foto o cédula obligatoria** al registrar un autorizado nuevo (se guarda reducida en el navegador para el demo).
- **Bitácora**: registro de todos los eventos y notificaciones.

## Archivos

- `index.html` · página única
- `styles.css` · estilos
- `seed.js` · escuela, niveles, personal, familias, autorizaciones e historial de ejemplo
- `app.js` · lógica de negocio, notificaciones y bot de WhatsApp
- `views.js` · interfaz (app padres, WhatsApp, dashboard, formularios)

## Siguiente paso hacia producción

WhatsApp real (Meta Cloud API o Twilio) → webhook → misma lógica de `handleIncoming`; base de datos (Postgres/Supabase); autenticación de padres y personal; notificaciones push; y el chat de "escribiendo…" pasa a ser respuestas del servidor.
