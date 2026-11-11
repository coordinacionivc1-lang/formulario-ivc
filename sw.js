// Guarda en el celular los archivos del formulario para que abra sin internet (y sin el PC).
// Solo atiende el formulario y sus archivos; los datos van al buzón de Google y nunca se guardan aquí.
// Rutas relativas: funciona igual en GitHub Pages (…/ivc-formulario/) y en el PC (/formulario.html).
//
// Actualización EN BLOQUE: cada versión baja todos sus archivos juntos (sin la caché HTTP, cache:'reload') a su
// propia caché; si alguno falla, la instalación se cancela y el celular sigue con la versión anterior completa.
// Nunca se mezclan archivos de dos versiones. Al cambiar CUALQUIER archivo del formulario, suba este número
// (y VERSION en formulario.js): es lo que hace que los celulares bajen la versión nueva.
const CACHE = 'ivc-formulario-v10';
const ARCHIVOS = ['formulario.html', 'formulario.js', 'reglas-formulario.js', 'config-formulario.js', 'formulario.css', 'estilos.css',
  'logos/alcaldia_mayor_bogota.png', 'manifest-formulario.json'];
const base = new URL('./', self.location).pathname;
const RUTAS = new Set(ARCHIVOS.map((a) => base + a));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ARCHIVOS.map((a) => new Request(a, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('ivc-formulario-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Abre al instante con la copia completa de esta versión (aunque la señal sea mala). Solo si falta un archivo se
// pide a la red; si tampoco hay red, se responde con un aviso (el formulario muestra «no terminó de abrir»).
async function desdeCopia(ruta) {
  const cache = await caches.open(CACHE);
  const guardada = await cache.match(ruta);
  if (guardada) return guardada;
  try {
    const r = await fetch(ruta, { cache: 'no-cache' });
    if (r.ok) await cache.put(ruta, r.clone());
    return r;
  } catch {
    return new Response('Sin internet y el formulario aún no está guardado en este celular. Ábralo una vez con internet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // La raíz solo es el formulario en GitHub Pages (…/ivc-formulario/). En el PC la raíz «/» es el aplicativo de
  // coordinación y nunca se reemplaza por el formulario.
  const raizDelFormulario = base !== '/' && (url.pathname === base || url.pathname === `${base}index.html`);
  const navegacion = e.request.mode === 'navigate' && (raizDelFormulario || url.pathname === `${base}formulario.html` || url.pathname.endsWith('/formulario') || url.pathname.endsWith('/form'));
  if (navegacion) { e.respondWith(desdeCopia(`${base}formulario.html`)); return; }
  if (!RUTAS.has(url.pathname)) return;
  e.respondWith((async () => {
    // En el PC, el aplicativo de coordinación comparte estilos.css y el logo con el formulario: para él van
    // siempre a la red, para que no vea una versión vieja de los estilos.
    if (base === '/' && e.clientId) {
      const cliente = await self.clients.get(e.clientId);
      if (cliente && !/\/(formulario(\.html)?|form)$/.test(new URL(cliente.url).pathname)) return fetch(e.request);
    }
    return desdeCopia(url.pathname);
  })());
});
