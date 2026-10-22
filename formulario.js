// Formulario guiado de operativos IVC (piloto). Sin dependencias; todo texto se inserta como textContent.
// Pasos: datos generales → actividades (con fotos) → cierre (con foto) → vista previa → «Enviar a verificación».
//
// Funciona como el bot de Telegram: el celular NO habla con el PC sino con el BUZÓN de Google (Apps Script), que
// está siempre encendido. Todo se guarda primero en el celular (datos y fotos, en IndexedDB); al «Enviar», las fotos
// y el reporte suben al buzón (si no hay señal, quedan «En espera de envío» y salen solas cuando la haya). El PC los
// recoge cuando se enciende, los revisa con las mismas reglas (reglas-formulario.js) y publica el estado en el buzón.
import { validarFormulario, consolidado, erroresFotos, uid as uidSeguro } from './reglas-formulario.js';
import { BUZON } from './config-formulario.js';

const $ = (s, r = document) => r.querySelector(s);
const vista = $('#vista');
let yo = null;
let cat = null;      // catálogos del servidor (también guardados en el celular)
let f = null;        // reporte abierto: registro local + fotos
let paso = 0;
let actSel = 0;      // pestaña de actividad abierta
let enLinea = navigator.onLine;
// Ya está en el buzón de Google: llega al aplicativo apenas coordinación encienda el PC.
const EN_BUZON = '📨 Enviado (en el buzón)';

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
  let j;
  try {
    const r = await fetch(BUZON, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ accion, datos }), redirect: 'follow', signal: ctrl.signal });
    j = await r.json();
  } catch { marcarConexion(false); throw errorRed(); } finally { clearTimeout(t); }
  marcarConexion(true);
  if (j.ok) return j;
  if (j.codigo === 'PASE') {
    if (silencioso) throw Object.assign(new Error('Su ingreso venció: ingrese de nuevo para enviar lo pendiente.'), { estado: 401 });
    olvidarIngreso(); iniciar(); throw new Error(j.error);
  }
  throw Object.assign(new Error(j.error || 'No se pudo completar'), { codigo: j.codigo, faltan: j.faltan });
}
const conPase = (datos = {}) => ({ ...datos, pase: yo?.pase });
function aviso(t, error = false) {
  const el = $('#toast');
  el.textContent = t; el.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(aviso.t); aviso.t = setTimeout(() => { el.className = 'toast'; }, error ? 7000 : 3000);
}
const uid = () => uidSeguro();
const fechaHora = (iso) => (iso ? new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' }) : '—');
function confirmar(texto, boton = 'Confirmar') {
  return new Promise((resolver) => {
    const d = $('#dialogo'); const fm = $('#dialogo-form');
    poner(fm, h('p', {}, texto), h('div', { class: 'acciones' }, h('button', { value: 'ok', class: 'principal' }, boton), h('button', { value: 'no' }, 'Cancelar')));
    d.onclose = () => resolver(d.returnValue === 'ok'); d.returnValue = ''; d.showModal();
  });
}
const COLOR = { Borrador: 'neutro', 'Pendiente de verificación': 'alerta', 'Requiere corrección': 'error', Rechazado: 'error', Confirmado: 'ok', Eliminado: 'neutro',
  Sincronizado: 'ok', 'Pendiente de sincronización': 'alerta', 'Error de sincronización': 'error', 'En espera de envío': 'alerta', 'No se pudo enviar': 'error',
  'No se pudo procesar': 'error', [EN_BUZON]: 'ok' };
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
function cambio() {
  if (!f?.editable) return;
  f.datos._ubicacion = { paso, actividad: actSel };
  indicador('Guardando…');
  clearTimeout(tGuardar);
  tGuardar = setTimeout(guardarLocal, 300);
}
function guardarLocal() {
  clearTimeout(tGuardar);
  if (!f?.editable) return Promise.resolve();
  const lid = f.lid;
  const datos = JSON.parse(JSON.stringify(f.datos));
  return enFila(async () => {
    const r = (await L.reporte(lid)) || null;
    if (!r) return;
    r.datos = datos; r.sucio = true; r.rev = (r.rev || 0) + 1; r.actualizado = Date.now();
    await L.ponerReporte(r);
    if (f?.lid === lid) { f.sucio = true; f.rev = r.rev; }
  }).then(() => { indicador('✓ Guardado en el celular'); sincronizarPronto(); })
    .catch(() => aviso('No se pudo guardar en este celular. Revise el espacio disponible.', true));
}
function indicador(t) { const ind = $('#guardado'); if (ind) ind.textContent = t; }
function recordarUbicacion() {
  if (!f?.editable) return;
  f.datos._ubicacion = { paso, actividad: actSel };
  cambio();
}

// ---------- Envío al buzón de Google ----------
// Solo salen los reportes que la gestora mandó a verificación (enEspera). Los borradores se quedan en el celular.
let sincronizando = null;
let necesitaIngreso = false;
function sincronizarPronto(ms = 1500) { clearTimeout(sincronizarPronto.t); sincronizarPronto.t = setTimeout(() => sincronizar().catch(() => {}), ms); }
function sincronizar() {
  if (sincronizando || !yo) return sincronizando || Promise.resolve();
  sincronizando = (async () => {
    for (const r of await L.reportes(yo.id)) {
      if (!r.enEspera) continue;
      try { await enviarAlBuzon(r.lid); } catch (e) {
        if (e.red) break;
        if (e.estado === 401) { necesitaIngreso = true; break; }
        await actualizarReporte(r.lid, { enEspera: false, error: e.message || 'No se pudo enviar.' }).catch(() => {});
        diagnostico(r.lid, 'envio', e.message || String(e));
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
// Sube al buzón las fotos que faltan (una por una) y luego el reporte completo.
async function enviarAlBuzon(lid) {
  let r = await L.reporte(lid);
  if (!r?.enEspera) return;
  const o = { silencioso: true };
  for (const x of await L.fotos(lid)) if (x.quitar) await L.quitarFoto(x.fid);
  for (const x of await L.fotos(lid)) {
    if (x.sid || x.error) continue;
    if (!(x.blob instanceof Blob) || !x.blob.size) {
      const msg = 'Una foto no quedó guardada en este celular: quítela y adjúntela de nuevo.';
      await L.ponerFoto({ ...x, error: msg });
      if (f?.lid === lid) { const y = f.fotos.find((z) => z.fid === x.fid); if (y) y.error = msg; }
      diagnostico(lid, 'foto-sin-archivo', msg);
      continue;
    }
    await buzon('buzon_foto', conPase({ lid, fid: x.fid, base64: await base64De(x.blob) }), { ...o, espera: 120_000 });
    const nueva = { ...x, sid: 'buzon' }; // ya está en el buzón (el número del PC, si lo tenía, se conserva)
    await L.ponerFoto(nueva);
    if (f?.lid === lid) { const i = f.fotos.findIndex((y) => y.fid === x.fid); if (i >= 0) f.fotos[i] = nueva; }
  }
  const fotos = (await L.fotos(lid)).filter((x) => !x.quitar);
  const conError = fotos.filter((x) => x.error);
  if (conError.length) { await actualizarReporte(lid, { enEspera: false, error: `Revise las fotos: ${conError[0].error}` }); return; }
  r = await L.reporte(lid);
  if (!r?.enEspera) return;
  const envio = (r.envio || 0) + 1;
  try {
    await buzon('buzon_enviar', conPase({ lid, envio, tipo: r.tipo, datos: r.datos,
      fotos: fotos.map((x) => ({ fid: x.fid, sid: Number(x.sid) > 0 ? Number(x.sid) : null, actividad: x.actividad, es_cierre: x.es_cierre })) }), { ...o, espera: 60_000 });
  } catch (e) {
    // Una foto que el buzón no tiene (se borró allá): se vuelve a subir en la próxima vuelta.
    if (e.codigo === 'FALTAN_FOTOS') { for (const x of fotos) if ((e.faltan || []).includes(x.fid)) await L.ponerFoto({ ...x, sid: null }); return; }
    throw e;
  }
  await terminarEnviado(lid, true, envio);
}
// Ya está en el buzón: el reporte queda en el celular en solo lectura hasta que coordinación lo revise
// (si lo devuelve para corrección, se corrige aquí mismo y se reenvía).
async function terminarEnviado(lid, avisar, envio) {
  const r = await actualizarReporte(lid, { enEspera: false, editable: false, sucio: false, envio, estado: EN_BUZON, error: null, observaciones: null, enviadoEn: Date.now() });
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
function marcarConexion(v) { if (enLinea !== v) { enLinea = v; pintarConexion(); if (v) { necesitaIngreso = false; sincronizarPronto(500); } } }
async function pintarConexion() {
  const el = $('#conexion');
  if (!el || !yo) return;
  const espera = (await L.reportes(yo.id).catch(() => [])).filter((r) => r.enEspera).length;
  poner(el,
    h('span', { class: `chip ${enLinea ? 'ok' : 'alerta'}` }, enLinea ? '🟢 Con internet' : '🔴 Sin internet: se guarda en el celular'),
    espera ? [' ', h('span', { class: 'chip alerta' }, `📤 ${espera} en espera de envío`)] : null,
    necesitaIngreso ? [' ', h('button', { type: 'button', class: 'mini principal', onclick: () => { olvidarIngreso(); iniciar(); } }, 'Ingresar para enviar')] : null);
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
async function comprimir(archivo) {
  try {
    const img = await createImageBitmap(archivo, { imageOrientation: 'from-image' });
    const escala = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * escala); c.height = Math.round(img.height * escala);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    return blob || archivo;
  } catch { return archivo; }
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
async function esperarSubidas() {
  for (let i = 0; subiendo > 0 && i < 300; i++) await new Promise((r) => setTimeout(r, 200));
  return subiendo === 0;
}
function bloqueFotos({ actividad = null, cierre = false, max, min = null, titulo = 'Registro fotográfico', que = 'por actividad' }) {
  const propias = f.fotos.filter((x) => (cierre ? x.es_cierre : !x.es_cierre && x.actividad === actividad));
  const cont = h('div', { class: 'fotos' });
  const agregar = async (lista) => {
    subiendo++;
    try {
      for (const archivo of lista) {
        const ya = f.fotos.filter((x) => (cierre ? x.es_cierre : !x.es_cierre && x.actividad === actividad)).length;
        if (ya >= max) { aviso(cierre ? 'Solo una fotografía de cierre: quite la actual para reemplazarla.' : `Máximo ${max} fotografías ${que}.`, true); break; }
        const foto = { fid: `f-${uid()}`, lid: f.lid, actividad: cierre ? null : actividad, es_cierre: cierre ? 1 : 0, blob: await comprimir(archivo), sid: null, quitar: false, error: null };
        try { await L.ponerFoto(foto); } catch { aviso('No se pudo guardar la foto en este celular. Revise el espacio disponible.', true); break; }
        f.fotos.push(foto);
        pintar();
      }
    } finally { subiendo--; }
    await guardarLocal(); // la actividad debe llegar al servidor antes que sus fotos
  };
  poner(cont, propias.map((x) => h('figure', { class: 'miniatura' },
    h('img', { src: srcFoto(x), alt: 'Fotografía adjunta', loading: 'lazy' }),
    !x.sid ? h('span', { class: 'estado-foto', title: x.error || 'Guardada en el celular; se subirá al enviar' }, x.error ? '⚠' : '📱') : null,
    f.editable ? h('button', { type: 'button', class: 'quitar', title: 'Quitar foto', onclick: async () => {
      try { await quitarUnaFoto(x); pintar(); } catch (e) { aviso(e.message, true); }
    } }, '✕') : null)),
  f.editable && propias.length < max ? h('label', { class: 'agregar-foto' }, `📷 ${propias.length ? 'Agregar otra' : 'Agregar foto'}`,
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
        f.editable ? h('button', { type: 'button', class: 'mini', onclick: async () => { if (await confirmar(`¿Quitar el vendedor ${j + 1}? Se quitan también sus fotos.`, 'Quitar')) { await quitarFotosDe(`${a.uid}:${v.uid}`); a.vendedores.splice(j, 1); cambio(); pintar(); } } }, 'Quitar') : null),
      h('div', { class: 'rejilla' }, texto(v, 'nombre', 'Nombre del vendedor')),
      siNo(v, 'ipes', '¿Está registrado en el IPES?'),
      v.ipes ? h('div', { class: 'rejilla' }, texto(v, 'ipes_obs', 'Observaciones sobre el registro en el IPES', { area: true, obligatorio: false })) : null,
      siNo(v, 'retiro', '¿Se retiró voluntariamente?'),
      siNo(v, 'medida_policia', '¿Hubo medida correctiva por parte de la Policía?'),
      bloqueFotos({ actividad: `${a.uid}:${v.uid}`, min: cat.minFotosVendedor, max: cat.maxFotosVendedor, titulo: `Fotos del vendedor ${j + 1}`, que: 'por vendedor' }))),
    f.editable ? h('button', { type: 'button', onclick: () => { a.vendedores.push({ uid: uid() }); cambio(); pintar(); } }, '+ Agregar otro vendedor') : null,
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
  return [...v.errores.filter(propio), ...erroresFotos(v.actividades, f.fotos, f.tipo, cat).filter(propio)];
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
async function archivoFoto(x, i, prefijo) {
  let blob = x.blob;
  if (!blob) {
    const r = await fetch(srcFoto(x));
    if (!r.ok) throw new Error('No se pudo cargar una foto: revise la conexión e intente de nuevo.');
    blob = await r.blob();
  }
  return new File([blob], `${prefijo}-${i + 1}.jpg`, { type: 'image/jpeg' });
}
async function compartirActividad(a, n) {
  const texto = textoActividadWhatsApp(a, n);
  try {
    const prefijo = `ID${d().general.id_operativo || ''}-actividad${n}`.replace(/[^\w-]/g, '');
    const files = await Promise.all(fotosDeActividad(a).map((x, i) => archivoFoto(x, i, prefijo)));
    if (navigator.canShare && navigator.canShare({ files, text: texto })) { await navigator.share({ files, text: texto }); return; }
    if (navigator.share) { await navigator.share({ text: texto }); aviso('Se compartió el texto; agregue las fotos desde WhatsApp.'); return; }
    await copiarTexto(texto);
  } catch (e) { if (e?.name !== 'AbortError') aviso(e.message || 'No se pudo compartir', true); }
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
  const texto = textoActividadWhatsApp(a, n);
  const fotos = fotosDeActividad(a);
  return h('div', { class: 'panel whatsapp-actividad' },
    h('h4', {}, `📲 Enviar la actividad ${n} por WhatsApp`),
    h('div', { class: 'acciones' },
      h('button', { type: 'button', class: 'principal grande', onclick: () => compartirActividad(a, n) }, `📤 Compartir${fotos.length ? ` con ${fotos.length} foto(s)` : ''}`),
      h('button', { type: 'button', onclick: () => copiarTexto(texto) }, '📋 Copiar texto'),
      h('button', { type: 'button', class: 'mini', onclick: () => { marcarOk(a, false); pintar(); } }, 'Ocultar')),
    h('p', { class: 'nota' }, '«Compartir» abre WhatsApp con el texto y las fotos para elegir el grupo. El operativo sigue abierto: continúe con la siguiente actividad y, al final, envíe todo a verificación como siempre.'),
    h('pre', { class: 'wa-texto' }, texto));
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
        f.editable ? h('button', { type: 'button', class: 'mini peligro', onclick: eliminar }, '🗑 Eliminar actividad') : null),
      f.tipo === 'establecimientos' ? actividadEstablecimiento(a) : f.tipo === 'espacio' ? actividadEspacio(a) : actividadCerros(a),
      f.tipo === 'espacio'
        ? bloqueFotos({ actividad: a.uid, min: 0, max: cat.fotosPorTipo.espacio.max, titulo: 'Registro fotográfico general de la intervención' })
        : bloqueFotos({ actividad: a.uid, min: cat.fotosPorTipo[f.tipo].min, max: cat.fotosPorTipo[f.tipo].max }),
      bloqueOk(a, actSel + 1)),
    acts.length > 1 ? h('div', { class: 'acciones' },
      actSel > 0 ? h('button', { type: 'button', class: 'mini', onclick: () => irA(actSel - 1) }, `← Actividad ${actSel}`) : null,
      actSel < acts.length - 1 ? h('button', { type: 'button', class: 'mini', onclick: () => irA(actSel + 1) }, `Actividad ${actSel + 2} →`) : null) : null,
    // Agregar va al final de la actividad, separado del botón «Continuar al cierre del operativo».
    f.editable ? h('button', { type: 'button', class: 'agregar-actividad', onclick: () => { acts.push({ uid: uid() }); irA(acts.length - 1); } }, AGREGAR[f.tipo]) : null,
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
  v.errores.push(...erroresFotos(v.actividades, f.fotos, f.tipo, cat));
  for (const x of f.fotos.filter((y) => y.error)) v.errores.push(`Foto con problema: ${x.error}`);
  return { errores: v.errores, consolidado: consolidado(f.tipo, v.actividades) };
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
    f.editable ? h('div', { class: 'acciones enviar' }, h('button', { type: 'button', class: 'principal grande', disabled: r.errores.length > 0 || f.enEspera, onclick: enviar },
      f.enEspera ? 'En espera de envío…' : corrigiendo ? 'Reenviar a verificación' : 'Enviar a verificación')) : null,
    h('p', { class: 'nota' }, 'Al enviar, el reporte y sus fotos van al buzón y llegan al aplicativo para verificación (aunque el PC de coordinación esté apagado, se reciben cuando lo enciendan). Solo después de confirmado se registra en la Matriz General IVC. Si no hay señal, queda en espera en el celular y se envía solo cuando la haya.'));
}

async function enviar(e) {
  e.target.disabled = true;
  try {
    if (!(await esperarSubidas())) { e.target.disabled = false; return aviso('Aún se están guardando fotografías. Espere un momento y vuelva a enviar.', true); }
    await guardarLocal();
    const r = revisar();
    if (r.errores.length) { e.target.disabled = false; pintar(); return aviso('Complete los datos que faltan antes de enviar.', true); }
    const lid = f.lid;
    await actualizarReporte(lid, { enEspera: true, error: null });
    aviso('Enviando…');
    // Si ya había un envío en curso, se repite una vez para que tome este reporte.
    for (let i = 0; i < 2; i++) { await sincronizar().catch(() => {}); const q = await L.reporte(lid); if (!q?.enEspera || !enLinea) break; }
    const quedo = await L.reporte(lid);
    if (!quedo || !quedo.editable) return; // ya llegó al buzón: terminarEnviado mostró la confirmación
    if (quedo.enEspera) {
      f = null;
      poner(vista, h('div', { class: 'panel exito' }, h('h2', {}, '📥 Reporte guardado: en espera de envío'),
        h('p', {}, `Operativo ${quedo.datos.general.id_operativo} · ${quedo.datos.actividades.length} actividad(es).`),
        h('p', {}, 'No hay señal en este momento. El reporte y sus fotos quedaron guardados en este celular y se enviarán solos cuando haya internet (con el formulario abierto o al volver a abrirlo).'),
        h('p', { class: 'nota' }, `No borre los datos del navegador ni desinstale la aplicación hasta que el reporte aparezca como «${EN_BUZON}».`),
        h('div', { class: 'acciones' }, h('button', { class: 'principal', onclick: () => inicio() }, 'Volver a mis reportes'))));
    } else { aviso(quedo.error || 'No se pudo enviar.', true); f = { ...f, ...quedo }; pintar(); }
  } catch (err) { aviso(err.message, true); e.target.disabled = false; }
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
  const estado = !f.editable ? `Solo lectura · ${f.estado || ''}` : f.enEspera ? '📤 En espera de envío' : '✓ Guardado en el celular';
  poner(vista,
    h('div', { class: 'acciones' }, h('button', { type: 'button', class: 'mini', onclick: async () => { await guardarLocal(); inicio(); } }, '← Mis reportes'),
      h('span', { id: 'guardado', class: 'guardado' }, estado)),
    f.observaciones ? h('div', { class: 'panel suave' }, h('b', {}, 'Observaciones de coordinación: '), f.observaciones) : null,
    h('ol', { class: 'pasos' }, PASOS.map((t, i) => h('li', { class: i === paso ? 'actual' : i < paso ? 'hecho' : '' },
      h('button', { type: 'button', onclick: () => irPaso(i) }, `${i + 1}. ${t}`)))),
    h('div', { class: 'panel' }, h('h2', {}, PASOS[paso]), cont),
    h('div', { class: 'acciones navegacion' },
      paso > 0 ? h('button', { type: 'button', onclick: () => irPaso(paso - 1) }, '← Anterior') : h('span'),
      paso < PASOS.length - 1 ? h('button', { type: 'button', class: 'principal', onclick: () => irPaso(paso + 1) },
        paso === 1 ? 'Continuar al cierre del operativo →' : 'Siguiente →') : null));
  // Reporte ya enviado o revisado: solo lectura.
  if (!f.editable) for (const el of cont.querySelectorAll('input, select, textarea')) el.disabled = true;
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
const FINALES = ['Confirmado', 'Rechazado', 'Descartado', 'Eliminado'];
async function aplicarEstados(estados) {
  if (!Array.isArray(estados)) return;
  for (const e of estados) {
    const r = await L.reporte(e.lid);
    if (!r || r.usuarioId !== yo.id || r.enEspera) continue;
    // Un reenvío que el PC aún no recoge: lo que diga el estado es del envío anterior.
    if ((r.envio || 0) > (e.envio || 0) && e.envio !== undefined) continue;
    if (FINALES.includes(e.estado) && !r.editable) { await enFila(() => L.borrarReporte(r.lid)); continue; }
    const corregir = ['Requiere corrección', 'No se pudo procesar'].includes(e.estado);
    if (r.estado !== e.estado || r.observaciones !== (e.observaciones || null) || (corregir && !r.editable)) {
      await actualizarReporte(r.lid, { estado: e.estado, observaciones: e.observaciones || null, ...(corregir && !r.editable ? { editable: true, sucio: true } : {}) });
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
              : t ? h('button', { type: 'button', class: 'principal', onclick: () => nuevoReporte(t, generalDesdeCronograma(a)).catch((e) => aviso(e.message, true)) }, '📝 Reportar esta actividad')
                : h('span', { class: 'nota' }, 'Este tipo de operativo aún no tiene formulario.')));
    }));
}

// ---------- Compartir en WhatsApp (con lo guardado en el celular) ----------
async function copiarTexto(t) {
  try { await navigator.clipboard.writeText(t); aviso('Texto copiado: péguelo en WhatsApp'); } catch { aviso('No se pudo copiar: mantenga presionado el texto y cópielo', true); }
}
async function compartir(b) {
  try {
    const files = b.fotos.filter((x) => x.blob).map((x, i) => new File([x.blob], `${b.prefijo}-${i + 1}.jpg`, { type: 'image/jpeg' }));
    if (files.length && navigator.canShare && navigator.canShare({ files, text: b.texto })) { await navigator.share({ files, text: b.texto }); return; }
    if (navigator.share) { await navigator.share({ text: b.texto }); if (files.length) aviso('Se compartió el texto; agregue las fotos desde WhatsApp.'); return; }
    await copiarTexto(b.texto);
  } catch (e) { if (e?.name !== 'AbortError') aviso(e.message || 'No se pudo compartir', true); }
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
  const bloques = [{ clave: 'op', titulo: '🏁 Operativo completo', texto: resumen, fotos: fotos.filter((x) => x.es_cierre), prefijo: `${idTxt}-cierre` },
    ...acts.map((a, i) => ({ clave: a.uid, titulo: `${i + 1}. ${(a.nombre || a.tramo || (a.poligonos || []).join(', ') || '').slice(0, 20)}`,
      texto: textoActividadLocal(r.tipo, g, a, i + 1, deAct(a).length, nota), fotos: deAct(a), prefijo: `${idTxt}-actividad${i + 1}` }))];
  let sel = 'op';
  const cont = h('div', {});
  const pintarWa = () => {
    const b = bloques.find((x) => x.clave === sel);
    poner(cont,
      h('div', { class: 'pestanas-act' }, bloques.map((x) => h('button', { type: 'button', class: x.clave === sel ? 'activa' : '', onclick: () => { sel = x.clave; pintarWa(); } }, x.titulo))),
      h('div', { class: 'acciones' },
        h('button', { type: 'button', class: 'principal grande', onclick: () => compartir(b) }, `📤 Compartir${b.fotos.length ? ` con ${b.fotos.length} foto(s)` : ''}`),
        h('button', { type: 'button', onclick: () => copiarTexto(b.texto) }, '📋 Copiar texto')),
      h('pre', { class: 'wa-texto' }, b.texto),
      b.fotos.length ? h('div', { class: 'fotos' }, b.fotos.map((x) => h('figure', { class: 'miniatura' }, h('img', { src: srcFoto(x), alt: 'Foto', loading: 'lazy' })))) : null);
  };
  pintarWa();
  poner(vista,
    h('div', { class: 'acciones' }, h('button', { type: 'button', class: 'mini', onclick: () => inicio() }, '← Mis reportes')),
    h('div', { class: 'panel' }, h('h2', {}, `📲 Compartir en WhatsApp · ${idTxt}`),
      r.estado !== 'Confirmado' ? h('p', { class: 'chip alerta' }, 'Aún está pendiente de verificación: el texto lo indica al final.') : null,
      h('p', { class: 'nota' }, 'Elija «Operativo completo» o una actividad y pulse «Compartir»: se abre WhatsApp con el texto y las fotos para elegir el grupo.'),
      cont));
}

// ---------- Inicio: mis reportes (los del celular y el estado que publica el PC) ----------
async function inicio({ retomar = false } = {}) {
  f = null;
  const locales = (await L.reportes(yo.id)).sort((a, b) => (b.actualizado || 0) - (a.actualizado || 0));
  const enCelular = new Set(locales.map((r) => r.lid));
  // Reportes que ya no están en este celular (confirmados, rechazados o hechos en otro equipo): solo se muestra su estado.
  const otros = (leerJSON(`ivc_estados_${yo.id}`) || []).filter((e) => !enCelular.has(e.lid)).slice(0, 30);
  const estadoDe = (r) => (r.enEspera ? 'En espera de envío' : r.error ? 'No se pudo enviar' : r.estado || 'Borrador');
  const nuevo = h('div', { class: 'panel' }, h('h2', {}, 'Nuevo reporte'), h('p', {}, 'Seleccione el tipo de operativo:'),
    h('div', { class: 'tipos' }, cat.tipos.map((t) => h('button', { type: 'button', class: 'tipo', onclick: () => nuevoReporte(t).catch((e) => aviso(e.message, true)) },
      { establecimientos: '🏪', espacio: '🛒', cerros: '⛰️' }[t.clave], h('span', {}, t.nombre)))));
  const fila = (r) => {
    const estado = estadoDe(r);
    const g = r.datos?.general || {};
    return h('div', { class: 'reporte' },
      h('div', {}, h('b', {}, `${r.tipoNombre} · ID ${g.id_operativo || '—'}`), h('div', { class: 'nota' }, `${g.fecha || 'sin fecha'} · ${r.datos?.actividades?.length || 0} actividad(es) · actualizado ${fechaHora(r.actualizado ? new Date(r.actualizado).toISOString() : null)}`),
        h('div', {}, chip(estado), r.editable && !r.enEspera && estado === 'Borrador' ? [' ', chip('📱 Sin enviar')] : null),
        r.error ? h('div', { class: 'nota alerta' }, r.error) : null,
        r.observaciones ? h('div', { class: 'nota alerta' }, `Observaciones: ${r.observaciones}`) : null),
      h('div', { class: 'acciones' },
        h('button', { type: 'button', class: r.editable ? 'principal' : '', onclick: () => abrir({ lid: r.lid }) },
          ['Requiere corrección', 'No se pudo procesar'].includes(estado) ? 'Corregir y reenviar' : r.editable ? 'Continuar' : 'Ver'),
        !r.editable ? h('button', { type: 'button', onclick: () => verWhatsApp(r.lid).catch((e) => aviso(e.message, true)) }, '📲 WhatsApp') : null,
        r.editable && !r.envio && !r.enEspera ? h('button', { type: 'button', class: 'mini', onclick: async () => {
          if (!(await confirmar('¿Descartar este borrador? No se ha enviado.', 'Descartar'))) return;
          await enFila(() => L.borrarReporte(r.lid));
          inicio();
        } }, 'Descartar') : null));
  };
  poner(vista, panelProgramadas(locales), nuevo,
    !enLinea ? h('p', { class: 'chip alerta' }, '🔴 Sin internet: puede diligenciar y enviar; lo hecho queda en este celular y se envía solo cuando haya señal.') : null,
    h('div', { class: 'panel' }, h('h2', {}, `Mis reportes (${locales.length + otros.length})`),
      locales.length || otros.length ? [
        locales.map(fila),
        otros.map((e) => h('div', { class: 'reporte' },
          h('div', {}, h('b', {}, `${e.tipoNombre || 'Reporte'} · ID ${e.idOperativo || '—'}`), h('div', { class: 'nota' }, `${e.fecha || 'sin fecha'} · ${e.actividades ?? 0} actividad(es) · actualizado ${fechaHora(e.actualizado)}`),
            h('div', {}, chip(e.estado), e.sincronizacion && e.sincronizacion !== 'No aplica' ? [' ', chip(e.sincronizacion)] : null),
            e.observaciones ? h('div', { class: 'nota alerta' }, `Observaciones: ${e.observaciones}`) : null))),
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
window.addEventListener('pagehide', () => { if (f?.editable) guardarLocal(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (f?.editable) guardarLocal(); } else sincronizarPronto(300);
});
window.addEventListener('online', () => sincronizarPronto(300));
setInterval(() => { if (yo && document.visibilityState === 'visible') sincronizar().catch(() => {}); }, 30_000);
// Estados publicados por el PC: se revisan cada 5 minutos mientras el formulario está abierto en «Mis reportes».
setInterval(() => { if (yo && !f && document.visibilityState === 'visible') actualizarDatos().then((ok) => { if (ok && !f) inicio().catch(() => {}); }); }, 300_000);
// Aplicación instalable que abre sin internet (guarda en el celular los archivos del formulario).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
iniciar().catch((e) => poner(vista, h('div', { class: 'panel' }, `No se pudo cargar: ${e.message}`)));
