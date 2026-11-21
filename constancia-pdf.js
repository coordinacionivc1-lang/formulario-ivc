// Constancia de asistencia al operativo (PDF), generada en el celular de la gestora, sin internet y sin librerías.
// Sirve de soporte para la cuenta de cobro: tipo de operativo, ID, fecha, horas, abogado, gestora, acompañamiento,
// actividades, resultados, resumen de cierre y la foto de cierre. Máximo dos hojas tamaño carta.
//
// Lógica pura (sin pantalla): recibe los datos y la foto de cierre ya en JPEG y devuelve los bytes del PDF.
// La prueba test/constancia-pdf.test.js la ejecuta tal cual.

// Anchos de Helvetica y Helvetica-Bold (codificación WinAnsi, códigos 32 a 255), tomados de los AFM de Adobe.
const ANCHO_N = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,500,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,0];
const ANCHO_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,556,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,0];

const ANCHO = 612, ALTO = 792, M = 50; // carta, en puntos
const ARRIBA = 50, ABAJO = ALTO - 58;  // zona útil (el pie va debajo)
const ROJO = [0.702, 0.071, 0.122], GRIS = [0.36, 0.29, 0.3], NEGRO = [0.13, 0.13, 0.13], LINEA = [0.85, 0.78, 0.78];
export const TIPOS_CONSTANCIA = [['establecimientos', 'Establecimientos de comercio'], ['espacio', 'Espacio público'], ['cerros', 'Cerros orientales']];

// ---------- Texto en WinAnsi ----------
const ESPECIALES = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
// Deja solo lo que Helvetica puede escribir: quita emojis, cambia saltos y tabulaciones por espacios.
export function limpiarTexto(s) {
  let out = '';
  for (const ch of String(s ?? '').normalize('NFC')) {
    const c = ch.codePointAt(0);
    if (ESPECIALES[ch]) out += String.fromCharCode(ESPECIALES[ch]);
    else if (c === 10) out += '\n';
    else if (c < 32 || c === 127) out += ' ';
    else if (c < 128 || (c >= 160 && c <= 255)) out += ch;
    else if (c > 0xffff || (c >= 0x2600 && c <= 0x27bf) || (c >= 0xfe00 && c <= 0xfe0f) || c === 0x200d) continue; // emojis
    else out += '?';
  }
  return out.replace(/[ \t]+/g, ' ');
}
const anchoDe = (s, negrita, tam) => {
  const t = negrita ? ANCHO_B : ANCHO_N;
  let w = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); w += c >= 32 && c <= 255 ? t[c - 32] || 556 : 556; }
  return (w * tam) / 1000;
};
// Parte el texto (ya limpio) en líneas que caben en «max» puntos.
export function partirLineas(texto, negrita, tam, max) {
  const lineas = [];
  for (const parrafo of String(texto).split('\n')) {
    let actual = '';
    for (const palabra of parrafo.split(' ').filter(Boolean)) {
      const prueba = actual ? `${actual} ${palabra}` : palabra;
      if (anchoDe(prueba, negrita, tam) <= max) { actual = prueba; continue; }
      if (actual) lineas.push(actual);
      // Palabra más larga que la línea: se corta por letras.
      let resto = palabra;
      while (anchoDe(resto, negrita, tam) > max) {
        let n = resto.length;
        while (n > 1 && anchoDe(resto.slice(0, n), negrita, tam) > max) n--;
        lineas.push(resto.slice(0, n)); resto = resto.slice(n);
      }
      actual = resto;
    }
    lineas.push(actual);
  }
  while (lineas.length > 1 && lineas[lineas.length - 1] === '') lineas.pop();
  return lineas;
}
const recortar = (s, negrita, tam, max) => {
  if (anchoDe(s, negrita, tam) <= max) return s;
  let n = s.length;
  while (n > 0 && anchoDe(`${s.slice(0, n)}\x85`, negrita, tam) > max) n--;
  return `${s.slice(0, n).trimEnd()}\x85`;
};
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const n2 = (x) => (Math.round(x * 100) / 100).toString();

// ---------- Fechas y horas ----------
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function fechaLarga(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}` : 'No informada';
}
export function hora12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return 'No informada';
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}
export function duracion(ini, fin) {
  const a = /^(\d{1,2}):(\d{2})/.exec(String(ini || '')), b = /^(\d{1,2}):(\d{2})/.exec(String(fin || ''));
  if (!a || !b) return null;
  let min = (Number(b[1]) * 60 + Number(b[2])) - (Number(a[1]) * 60 + Number(a[2]));
  if (min <= 0) min += 24 * 60; // terminó después de medianoche
  const h = Math.floor(min / 60), r = min % 60;
  return [h ? `${h} h` : null, r ? `${r} min` : null].filter(Boolean).join(' ') || '0 min';
}
const fechaHoraBog = (d) => {
  try { return new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' }); } catch { return ''; }
};

// ---------- JPEG ----------
// Tamaño y canales de una foto JPEG (lee el marcador SOF). null si no es un JPEG válido.
export function infoJPEG(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const largo = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const alto = (b[i + 5] << 8) | b[i + 6], ancho = (b[i + 7] << 8) | b[i + 8], canales = b[i + 9];
      return ancho > 0 && alto > 0 && [1, 3, 4].includes(canales) ? { ancho, alto, canales } : null;
    }
    i += 2 + largo;
  }
  return null;
}

// Nombre del archivo: «Constancia-ID71562-2026-11-21-Ana-Perez.pdf».
export function nombreConstancia(c) {
  const g = c?.general || {};
  const limpio = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${['Constancia', limpio(g.id_operativo) && `ID${limpio(g.id_operativo)}`, limpio(g.fecha), limpio(g.gestora).slice(0, 40)].filter(Boolean).join('-')}.pdf`;
}

// ---------- Documento ----------
// c: { tipo, tipoNombre, general, cierre, actividades: [texto], consolidado: { clave: valor }, enviadoEn, conFoto }
// opciones: { jpeg: Uint8Array | null, generado: Date }
// Devuelve { bytes: Uint8Array, paginas }.
export function constanciaPDF(c, { jpeg = null, generado = new Date() } = {}) {
  const g = c.general || {};
  const cierre = c.cierre || {};
  const foto = jpeg ? infoJPEG(jpeg) : null;
  const paginas = [[]];
  let y = ARRIBA;
  const ops = () => paginas[paginas.length - 1];
  const Y = (yy) => n2(ALTO - yy);
  const color = (k, fill = true) => `${k.map(n2).join(' ')} ${fill ? 'rg' : 'RG'}`;
  const texto = (x, yy, s, { negrita = false, tam = 10, col = NEGRO } = {}) => {
    ops().push(`BT /${negrita ? 'F2' : 'F1'} ${tam} Tf ${color(col)} ${n2(x)} ${Y(yy)} Td (${esc(s)}) Tj ET`);
  };
  const linea = (x1, y1, x2, col = LINEA, grosor = 0.8) => ops().push(`${color(col, false)} ${grosor} w ${n2(x1)} ${Y(y1)} m ${n2(x2)} ${Y(y1)} l S`);
  const rect = (x, yy, w, h, { relleno = null, borde = null } = {}) => {
    if (relleno) ops().push(`${color(relleno)} ${n2(x)} ${Y(yy + h)} ${n2(w)} ${n2(h)} re f`);
    if (borde) ops().push(`${color(borde, false)} 1 w ${n2(x)} ${Y(yy + h)} ${n2(w)} ${n2(h)} re S`);
  };
  // Espacio reservado en la última hoja para la foto y las firmas (para no pasar de dos hojas).
  const RESERVA = (foto ? 230 : 40) + 95;
  const limite = () => (paginas.length === 1 ? ABAJO : ABAJO - RESERVA);
  let recortado = false;
  // ¿Cabe un bloque de alto h? Si no, pasa a la hoja 2; en la hoja 2 ya no hay más hojas.
  const cabe = (h) => {
    if (y + h <= limite()) return true;
    if (paginas.length === 1) { paginas.push([]); y = ARRIBA; return y + h <= limite(); }
    recortado = true;
    return false;
  };
  const titulo = (t) => {
    if (!cabe(30)) return false;
    y += 14;
    texto(M, y + 10, limpiarTexto(t).toUpperCase(), { negrita: true, tam: 10.5, col: ROJO });
    linea(M, y + 15, ANCHO - M, ROJO, 0.6);
    y += 22;
    return true;
  };
  const fila = (k, v) => {
    const kw = 150, tam = 10, lh = tam * 1.35;
    const ls = partirLineas(limpiarTexto(v || 'No informado'), false, tam, ANCHO - 2 * M - kw);
    if (!cabe(lh * Math.min(ls.length, 2))) return false;
    texto(M, y + tam, limpiarTexto(k), { negrita: true, tam, col: GRIS });
    for (const l of ls) { if (!cabe(lh)) return false; texto(M + kw, y + tam, l, { tam }); y += lh; }
    y += 2;
    return true;
  };

  // Encabezado
  rect(0, 0, ANCHO, 8, { relleno: ROJO });
  texto(M, y + 4, limpiarTexto('ALCALDÍA LOCAL DE USAQUÉN'), { negrita: true, tam: 11, col: GRIS });
  texto(M, y + 18, limpiarTexto('Grupo IVC Jurídico Policivo · Inspección, Vigilancia y Control'), { tam: 9, col: GRIS });
  y += 44;
  texto(M, y, limpiarTexto('CONSTANCIA DE ASISTENCIA A OPERATIVO IVC'), { negrita: true, tam: 16, col: ROJO });
  y += 16;
  texto(M, y, limpiarTexto('Soporte del acompañamiento realizado por el gestor(a) al abogado(a) responsable del operativo'), { tam: 9, col: GRIS });
  y += 10;

  // Tipo de operativo (casillas)
  titulo('Tipo de operativo');
  let x = M;
  for (const [clave, nombre] of TIPOS_CONSTANCIA) {
    const si = c.tipo === clave;
    rect(x, y, 11, 11, { borde: NEGRO, relleno: si ? ROJO : null });
    if (si) texto(x + 2.2, y + 9.4, 'X', { negrita: true, tam: 10, col: [1, 1, 1] });
    const t = limpiarTexto(nombre);
    texto(x + 16, y + 9.5, t, { negrita: si, tam: 10 });
    x += 16 + anchoDe(t, si, 10) + 26;
  }
  y += 16;

  // Datos
  titulo('Datos del operativo');
  fila('ID del operativo', g.id_operativo);
  fila('Fecha', fechaLarga(g.fecha));
  fila('Hora de inicio', hora12(g.hora_inicio));
  fila('Hora de finalización', hora12(cierre.hora_fin));
  const dur = duracion(g.hora_inicio, cierre.hora_fin);
  if (dur) fila('Duración aproximada', dur);
  fila('Abogado(a) responsable', g.abogado);
  fila('Gestor(a) que acompañó', g.gestora);
  fila('Acompañamiento', (g.entidades || []).join(', ') || 'Sin acompañamiento reportado');
  if (c.tipo === 'cerros' && (g.poligonos || []).length) fila('Polígonos', g.poligonos.join(', '));

  // Actividades
  const acts = (c.actividades || []).filter((a) => String(a || '').trim());
  if (titulo(`Actividades realizadas (${acts.length})`)) {
    const MAX = 8;
    for (const [i, a] of acts.slice(0, MAX).entries()) {
      if (!cabe(13)) break;
      texto(M + 6, y + 10, recortar(limpiarTexto(`${i + 1}. ${a}`), false, 10, ANCHO - 2 * M - 6), { tam: 10 });
      y += 13;
    }
    if (acts.length > MAX && cabe(13)) { texto(M + 6, y + 10, limpiarTexto(`… y ${acts.length - MAX} más (detalle en el reporte del formulario).`), { tam: 9, col: GRIS }); y += 13; }
    if (!acts.length && cabe(13)) { texto(M + 6, y + 10, 'Sin actividades registradas.', { tam: 10, col: GRIS }); y += 13; }
  }

  // Resultados
  const res = Object.entries(c.consolidado || {});
  if (res.length && titulo('Resultados reportados')) {
    // Dos columnas para ocupar menos espacio.
    const colW = (ANCHO - 2 * M) / 2;
    for (let i = 0; i < res.length; i += 2) {
      if (!cabe(14)) break;
      for (const [j, par] of res.slice(i, i + 2).entries()) {
        const [k, v] = par.map((z) => limpiarTexto(z));
        const kx = M + j * colW;
        const kTxt = recortar(`${k}:`, true, 9.5, colW - 60);
        texto(kx, y + 10, kTxt, { negrita: true, tam: 9.5, col: GRIS });
        texto(kx + anchoDe(kTxt, true, 9.5) + 5, y + 10, recortar(v, false, 9.5, colW - anchoDe(kTxt, true, 9.5) - 10), { tam: 9.5 });
      }
      y += 14;
    }
  }

  // Resumen de cierre
  if (titulo('Resumen de la finalización del operativo')) {
    // Cada línea deja sitio para el aviso de recorte: si el resumen no cabe en las dos hojas, se corta y se avisa.
    const tam = 10, lh = tam * 1.32;
    const ls = partirLineas(limpiarTexto(cierre.resumen || 'Sin resumen de cierre.'), false, tam, ANCHO - 2 * M);
    for (const [i, l] of ls.entries()) {
      if (!cabe(lh + (i < ls.length - 1 ? 14 : 0))) { recortado = true; break; }
      texto(M, y + tam, l, { tam });
      y += lh;
    }
    if (recortado) { texto(M, y + 10, limpiarTexto('[Resumen recortado para no pasar de dos hojas: el texto completo está en el reporte del formulario.]'), { tam: 8, col: GRIS }); y += 13; }
  }

  // Foto de cierre (si no cabe con buen tamaño en la hoja 1, va en la hoja 2)
  const FIRMAS = 95;
  const libre = () => ABAJO - FIRMAS - y - 26;
  if (paginas.length === 1 && libre() < (foto ? 200 : 30)) { paginas.push([]); y = ARRIBA; }
  y += 14;
  texto(M, y + 10, limpiarTexto('FOTOGRAFÍA DE CIERRE'), { negrita: true, tam: 10.5, col: ROJO });
  linea(M, y + 15, ANCHO - M, ROJO, 0.6);
  y += 24;
  if (foto) {
    const maxW = ANCHO - 2 * M, maxH = Math.min(380, Math.max(120, libre()));
    const k = Math.min(maxW / foto.ancho, maxH / foto.alto);
    const w = foto.ancho * k, h = foto.alto * k;
    const fx = (ANCHO - w) / 2;
    ops().push(`q ${n2(w)} 0 0 ${n2(h)} ${n2(fx)} ${Y(y + h)} cm /Im1 Do Q`);
    rect(fx, y, w, h, { borde: LINEA });
    y += h + 6;
  } else {
    texto(M, y + 10, jpeg || c.conFoto ? 'La fotografía de cierre no se pudo incluir (está en el reporte del formulario).' : 'No se adjuntó fotografía de cierre.', { tam: 10, col: GRIS });
    y += 18;
  }

  // Firmas
  y += 50;
  const fw = (ANCHO - 2 * M - 40) / 2;
  for (const [j, [rol, nombre]] of [['Gestor(a)', g.gestora], ['Abogado(a) responsable', g.abogado]].entries()) {
    const fx = M + j * (fw + 40);
    linea(fx, y, fx + fw, NEGRO, 0.7);
    texto(fx, y + 12, recortar(limpiarTexto(nombre || ''), true, 9.5, fw), { negrita: true, tam: 9.5 });
    texto(fx, y + 24, limpiarTexto(rol), { tam: 8.5, col: GRIS });
  }

  // Pie de cada hoja
  const enviado = c.enviadoEn ? ` · Enviado a verificación el ${fechaHoraBog(c.enviadoEn)}` : '';
  paginas.forEach((p, i) => {
    const pie = [];
    pie.push(`${color(LINEA, false)} 0.6 w ${M} ${Y(ALTO - 44)} m ${ANCHO - M} ${Y(ALTO - 44)} l S`);
    const t1 = recortar(limpiarTexto(`Generado en el Formulario IVC el ${fechaHoraBog(generado)}${enviado}`), false, 7.5, ANCHO - 2 * M - 60);
    pie.push(`BT /F1 7.5 Tf ${color(GRIS)} ${M} ${Y(ALTO - 33)} Td (${esc(t1)}) Tj ET`);
    const pag = `Hoja ${i + 1} de ${paginas.length}`;
    pie.push(`BT /F1 7.5 Tf ${color(GRIS)} ${n2(ANCHO - M - anchoDe(pag, false, 7.5))} ${Y(ALTO - 33)} Td (${pag}) Tj ET`);
    const t2 = limpiarTexto('Resume lo reportado por el gestor(a) en el formulario. La información oficial es la verificada por coordinación en el aplicativo IVC.');
    pie.push(`BT /F1 7 Tf ${color(GRIS)} ${M} ${Y(ALTO - 23)} Td (${esc(recortar(t2, false, 7, ANCHO - 2 * M))}) Tj ET`);
    p.push(...pie);
  });

  return { bytes: escribirPDF(paginas, foto ? { ...foto, datos: jpeg } : null, `Constancia de asistencia - ID ${g.id_operativo || ''}`), paginas: paginas.length };
}

// ---------- Escritura del archivo PDF ----------
function escribirPDF(paginas, imagen, tituloDoc) {
  const partes = [];
  let largo = 0;
  const offsets = [];
  const latin1 = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
  const poner = (x) => { const b = typeof x === 'string' ? latin1(x) : x; partes.push(b); largo += b.length; };
  const obj = (n, cuerpo, flujo = null) => {
    offsets[n] = largo;
    poner(`${n} 0 obj\n${cuerpo}\n`);
    if (flujo) { poner('stream\n'); poner(flujo); poner('\nendstream\n'); }
    poner('endobj\n');
  };
  poner('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const nImg = imagen ? 6 : null;
  const primeraPag = imagen ? 7 : 6;
  const kids = paginas.map((_, i) => `${primeraPag + i * 2} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${paginas.length} >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  obj(5, `<< /Title (${esc(limpiarTexto(tituloDoc))}) /Producer (Formulario IVC) >>`);
  if (imagen) {
    const cs = { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' }[imagen.canales];
    obj(nImg, `<< /Type /XObject /Subtype /Image /Width ${imagen.ancho} /Height ${imagen.alto} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${imagen.datos.length} >>`, imagen.datos);
  }
  const recursos = `<< /Font << /F1 3 0 R /F2 4 0 R >>${imagen ? ` /XObject << /Im1 ${nImg} 0 R >>` : ''} >>`;
  paginas.forEach((p, i) => {
    const n = primeraPag + i * 2;
    const contenido = latin1(p.join('\n'));
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] /Resources ${recursos} /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${contenido.length} >>`, contenido);
  });
  const total = primeraPag + paginas.length * 2;
  const xref = largo;
  let tabla = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) tabla += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  poner(`${tabla}trailer\n<< /Size ${total} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(largo);
  let o = 0;
  for (const b of partes) { out.set(b, o); o += b.length; }
  return out;
}
