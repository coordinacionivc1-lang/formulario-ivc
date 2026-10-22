// Reglas del formulario IVC compartidas por el servidor y el celular (mismo archivo, mismas reglas).
// El celular las usa para revisar el reporte aun sin conexión; el servidor las vuelve a aplicar al recibirlo.
// Sin dependencias: funciona en Node y en el navegador. Los catálogos llegan como parámetro.

const txt = (v, max = 300) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
const largo = (v, max = 5000) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const siNo = (v) => (v === 'si' || v === 'no' ? v : '');
const entero = (v, { min = 0 } = {}) => (/^\d{1,6}$/.test(String(v ?? '').trim()) && Number(v) >= min ? Number(v) : null);
const decimal = (v) => {
  const t = String(v ?? '').trim().replace(',', '.');
  return /^\d{1,7}(\.\d{1,2})?$/.test(t) ? Number(t) : null;
};
const fechaValida = (t) => {
  const m = String(t || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Boolean(m && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]);
};
const horaValida = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const enLista = (lista, v) => (lista || []).includes(v);
const unicos = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map((x) => String(x)))];
export function uid() {
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- Normalización + validación completa ----------
// cat: { tipos, abogados, gestoras (nombres), entidades, tipologias, documentos, poligonos }.
// Devuelve { errores, general, actividades, cierre }. Al responder «No», los valores dependientes se descartan.
export function validarFormulario(tipo, datos, cat) {
  const errores = [];
  const g = datos?.general || {};
  const POLIGONO = Object.fromEntries((cat.poligonos || []).map((p) => [p.codigo, p.nombre]));
  if (!(cat.tipos || []).some((t) => t.clave === tipo)) errores.push('Seleccione el tipo de operativo.');
  const general = {
    id_operativo: txt(g.id_operativo, 30),
    fecha: txt(g.fecha, 10), hora_inicio: txt(g.hora_inicio, 5),
    abogado: txt(g.abogado, 80), gestora: txt(g.gestora, 80),
    entidades: unicos(g.entidades).filter((e) => enLista(cat.entidades, e)),
    poligonos: tipo === 'cerros' ? unicos(g.poligonos).filter((p) => POLIGONO[p]) : [],
  };
  if (!/^[0-9A-Za-z-]{2,30}$/.test(general.id_operativo)) errores.push('Datos generales: escriba el ID del operativo (números o letras, sin espacios).');
  if (!fechaValida(general.fecha)) errores.push('Datos generales: seleccione la fecha.');
  if (!horaValida(general.hora_inicio)) errores.push('Datos generales: seleccione la hora de inicio.');
  if (!enLista(cat.abogados, general.abogado)) errores.push('Datos generales: seleccione el primer responsable (abogado).');
  if (!enLista(cat.gestoras, general.gestora)) errores.push('Datos generales: seleccione el segundo responsable (gestora).');
  if (!general.entidades.length) errores.push('Datos generales: seleccione al menos una entidad de acompañamiento.');
  if (tipo === 'cerros' && !general.poligonos.length) errores.push('Datos generales: seleccione los polígonos de monitoreo.');

  const acts = Array.isArray(datos?.actividades) ? datos.actividades : [];
  if (!acts.length) errores.push('Registre al menos una actividad.');
  const actividades = acts.slice(0, 60).map((a, i) => {
    const n = i + 1;
    const err = (m) => errores.push(`Actividad ${n}: ${m}`);
    const base = { uid: txt(a?.uid, 20) || uid() };
    if (tipo === 'establecimientos') {
      const r = {
        ...base, nombre: txt(a.nombre, 200), tipo_establecimiento: txt(a.tipo_establecimiento, 150), tipologia: txt(a.tipologia, 20),
        direccion: txt(a.direccion, 200), zona: txt(a.zona, 120),
        documentos: unicos(a.documentos).filter((x) => enLista(cat.documentos, x)),
        medidas: siNo(a.medidas), suspension: '', dias: null, ruido: siNo(a.ruido), db_encendida: null, db_apagada: null,
        informe: siNo(a.informe), observaciones: largo(a.observaciones),
      };
      if (!r.nombre) err('escriba el nombre del establecimiento.');
      if (!r.tipo_establecimiento) err('escriba el tipo de establecimiento.');
      if (!enLista(cat.tipologias, r.tipologia)) err('seleccione la tipología.');
      if (!r.direccion) err('escriba la dirección.');
      if (!r.zona) err('escriba la zona.');
      if (!r.medidas) err('indique si se impusieron medidas correctivas.');
      if (r.medidas === 'si') {
        r.suspension = siNo(a.suspension);
        if (!r.suspension) err('indique si hubo suspensión de la actividad.');
        if (r.suspension === 'si') { r.dias = entero(a.dias, { min: 1 }); if (!r.dias) err('escriba los días de suspensión (número entero mayor que cero).'); }
      }
      if (!r.ruido) err('indique si se realizó prueba de ruido.');
      if (r.ruido === 'si') {
        r.db_encendida = decimal(a.db_encendida); r.db_apagada = decimal(a.db_apagada);
        if (r.db_encendida === null) err('escriba los decibeles con la fuente encendida.');
        if (r.db_apagada === null) err('escriba los decibeles con la fuente apagada.');
      }
      if (!r.informe) err('indique si se cuenta con informe técnico.');
      return r;
    }
    if (tipo === 'espacio') {
      const vendedores = (Array.isArray(a.vendedores) ? a.vendedores : []).slice(0, 200).map((v, j) => {
        const e = (m) => err(`vendedor ${j + 1}: ${m}`);
        const r = { uid: txt(v?.uid, 20) || uid(), nombre: txt(v.nombre, 150), ipes: siNo(v.ipes), ipes_obs: largo(v.ipes_obs, 1000),
          retiro: siNo(v.retiro), medida_policia: siNo(v.medida_policia) };
        if (!r.nombre) e('escriba el nombre.');
        if (!r.ipes) e('indique si está registrado en el IPES.');
        if (!r.retiro) e('indique si se retiró voluntariamente.');
        if (!r.medida_policia) e('indique si hubo medida correctiva de la Policía.');
        return r;
      });
      const r = { ...base, vendedores, tramo: txt(a.tramo, 250), cantidad_vendedores: entero(a.cantidad_vendedores),
        comparendos_movilidad: siNo(a.comparendos_movilidad), cantidad_comparendos: 0, area_m2: decimal(a.area_m2) };
      if (!r.tramo) err('escriba la dirección o tramo de intervención.');
      if (r.cantidad_vendedores === null) err('escriba la cantidad de vendedores intervenidos (0 o más).');
      if (!r.comparendos_movilidad) err('indique si hubo comparendos de Movilidad.');
      if (r.comparendos_movilidad === 'si') { r.cantidad_comparendos = entero(a.cantidad_comparendos, { min: 1 }); if (!r.cantidad_comparendos) err('escriba la cantidad de comparendos a vehículos.'); }
      if (r.area_m2 === null) err('escriba el área de espacio público recuperada en m² (0 o más).');
      return r;
    }
    // cerros
    const r = { ...base, poligonos: unicos(a.poligonos).filter((p) => general.poligonos.includes(p)), observaciones: largo(a.observaciones),
      medidas: siNo(a.medidas), cantidad_medidas: null, suspensiones: siNo(a.suspensiones), cantidad_suspensiones: null };
    if (!r.poligonos.length) err('seleccione el polígono o polígonos de la actividad.');
    if (!r.observaciones) err('escriba las observaciones del recorrido.');
    if (!r.medidas) err('indique si hubo medidas correctivas.');
    if (r.medidas === 'si') { r.cantidad_medidas = entero(a.cantidad_medidas, { min: 1 }); if (!r.cantidad_medidas) err('escriba cuántas medidas correctivas.'); }
    if (!r.suspensiones) err('indique si hubo suspensiones.');
    if (r.suspensiones === 'si') { r.cantidad_suspensiones = entero(a.cantidad_suspensiones, { min: 1 }); if (!r.cantidad_suspensiones) err('escriba cuántas suspensiones.'); }
    return r;
  });
  const c = datos?.cierre || {};
  const cierre = { hora_fin: txt(c.hora_fin, 5), resumen: largo(c.resumen) };
  if (!horaValida(cierre.hora_fin)) errores.push('Cierre: seleccione la hora de finalización.');
  if (!cierre.resumen) errores.push('Cierre: escriba el resumen de cierre del operativo.');
  return { errores, general, actividades, cierre };
}

// ---------- Consolidado (calculado desde el detalle) ----------
export function consolidado(tipo, actividades) {
  if (tipo === 'establecimientos') {
    return {
      'Establecimientos visitados': actividades.length,
      'Con medida correctiva': actividades.filter((a) => a.medidas === 'si').length,
      'Con suspensión': actividades.filter((a) => a.suspension === 'si').length,
      'Días de suspensión (total)': actividades.reduce((s, a) => s + (a.dias || 0), 0),
      'Con prueba de ruido': actividades.filter((a) => a.ruido === 'si').length,
      'Con informe técnico': actividades.filter((a) => a.informe === 'si').length,
    };
  }
  if (tipo === 'espacio') {
    const vs = actividades.flatMap((a) => a.vendedores || []);
    return {
      'Tramos o intervenciones': actividades.length,
      'Vendedores registrados': vs.length,
      'Vendedores intervenidos (declarados)': actividades.reduce((s, a) => s + (a.cantidad_vendedores || 0), 0),
      'Registrados en el IPES': vs.filter((v) => v.ipes === 'si').length,
      'Retiros voluntarios': vs.filter((v) => v.retiro === 'si').length,
      'Vendedores con medida correctiva de Policía': vs.filter((v) => v.medida_policia === 'si').length,
      'Comparendos de Movilidad': actividades.reduce((s, a) => s + (a.cantidad_comparendos || 0), 0),
      'Área recuperada (m²)': Math.round(actividades.reduce((s, a) => s + (a.area_m2 || 0), 0) * 100) / 100,
    };
  }
  // Cerros: cada actividad cuenta una sola vez aunque cubra varios polígonos; medidas y suspensiones por separado.
  return {
    'Actividades de monitoreo': actividades.length,
    'Polígonos monitoreados': new Set(actividades.flatMap((a) => a.poligonos)).size,
    'Medidas correctivas': actividades.reduce((s, a) => s + (a.cantidad_medidas || 0), 0),
    'Suspensiones': actividades.reduce((s, a) => s + (a.cantidad_suspensiones || 0), 0),
  };
}

// ---------- Fotos: mínimo y máximo por actividad (y por vendedor), y una sola de cierre ----------
export function erroresFotos(actividades, fotos, tipo, cat) {
  const errores = [];
  const lim = cat.fotosPorTipo?.[tipo] || { min: cat.minFotosActividad, max: cat.maxFotosActividad };
  const cuantas = (clave) => fotos.filter((x) => !x.es_cierre && x.actividad === clave).length;
  actividades.forEach((a, i) => {
    const n = cuantas(a.uid);
    // Espacio público: fotos por vendedor (2 a 4); las del tramo son opcionales.
    if (tipo === 'espacio') {
      (a.vendedores || []).forEach((v, j) => {
        const nv = cuantas(`${a.uid}:${v.uid}`);
        if (nv < cat.minFotosVendedor) errores.push(`Actividad ${i + 1}, vendedor ${j + 1}${v.nombre ? ` (${v.nombre})` : ''}: adjunte mínimo ${cat.minFotosVendedor} fotografías (lleva ${nv}).`);
        if (nv > cat.maxFotosVendedor) errores.push(`Actividad ${i + 1}, vendedor ${j + 1}: máximo ${cat.maxFotosVendedor} fotografías (lleva ${nv}).`);
      });
    } else if (n < lim.min) errores.push(`Actividad ${i + 1}: adjunte mínimo ${lim.min} fotografías (lleva ${n}).`);
    if (n > lim.max) errores.push(`Actividad ${i + 1}: máximo ${lim.max} fotografías (lleva ${n}).`);
  });
  if (!fotos.some((x) => x.es_cierre)) errores.push('Cierre: adjunte la fotografía de cierre.');
  return errores;
}
