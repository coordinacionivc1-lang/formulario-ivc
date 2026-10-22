// Guarda en el celular los archivos del formulario para que abra sin internet (y sin el PC).
// Solo atiende el formulario y sus archivos; los datos van al buzón de Google y nunca se guardan aquí.
// Rutas relativas: funciona igual en GitHub Pages (…/ivc-formulario/) y en el PC (/formulario.html).
const CACHE = 'ivc-formulario-v3';
const ARCHIVOS = ['formulario.html', 'formulario.js', 'reglas-formulario.js', 'config-formulario.js', 'formulario.css', 'estilos.css',
  'logos/alcaldia_mayor_bogota.png', 'manifest-formulario.json'];
const base = new URL('./', self.location).pathname;
const RUTAS = new Set(ARCHIVOS.map((a) => base + a));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Abre al instante con la copia guardada (aunque la señal sea mala) y la actualiza por detrás para la próxima vez.
// Si aún no hay copia, la trae de la red.
async function copiaYActualiza(ruta) {
  const cache = await caches.open(CACHE);
  const guardada = await cache.match(ruta);
  const red = fetch(ruta, { cache: 'no-store' }).then(async (r) => { if (r.ok) await cache.put(ruta, r.clone()); return r; });
  if (guardada) { red.catch(() => {}); return guardada; }
  try { return await red; } catch {
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
  if (navegacion) { e.respondWith(copiaYActualiza(`${base}formulario.html`)); return; }
  if (RUTAS.has(url.pathname)) e.respondWith(copiaYActualiza(url.pathname));
});
