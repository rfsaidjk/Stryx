(() => {
  'use strict';

  const engineUrls = {
    duckduckgo: 'https://duckduckgo.com/',
    brave: 'https://search.brave.com/search',
    google: 'https://www.google.com/search',
  };
  const localhost = new Set(['localhost', '127.0.0.1', '[::1]']);
  const labels = {
    es: {
      url: 'Introduce una URL HTTP o HTTPS válida, o escribe una búsqueda.',
      origin: 'Configura la URL HTTPS de Render en la etiqueta stryx-proxy-origin de index.html.',
      local: 'Abre Stryx desde tu servidor Node.js.',
      worker: 'Ultraviolet necesita HTTPS o localhost y un navegador con Service Workers.',
      scope: 'El Service Worker no cubre la ruta de Ultraviolet. Revisa register-sw.js y uv.config.js.',
      assets: 'No se pudo cargar',
      config: 'La configuración de Ultraviolet o BareMux no está disponible.',
      timeout: 'Ultraviolet tardó demasiado en iniciar. Revisa el Service Worker y /wisp/.',
    },
    en: {
      url: 'Enter a valid HTTP or HTTPS URL or a search query.',
      origin: 'Set your Render HTTPS URL in the stryx-proxy-origin tag in index.html.',
      local: 'Open Stryx from your Node.js server.',
      worker: 'Ultraviolet requires HTTPS or localhost and a browser with Service Workers.',
      scope: 'The Service Worker does not cover the Ultraviolet route. Check register-sw.js and uv.config.js.',
      assets: 'Could not load',
      config: 'The Ultraviolet or BareMux configuration is unavailable.',
      timeout: 'Ultraviolet took too long to start. Check the Service Worker and /wisp/.',
    },
  };
  const message = key => labels[document.documentElement.lang === 'es' ? 'es' : 'en'][key];
  const fail = key => new Error(message(key));
  const assets = [
    '/baremux/index.js',
    '/uv/uv.bundle.js',
    '/uv/uv.config.js',
    '/register-sw.js',
  ];
  const transport = '/epoxy/index.mjs';
  const loadedScripts = new Map();
  let startup;

  function destination(value, engine) {
    const input = String(value ?? '').trim();
    if (!input || input.length > 2048) throw fail('url');

    const hostLike = /^(?:[\p{L}\d-]+\.)+[\p{L}\d-]+(?::\d+)?(?:[/?#]|$)/iu;
    const loopbackLike = /^(?:localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
    const looksLikeUrl = !/\s/.test(input) && (hostLike.test(input) || loopbackLike.test(input));
    const hasScheme = /^(?:https?:|[a-z][a-z\d+.-]*:\/\/|javascript:|data:|file:|blob:|mailto:|tel:|about:|vbscript:)/i.test(input);
    if (looksLikeUrl || hasScheme) {
      let url;
      try {
        url = new URL(looksLikeUrl ? 'https://' + input : input);
      } catch {
        throw fail('url');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('url');
      return url;
    }

    const url = new URL(Object.hasOwn(engineUrls, engine) ? engineUrls[engine] : engineUrls.duckduckgo);
    url.searchParams.set('q', input);
    return url;
  }

  function backendOrigin() {
    if (!['https:', 'http:'].includes(location.protocol)) throw fail('local');
    if (localhost.has(location.hostname)) return location.origin;

    const value = document.querySelector('meta[name="stryx-proxy-origin"]')?.content.trim();
    if (!value) {
      if (location.hostname.endsWith('.github.io')) throw fail('origin');
      return location.origin;
    }

    let url;
    try {
      url = new URL(value);
    } catch {
      throw fail('origin');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw fail('origin');
    }
    return url.origin;
  }

  function loadScript(path) {
    if (loadedScripts.has(path)) return loadedScripts.get(path);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = path;
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        reject(new Error(message('assets') + ' ' + path));
      };
      document.head.append(script);
    }).catch(error => {
      loadedScripts.delete(path);
      throw error;
    });
    loadedScripts.set(path, promise);
    return promise;
  }

  function within(promise, ms = 12000) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(fail('timeout')), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function start() {
    if (!isSecureContext || !navigator.serviceWorker) throw fail('worker');
    for (const path of assets) await within(loadScript(path));

    const config = globalThis.__uv$config;
    if (typeof config?.encodeUrl !== 'function' || typeof config.prefix !== 'string' ||
        typeof globalThis.BareMux?.BareMuxConnection !== 'function' || typeof globalThis.registerSW !== 'function') {
      throw fail('config');
    }

    const prefix = new URL(config.prefix, location.origin);
    if (prefix.origin !== location.origin || !prefix.pathname.endsWith('/') || prefix.search || prefix.hash) {
      throw fail('config');
    }

    const sw = navigator.serviceWorker;
    await within(globalThis.registerSW());
    const registration = await within(sw.getRegistration(prefix.href));
    if (!registration || !prefix.href.startsWith(registration.scope)) throw fail('scope');
    if (registration.active?.state !== 'activated') {
      const worker = registration.installing || registration.waiting || registration.active;
      if (!worker) throw fail('scope');
      let listener;
      try {
        await within(new Promise((resolve, reject) => {
          listener = () => {
            if (worker.state === 'activated') resolve();
            if (worker.state === 'redundant') reject(fail('worker'));
          };
          worker.addEventListener('statechange', listener);
          listener();
        }));
      } finally {
        if (listener) worker.removeEventListener('statechange', listener);
      }
    }

    const connection = new globalThis.BareMux.BareMuxConnection('/baremux/worker.js');
    const wisp = new URL('/wisp/', location.origin);
    wisp.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (await within(connection.getTransport()) !== transport) {
      await within(connection.setTransport(transport, [{wisp: wisp.href}]));
    }
    return {prefix, config};
  }

  async function open(value, engine) {
    const target = destination(value, engine);
    const backend = backendOrigin();
    if (backend !== location.origin) {
      const entry = new URL('/', backend);
      entry.hash = new URLSearchParams({uv: target.href}).toString();
      location.assign(entry.href);
      return;
    }

    startup ??= start().catch(error => {
      startup = undefined;
      throw error;
    });
    const {prefix, config} = await startup;
    // encodeUrl creates the URL representation expected by this UV build.
    location.assign(prefix.href + config.encodeUrl(target.href));
  }

  function handoff() {
    const value = new URLSearchParams(location.hash.slice(1)).get('uv');
    return value || null;
  }

  window.StryxProxy = Object.freeze({open, handoff});
})();
