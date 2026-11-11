// Formulario guiado de operativos IVC (piloto). Sin dependencias; todo texto se inserta como textContent.
// Pasos: datos generales → actividades (con fotos) → cierre (con foto) → vista previa → «Enviar a verificación».
//
// Funciona como el bot de Telegram: el celular NO habla con el PC sino con el BUZÓN de Google (Apps Script), que
// está siempre encendido. Todo se guarda primero en el celular (datos y fotos, en IndexedDB); al «Enviar», las fotos
// y el reporte suben al buzón (si no hay señal, quedan «En espera de envío» y salen solas cuando la haya). El PC los
// recoge cuando se enciende, los revisa con las mismas reglas (reglas-formulario.js) y publica el estado en el buzón.
import { validarFormulario, consolidado, erroresFotos, uid as uidSeguro } from './reglas-formulario.js';
import { BUZON } from './config-formulario.js';

// ===== LÓGICA PURA (sin pantalla ni almacenamiento): la prueba test/formulario-celular.test.js =====
// Va dentro de formulario.js (y no en un archivo aparte) para que la publicación y la caché del celular no cambien.
// Versión visible en el pie. Debe coincidir con CACHE de sw.js ('ivc-formulario-' + VERSION): súbalas juntas.
const VERSION = 'v10';
// Nombre del archivo de una foto compartida a WhatsApp: «ID71562-actividad1-1.jpg» (letras, números, _ y -).
function nombreArchivoCompartir(prefijo, i, tipo = '') {
  const limpio = String(prefijo || '').replace(/[^\w-]/g, '') || 'foto';
  const ext = /png/i.test(tipo) ? 'png' : /webp/i.test(tipo) ? 'webp' : /hei[cf]/i.test(tipo) ? 'heic' : 'jpg';
  return `${limpio}-${i + 1}.${ext}`;
}
// --- Fotos: nunca frenan el envío. La que no se puede mandar se marca con su error, se omite y se avisa. ---
const LIMITE_FOTO = 9 * 1024 * 1024; // el buzón acepta hasta ~10,5 MB; por encima de 9 MB ya no se intenta
const SUBIDAS_A_LA_VEZ = 2;
const MAX_AGOTADAS = 3; // tiempos agotados seguidos con la misma foto antes de omitirla
const LADOS_COMPRESION = [1600, 1280]; // si la primera reducción falla, se intenta una más pequeña
const FOTO_SIN_ARCHIVO = 'Una foto no quedó guardada en este celular: no se enviará. Quítela y adjúntela de nuevo.';
const FOTO_PESADA = 'Una foto es muy pesada (más de 9 MB) y no se enviará: tómela de nuevo o elija otra.';
const FOTO_ILEGIBLE = 'Una foto no se pudo leer en este celular (formato no compatible, por ejemplo HEIC) y no se enviará: tómela de nuevo o elija otra.';
const FOTO_LENTA = 'Una foto no alcanzó a subir con esta señal después de 3 intentos: el reporte se envía sin ella.';
// Espera para subir una foto: según su tamaño (unos 7 KB por segundo, señal débil), entre 60 s y 4 min.
function esperaFoto(bytes) {
  return Math.min(240_000, Math.max(60_000, Math.round(((Number(bytes) || 0) / 1024) * 150)));
}
// Resultado de comprimir: intentos = ['ok' | 'error' | 'tiempo', …] con cada tamaño de LADOS_COMPRESION.
// 'reducida' si alguno funcionó; 'ilegible' si el celular no pudo abrir la foto ninguna vez; si no, se guarda el original.
function elegirTrasCompresion(intentos) {
  if (intentos.includes('ok')) return 'reducida';
  if (intentos.length && intentos.every((x) => x === 'error')) return 'ilegible';
  return 'original';
}
// Problema de una foto ya guardada, antes de subirla (null si se puede subir).
function problemaDeFoto(x) {
  if (!x || !x.blob || !(Number(x.blob.size) > 0)) return FOTO_SIN_ARCHIVO;
  if (x.blob.size > LIMITE_FOTO) return FOTO_PESADA;
  return null;
}
// Qué hacer después de intentar subir una foto. e = error (o null si subió), agotadas = tiempos agotados previos.
//   ok: quedó en el buzón · omitir: se marca con error y el reporte sigue sin ella · detener: se reintenta más tarde.
function resultadoSubida(e, agotadas = 0) {
  if (!e) return { accion: 'ok' };
  if (e.codigo === 'FOTO_RECHAZADA') return { accion: 'omitir', error: `El buzón no aceptó una foto (${e.message || 'foto no válida'}): el reporte se envía sin ella.` };
  if (e.lectura) return { accion: 'omitir', error: FOTO_ILEGIBLE };
  if (e.tiempo) {
    const n = (Number(agotadas) || 0) + 1;
    return n >= MAX_AGOTADAS ? { accion: 'omitir', error: FOTO_LENTA, agotada: n } : { accion: 'detener', agotada: n };
  }
  return { accion: 'detener' };
}
// --- Respuestas del buzón y mensajes para la gestora ---
const NO_JSON = 'El buzón no respondió bien; se reintentará solo.';
const SIN_ESPACIO = 'No se pudo guardar en el celular: libere espacio (borre fotos o reportes ya confirmados) y vuelva a intentar.';
// El buzón responde JSON; una página HTML de Google (cuota, implementación cambiada…) no es «sin internet».
function leerRespuesta(texto) {
  try { const j = JSON.parse(String(texto ?? '')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}
// Errores técnicos (de Google o del navegador, casi siempre en inglés) → mensaje claro y si conviene reintentar solo.
const TRADUCCIONES = [
  [/QuotaExceededError|storage.*(full|quota)|no (queda )?espacio/i, SIN_ESPACIO, false],
  [/lock timeout|holding the lock|bloqueo|another process/i, 'El buzón de Google está ocupado; se reintentará solo en unos minutos.', true],
  [/too many times|service invoked|quota|cuota|rate ?limit|límite de uso/i, 'Google alcanzó su límite de uso o está saturado; se reintentará solo. Si sigue así varias horas, avise a coordinación.', true],
  [/service error|internal error|server error|backend error|timed? ?out|exceeded maximum execution|unavailable|try again later/i, 'Google tuvo una falla pasajera; se reintentará solo.', true],
  [/failed to fetch|networkerror|network request failed|load failed|err_internet|err_network/i, 'No hay señal en este momento: el reporte queda guardado en el celular y se enviará solo.', true],
  [/NotReadableError|NotFoundError|could not be read|requested file/i, FOTO_ILEGIBLE, false],
];
function traducirError(msg) {
  const m = String(msg ?? '').trim();
  for (const [re, texto, reintentar] of TRADUCCIONES) if (re.test(m)) return { texto, reintentar };
  // Mensaje técnico desconocido (en inglés): no se muestra tal cual.
  if (!m || /\b(the|was|cannot|undefined|exception|unexpected|TypeError|ReferenceError|SyntaxError|is not)\b/.test(m)) {
    return { texto: 'No se pudo enviar por una falla de Google o del celular. Intente de nuevo; si se repite, avise a coordinación.', reintentar: false };
  }
  return { texto: m, reintentar: false }; // los mensajes del aplicativo ya vienen en español
}
// Por qué un reporte sigue «en espera» (null: no es una espera, es un error del reporte).
function motivoDe(e) {
  if (!e) return null;
  if (e.estado === 401) return 'pase';
  if (e.codigo === 'OCUPADO') return 'ocupado';
  if (e.codigo === 'NO_JSON') return 'buzon';
  if (e.tiempo) return 'lenta';
  if (e.red) return 'red';
  if (e.reintentar) return 'ocupado';
  return null;
}
// Qué ve la gestora cuando un reporte queda en espera, según el motivo.
function textoEspera(motivo) {
  const T = {
    pase: ['🔑 Vuelva a ingresar con la clave', 'Su ingreso venció o la clave del equipo cambió. El reporte quedó guardado en este celular: para enviarlo, pulse «Ingresar de nuevo» y escriba la clave del equipo.'],
    ocupado: ['📥 Reporte guardado: se reintentará solo', 'El buzón de Google está ocupado en este momento. El reporte quedó guardado y se enviará solo en unos minutos (deje el formulario abierto). Si en una hora sigue en espera, avise a coordinación.'],
    buzon: ['📥 Reporte guardado: se reintentará solo', 'El buzón no respondió bien. El reporte quedó guardado y se reintentará solo (deje el formulario abierto). Si en una hora sigue en espera, avise a coordinación.'],
    lenta: ['📥 Reporte guardado: la señal está muy débil', 'Las fotos siguen subiendo poco a poco. Deje el formulario abierto o, si puede, conéctese a wifi: se enviará solo.'],
    fotos: ['📥 Reporte guardado: faltan fotos por subir', 'El buzón pidió volver a subir algunas fotos. Se reintentará solo en unos segundos (deje el formulario abierto).'],
    red: ['📥 Reporte guardado: en espera de envío', 'No hay señal en este momento. El reporte y sus fotos quedaron guardados en este celular y se enviarán solos cuando haya internet (con el formulario abierto o al volver a abrirlo).'],
  };
  const [titulo, texto] = T[motivo] || T.red;
  return { titulo, texto };
}
// Espera antes de reintentar cuando el buzón está ocupado: 15 s, 30 s, 1 min, 2 min… hasta 10 min.
function esperaReintento(n) { return Math.min(600_000, 15_000 * 2 ** Math.max(0, Number(n) || 0)); }
// --- Estados que publica el PC ---
const FINALES = ['Confirmado', 'Rechazado', 'Descartado', 'Eliminado'];
const CORREGIR = ['Requiere corrección', 'No se pudo procesar'];
// El PC lo recibió pero está reintentando procesarlo: no se edita ni se descarta (si queda en cuarentena, pasa a
// «No se pudo procesar» y ahí sí se puede corregir y reenviar).
const EN_REVISION = 'Recibido con problema';
// Observación del PC que la gestora no puede pasar por alto (p. ej. «Su corrección (envío N) no se aplicó…»).
const observacionUrgente = (obs) => /no se aplic[óo]|hable con coordinaci[óo]n/i.test(String(obs || ''));
// Qué hacer con la copia del celular según el estado que publicó el PC: null (nada), { borrar } o { cambios }.
function decidirEstado(r, e, usuarioId) {
  if (!r || !e || r.usuarioId !== usuarioId || r.enEspera) return null;
  // Un reenvío que el PC aún no recoge: lo que diga el estado es del envío anterior.
  if (e.envio !== undefined && (r.envio || 0) > (e.envio || 0)) return null;
  const observaciones = e.observaciones || null;
  if (FINALES.includes(e.estado)) {
    if (!r.editable) return { borrar: true };
    // Coordinación lo cerró (p. ej. devuelto y luego confirmado sin reenvío): deja de ser editable.
    return { cambios: { estado: e.estado, observaciones, editable: false, sucio: false, cerradoPorCoordinacion: true } };
  }
  const corregir = CORREGIR.includes(e.estado);
  const enRevision = e.estado === EN_REVISION;
  if (r.estado !== e.estado || r.observaciones !== observaciones || (corregir && !r.editable) || (enRevision && r.editable)) {
    return { cambios: { estado: e.estado, observaciones, ...(corregir && !r.editable ? { editable: true, sucio: true } : {}), ...(enRevision && r.editable ? { editable: false } : {}) } };
  }
  return null;
}
// Se puede descartar: borrador nunca enviado, «No se pudo procesar» o un reporte que el aplicativo dice que se puede borrar.
function puedeDescartar(r) {
  if (!r || r.enEspera || r.estado === EN_REVISION) return false;
  if (r.estado === 'No se pudo procesar') return true;
  if (/puede (borrar|descartar)/i.test(`${r.observaciones || ''} ${r.error || ''}`)) return true;
  return Boolean(r.editable && !r.envio && !r.intentado);
}
// Envuelve una acción asíncrona para que un segundo toque, mientras la primera sigue en curso, no la repita.
function unaVez(fn) {
  let enCurso = null;
  return (...args) => {
    if (enCurso) return enCurso;
    enCurso = Promise.resolve().then(() => fn(...args)).finally(() => { enCurso = null; });
    return enCurso;
  };
}
// --- Estados en «Mis reportes»: cuándo se envió y qué tiene que hacer la gestora ---
// Ya está en el buzón de Google: llega al aplicativo apenas coordinación encienda el PC.
const EN_BUZON = '📨 Enviado (en el buzón)';
const fechaHora = (iso) => (iso ? new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' }) : '—');
const fechaDe = (ms) => (ms ? fechaHora(new Date(ms).toISOString()) : '—');
const MOTIVO_CORTO = { red: 'sin señal', lenta: 'señal débil', ocupado: 'el buzón estaba ocupado', buzon: 'el buzón no respondió bien', pase: 'debe volver a ingresar con la clave', fotos: 'faltaban fotos por subir' };
function estadoDe(r) { return r.enEspera ? 'En espera de envío' : r.error ? 'No se pudo enviar' : r.estado || 'Borrador'; }
// { estado, que, accion }: accion = 'intentar' (Intentar ahora) · 'reintentar' (abrir en Vista previa) · null.
function guiaEstado(r, ahora = Date.now()) {
  const estado = estadoDe(r);
  const enviado = r.enviadoEn ? `Enviado el ${fechaDe(r.enviadoEn)}. ` : '';
  if (r.enEspera) {
    const ultimo = r.ultimoIntento ? `Último intento: ${fechaDe(r.ultimoIntento)} (${MOTIVO_CORTO[r.motivoEspera] || 'sin señal'}). ` : '';
    const que = r.motivoEspera === 'pase' ? 'Vuelva a ingresar con la clave para enviarlo.' : 'Se enviará solo; si ya tiene señal, pulse «Intentar ahora».';
    return { estado, que: ultimo + que, accion: r.motivoEspera === 'pase' ? null : 'intentar' };
  }
  if (r.error) return { estado, que: 'Pulse «Reintentar envío»: se abre la vista previa para enviarlo de nuevo. Si se repite, avise a coordinación.', accion: 'reintentar' };
  if (r.cerradoPorCoordinacion) return { estado, que: `Coordinación ya cerró este reporte (${r.estado}). Los cambios en el celular no se enviarán.`, accion: null };
  switch (estado) {
    case EN_BUZON: {
      const viejo = r.enviadoEn && ahora - r.enviadoEn > 48 * 3600_000;
      return { estado, que: enviado + (viejo ? 'Si coordinación no lo ve en el aplicativo, avísele. No lo borre.' : 'Esperando que coordinación lo reciba; no tiene que hacer nada.'), accion: null };
    }
    case EN_REVISION: return { estado, que: 'Coordinación lo está revisando; no necesita hacer nada por ahora.', accion: null };
    case 'Pendiente de verificación': return { estado, que: `${enviado}Coordinación lo recibió y lo está revisando; no tiene que hacer nada.`, accion: null };
    case 'Requiere corrección': return { estado, que: 'Corrija lo que indica coordinación y pulse «Reenviar a verificación».', accion: null };
    case 'No se pudo procesar': return { estado, que: 'Corrija lo indicado y reenvíelo, o descártelo si ya lo reportó en otro.', accion: null };
    case 'Confirmado': return { estado, que: 'Confirmado por coordinación.', accion: null };
    case 'Borrador': return { estado, que: 'Sin enviar: termínelo y pulse «Enviar a verificación».', accion: null };
    default: return { estado, que: enviado.trim(), accion: null };
  }
}
// ===== FIN LÓGICA PURA =====

const $ = (s, r = document) => r.querySelector(s);
const vista = $('#vista');
let yo = null;
let cat = null;      // catálogos del servidor (también guardados en el celular)
let f = null;        // reporte abierto: registro local + fotos
let paso = 0;
let actSel = 0;      // pestaña de actividad abierta
let enLinea = navigator.onLine;

// ---------- Utilidades ----------
function h(tag, attrs = {}, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of hijos.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const poner = (el, ...nodos) => el.replaceChildren(...nodos.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
// Error de red: sin internet (o Google no responde). No es un error del reporte.
const errorRed = () => Object.assign(new Error('Sin internet en este momento: queda guardado en este celular.'), { red: true });
// Llamada al buzón de Google. Va como text/plain para que el navegador no pida permiso previo (CORS) a Apps Script.
async function buzon(accion, datos = {}, { silencioso = false, espera = 30_000 } = {}) {
  if (!BUZON) throw new Error('El formulario no tiene configurado el buzón: avise a coordinación.');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), espera);
  let r, texto;
  try {
    r = await fetch(BUZON, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ accion, datos }), redirect: 'follow', signal: ctrl.signal });
    texto = await r.text();
  } catch {
    // Se agotó la espera: hay señal pero muy lenta (no se pinta «Sin internet»).
    if (ctrl.signal.aborted) { marcarLenta(true); throw Object.assign(errorRed(), { tiempo: true }); }
    marcarConexion(false); throw errorRed();
  } finally { clearTimeout(t); }
  marcarLenta(false);
  marcarConexion(true);
  const j = leerRespuesta(texto);
  // Hay internet, pero Google respondió otra cosa (página HTML de cuota o de error): se reintenta, no es «sin señal».
  if (!j) throw Object.assign(new Error(NO_JSON), { codigo: 'NO_JSON', reintentar: true, tecnico: `HTTP ${r.status} ${String(texto || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 150)}` });
  if (j.ok) return j;
  if (j.codigo === 'PASE') {
    if (silencioso) throw Object.assign(new Error('Su ingreso venció o la clave cambió: vuelva a ingresar con la clave para enviar lo pendiente.'), { estado: 401 });
    olvidarIngreso(); iniciar(); throw new Error(j.error);
  }
  if (j.codigo === 'OCUPADO') throw Object.assign(new Error('El buzón de Google está ocupado; se reintentará solo en unos minutos.'), { codigo: 'OCUPADO', reintentar: true, tecnico: j.error });
  const tr = traducirError(j.error || 'No se pudo completar');
  throw Object.assign(new Error(tr.texto), { codigo: j.codigo, faltan: j.faltan, reintentar: tr.reintentar, tecnico: j.error });
}
const conPase = (datos = {}) => ({ ...datos, pase: yo?.pase });
function aviso(t, error = false) {
  const el = $('#toast');
  el.textContent = t; el.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(aviso.t); aviso.t = setTimeout(() => { el.className = 'toast'; }, error ? 7000 : 3000);
}
const uid = () => uidSeguro();
function confirmar(texto, boton = 'Confirmar', no = 'Cancelar') {
  return new Promise((resolver) => {
    const d = $('#dialogo'); const fm = $('#dialogo-form');
    poner(fm, h('p', {}, texto), h('div', { class: 'acciones' }, h('button', { value: 'ok', class: 'principal' }, boton), h('button', { value: 'no' }, no)));
    d.onclose = () => resolver(d.returnValue === 'ok'); d.returnValue = ''; d.showModal();
  });
}
const COLOR = { Borrador: 'neutro', 'Pendiente de verificación': 'alerta', 'Requiere corrección': 'error', Rechazado: 'error', Confirmado: 'ok', Eliminado: 'neutro',
  Sincronizado: 'ok', 'Pendiente de sincronización': 'alerta', 'Error de sincronización': 'error', 'En espera de envío': 'alerta', 'No se pudo enviar': 'error',
  'No se pudo procesar': 'error', [EN_BUZON]: 'neutro', [EN_REVISION]: 'alerta' };
const chip = (t) => h('span', { class: `chip ${COLOR[t] || 'neutro'}` }, t);

// ---------- Almacén del celular (IndexedDB): reportes y fotos ----------
// reportes: { lid, usuarioId, sid, tipo, tipoNombre, datos, version, estado, editable, observaciones,
//             sucio, rev, enEspera, error, envio (envíos al buzón), actualizado }
// fotos:    { fid, lid, actividad, es_cierre, blob, sid, quitar, error }
let bdAbierta = null;
function abrirBD() {
  bdAbierta ||= new Promise((ok, mal) => {
    const r = indexedDB.open('ivc-formulario', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('reportes', { keyPath: 'lid' });
      db.createObjectStore('fotos', { keyPath: 'fid' }).createIndex('lid', 'lid');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
  });
  return bdAbierta;
}
async function bd(almacen, modo, fn) {
  const db = await abrirBD();
  return new Promise((ok, mal) => {
    const t = db.transaction(almacen, modo);
    const req = fn(t.objectStore(almacen));
    let res;
    if (req) req.onsuccess = () => { res = req.result; };
    t.oncomplete = () => ok(res);
    t.onerror = () => mal(t.error);
    t.onabort = () => mal(t.error || new Error('No se pudo guardar en el celular'));
  });
}
const L = {
  reportes: async (usuarioId) => (await bd('reportes', 'readonly', (s) => s.getAll())).filter((x) => x.usuarioId === usuarioId),
  reporte: (lid) => bd('reportes', 'readonly', (s) => s.get(lid)),
  ponerReporte: (r) => bd('reportes', 'readwrite', (s) => s.put(r)),
  fotos: (lid) => bd('fotos', 'readonly', (s) => s.index('lid').getAll(lid)),
  ponerFoto: (x) => bd('fotos', 'readwrite', (s) => s.put(x)),
  quitarFoto: (fid) => bd('fotos', 'readwrite', (s) => s.delete(fid)),
  // Cambia una foto solo si todavía existe (leer y guardar en la misma operación): una foto que la gestora quitó
  // mientras se subía no reaparece. Devuelve si existía.
  async marcarFoto(fid, cambios) {
    let existe = false;
    await bd('fotos', 'readwrite', (s) => {
      const g = s.get(fid);
      g.onsuccess = () => { if (g.result) { existe = true; s.put({ ...g.result, ...cambios }); } };
    });
    return existe;
  },
  async borrarReporte(lid) {
    for (const x of await L.fotos(lid)) await L.quitarFoto(x.fid);
    await bd('reportes', 'readwrite', (s) => s.delete(lid));
  },
};
// Las escrituras de un mismo reporte van en fila (leer → cambiar → guardar), para que la pantalla y el envío
// automático no se pisen.
let filaBD = Promise.resolve();
function enFila(fn) { const p = filaBD.then(fn, fn); filaBD = p.catch(() => {}); return p; }
// Cambia campos de control del reporte (versión, estado, errores…) en el celular y, si está abierto, en pantalla.
function actualizarReporte(lid, cambios) {
  return enFila(async () => {
    const r = await L.reporte(lid);
    if (!r) return null;
    const c = typeof cambios === 'function' ? cambios(r) : cambios;
    Object.assign(r, c);
    await L.ponerReporte(r);
    if (f?.lid === lid) Object.assign(f, c);
    return r;
  });
}

// ---------- Guardado automático (en el celular, y luego al servidor) ----------
let tGuardar = null;
// Se puede cambiar: editable y sin envío pendiente (en espera no se edita; primero se cancela el envío).
const puedeEditar = () => Boolean(f?.editable && !f.enEspera);
function cambio() {
  if (!puedeEditar()) return;
  f.datos._ubicacion = { paso, actividad: actSel };
  indicador('Guardando…');
  clearTimeout(tGuardar);
  tGuardar = setTimeout(() => guardarLocal(), 300);
}
// Con lanzar (al enviar), un fallo al guardar detiene el envío: nunca sale una versión vieja del reporte.
function guardarLocal({ lanzar = false } = {}) {
  clearTimeout(tGuardar);
  if (!puedeEditar()) return Promise.resolve();
  const lid = f.lid;
  const datos = JSON.parse(JSON.stringify(f.datos));
  return enFila(async () => {
    const r = (await L.reporte(lid)) || null;
    if (!r) return;
    r.datos = datos; r.sucio = true; r.rev = (r.rev || 0) + 1; r.actualizado = Date.now();
    await L.ponerReporte(r);
    if (f?.lid === lid) { f.sucio = true; f.rev = r.rev; }
  }).then(() => { indicador('✓ Guardado en el celular'); sincronizarPronto(); }, (e) => {
    indicador('⚠ Sin guardar');
    aviso(SIN_ESPACIO, true);
    if (lanzar) throw Object.assign(new Error(SIN_ESPACIO), { almacen: true, tecnico: String(e?.message || e) });
  });
}
function indicador(t) { const ind = $('#guardado'); if (ind) ind.textContent = t; }
function recordarUbicacion() {
  if (!puedeEditar()) return;
  f.datos._ubicacion = { paso, actividad: actSel };
  cambio();
}

// ---------- Envío al buzón de Google ----------
// Solo salen los reportes que la gestora mandó a verificación (enEspera). Los borradores se quedan en el celular.
let sincronizando = null;
let necesitaIngreso = false;
let enviandoAhora = null; // lid del reporte cuyas fotos o sobre se están subiendo en este momento
let senalLenta = false;   // la última llamada agotó la espera: hay señal, pero muy débil
let reintentosOcupado = 0, noAntesDe = 0; // espera creciente cuando el buzón está ocupado o responde mal
function sincronizarPronto(ms = 1500) { clearTimeout(sincronizarPronto.t); sincronizarPronto.t = setTimeout(() => sincronizar().catch(() => {}), ms); }
// ahora: la gestora pulsó Enviar o «Intentar ahora» (no espera el turno del reintento automático).
function sincronizar({ ahora = false } = {}) {
  if (sincronizando || !yo) return sincronizando || Promise.resolve();
  if (!ahora && Date.now() < noAntesDe) return Promise.resolve();
  sincronizando = (async () => {
    for (const r of await L.reportes(yo.id)) {
      if (!r.enEspera) continue;
      try { await enviarAlBuzon(r.lid); reintentosOcupado = 0; noAntesDe = 0; } catch (e) {
        const motivo = motivoDe(e);
        if (motivo) {
          // Sigue en espera (no es un error del reporte): se anota por qué, para mostrárselo a la gestora.
          await actualizarReporte(r.lid, { motivoEspera: motivo, ultimoIntento: Date.now() }).catch(() => {});
          if (motivo === 'pase') necesitaIngreso = true;
          if (motivo === 'ocupado' || motivo === 'buzon') {
            const ms = esperaReintento(reintentosOcupado++);
            noAntesDe = Date.now() + ms;
            sincronizarPronto(ms + 100);
            if (motivo === 'buzon') diagnostico(r.lid, 'buzon-no-json', e.tecnico || e.message);
          }
          break;
        }
        const t = traducirError(e.message);
        await actualizarReporte(r.lid, { enEspera: false, motivoEspera: null, ultimoIntento: Date.now(), error: t.texto }).catch(() => {});
        diagnostico(r.lid, 'envio', e.tecnico || e.message || String(e));
      }
    }
  })().finally(() => { sincronizando = null; pintarConexion(); });
  return sincronizando;
}
const base64De = (blob) => new Promise((ok, mal) => {
  const lector = new FileReader();
  lector.onload = () => ok(String(lector.result).split(',')[1] || '');
  lector.onerror = () => mal(lector.error);
  lector.readAsDataURL(blob);
});
// Avance del envío en pantalla (para que la gestora no cierre ni bloquee el celular mientras suben las fotos)
// y pantalla encendida mientras tanto: con la pantalla apagada el navegador detiene la subida.
let bloqueoPantalla = null;
async function mantenerPantalla(si) {
  try {
    if (si && !bloqueoPantalla && navigator.wakeLock) bloqueoPantalla = await navigator.wakeLock.request('screen');
    if (!si && bloqueoPantalla) { await bloqueoPantalla.release(); bloqueoPantalla = null; }
  } catch { bloqueoPantalla = null; }
}
// Mensaje fijo arriba (misma franja del avance del envío). titulo null: lo oculta.
function mostrarMensaje(titulo, detalle = '') {
  const caja = $('#avance-envio');
  if (!caja) return;
  if (titulo === null) { caja.hidden = true; return; }
  caja.hidden = false;
  poner(caja, h('b', {}, titulo), detalle ? h('div', {}, detalle) : null);
}
function mostrarAvance(lid, hechas, total) {
  const caja = $('#avance-envio');
  if (!caja) return;
  if (hechas === null) { caja.hidden = true; return; }
  caja.hidden = false;
  poner(caja, h('b', {}, total ? `📤 Subiendo fotos: ${hechas} de ${total}` : '📤 Enviando el reporte…'),
    total ? h('progress', { max: total, value: hechas }) : null,
    h('div', {}, '⚠️ No cierre el formulario ni bloquee el celular hasta ver «✅ Reporte enviado».'));
}
// Sube al buzón las fotos que faltan (varias a la vez) y luego el reporte completo.
async function enviarAlBuzon(lid) {
  let r = await L.reporte(lid);
  if (!r?.enEspera) return;
  const o = { silencioso: true };
  for (const x of await L.fotos(lid)) if (x.quitar) await L.quitarFoto(x.fid);
  const porSubir = [];
  for (const x of await L.fotos(lid)) {
    if (x.sid || x.error) continue;
    const problema = problemaDeFoto(x);
    if (problema) { await omitirFoto(lid, x, problema, problema === FOTO_SIN_ARCHIVO ? 'foto-sin-archivo' : 'foto-omitida'); continue; }
    porSubir.push(x);
  }
  enviandoAhora = lid;
  await mantenerPantalla(true);
  try {
    let siguiente = 0, hechas = 0, fallo = null;
    const total = porSubir.length;
    mostrarAvance(lid, 0, total);
    // Dos a la vez; si una ya agotó la espera antes (señal débil), de a una.
    const aLaVez = porSubir.some((x) => x.agotada) ? 1 : SUBIDAS_A_LA_VEZ;
    await Promise.all(Array.from({ length: Math.min(aLaVez, total) }, async () => {
      while (!fallo && siguiente < total) {
        const x = porSubir[siguiente++];
        let error = null;
        try {
          let base64;
          try { base64 = await base64De(x.blob); } catch (e) { throw Object.assign(new Error(String(e?.message || e)), { lectura: true }); }
          await buzon('buzon_foto', conPase({ lid, fid: x.fid, base64 }), { ...o, espera: esperaFoto(x.blob.size) });
        } catch (e) { error = e; }
        const v = resultadoSubida(error, x.agotada);
        if (v.accion === 'ok') {
          // Ya está en el buzón (el número del PC, si lo tenía, se conserva). Si la quitaron mientras subía, no reaparece.
          if (await L.marcarFoto(x.fid, { sid: 'buzon', agotada: 0 })) reflejarFoto(lid, x.fid, { sid: 'buzon', agotada: 0 });
        } else if (v.accion === 'omitir') {
          await omitirFoto(lid, x, v.error, 'foto-omitida', error);
        } else {
          if (v.agotada) await L.marcarFoto(x.fid, { agotada: v.agotada });
          fallo ||= error; return;
        }
        mostrarAvance(lid, ++hechas, total);
      }
    }));
    if (fallo) throw fallo;
    mostrarAvance(lid, 0, 0);
    await enviarSobre(lid, o);
  } finally { enviandoAhora = null; mostrarAvance(lid, null); mantenerPantalla(false); }
}
// Foto que no se puede mandar: queda marcada con su error (se omite del envío, sin frenarlo) y se avisa.
async function omitirFoto(lid, x, msg, tipo, e = null) {
  if (await L.marcarFoto(x.fid, { error: msg })) reflejarFoto(lid, x.fid, { error: msg });
  aviso(`⚠ ${msg}`, true);
  diagnostico(lid, tipo, e?.message ? `${msg} [${e.message}]` : msg);
}
function reflejarFoto(lid, fid, cambios) {
  if (f?.lid !== lid) return;
  const y = f.fotos.find((z) => z.fid === fid);
  if (y) Object.assign(y, cambios);
}
async function enviarSobre(lid, o) {
  let r;
  const fotos = (await L.fotos(lid)).filter((x) => !x.quitar);
  const conError = fotos.filter((x) => x.error);
  // Las fotos nunca frenan el envío: una que no quedó guardada en el celular (sin archivo y sin copia en el PC)
  // no se puede mandar; se omite y coordinación ve en el aplicativo cuántas fotos llegaron.
  const enviables = fotos.filter((x) => !x.error || Number(x.sid) > 0 || x.sid === 'buzon');
  if (conError.length) diagnostico(lid, 'fotos-omitidas', `${conError.length} foto(s) se omitieron: ${conError[0].error}`);
  r = await L.reporte(lid);
  if (!r?.enEspera) return;
  const envio = (r.envio || 0) + 1;
  // Puede que el sobre llegue aunque se pierda la respuesta: si después se cancela para editar, el próximo envío
  // lleva un número mayor y el PC no lo toma como repetido.
  if (!r.intentado) await actualizarReporte(lid, { intentado: true });
  try {
    await buzon('buzon_enviar', conPase({ lid, envio, tipo: r.tipo, datos: r.datos,
      fotos: enviables.map((x) => ({ fid: x.fid, sid: Number(x.sid) > 0 ? Number(x.sid) : null, actividad: x.actividad, es_cierre: x.es_cierre })) }), { ...o, espera: 60_000 });
  } catch (e) {
    // Una foto que el buzón no tiene (se borró allá): se vuelve a subir en la próxima vuelta.
    if (e.codigo === 'FALTAN_FOTOS') {
      for (const x of enviables) if ((e.faltan || []).includes(x.fid)) await L.marcarFoto(x.fid, { sid: null });
      await actualizarReporte(lid, { motivoEspera: 'fotos', ultimoIntento: Date.now() });
      return;
    }
    throw e;
  }
  await terminarEnviado(lid, true, envio);
}
// Ya está en el buzón: el reporte queda en el celular en solo lectura hasta que coordinación lo revise
// (si lo devuelve para corrección, se corrige aquí mismo y se reenvía).
async function terminarEnviado(lid, avisar, envio) {
  const r = await actualizarReporte(lid, { enEspera: false, editable: false, sucio: false, envio, intentado: false, motivoEspera: null, estado: EN_BUZON, error: null, observaciones: null, enviadoEn: Date.now(), ultimoIntento: Date.now() });
  if (avisar) aviso(`✅ Reporte ${r?.datos?.general?.id_operativo || ''} enviado.`);
  if (f?.lid === lid) {
    f = null;
    mostrarEnviado(r);
  } else if (!f) inicio().catch(() => {});
}

// Rastro para coordinación: los errores de envío del celular quedan anotados en el buzón (pestaña Piloto_Buzon_Diagnostico;
// solo el tipo de error y el estado del reporte, sin datos del operativo). Si no hay conexión, no se insiste.
const diagnosticos = new Map();
async function diagnostico(lid, tipo, mensaje) {
  const k = `${lid}|${tipo}|${mensaje}`;
  if (Date.now() - (diagnosticos.get(k) || 0) < 120_000) return;
  diagnosticos.set(k, Date.now());
  try {
    const fotos = await L.fotos(lid);
    const r = await L.reporte(lid);
    await buzon('buzon_diagnostico', conPase({ lid, tipo, mensaje: String(mensaje || '').slice(0, 300), detalle: {
      envio: r?.envio || 0, sucio: Boolean(r?.sucio), enEspera: Boolean(r?.enEspera),
      fotos: fotos.length, pendientes: fotos.filter((x) => !x.sid && !x.quitar).length, conError: fotos.filter((x) => x.error).length,
      sinArchivo: fotos.filter((x) => !x.sid && !(x.blob instanceof Blob)).length, navegador: navigator.userAgent.slice(0, 160) } }), { silencioso: true });
  } catch { /* sin conexión: no importa */ }
}

// ---------- Estado de la conexión (cabecera) ----------
function marcarConexion(v) { if (enLinea !== v) { enLinea = v; if (!v) senalLenta = false; pintarConexion(); if (v) { necesitaIngreso = false; sincronizarPronto(500); } } }
function marcarLenta(v) { if (v) enLinea = true; if (senalLenta !== v) { senalLenta = v; pintarConexion(); } }
async function pintarConexion() {
  const el = $('#conexion');
  if (!el || !yo) return;
  const espera = (await L.reportes(yo.id).catch(() => [])).filter((r) => r.enEspera).length;
  poner(el,
    senalLenta ? h('span', { class: 'chip alerta', title: 'Las fotos siguen subiendo; si puede, conéctese a wifi.' }, '🟡 Señal débil')
      : h('span', { class: `chip ${enLinea ? 'ok' : 'alerta'}`, title: enLinea ? null : 'Lo que haga se guarda en el celular y se envía solo cuando haya señal.' }, enLinea ? '🟢 Con internet' : '🔴 Sin internet'),
    espera ? [' ', h('span', { class: 'chip alerta' }, `📤 ${espera} en espera de envío`)] : null,
    necesitaIngreso ? [' ', h('button', { type: 'button', class: 'mini principal', onclick: () => { olvidarIngreso(); iniciar(); } }, '🔑 Vuelva a ingresar con la clave')] : null);
}

// ---------- Campos ----------
const req = (t) => h('span', {}, t, h('span', { class: 'req', 'aria-hidden': 'true' }, ' *'));
function texto(obj, campo, etiqueta, { tipo = 'text', placeholder, obligatorio = true, area = false, extra = {} } = {}) {
  const set = (e) => { obj[campo] = e.target.value; cambio(); };
  const input = area ? h('textarea', { rows: 4, placeholder, oninput: set, ...extra }, obj[campo] || '')
    : h('input', { type: tipo, value: obj[campo] ?? '', placeholder, oninput: set, ...extra });
  return h('label', { class: area ? 'ancho' : '' }, obligatorio ? req(etiqueta) : etiqueta, input);
}
function seleccion(obj, campo, etiqueta, opciones) {
  return h('label', {}, req(etiqueta), h('select', { onchange: (e) => { obj[campo] = e.target.value; cambio(); } },
    h('option', { value: '' }, 'Seleccione…'), opciones.map((o) => h('option', { value: o, selected: obj[campo] === o }, o))));
}
// Sí / No. Al pasar a «No» se limpian los datos que dependen de la respuesta (regla de la especificación).
function siNo(obj, campo, etiqueta, { limpiar = [], alCambiar } = {}) {
  const nombre = `${campo}-${uid()}`;
  const op = (v, t) => h('label', { class: `opcion${obj[campo] === v ? ' marcada' : ''}` },
    h('input', { type: 'radio', name: nombre, value: v, checked: obj[campo] === v, onchange: () => {
      obj[campo] = v;
      if (v === 'no') for (const c of limpiar) delete obj[c];
      cambio(); (alCambiar || pintar)();
    } }), t);
  return h('fieldset', { class: 'sino' }, h('legend', {}, req(etiqueta)), op('si', 'Sí'), op('no', 'No'));
}
function multiple(obj, campo, etiqueta, opciones, { etiquetaDe = (o) => o, valorDe = (o) => o, obligatorio = true } = {}) {
  const sel = new Set(obj[campo] || []);
  return h('fieldset', { class: 'multiple' }, h('legend', {}, obligatorio ? req(etiqueta) : etiqueta),
    opciones.map((o) => h('label', { class: `opcion${sel.has(valorDe(o)) ? ' marcada' : ''}` },
      h('input', { type: 'checkbox', checked: sel.has(valorDe(o)), onchange: (e) => {
        const s = new Set(obj[campo] || []);
        if (e.target.checked) s.add(valorDe(o)); else s.delete(valorDe(o));
        obj[campo] = [...s]; e.target.parentElement.classList.toggle('marcada', e.target.checked); cambio();
      } }), etiquetaDe(o))));
}

// ---------- Fotos (se comprimen y se guardan en el celular; se suben solas cuando hay conexión) ----------
// Devuelve { blob, error }. Primero a 1600 px; si falla o tarda más de 20 s, a 1280 px. Si ninguna funciona:
// foto que el celular no puede abrir → error (no se envía); si solo tardó, se guarda el original (si no pasa de 9 MB).
async function comprimir(archivo) {
  const intentos = [];
  for (const lado of LADOS_COMPRESION) {
    let reloj;
    const limite = new Promise((ok) => { reloj = setTimeout(() => ok('tiempo'), 20_000); });
    try {
      const r = await Promise.race([reducirFoto(archivo, lado), limite]);
      if (r instanceof Blob) return { blob: r, error: r.size > LIMITE_FOTO ? FOTO_PESADA : null };
      intentos.push('tiempo');
    } catch { intentos.push('error'); } finally { clearTimeout(reloj); }
  }
  if (elegirTrasCompresion(intentos) === 'ilegible') return { blob: null, error: FOTO_ILEGIBLE };
  const error = problemaDeFoto({ blob: archivo });
  return { blob: error ? null : archivo, error };
}
async function reducirFoto(archivo, lado) {
  const img = await createImageBitmap(archivo, { imageOrientation: 'from-image' });
  const escala = Math.min(1, lado / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * escala); c.height = Math.round(img.height * escala);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  img.close(); // libera la imagen grande de la memoria (celulares con poca RAM y varias fotos seguidas)
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  c.width = 0; c.height = 0;
  if (!blob) throw new Error('No se pudo reducir la foto');
  return blob;
}
const urls = new Map(); // fid → dirección de la foto guardada en el celular
function srcFoto(x) {
  if (x.blob) { if (!urls.has(x.fid)) urls.set(x.fid, URL.createObjectURL(x.blob)); return urls.get(x.fid); }
  return FOTO_SIN_COPIA; // foto de una versión anterior que quedó solo en el PC
}
const FOTO_SIN_COPIA = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ddd"/><text x="5" y="6.5" font-size="5" text-anchor="middle">📷</text></svg>')}`;
// Quita una foto del celular. El reporte que se envía lleva la lista de fotos, así que el PC también la quita.
async function quitarUnaFoto(x) {
  await L.quitarFoto(x.fid);
  f.fotos = f.fotos.filter((y) => y.fid !== x.fid);
  sincronizarPronto();
}
// Quita las fotos de una actividad o de un vendedor («actividad:vendedor»).
async function quitarFotosDe(clave, { conVendedores = false } = {}) {
  const es = (y) => !y.es_cierre && (y.actividad === clave || (conVendedores && String(y.actividad || '').startsWith(`${clave}:`)));
  for (const x of f.fotos.filter(es)) await quitarUnaFoto(x);
}
let subiendo = 0; // fotos que se están comprimiendo y guardando en el celular
// Al pulsar Enviar con fotos que aún se están preparando: espera hasta 60 s, con un mensaje en pantalla.
async function esperarSubidas() {
  if (subiendo > 0) mostrarMensaje('⏳ Terminando de guardar las fotos en el celular…', 'Espere unos segundos: el envío empieza solo. No cierre el formulario.');
  try {
    for (let i = 0; subiendo > 0 && i < 300; i++) await new Promise((r) => setTimeout(r, 200));
  } finally { mostrarMensaje(null); }
  return subiendo === 0;
}
function bloqueFotos({ actividad = null, cierre = false, max, min = null, titulo = 'Registro fotográfico', que = 'por actividad' }) {
  const propias = f.fotos.filter((x) => (cierre ? x.es_cierre : !x.es_cierre && x.actividad === actividad));
  const cont = h('div', { class: 'fotos' });
  const agregar = async (lista) => {
    // Si la gestora sale a «Mis reportes» mientras se comprimen, las fotos siguen guardándose en SU reporte.
    const rep = f;
    subiendo++;
    try {
      for (const archivo of lista) {
        const ya = rep.fotos.filter((x) => (cierre ? x.es_cierre : !x.es_cierre && x.actividad === actividad)).length;
        if (ya >= max) { aviso(cierre ? 'Solo una fotografía de cierre: quite la actual para reemplazarla.' : `Máximo ${max} fotografías ${que}.`, true); break; }
        const c = await comprimir(archivo);
        // Si mientras se preparaba la foto el reporte ya salió a enviar, no se agrega en silencio a un reporte cerrado.
        const actual = await L.reporte(rep.lid).catch(() => null);
        if (!actual || !actual.editable || actual.enEspera) {
          aviso('Una foto terminó de prepararse después de enviar el reporte y no se agregó. Si la necesita, cancele el envío y adjúntela de nuevo.', true);
          diagnostico(rep.lid, 'foto-tardia', 'Foto que terminó de comprimirse después del envío');
          break;
        }
        // Una foto que no se puede usar queda marcada (⚠) para que la gestora la vea y la cambie; no frena el envío.
        const foto = { fid: `f-${uid()}`, lid: rep.lid, actividad: cierre ? null : actividad, es_cierre: cierre ? 1 : 0, blob: c.blob, sid: null, quitar: false, error: c.error };
        try { await L.ponerFoto(foto); } catch { aviso('No se pudo guardar la foto en este celular. Revise el espacio disponible.', true); break; }
        if (c.error) aviso(`⚠ ${c.error}`, true);
        rep.fotos.push(foto);
        if (f === rep) pintar();
      }
    } finally { subiendo = Math.max(0, subiendo - 1); }
    if (f === rep) await guardarLocal(); // la actividad debe llegar al servidor antes que sus fotos
  };
  poner(cont, propias.map((x) => h('figure', { class: 'miniatura' },
    h('img', { src: srcFoto(x), alt: 'Fotografía adjunta', loading: 'lazy' }),
    !x.sid ? h('span', { class: 'estado-foto', title: x.error || 'Guardada en el celular; se subirá al enviar' }, x.error ? '⚠' : '📱') : null,
    puedeEditar() ? h('button', { type: 'button', class: 'quitar', title: 'Quitar foto', 'aria-label': 'Quitar foto', onclick: async () => {
      if (!(await confirmar('¿Quitar esta foto del reporte?', 'Sí, quitar', 'No'))) return;
      try { await quitarUnaFoto(x); pintar(); } catch (e) { aviso(traducirError(e.message).texto, true); }
    } }, '✕') : null)),
  puedeEditar() && propias.length < max ? h('label', { class: 'agregar-foto' }, `📷 ${propias.length ? 'Agregar otra' : 'Agregar foto'}`,
    h('input', { type: 'file', accept: 'image/*', multiple: !cierre, onchange: (e) => { agregar([...e.target.files]); e.target.value = ''; } })) : null);
  const minimo = cierre ? 1 : min ?? cat.minFotosActividad;
  const etiqueta = cierre ? 'Fotografía de cierre (1 foto)' : minimo
    ? `${titulo} (${propias.length} de mínimo ${minimo}, máximo ${max})` : `${titulo} (${propias.length}, opcional, máximo ${max})`;
  const conError = propias.filter((x) => x.error);
  return h('div', { class: 'ancho' },
    h('div', { class: 'etiqueta' }, minimo ? req(etiqueta) : etiqueta),
    cont,
    conError.length ? h('p', { class: 'chip error' }, `⚠ ${conError[0].error} Quite esa foto y adjunte otra.`) : null,
    propias.length < minimo ? h('p', { class: 'chip alerta' }, cierre ? 'Falta la foto de cierre.' : `Faltan ${minimo - propias.length} foto(s) para el mínimo de ${minimo}.`) : null);
}

// ---------- Pasos ----------
const PASOS = ['Datos generales', 'Actividades', 'Cierre', 'Vista previa'];
const d = () => f.datos;

function pasoGeneral() {
  const g = d().general;
  const nodos = [
    h('h3', {}, `Tipo de operativo: ${f.tipoNombre}`),
    h('div', { class: 'rejilla' },
      texto(g, 'id_operativo', 'ID del operativo (del cronograma)', { placeholder: 'Ej.: 70271', extra: { inputmode: 'text', autocomplete: 'off' } }),
      texto(g, 'fecha', 'Fecha', { tipo: 'date' }),
      texto(g, 'hora_inicio', 'Hora de inicio', { tipo: 'time' }),
      seleccion(g, 'abogado', 'Primer responsable — abogado', cat.abogados),
      seleccion(g, 'gestora', 'Segundo responsable — gestora', cat.gestoras)),
    multiple(g, 'entidades', 'Acompañamiento (puede marcar varias)', cat.entidades),
  ];
  if (f.tipo === 'cerros') {
    const buscar = h('input', { type: 'search', placeholder: 'Buscar polígono por código o nombre…', oninput: (e) => {
      const q = e.target.value.toLowerCase();
      for (const el of lista.children) el.hidden = q && !el.dataset.texto.includes(q);
    } });
    const sel = new Set(g.poligonos || []);
    const lista = h('div', { class: 'poligonos' }, cat.poligonos.map((p) => h('label', { class: `opcion${sel.has(p.codigo) ? ' marcada' : ''}`, 'data-texto': `${p.codigo} ${p.nombre}`.toLowerCase() },
      h('input', { type: 'checkbox', checked: sel.has(p.codigo), onchange: (e) => {
        const s = new Set(g.poligonos || []);
        if (e.target.checked) s.add(p.codigo); else { s.delete(p.codigo); for (const a of d().actividades) a.poligonos = (a.poligonos || []).filter((x) => x !== p.codigo); }
        g.poligonos = [...s]; e.target.parentElement.classList.toggle('marcada', e.target.checked); cambio();
      } }), h('b', { class: 'mono' }, p.codigo), ' ', p.nombre)));
    nodos.push(h('fieldset', { class: 'multiple' }, h('legend', {}, req('Polígonos de monitoreo')),
      cat.poligonosPreliminar ? h('p', { class: 'nota' }, 'Catálogo preliminar (relación histórica de 2016), pendiente de validar con Hábitat.') : null, buscar, lista));
  }
  return nodos;
}

function actividadEstablecimiento(a) {
  return [
    h('div', { class: 'rejilla' },
      texto(a, 'nombre', 'Nombre del establecimiento'),
      texto(a, 'tipo_establecimiento', 'Tipo de establecimiento', { placeholder: 'Ej.: Bar, restaurante, taller' }),
      seleccion(a, 'tipologia', 'Tipología', cat.tipologias),
      texto(a, 'direccion', 'Dirección del establecimiento'),
      texto(a, 'zona', 'Zona', { placeholder: 'Barrio o sector' })),
    multiple(a, 'documentos', 'Documentos presentados — artículo 87', cat.documentos, { obligatorio: false }),
    siNo(a, 'medidas', '¿Se impusieron medidas correctivas?', { limpiar: ['suspension', 'dias'] }),
    a.medidas === 'si' ? siNo(a, 'suspension', '¿Hubo suspensión de la actividad?', { limpiar: ['dias'] }) : null,
    a.suspension === 'si' ? h('div', { class: 'rejilla' }, texto(a, 'dias', '¿Cuántos días de suspensión?', { tipo: 'number', extra: { min: 1, step: 1, inputmode: 'numeric' } })) : null,
    siNo(a, 'ruido', '¿Se realizó prueba de ruido?', { limpiar: ['db_encendida', 'db_apagada'] }),
    a.ruido === 'si' ? h('div', { class: 'rejilla' },
      texto(a, 'db_encendida', 'Decibeles con la fuente encendida (dB)', { tipo: 'number', extra: { min: 0, step: '0.01', inputmode: 'decimal' } }),
      texto(a, 'db_apagada', 'Decibeles con la fuente apagada (dB)', { tipo: 'number', extra: { min: 0, step: '0.01', inputmode: 'decimal' } })) : null,
    siNo(a, 'informe', '¿Se cuenta con informe técnico?'),
    h('div', { class: 'rejilla' }, texto(a, 'observaciones', 'Observaciones (hallazgos, actuaciones y novedades)', { area: true, obligatorio: false })),
  ];
}
function actividadEspacio(a) {
  a.vendedores = a.vendedores || [];
  return [
    h('h4', {}, `Vendedores (${a.vendedores.length})`),
    a.vendedores.map((v, j) => h('div', { class: 'subbloque' },
      h('div', { class: 'cabecera' }, h('b', {}, `Vendedor ${j + 1}`),
        puedeEditar() ? h('button', { type: 'button', class: 'mini', onclick: async () => { if (await confirmar(`¿Quitar el vendedor ${j + 1}? Se quitan también sus fotos.`, 'Quitar')) { await quitarFotosDe(`${a.uid}:${v.uid}`); a.vendedores.splice(j, 1); cambio(); pintar(); } } }, 'Quitar') : null),
      h('div', { class: 'rejilla' }, texto(v, 'nombre', 'Nombre del vendedor')),
      siNo(v, 'ipes', '¿Está registrado en el IPES?'),
      v.ipes ? h('div', { class: 'rejilla' }, texto(v, 'ipes_obs', 'Observaciones sobre el registro en el IPES', { area: true, obligatorio: false })) : null,
      siNo(v, 'retiro', '¿Se retiró voluntariamente?'),
      siNo(v, 'medida_policia', '¿Hubo medida correctiva por parte de la Policía?'),
      bloqueFotos({ actividad: `${a.uid}:${v.uid}`, min: cat.minFotosVendedor, max: cat.maxFotosVendedor, titulo: `Fotos del vendedor ${j + 1}`, que: 'por vendedor' }))),
    puedeEditar() ? h('button', { type: 'button', onclick: () => { a.vendedores.push({ uid: uid() }); cambio(); pintar(); } }, '+ Agregar otro vendedor') : null,
    h('h4', {}, 'Datos de la intervención'),
    h('div', { class: 'rejilla' },
      texto(a, 'tramo', 'Dirección o tramo de intervención'),
      texto(a, 'cantidad_vendedores', 'Cantidad de vendedores intervenidos', { tipo: 'number', extra: { min: 0, step: 1, inputmode: 'numeric' } })),
    a.cantidad_vendedores !== undefined && a.cantidad_vendedores !== '' && Number(a.cantidad_vendedores) !== a.vendedores.length
      ? h('p', { class: 'chip alerta' }, `Declara ${a.cantidad_vendedores} vendedores y registró ${a.vendedores.length}: revise antes de enviar.`) : null,
    h('h4', {}, 'Resultados de la intervención'),
    siNo(a, 'comparendos_movilidad', '¿Hubo comparendos por parte de Movilidad?', { limpiar: ['cantidad_comparendos'] }),
    a.comparendos_movilidad === 'si' ? h('div', { class: 'rejilla' }, texto(a, 'cantidad_comparendos', 'Cantidad de comparendos a vehículos', { tipo: 'number', extra: { min: 1, step: 1, inputmode: 'numeric' } })) : null,
    h('div', { class: 'rejilla' }, texto(a, 'area_m2', 'Área de espacio público recuperada aprox. (m²)', { tipo: 'number', extra: { min: 0, step: '0.01', inputmode: 'decimal' } })),
  ];
}
function actividadCerros(a) {
  const disponibles = cat.poligonos.filter((p) => (d().general.poligonos || []).includes(p.codigo));
  return [
    disponibles.length ? multiple(a, 'poligonos', 'Polígonos asociados', disponibles, { etiquetaDe: (p) => `${p.codigo} ${p.nombre}`, valorDe: (p) => p.codigo })
      : h('p', { class: 'chip alerta' }, 'Primero seleccione los polígonos del operativo en «Datos generales».'),
    h('div', { class: 'rejilla' }, texto(a, 'observaciones', 'Observaciones (recorrido, hallazgos y actuaciones)', { area: true })),
    siNo(a, 'medidas', '¿Hubo medidas correctivas?', { limpiar: ['cantidad_medidas'] }),
    a.medidas === 'si' ? h('div', { class: 'rejilla' }, texto(a, 'cantidad_medidas', '¿Cuántas medidas correctivas?', { tipo: 'number', extra: { min: 1, step: 1, inputmode: 'numeric' } })) : null,
    siNo(a, 'suspensiones', '¿Hubo suspensiones?', { limpiar: ['cantidad_suspensiones'] }),
    a.suspensiones === 'si' ? h('div', { class: 'rejilla' }, texto(a, 'cantidad_suspensiones', '¿Cuántas suspensiones?', { tipo: 'number', extra: { min: 1, step: 1, inputmode: 'numeric' } })) : null,
  ];
}
// ---------- «OK» por actividad (establecimientos): compartir en WhatsApp sin cerrar el operativo ----------
// La gestora reporta cada establecimiento apenas termina, con sus fotos. No cambia los datos del reporte:
// el «OK» se recuerda solo en este celular, y el envío a verificación sigue igual al final.
const claveOk = (a) => `ivc_ok_${f.lid}_${a.uid}`;
const actividadOk = (a) => { try { return localStorage.getItem(claveOk(a)) === '1'; } catch { return false; } };
function marcarOk(a, v) { try { if (v) localStorage.setItem(claveOk(a), '1'); else localStorage.removeItem(claveOk(a)); } catch { /* sin almacenamiento */ } }
const fotosDeActividad = (a) => f.fotos.filter((x) => !x.es_cierre && x.actividad === a.uid);
// Lo que falta de ESTA actividad (mismas reglas del envío final, sin exigir el cierre del operativo).
function erroresActividad(n) {
  const v = validarFormulario(f.tipo, { general: d().general, actividades: d().actividades, cierre: {} }, cat);
  const propio = (e) => e.startsWith(`Actividad ${n}:`) || e.startsWith(`Actividad ${n},`);
  return v.errores.filter(propio); // las fotos no impiden el OK (coordinación revisa)
}
function textoActividadWhatsApp(a, n) {
  const g = d().general;
  const fecha = g.fecha ? g.fecha.split('-').reverse().join('/') : '—';
  const fotos = fotosDeActividad(a).length;
  return [
    '🏪 *ACTIVIDAD IVC – ESTABLECIMIENTOS DE COMERCIO*', `🆔 *ID:* ${g.id_operativo || '—'} · Actividad ${n}`, `📅 *Fecha:* ${fecha}`,
    `🏪 *Establecimiento:* ${a.nombre || '—'}`, `🏷️ *Tipo:* ${a.tipo_establecimiento || '—'}`, `📌 *Tipología:* ${a.tipologia || '—'}`,
    `📍 *Dirección:* ${a.direccion || '—'}`, `📍 *Zona:* ${a.zona || '—'}`,
    [g.abogado, g.gestora].some(Boolean) ? `👤 *Responsables:* ${[g.abogado, g.gestora].filter(Boolean).join(' · ')}` : null,
    (g.entidades || []).length ? `👥 *Acompañamiento:* ${g.entidades.join(', ')}` : null,
    `📄 *Documentos (art. 87):* ${(a.documentos || []).join(', ') || 'Ninguno reportado'}`,
    `⚖️ *Medidas correctivas:* ${a.medidas === 'si' ? 'Sí' : 'No'}`,
    a.medidas === 'si' ? `⛔ *Suspensión:* ${a.suspension === 'si' ? `Sí · ${a.dias} día(s)` : 'No'}` : null,
    `🔊 *Prueba de ruido:* ${a.ruido === 'si' ? `Sí · encendida ${a.db_encendida} dB · apagada ${a.db_apagada} dB` : 'No'}`,
    `📄 *Informe técnico:* ${a.informe === 'si' ? 'Sí' : 'No'}`,
    a.observaciones ? `🔎 *Observaciones:* ${a.observaciones}` : null,
    fotos ? `📷 *Registro fotográfico:* ${fotos} foto(s)` : null,
    '', '⏳ _Reporte en curso: pendiente de verificación por coordinación._',
  ].filter((x) => x !== null).join('\n');
}
function bloqueActividad(a, n) {
  const g = d().general;
  return { texto: textoActividadWhatsApp(a, n), fotos: fotosDeActividad(a), prefijo: `ID${g.id_operativo || ''}-actividad${n}`,
    titulo: `ID ${g.id_operativo || '—'} · Actividad ${n} de ${d().actividades.length}`, subtitulo: [a.nombre, g.fecha && g.fecha.split('-').reverse().join('/')].filter(Boolean).join(' · ') };
}

// ---------- Compartir en WhatsApp ----------
// Se comparten las fotos tal como quedaron guardadas en el celular (sin marcas ni rótulos) y el texto como pie.
async function blobDe(x) {
  if (x.blob) return x.blob;
  const r = await fetch(srcFoto(x));
  if (!r.ok) throw new Error('No se pudo cargar una foto: revise la conexión e intente de nuevo.');
  return r.blob();
}
async function compartirBloque(b) {
  try {
    const files = await Promise.all(b.fotos.map(async (x, i) => {
      const blob = await blobDe(x);
      return new File([blob], nombreArchivoCompartir(b.prefijo, i, blob.type), { type: blob.type || 'image/jpeg' });
    }));
    if (files.length && navigator.canShare && navigator.canShare({ files, text: b.texto })) { await navigator.share({ files, text: b.texto }); return; }
    if (navigator.share) { await navigator.share({ text: b.texto }); if (files.length) aviso('Se compartió el texto; agregue las fotos desde WhatsApp.'); return; }
    await copiarTexto(b.texto);
  } catch (e) { if (e?.name !== 'AbortError') aviso(e.message || 'No se pudo compartir', true); }
}
function botonesCompartir(b) {
  const n = b.fotos.length;
  return [
    h('button', { type: 'button', class: 'principal grande', onclick: () => compartirBloque(b) }, `📤 Compartir${n ? ` con ${n} foto(s)` : ''}`),
    h('button', { type: 'button', onclick: () => copiarTexto(b.texto) }, '📋 Copiar texto')];
}
function bloqueOk(a, n) {
  if (f.tipo !== 'establecimientos') return null;
  if (!actividadOk(a)) {
    return h('div', { class: 'ok-actividad' },
      h('button', { type: 'button', class: 'principal grande', onclick: () => {
        const errs = erroresActividad(n);
        if (errs.length) { aviso(`Antes del OK complete: ${errs.slice(0, 3).map((e) => e.replace(/^Actividad \d+: /, '')).join(' · ')}${errs.length > 3 ? ' …' : ''}`, true); return; }
        marcarOk(a, true); pintar();
      } }, '✅ OK – actividad terminada'),
      h('p', { class: 'nota' }, 'Al dar OK puede enviar esta actividad con sus fotos por WhatsApp, sin cerrar el operativo.'));
  }
  const b = bloqueActividad(a, n);
  return h('div', { class: 'panel whatsapp-actividad' },
    h('h4', {}, `📲 Enviar la actividad ${n} por WhatsApp`),
    h('div', { class: 'acciones' }, ...botonesCompartir(b),
      h('button', { type: 'button', class: 'mini', onclick: () => { marcarOk(a, false); pintar(); } }, 'Ocultar')),
    h('p', { class: 'nota' }, '«Compartir» abre WhatsApp con las fotos y el texto para elegir el grupo. El operativo sigue abierto: continúe con la siguiente actividad y, al final, envíe todo a verificación como siempre.'),
    h('pre', { class: 'wa-texto' }, b.texto));
}
const NOMBRE_ACT = { establecimientos: 'Establecimiento', espacio: 'Tramo o intervención', cerros: 'Actividad de monitoreo' };
const AGREGAR = { establecimientos: '+ Agregar otro establecimiento', espacio: '+ Agregar otro tramo', cerros: '+ Agregar otra actividad' };
// Una pestaña por actividad: se trabaja una a la vez y cada una tiene su botón «Eliminar actividad».
const nombreCorto = (a) => a.nombre || a.tramo || (a.poligonos || []).join(', ') || '';
function pasoActividades() {
  const acts = d().actividades;
  actSel = Math.min(Math.max(0, actSel), acts.length - 1);
  const a = acts[actSel];
  const irA = (i) => { actSel = i; recordarUbicacion(); pintar(); window.scrollTo(0, 0); };
  const eliminar = async () => {
    const etiqueta = `${NOMBRE_ACT[f.tipo].toLowerCase()} ${actSel + 1}${nombreCorto(a) ? ` (${nombreCorto(a)})` : ''}`;
    if (!(await confirmar(`¿Eliminar la ${etiqueta}? Se eliminan también sus datos y sus fotos.`, 'Eliminar actividad'))) return;
    await quitarFotosDe(a.uid, { conVendedores: true });
    acts.splice(actSel, 1);
    if (!acts.length) acts.push({ uid: uid() });
    actSel = Math.max(0, actSel - 1);
    recordarUbicacion(); pintar(); aviso('Actividad eliminada');
  };
  const fotosDe = (x) => f.fotos.filter((y) => !y.es_cierre && (y.actividad === x.uid || String(y.actividad || '').startsWith(`${x.uid}:`))).length;
  return [
    h('div', { class: 'pestanas-act', role: 'tablist' },
      acts.map((x, i) => h('button', { type: 'button', role: 'tab', class: i === actSel ? 'activa' : '', 'aria-selected': String(i === actSel), onclick: () => irA(i) },
        h('b', {}, `${i + 1}`), ` ${(nombreCorto(x) || NOMBRE_ACT[f.tipo]).slice(0, 22)}`, fotosDe(x) ? ` · 📷${fotosDe(x)}` : '', actividadOk(x) ? ' ✅' : ''))),
    h('section', { class: 'actividad' },
      h('div', { class: 'cabecera' }, h('h3', {}, `${NOMBRE_ACT[f.tipo]} ${actSel + 1} de ${acts.length}${nombreCorto(a) ? ` · ${nombreCorto(a)}` : ''}`),
        puedeEditar() ? h('button', { type: 'button', class: 'mini peligro', onclick: eliminar }, '🗑 Eliminar actividad') : null),
      f.tipo === 'establecimientos' ? actividadEstablecimiento(a) : f.tipo === 'espacio' ? actividadEspacio(a) : actividadCerros(a),
      f.tipo === 'espacio'
        ? bloqueFotos({ actividad: a.uid, min: 0, max: cat.fotosPorTipo.espacio.max, titulo: 'Registro fotográfico general de la intervención' })
        : bloqueFotos({ actividad: a.uid, min: cat.fotosPorTipo[f.tipo].min, max: cat.fotosPorTipo[f.tipo].max }),
      bloqueOk(a, actSel + 1)),
    acts.length > 1 ? h('div', { class: 'acciones' },
      actSel > 0 ? h('button', { type: 'button', class: 'mini', onclick: () => irA(actSel - 1) }, `← Actividad ${actSel}`) : null,
      actSel < acts.length - 1 ? h('button', { type: 'button', class: 'mini', onclick: () => irA(actSel + 1) }, `Actividad ${actSel + 2} →`) : null) : null,
    // Agregar va al final de la actividad, separado del botón «Continuar al cierre del operativo».
    puedeEditar() ? h('button', { type: 'button', class: 'agregar-actividad', onclick: () => { acts.push({ uid: uid() }); irA(acts.length - 1); } }, AGREGAR[f.tipo]) : null,
  ];
}
function pasoCierre() {
  const c = d().cierre;
  return [
    h('div', { class: 'rejilla' },
      texto(c, 'hora_fin', 'Hora de finalización', { tipo: 'time' }),
      texto(c, 'resumen', 'Resumen de cierre del operativo (lo realizado, resultados, novedades y compromisos)', { area: true })),
    bloqueFotos({ cierre: true, max: 1 }),
  ];
}
// Revisión en el celular con las mismas reglas del servidor (funciona sin conexión).
function revisar() {
  const v = validarFormulario(f.tipo, d(), cat);
  // Las fotos (que falten o que no hayan quedado bien guardadas) solo se avisan: el reporte se puede enviar y coordinación decide.
  const avisosFotos = [...f.fotos.filter((y) => y.error).map((x) => `Una foto tiene un problema y no se enviará: ${x.error}`), ...erroresFotos(v.actividades, f.fotos, f.tipo, cat)];
  return { errores: v.errores, avisosFotos, consolidado: consolidado(f.tipo, v.actividades) };
}
function pasoVista(cont) {
  const r = revisar();
  const g = d().general;
  const fotosDe = (a) => f.fotos.filter((x) => !x.es_cierre && (x.actividad === a.uid || String(x.actividad || '').startsWith(`${a.uid}:`))).length;
  const enCelular = f.fotos.filter((x) => !x.sid).length;
  const corrigiendo = ['Requiere corrección', 'No se pudo procesar'].includes(f.estado);
  poner(cont,
    r.errores.length ? h('div', { class: 'panel suave' }, h('b', {}, `Antes de enviar, complete (${r.errores.length}):`), h('ul', {}, r.errores.map((e) => h('li', {}, e))))
      : h('p', { class: 'chip ok' }, '✓ El formulario está completo.'),
    r.avisosFotos.length ? h('div', { class: 'panel suave' }, h('b', {}, 'Fotografías (puede enviar igual; coordinación lo revisa):'), h('ul', {}, r.avisosFotos.map((e) => h('li', {}, e)))) : null,
    f.error ? h('p', { class: 'chip error' }, `El último envío no se pudo completar: ${f.error}`) : null,
    corrigiendo && f.observaciones ? h('p', { class: 'chip error' }, `Motivo: ${f.observaciones}`) : null,
    h('div', { class: 'panel' }, h('h3', {}, 'Datos generales'),
      h('dl', { class: 'resumen' }, [['Tipo', f.tipoNombre], ['ID', g.id_operativo], ['Fecha', g.fecha], ['Hora de inicio', g.hora_inicio], ['Primer responsable', g.abogado],
        ['Segundo responsable', g.gestora], ['Acompañamiento', (g.entidades || []).join(', ')], ...(f.tipo === 'cerros' ? [['Polígonos', (g.poligonos || []).join(', ')]] : [])]
        .map(([k, v]) => [h('dt', {}, k), h('dd', {}, v || '—')]))),
    h('div', { class: 'panel' }, h('h3', {}, `Actividades (${d().actividades.length})`),
      h('ol', {}, d().actividades.map((a) => h('li', {}, a.nombre || a.tramo || (a.poligonos || []).join(', ') || 'Sin nombre', ` · 📷 ${fotosDe(a)}`)))),
    h('div', { class: 'panel' }, h('h3', {}, 'Consolidado (calculado del detalle)'),
      h('dl', { class: 'resumen' }, Object.entries(r.consolidado).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
    h('div', { class: 'panel' }, h('h3', {}, 'Cierre'), h('p', {}, `Hora de finalización: ${d().cierre.hora_fin || '—'}`), h('p', {}, d().cierre.resumen || '—'),
      h('p', {}, `Fotografía de cierre: ${f.fotos.some((x) => x.es_cierre) ? '✓ adjunta' : 'falta'}`)),
    enCelular ? h('p', { class: 'nota' }, `📱 ${enCelular} foto(s) están guardadas en el celular y se subirán al enviar.`) : null,
    puedeEditar() ? h('div', { class: 'acciones enviar' }, h('button', { type: 'button', class: 'principal grande', disabled: r.errores.length > 0, onclick: enviar },
      corrigiendo ? 'Reenviar a verificación' : 'Enviar a verificación')) : null,
    h('p', { class: 'nota' }, 'Al enviar, el reporte y sus fotos van al buzón y llegan al aplicativo para verificación (aunque el PC de coordinación esté apagado, se reciben cuando lo enciendan). Solo después de confirmado se registra en la Matriz General IVC. Si no hay señal, queda en espera en el celular y se envía solo cuando la haya.'));
}

async function enviar(e) {
  e.target.disabled = true;
  try {
    if (!(await esperarSubidas())) { subiendo = 0; diagnostico(f.lid, 'fotos-guardando', 'Fotos que no terminaban de guardarse al enviar'); }
    // Si no se pudo guardar lo digitado, no se envía (saldría la versión anterior).
    try { await guardarLocal({ lanzar: true }); } catch (err) {
      diagnostico(f.lid, 'sin-espacio', err.tecnico || err.message);
      e.target.disabled = false; pintar(); return;
    }
    const r = revisar();
    if (r.errores.length) { diagnostico(f.lid, 'bloqueado', r.errores.join(' | ')); e.target.disabled = false; pintar(); return aviso(`Complete antes de enviar: ${r.errores.slice(0, 2).join(' · ')}${r.errores.length > 2 ? ' …' : ''}`, true); }
    const lid = f.lid;
    await actualizarReporte(lid, { enEspera: true, error: null, motivoEspera: null });
    aviso('Enviando…');
    // Si ya había un envío en curso, se repite una vez para que tome este reporte.
    for (let i = 0; i < 2; i++) { await sincronizar({ ahora: true }).catch(() => {}); const q = await L.reporte(lid); if (!q?.enEspera || !enLinea || necesitaIngreso) break; }
    const quedo = await L.reporte(lid);
    if (!quedo || !quedo.editable) return; // ya llegó al buzón: terminarEnviado mostró la confirmación
    if (quedo.enEspera) { f = null; mostrarEnEspera(quedo); }
    else { aviso(quedo.error || 'No se pudo enviar.', true); f = { ...f, ...quedo }; pintar(); }
  } catch (err) { aviso(traducirError(err.message).texto, true); e.target.disabled = false; }
}
// El reporte quedó guardado y en espera: el mensaje dice por qué y qué hacer.
function mostrarEnEspera(r) {
  const m = necesitaIngreso ? 'pase' : r.motivoEspera || 'red';
  const t = textoEspera(m);
  poner(vista, h('div', { class: 'panel exito' }, h('h2', {}, t.titulo),
    h('p', {}, `Operativo ${r.datos?.general?.id_operativo || '—'} · ${r.datos?.actividades?.length || 0} actividad(es).`),
    h('p', {}, t.texto),
    h('p', { class: 'nota' }, `No borre los datos del navegador ni desinstale la aplicación hasta que el reporte aparezca como «${EN_BUZON}».`),
    h('div', { class: 'acciones' },
      m === 'pase' ? h('button', { class: 'principal', onclick: () => { olvidarIngreso(); iniciar(); } }, 'Ingresar de nuevo') : null,
      h('button', { class: m === 'pase' ? '' : 'principal', onclick: () => inicio() }, 'Volver a mis reportes'))));
}
// Cancela el envío pendiente para poder editar (de forma explícita, con confirmación).
async function cancelarEnvio(lid) {
  if (enviandoAhora === lid) { aviso('Se está enviando en este momento: espere a que termine.', true); return false; }
  if (!(await confirmar('¿Cancelar el envío para editar? El reporte queda en este celular sin enviar; cuando termine de corregir, pulse «Enviar a verificación» de nuevo.', 'Sí, cancelar el envío', 'No, dejarlo en espera'))) return false;
  if (enviandoAhora === lid) { aviso('Se está enviando en este momento: espere a que termine.', true); return false; }
  await actualizarReporte(lid, (r) => ({ enEspera: false, motivoEspera: null, ...(r.intentado ? { envio: (r.envio || 0) + 1, intentado: false } : {}) }));
  pintarConexion();
  aviso('Envío cancelado: ya puede editar el reporte.');
  return true;
}
function mostrarEnviado(r) {
  const c = consolidado(r.tipo, validarFormulario(r.tipo, r.datos, cat).actividades);
  poner(vista, h('div', { class: 'panel exito' }, h('h2', {}, '✅ Reporte enviado a verificación'),
    h('p', {}, `Operativo ${r.datos?.general?.id_operativo || ''} · ${r.datos?.actividades?.length || 0} actividad(es). Quedó en el buzón: llega al aplicativo de coordinación aunque el PC esté apagado (se recibe al encenderlo).`),
    h('dl', { class: 'resumen' }, Object.entries(c).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h('div', { class: 'acciones' }, h('button', { class: 'principal grande', onclick: () => verWhatsApp(r.lid).catch((e) => aviso(e.message, true)) }, '📲 Compartir en WhatsApp'),
      h('button', { onclick: () => inicio() }, 'Volver a mis reportes'))));
}

function pintar() {
  if (!f) return;
  const y = window.scrollY;
  const cont = h('div', { class: 'paso' });
  const cuerpo = [pasoGeneral, pasoActividades, pasoCierre][paso];
  if (cuerpo) poner(cont, cuerpo()); else pasoVista(cont);
  const estado = !f.editable ? `Solo lectura · ${f.estado || ''}` : f.enEspera ? '📤 En espera de envío (solo lectura)' : '✓ Guardado en el celular';
  const lid = f.lid;
  poner(vista,
    h('div', { class: 'acciones' }, h('button', { type: 'button', class: 'mini', onclick: async () => { await guardarLocal(); inicio(); } }, '← Mis reportes'),
      h('span', { id: 'guardado', class: 'guardado' }, estado)),
    f.editable && f.enEspera ? h('div', { class: 'panel suave' },
      h('p', {}, h('b', {}, '📤 Este reporte está en espera de envío y no se puede cambiar. '), textoEspera(necesitaIngreso ? 'pase' : f.motivoEspera || 'red').texto),
      h('div', { class: 'acciones' }, h('button', { type: 'button', onclick: async () => { if (await cancelarEnvio(lid) && f?.lid === lid) pintar(); } }, '✏️ Cancelar el envío para editar'))) : null,
    f.cerradoPorCoordinacion ? h('p', { class: 'chip alerta' }, `Coordinación ya cerró este reporte (${f.estado}): los cambios que haga aquí no se enviarán.`) : null,
    f.observaciones ? h('div', { class: 'panel suave' }, h('b', {}, 'Observaciones de coordinación: '), f.observaciones) : null,
    h('ol', { class: 'pasos' }, PASOS.map((t, i) => h('li', { class: i === paso ? 'actual' : i < paso ? 'hecho' : '' },
      h('button', { type: 'button', onclick: () => irPaso(i) }, `${i + 1}. ${t}`)))),
    h('div', { class: 'panel' }, h('h2', {}, PASOS[paso]), cont),
    h('div', { class: 'acciones navegacion' },
      paso > 0 ? h('button', { type: 'button', onclick: () => irPaso(paso - 1) }, '← Anterior') : h('span'),
      paso < PASOS.length - 1 ? h('button', { type: 'button', class: 'principal', onclick: () => irPaso(paso + 1) },
        paso === 1 ? 'Continuar al cierre del operativo →' : 'Siguiente →') : null));
  // Reporte ya enviado o revisado: solo lectura.
  if (!puedeEditar()) for (const el of cont.querySelectorAll('input, select, textarea')) el.disabled = true;
  window.scrollTo(0, y);
}

function irPaso(i) { paso = Math.min(Math.max(0, i), PASOS.length - 1); recordarUbicacion(); pintar(); window.scrollTo(0, 0); }

function prepararDatos(datos) {
  const x = datos || {};
  x.general = x.general || {};
  x.actividades = x.actividades?.length ? x.actividades : [{ uid: uid() }];
  x.cierre = x.cierre || {};
  return x;
}
async function mostrar(registro, fotos) {
  f = { ...registro, datos: prepararDatos(registro.datos), fotos: fotos.filter((x) => !x.quitar) };
  const u = f.datos._ubicacion || {};
  paso = Number.isInteger(u.paso) ? Math.min(Math.max(0, u.paso), PASOS.length - 1) : 0;
  actSel = Number.isInteger(u.actividad) ? u.actividad : 0;
  pintar();
}
// Abre un reporte guardado en el celular.
async function abrirLocal(lid) {
  const r = await L.reporte(lid);
  if (!r) throw new Error('El reporte ya no está en este celular.');
  await mostrar(r, await L.fotos(lid));
}
async function abrir(item) {
  try {
    if (item.lid && await L.reporte(item.lid)) return await abrirLocal(item.lid);
    aviso('Este reporte no está guardado en este celular (se hizo en otro equipo o ya se revisó). Coordinación lo tiene en el aplicativo.', true);
  } catch (e) { aviso(e.message, true); }
}
// Un doble toque en «Nuevo reporte» no crea dos borradores.
const crearReporte = unaVez((t, general) => nuevoReporte(t, general));
async function nuevoReporte(t, general = null) {
  const lid = `r-${uid()}-${Date.now().toString(36)}`;
  const registro = { lid, usuarioId: yo.id, sid: null, tipo: t.clave, tipoNombre: t.nombre, datos: prepararDatos(general ? { general } : {}), version: 0, estado: 'Borrador', editable: true,
    observaciones: null, sucio: true, rev: 1, enEspera: false, error: null, envio: 0, actualizado: Date.now() };
  await enFila(() => L.ponerReporte(registro));
  await mostrar(registro, []);
}

// ---------- Estado que publica el PC (en el buzón) ----------
// estados: [{ lid, estado, observaciones, sincronizacion, envio, … }] de los reportes de esta gestora.
// Si coordinación lo devuelve (o no se pudo procesar), vuelve a ser editable en el celular para corregirlo y reenviarlo.
// Ya confirmado o rechazado, la copia del celular (datos y fotos) se borra para liberar espacio.
// (FINALES, CORREGIR y decidirEstado están en la lógica pura, al comienzo.)
async function aplicarEstados(estados) {
  if (!Array.isArray(estados)) return;
  for (const e of estados) {
    const r = await L.reporte(e.lid);
    const decision = decidirEstado(r, e, yo.id);
    if (!decision) continue;
    if (decision.borrar) { if (f?.lid !== r.lid) await enFila(() => L.borrarReporte(r.lid)); continue; }
    await actualizarReporte(r.lid, decision.cambios);
    if (f?.lid === r.lid) {
      if (decision.cambios.cerradoPorCoordinacion) aviso(`Coordinación ya cerró este reporte (${e.estado}): los cambios que haga aquí no se enviarán.`, true);
      pintar();
    }
  }
}
// Catálogos, actividades programadas y estados (del buzón; si no hay internet, la última copia del celular).
async function actualizarDatos() {
  try {
    const j = await buzon('buzon_datos', conPase(), { espera: 20_000 });
    if (j.catalogos) { cat = j.catalogos; guardarJSON('ivc_catalogos', cat); }
    guardarJSON(`ivc_programadas_${yo.id}`, j.programadas || []);
    guardarJSON(`ivc_estados_${yo.id}`, j.estados || []);
    await aplicarEstados(j.estados);
    return true;
  } catch (e) {
    if (!e.red) aviso(e.message, true);
    return false;
  }
}

// ---------- Mis actividades programadas (Cronograma IVC) ----------
// Lo que el Cronograma le asigna a la gestora (3 días atrás a 7 adelante). «Reportar esta actividad» abre el
// formulario con fecha, hora, ID, abogado y acompañamiento ya puestos, y deja el reporte asociado a esa actividad.
const TIPO_DESDE_CRONOGRAMA = { 'Establecimiento de Comercio': 'establecimientos', 'Espacio Público': 'espacio', 'Cerros Orientales': 'cerros' };
const ENTIDAD_DESDE_CRONOGRAMA = [[/\bponal\b|polic/i, 'Policía Nacional'], [/\bsdm\b|movilidad/i, 'Secretaría de Movilidad'], [/\bsdgdgp\b|gobierno/i, 'Secretaría de Gobierno'],
  [/ambiente|\bsda\b/i, 'Secretaría de Ambiente'], [/\bcar\b/i, 'CAR'], [/planeaci/i, 'Secretaría Distrital de Planeación'], [/\bsdde\b|desarrollo econ/i, 'Secretaría de Desarrollo Económico']];
const sinT = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function mismaPersona(a, b) {
  const pa = sinT(a).split(' ').filter((x) => x.length > 1), pb = sinT(b).split(' ').filter((x) => x.length > 1);
  if (pa.length < 2 || pb.length < 2) return false;
  const [c, l] = pa.length <= pb.length ? [pa, new Set(pb)] : [pb, new Set(pa)];
  return c.every((x) => l.has(x));
}
function generalDesdeCronograma(a) {
  const entidades = [...new Set(ENTIDAD_DESDE_CRONOGRAMA.filter(([re]) => re.test(a.articulacion || '')).map(([, e]) => e))].filter((e) => cat.entidades.includes(e));
  return {
    id_operativo: a.id || '', fecha: a.fecha || '', hora_inicio: /^\d{2}:\d{2}$/.test(a.hora || '') ? a.hora : '',
    abogado: cat.abogados.find((x) => (a.responsables || []).some((r) => mismaPersona(x, r))) || '',
    gestora: cat.gestoras.find((x) => mismaPersona(x, yo.nombre)) || cat.gestoras.find((x) => x === yo.nombre) || '',
    entidades, _crono: a.clave,
  };
}
function panelProgramadas(locales) {
  const lista = leerJSON(`ivc_programadas_${yo.id}`);
  if (!lista?.length) return null;
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const cuando = (fe) => (fe === hoy ? 'Hoy' : new Date(`${fe}T12:00:00`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'short' }));
  const enCelular = (a) => locales.find((r) => r.datos?.general?._crono === a.clave || (a.formulario && r.lid === a.formulario));
  return h('div', { class: 'panel programadas' }, h('h2', {}, `Mis actividades programadas (${lista.length})`),
    h('p', { class: 'nota' }, 'Según el Cronograma IVC. Use «Reportar esta actividad» para que el reporte quede asociado y con los datos ya puestos.'),
    lista.map((a) => {
      const tipo = TIPO_DESDE_CRONOGRAMA[a.tipo];
      const local = enCelular(a);
      const t = tipo && cat.tipos.find((x) => x.clave === tipo);
      return h('div', { class: `programada ${a.estado === 'Sin reporte' ? 'atrasada' : ''}` },
        h('div', {}, h('b', {}, `${cuando(a.fecha)} · ${a.hora || ''} · ${a.tipo}`), a.estado === 'Sin reporte' ? [' ', chip('Sin reporte')] : null,
          a.descripcion ? h('div', {}, a.descripcion) : null,
          a.punto ? h('div', { class: 'nota' }, `📍 ${a.punto}`) : null,
          a.responsables?.length ? h('div', { class: 'nota' }, `⚖️ ${a.responsables.join(', ')}`) : null),
        h('div', { class: 'acciones' },
          local ? h('button', { type: 'button', class: 'principal', onclick: () => abrir({ lid: local.lid }) }, local.editable ? 'Continuar el reporte' : 'Ver el reporte')
            : a.formulario ? h('span', { class: 'nota' }, 'Ya se reportó desde otro equipo.')
              : t ? h('button', { type: 'button', class: 'principal', onclick: () => crearReporte(t, generalDesdeCronograma(a)).catch((e) => aviso(e.message, true)) }, '📝 Reportar esta actividad')
                : h('span', { class: 'nota' }, 'Este tipo de operativo aún no tiene formulario.')));
    }));
}

// ---------- Compartir en WhatsApp (con lo guardado en el celular) ----------
async function copiarTexto(t) {
  try { await navigator.clipboard.writeText(t); aviso('Texto copiado: péguelo en WhatsApp'); } catch { aviso('No se pudo copiar: mantenga presionado el texto y cópielo', true); }
}
const SI_NO = (v) => (v === 'si' ? 'Sí' : 'No');
function textoActividadLocal(tipo, g, a, n, fotos, nota) {
  const fecha = g.fecha ? g.fecha.split('-').reverse().join('/') : '—';
  const enc = { establecimientos: '🏪 *ACTIVIDAD IVC – ESTABLECIMIENTOS DE COMERCIO*', espacio: '🛒 *ACTIVIDAD IVC – ESPACIO PÚBLICO*', cerros: '⛰️ *ACTIVIDAD IVC – CERROS ORIENTALES*' }[tipo];
  const lineas = [enc, `🆔 *ID:* ${g.id_operativo || '—'} · Actividad ${n}`, `📅 *Fecha:* ${fecha}`];
  if (tipo === 'establecimientos') {
    lineas.push(`🏪 *Establecimiento:* ${a.nombre || '—'}`, `🏷️ *Tipo:* ${a.tipo_establecimiento || '—'}`, `📌 *Tipología:* ${a.tipologia || '—'}`,
      `📍 *Dirección:* ${a.direccion || '—'}`, `📍 *Zona:* ${a.zona || '—'}`, `📄 *Documentos (art. 87):* ${(a.documentos || []).join(', ') || 'Ninguno reportado'}`,
      `⚖️ *Medidas correctivas:* ${SI_NO(a.medidas)}`, a.medidas === 'si' ? `⛔ *Suspensión:* ${a.suspension === 'si' ? `Sí · ${a.dias} día(s)` : 'No'}` : null,
      `🔊 *Prueba de ruido:* ${a.ruido === 'si' ? `Sí · encendida ${a.db_encendida} dB · apagada ${a.db_apagada} dB` : 'No'}`, `📄 *Informe técnico:* ${SI_NO(a.informe)}`);
  } else if (tipo === 'espacio') {
    lineas.push(`📍 *Tramo:* ${a.tramo || '—'}`, `👥 *Vendedores intervenidos:* ${a.cantidad_vendedores ?? '—'}`,
      ...(a.vendedores || []).map((v, i) => `  ${i + 1}. ${v.nombre || '—'} · IPES: ${SI_NO(v.ipes)} · Retiro voluntario: ${SI_NO(v.retiro)} · Medida Policía: ${SI_NO(v.medida_policia)}`),
      `🚗 *Comparendos de Movilidad:* ${a.comparendos_movilidad === 'si' ? a.cantidad_comparendos : 'No'}`, `📐 *Área recuperada:* ${a.area_m2 ?? '—'} m²`);
  } else {
    lineas.push(`🗺️ *Polígonos:* ${(a.poligonos || []).join(', ') || '—'}`, `⚖️ *Medidas correctivas:* ${a.medidas === 'si' ? a.cantidad_medidas : 'No'}`,
      `⛔ *Suspensiones:* ${a.suspensiones === 'si' ? a.cantidad_suspensiones : 'No'}`);
  }
  lineas.push([g.abogado, g.gestora].some(Boolean) ? `👤 *Responsables:* ${[g.abogado, g.gestora].filter(Boolean).join(' · ')}` : null,
    (g.entidades || []).length ? `👥 *Acompañamiento:* ${g.entidades.join(', ')}` : null,
    a.observaciones ? `🔎 *Observaciones:* ${a.observaciones}` : null, fotos ? `📷 *Registro fotográfico:* ${fotos} foto(s)` : null, nota);
  return lineas.filter((x) => x !== null && x !== undefined).join('\n');
}
async function verWhatsApp(lid) {
  f = null;
  const r = await L.reporte(lid);
  if (!r) throw new Error('El reporte ya no está en este celular.');
  const fotos = (await L.fotos(lid)).filter((x) => !x.quitar);
  const g = r.datos.general || {};
  const idTxt = g.id_operativo || '—';
  const nota = r.estado === 'Confirmado' ? '' : '\n⏳ _Pendiente de verificación por coordinación._';
  const deAct = (a) => fotos.filter((x) => !x.es_cierre && (x.actividad === a.uid || String(x.actividad || '').startsWith(`${a.uid}:`)));
  const acts = r.datos.actividades || [];
  const c = consolidado(r.tipo, validarFormulario(r.tipo, r.datos, cat).actividades);
  const resumen = [`🏁 *OPERATIVO ${idTxt} – ${String(r.tipoNombre || '').toUpperCase()}*`, `📅 *Fecha:* ${g.fecha ? g.fecha.split('-').reverse().join('/') : '—'}`,
    `⏰ *Horario:* ${[g.hora_inicio, r.datos.cierre?.hora_fin].filter(Boolean).join(' – ') || '—'}`,
    `👤 *Responsables:* ${[g.abogado, g.gestora].filter(Boolean).join(' · ') || '—'}`, (g.entidades || []).length ? `👥 *Acompañamiento:* ${g.entidades.join(', ')}` : null,
    '', `📋 *Actividades (${acts.length}):*`, ...acts.map((a, i) => `• ${i + 1}. ${a.nombre || a.tramo || (a.poligonos || []).join(', ') || ''}`), '',
    ...Object.entries(c).map(([k, v]) => `• ${k}: ${v}`), r.datos.cierre?.resumen ? `\n📝 *Cierre:* ${r.datos.cierre.resumen}` : null, nota].filter((x) => x !== null).join('\n');
  const fechaTxt = g.fecha ? g.fecha.split('-').reverse().join('/') : '';
  const nombreAct = (a) => a.nombre || a.tramo || (a.poligonos || []).join(', ') || '';
  const bloques = [{ clave: 'op', pestana: '🏁 Operativo completo', texto: resumen, fotos: fotos.filter((x) => x.es_cierre && x.blob), prefijo: `ID${idTxt}-cierre`,
    titulo: `ID ${idTxt} · Cierre del operativo`, subtitulo: [r.tipoNombre, fechaTxt].filter(Boolean).join(' · ') },
  ...acts.map((a, i) => ({ clave: a.uid, pestana: `${i + 1}. ${nombreAct(a).slice(0, 20)}`,
    texto: textoActividadLocal(r.tipo, g, a, i + 1, deAct(a).length, nota), fotos: deAct(a).filter((x) => x.blob), prefijo: `ID${idTxt}-actividad${i + 1}`,
    titulo: `ID ${idTxt} · Actividad ${i + 1} de ${acts.length}`, subtitulo: [nombreAct(a), fechaTxt].filter(Boolean).join(' · ') }))];
  let sel = 'op';
  const cont = h('div', {});
  const pintarWa = () => {
    const b = bloques.find((x) => x.clave === sel);
    poner(cont,
      h('div', { class: 'pestanas-act' }, bloques.map((x) => h('button', { type: 'button', class: x.clave === sel ? 'activa' : '', onclick: () => { sel = x.clave; pintarWa(); } }, x.pestana))),
      h('div', { class: 'acciones' }, ...botonesCompartir(b)),
      h('pre', { class: 'wa-texto' }, b.texto),
      b.fotos.length ? h('div', { class: 'fotos' }, b.fotos.map((x) => h('figure', { class: 'miniatura' }, h('img', { src: srcFoto(x), alt: 'Foto', loading: 'lazy' })))) : null);
  };
  pintarWa();
  poner(vista,
    h('div', { class: 'acciones' }, h('button', { type: 'button', class: 'mini', onclick: () => inicio() }, '← Mis reportes')),
    h('div', { class: 'panel' }, h('h2', {}, `📲 Compartir en WhatsApp · ${idTxt}`),
      r.estado !== 'Confirmado' ? h('p', { class: 'chip alerta' }, 'Aún está pendiente de verificación: el texto lo indica al final.') : null,
      h('p', { class: 'nota' }, 'Elija «Operativo completo» o una actividad y pulse «Compartir»: se abre WhatsApp con las fotos y el texto para elegir el grupo. Comparta una actividad a la vez.'),
      cont));
}

// Descarta un reporte del celular (con confirmación). Queda anotado para no volver a mostrar su estado viejo.
async function descartar(r) {
  const nuncaEnviado = !r.envio && !r.intentado && r.estado !== 'No se pudo procesar';
  const texto = nuncaEnviado ? '¿Descartar este borrador? No se ha enviado; se borra de este celular con sus fotos.'
    : '¿Descartar este reporte? Coordinación no lo recibió en el aplicativo. Se borra de este celular con sus fotos y no se volverá a enviar.';
  if (!(await confirmar(texto, 'Sí, descartar', 'No, conservarlo'))) return;
  await enFila(() => L.borrarReporte(r.lid));
  if (!nuncaEnviado) guardarJSON(`ivc_descartados_${yo.id}`, [r.lid, ...(leerJSON(`ivc_descartados_${yo.id}`) || [])].slice(0, 200));
  aviso('Reporte descartado.');
  inicio();
}

// ---------- Inicio: mis reportes (los del celular y el estado que publica el PC) ----------
async function inicio({ retomar = false } = {}) {
  f = null;
  const locales = (await L.reportes(yo.id)).sort((a, b) => (b.actualizado || 0) - (a.actualizado || 0));
  const enCelular = new Set(locales.map((r) => r.lid));
  // Reportes que ya no están en este celular (confirmados, rechazados o hechos en otro equipo): solo se muestra su estado.
  const descartados = new Set(leerJSON(`ivc_descartados_${yo.id}`) || []);
  const otros = (leerJSON(`ivc_estados_${yo.id}`) || []).filter((e) => !enCelular.has(e.lid) && !descartados.has(e.lid) && e.estado !== 'Eliminado').slice(0, 30);
  const nuevo = h('div', { class: 'panel' }, h('h2', {}, 'Nuevo reporte'), h('p', {}, 'Seleccione el tipo de operativo:'),
    h('div', { class: 'tipos' }, cat.tipos.map((t) => h('button', { type: 'button', class: 'tipo', onclick: () => crearReporte(t).catch((e) => aviso(e.message, true)) },
      { establecimientos: '🏪', espacio: '🛒', cerros: '⛰️' }[t.clave], h('span', {}, t.nombre)))));
  const fila = (r) => {
    const guia = guiaEstado({ ...r, motivoEspera: r.enEspera && necesitaIngreso ? 'pase' : r.motivoEspera });
    const estado = guia.estado;
    const g = r.datos?.general || {};
    return h('div', { class: 'reporte' },
      h('div', {}, h('b', {}, `${r.tipoNombre} · ID ${g.id_operativo || '—'}`), h('div', { class: 'nota' }, `${g.fecha || 'sin fecha'} · ${r.datos?.actividades?.length || 0} actividad(es) · ${r.enviadoEn ? `enviado ${fechaDe(r.enviadoEn)}` : `actualizado ${fechaDe(r.actualizado)}`}`),
        h('div', {}, chip(estado), r.editable && !r.enEspera && estado === 'Borrador' ? [' ', chip('📱 Sin enviar')] : null),
        r.error ? h('div', { class: 'nota alerta' }, r.error) : null,
        r.observaciones ? h(observacionUrgente(r.observaciones) ? 'p' : 'div', { class: observacionUrgente(r.observaciones) ? 'chip error urgente' : 'nota alerta' }, `${observacionUrgente(r.observaciones) ? '⚠ ' : 'Observaciones: '}${r.observaciones}`) : null,
        guia.que ? h('div', { class: 'nota' }, `👉 ${guia.que}`) : null),
      h('div', { class: 'acciones' },
        guia.accion === 'intentar' ? h('button', { type: 'button', class: 'principal', onclick: async (e) => {
          e.target.disabled = true; aviso('Intentando enviar…');
          await sincronizar({ ahora: true }).catch(() => {});
          if (!f) inicio().catch(() => {});
        } }, '📤 Intentar ahora') : null,
        guia.accion === 'reintentar' ? h('button', { type: 'button', class: 'principal', onclick: async () => { await abrir({ lid: r.lid }); if (f?.lid === r.lid) irPaso(PASOS.length - 1); } }, '📤 Reintentar envío')
          : h('button', { type: 'button', class: r.editable && guia.accion !== 'intentar' ? 'principal' : '', onclick: () => abrir({ lid: r.lid }) },
            ['Requiere corrección', 'No se pudo procesar'].includes(estado) ? 'Corregir y reenviar' : r.editable && !r.enEspera ? 'Continuar' : 'Ver'),
        !r.editable ? h('button', { type: 'button', onclick: () => verWhatsApp(r.lid).catch((e) => aviso(e.message, true)) }, '📲 WhatsApp') : null,
        puedeDescartar(r) ? h('button', { type: 'button', class: 'mini', onclick: () => descartar(r).catch((e) => aviso(e.message, true)) },
          r.envio || r.intentado ? 'Descartar este reporte' : 'Descartar') : null));
  };
  poner(vista, panelProgramadas(locales), nuevo,
    !enLinea ? h('p', { class: 'chip alerta' }, '🔴 Sin internet: puede diligenciar y enviar; lo hecho queda en este celular y se envía solo cuando haya señal.') : null,
    almacenFragil && locales.some((r) => r.enEspera || r.editable) ? h('p', { class: 'nota' }, 'ℹ️ Este celular podría borrar los datos del formulario si se queda sin espacio. Envíe sus reportes apenas pueda y no los deje varios días sin enviar.') : null,
    h('div', { class: 'panel' }, h('h2', {}, `Mis reportes (${locales.length + otros.length})`),
      locales.length || otros.length ? [
        locales.map(fila),
        otros.map((e) => h('div', { class: 'reporte' },
          h('div', {}, h('b', {}, `${e.tipoNombre || 'Reporte'} · ID ${e.idOperativo || '—'}`), h('div', { class: 'nota' }, `${e.fecha || 'sin fecha'} · ${e.actividades ?? 0} actividad(es) · actualizado ${fechaHora(e.actualizado)}`),
            h('div', {}, chip(e.estado), e.sincronizacion && e.sincronizacion !== 'No aplica' ? [' ', chip(e.sincronizacion)] : null),
            e.observaciones ? h('div', { class: observacionUrgente(e.observaciones) ? 'chip error urgente' : 'nota alerta' }, `${observacionUrgente(e.observaciones) ? '⚠ ' : 'Observaciones: '}${e.observaciones}`) : null))),
      ] : h('p', { class: 'nota' }, 'Aún no tiene reportes. Empiece eligiendo el tipo de operativo.')));
  pintarConexion();
  // Al volver a entrar, se abre directamente el último reporte que estaba diligenciando, donde lo dejó.
  if (retomar) {
    const ultimo = locales.find((r) => r.editable && !r.enEspera && r.datos?._ubicacion && ['Borrador', 'Requiere corrección', 'No se pudo procesar'].includes(estadoDe(r)));
    if (ultimo) { await abrir({ lid: ultimo.lid }); aviso('Continúa donde lo dejó.'); }
  }
}

// ---------- Ingreso ----------
// El ingreso (nombre + clave del equipo) lo valida el buzón de Google y deja en el celular un pase de 30 días.
// Después, el formulario abre y guarda SIN internet; solo para enviar hace falta señal (no el PC).
const guardarJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
const leerJSON = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
function olvidarIngreso() { yo = null; try { localStorage.removeItem('ivc_yo'); } catch { /* sin almacenamiento */ } }
async function salir() {
  await guardarLocal();
  const pend = (await L.reportes(yo.id)).filter((r) => r.enEspera || r.editable).length;
  if (pend && !(await confirmar(`Tiene ${pend} reporte(s) sin enviar o en espera. Quedan guardados en este celular y se enviarán cuando vuelva a entrar con su nombre (para entrar necesitará internet). ¿Salir?`, 'Salir'))) return;
  olvidarIngreso();
  location.reload();
}
async function pantallaIngreso() {
  poner($('#sesion'));
  poner(vista, h('p', { class: 'cargando' }, 'Conectando con el buzón (puede tardar con mala señal)…'));
  let acc;
  try { acc = await buzon('buzon_acceso', {}, { espera: 20_000 }); } catch (e) {
    poner(vista, h('div', { class: 'panel' }, h('h2', {}, e.red ? '🔴 Sin internet' : 'No se pudo cargar el ingreso'),
      h('p', {}, e.red ? 'Para ingresar la primera vez necesita internet (datos o wifi). Después, el formulario funciona sin señal en este celular.' : e.message),
      h('div', { class: 'acciones' }, h('button', { class: 'principal', onclick: () => iniciar() }, 'Reintentar'))));
    return;
  }
  // Solo las gestoras activas en Usuarios del aplicativo (coordinación las activa o desactiva allí).
  const sel = h('select', { name: 'gestora', required: true },
    h('option', { value: '' }, 'Seleccione su nombre…'), (acc.gestoras || []).map((g) => h('option', { value: g.id }, g.nombre)));
  const clave = h('input', { name: 'clave', type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Clave del equipo' });
  poner(vista, h('form', { class: 'panel', onsubmit: async (e) => {
    e.preventDefault();
    const boton = e.target.querySelector('button'); boton.disabled = true;
    try {
      const j = await buzon('buzon_ingresar', { usuarioId: Number(sel.value), clave: clave.value });
      guardarJSON('ivc_yo', { ...j.usuario, pase: j.pase });
      await iniciar();
    } catch (err) { aviso(err.message, true); boton.disabled = false; }
  } }, h('h2', {}, 'Ingreso al formulario IVC'),
  acc.claveDefinida === false ? h('p', { class: 'chip alerta' }, 'Coordinación aún no ha definido la clave del formulario.') : null,
  h('div', { class: 'rejilla' }, h('label', {}, 'Su nombre', sel), h('label', {}, 'Clave del equipo', clave)),
  (acc.gestoras || []).length ? null : h('p', { class: 'chip alerta' }, 'No hay gestoras activas: coordinación debe activarlas en el aplicativo.'),
  h('div', { class: 'acciones' }, h('button', { class: 'principal grande' }, 'Entrar')),
  h('p', { class: 'nota' }, 'La clave la comparte coordinación. Guarde esta página en la pantalla de inicio de su celular para entrar rápido.')));
}
async function iniciar() {
  // El formulario sí cargó: se quita el aviso de «no terminó de abrir» que trae formulario.html.
  if (vista.querySelector('.cargando-lento')) poner(vista, h('p', { class: 'cargando' }, 'Cargando…'));
  // Limpieza de copias del formato anterior (antes del modo sin conexión).
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('ivc_form_')) localStorage.removeItem(k); } catch { /* idem */ }
  yo = leerJSON('ivc_yo');
  if (!yo?.pase) { yo = null; return pantallaIngreso(); }
  cat = leerJSON('ivc_catalogos');
  // Primera vez en este celular (o se borraron los catálogos): se necesitan del buzón antes de mostrar el formulario.
  if (!cat && !(await actualizarDatos())) {
    poner(vista, h('div', { class: 'panel' }, h('h2', {}, '🔴 Sin internet'),
      h('p', {}, 'Falta descargar las listas del formulario. Conéctese a internet (datos o wifi) una vez y pulse «Reintentar».'),
      h('div', { class: 'acciones' }, h('button', { class: 'principal', onclick: () => iniciar() }, 'Reintentar'))));
    return;
  }
  necesitaIngreso = false;
  poner($('#sesion'), h('span', { id: 'conexion' }), h('span', {}, yo.nombre),
    h('button', { class: 'mini', onclick: () => salir().catch((e) => aviso(e.message, true)) }, 'Salir'));
  try { await abrirBD(); } catch {
    poner(vista, h('div', { class: 'panel' }, 'Este navegador no permite guardar datos en el celular (¿modo incógnito?). Abra el formulario en el navegador normal.'));
    return;
  }
  pintarConexion();
  await inicio({ retomar: true });
  sincronizarPronto(300);
  // Estados y programadas frescos, sin hacer esperar la pantalla.
  actualizarDatos().then((ok) => { if (ok && !f) inicio().catch(() => {}); });
}

// Guardar al cerrar la página, cambiar de aplicación o bloquear el celular; reintentar el envío al volver.
window.addEventListener('pagehide', () => { if (puedeEditar()) guardarLocal(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (puedeEditar()) guardarLocal(); } else sincronizarPronto(300);
});
window.addEventListener('online', () => sincronizarPronto(300));
setInterval(() => { if (yo && document.visibilityState === 'visible') sincronizar().catch(() => {}); }, 30_000);
// Estados publicados por el PC: se revisan cada 5 minutos mientras el formulario está abierto en «Mis reportes».
setInterval(() => { if (yo && !f && document.visibilityState === 'visible') actualizarDatos().then((ok) => { if (ok && !f) inicio().catch(() => {}); }); }, 300_000);
// Aplicación instalable que abre sin internet (guarda en el celular los archivos del formulario).
// Aviso de versión nueva: el service worker bajó y activó una versión completa nueva mientras el formulario estaba abierto.
function avisoVersionNueva() {
  if ($('#version-nueva')) return;
  document.body.prepend(h('div', { id: 'version-nueva', class: 'version-nueva', role: 'status' },
    h('span', {}, '🔄 Hay una versión nueva: cierre y abra el formulario.'),
    h('button', { type: 'button', class: 'mini', onclick: async () => {
      if (enviandoAhora) { aviso('Espere a que termine el envío y vuelva a pulsar.', true); return; }
      await guardarLocal().catch(() => {});
      location.reload();
    } }, 'Abrir la versión nueva')));
}
{ const pie = $('#version-formulario'); if (pie) pie.textContent = `Formulario IVC · ${VERSION}`; }
if ('serviceWorker' in navigator) {
  const habiaVersion = Boolean(navigator.serviceWorker.controller); // la primera instalación no es «versión nueva»
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (habiaVersion) avisoVersionNueva(); });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // Al volver al formulario, revisa si se publicó una versión nueva.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
// Pide al navegador que no borre los datos del formulario cuando falte espacio. Si no lo concede, aviso suave en «Mis reportes».
let almacenFragil = false;
(async () => {
  try {
    if (!navigator.storage?.persist || (await navigator.storage.persisted?.())) return;
    almacenFragil = !(await navigator.storage.persist());
  } catch { /* navegador sin esta función: nada que avisar */ }
})();
iniciar().catch((e) => poner(vista, h('div', { class: 'panel' }, `No se pudo cargar: ${e.message}`)));
