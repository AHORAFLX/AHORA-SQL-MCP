/**
 * Formulario local del instalador.
 *
 * Levanta un servidor en 127.0.0.1, abre el navegador y sirve un formulario
 * autocontenido. No hay dependencias: solo `http` y un HTML con el CSS y el JS
 * dentro. El exe no crece nada y funciona en cualquier maquina con navegador.
 *
 * La logica es la MISMA que la del asistente de terminal (installer/setup.js) y la
 * del wrapper: aqui solo hay presentacion y transporte.
 *
 * SEGURIDAD: un servidor local que escribe ficheros es alcanzable por cualquier
 * pagina que el usuario tenga abierta. Contra eso:
 *   - escucha solo en 127.0.0.1,
 *   - cada peticion a /api necesita un token aleatorio que solo viaja en la URL
 *     que abrimos nosotros, enviado en una cabecera propia (una peticion
 *     cross-origin no puede poner cabeceras propias sin un preflight, que no
 *     respondemos),
 *   - se rechaza cualquier peticion con cabecera Origin ajena.
 */
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const {
  resolveConfigFile,
  listConnectionNames,
  readConnString,
  parseAdoConnectionString,
  applyConnection,
  resolveEnvironment,
} = require("../bin/start-mssql-mcp");

const {
  findConfigFiles,
  buildFlags,
  resolveServerEntry,
  writeClientConfig,
  pruneLegacyServer,
  buildProductFlags,
  productCommandFrom,
  writeProductConfig,
  hasProductServer,
  installProduct,
  buildPlaywrightFlags,
  playwrightCommand,
  writePlaywrightConfig,
  hasPlaywrightServer,
  installPlaywright,
  suggestAliases,
  aliasError,
  toolVersion,
  CLIENTS,
  PROFILES,
  SERVER_NAME,
  PRODUCT_SERVER_NAME,
  PLAYWRIGHT_SERVER_NAME,
  MIN_NODE_MAJOR,
} = require("./setup");
const {
  PRODUCT_PACKAGE,
  productRuntimeDir,
  productDll,
  installedProductVersion,
  latestProductVersion,
  dotnetSdkVersion,
} = require("./product-mcp");
const {
  PLAYWRIGHT_PACKAGE,
  playwrightRuntimeDir,
  installedPlaywrightVersion,
  detectBrowserChannel,
} = require("./playwright-mcp");
const { credentialsPathFor, writeCredentialsFile } = require("./credentials");
const { probeConnection } = require("./probe");
const { allowMcpTools } = require("./permissions");
const { readExisting, revealStoredPassword, samePath } = require("./existing");
const { installedVersion, runtimeDir, compareVersions } = require("./runtime");

const PKG_VERSION = require("../package.json").version;
const TOKEN_HEADER = "x-ahora-token";

/** Detecta los ficheros de configuracion de un proyecto y sus nombres de conexion. */
function detect(projectDir) {
  const root = path.resolve(projectDir);
  if (!fs.existsSync(root)) throw new Error(`No existe la carpeta: ${root}`);

  // Lo que el proyecto YA tiene configurado, para poder ofrecerlo puesto en vez de
  // hacer repetir todas las respuestas. Nunca lanza: como mucho dice que no hay nada.
  const existing = readExisting(root);

  const rutas = findConfigFiles(root);
  // El fichero con el que se configuro el proyecto puede no salir en la busqueda
  // (esta fuera de la carpeta, o en una que el buscador descarta por ruido). Sin
  // anadirlo no habria ninguna opcion que marcar y la precarga perderia la fuente,
  // que es justo el dato que mas cuesta volver a encontrar.
  if (existing.configFile && fs.existsSync(existing.configFile)) {
    if (!rutas.some((f) => samePath(f, existing.configFile))) {
      rutas.push(path.resolve(existing.configFile));
    }
  }

  const files = rutas.map((file) => {
    let names = [];
    let error = null;
    try {
      names = listConnectionNames(file);
    } catch (err) {
      error = err.message;
    }
    return {
      path: file,
      rel: path.relative(root, file) || path.basename(file),
      type: path.extname(file).toLowerCase() === ".json" ? "core" : "framework",
      names,
      // Los alias se sugieren aqui y no en el navegador para no tener dos
      // implementaciones de la misma regla: es la que usa tambien el asistente de
      // terminal.
      aliases: suggestAliases(names),
      error,
    };
  });
  return {
    root,
    files,
    defaultEnvironment: resolveEnvironment(undefined),
    // Con el MCP de producto ya registrado, la casilla viene marcada: asi una
    // reinstalacion no lo retira por dejar la casilla como estaba, que es justo lo
    // que haria si el valor por defecto fuera siempre "no".
    hasProduct: hasProductServer(root),
    // Lo mismo para el de Playwright, y contando tambien el puesto a mano: si ya hay
    // uno registrado, dejar la casilla en "no" haria que reinstalar lo retirase.
    hasPlaywright: hasPlaywrightServer(root),
    existing,
  };
}

/**
 * Que se puede ofrecer del MCP de navegador en ESTE equipo.
 *
 * Barato, al contrario que el del MCP de producto: no consulta ningun feed, solo mira
 * si hay Chrome o Edge en las rutas de siempre y que version quedo instalada.
 */
function playwrightStatus() {
  const dir = playwrightRuntimeDir();
  return {
    package: PLAYWRIGHT_PACKAGE,
    serverName: PLAYWRIGHT_SERVER_NAME,
    channel: detectBrowserChannel(),
    installed: installedPlaywrightVersion(dir),
    dir,
  };
}

/**
 * Que se puede ofrecer del MCP de desarrollo de producto en ESTE equipo.
 *
 * Se consulta cuando se marca la casilla, y no al detectar el proyecto, porque
 * implica una llamada al feed: quien no lo quiera no paga esa espera.
 *
 * Ninguno de los tres datos aborta nada por si mismo. Sin SDK todavia queda copiar
 * una carpeta ya publicada, y sin feed —hay redes donde api.nuget.org no se
 * alcanza— tambien.
 */
async function productStatus() {
  const dir = productRuntimeDir();
  const status = {
    package: PRODUCT_PACKAGE,
    serverName: PRODUCT_SERVER_NAME,
    dotnet: dotnetSdkVersion(),
    installed: installedProductVersion(dir),
    dir,
    latest: null,
    feedError: null,
  };
  try {
    status.latest = await latestProductVersion();
  } catch (err) {
    status.feedError = err.message;
  }
  return status;
}

/**
 * Valida la conexion.
 *
 * Con fichero de configuracion: resuelve cada cadena y ademas intenta CONECTAR.
 * Sin fichero: los datos vienen tecleados, asi que conectar es la unica forma de
 * saber si son correctos — comprobar que los campos no estan vacios no vale nada.
 *
 * `manual` admite una conexion o una lista: sin fichero de configuracion tambien se
 * pueden exponer varias bases de datos, igual que con el. Se acepta la forma de una
 * sola por compatibilidad con quien ya llame a esto.
 */
async function validate({ projectDir, configFile, environment, names = [], manual }) {
  if (!configFile) {
    const typed = (Array.isArray(manual) ? manual : [manual]).filter(Boolean);
    if (typed.length === 0) {
      throw new Error("Faltan datos: servidor, base de datos, usuario y contrasena.");
    }
    // El alias solo importa con varias: con una la clave es siempre `maindb`. Se
    // sugiere aqui, con la misma regla que usa el fichero de configuracion, para no
    // tener una segunda implementacion en el navegador.
    const suggested =
      typed.length > 1 ? suggestAliases(typed.map((m) => m.alias || m.database)) : [];
    const results = [];
    for (const [i, one] of typed.entries()) {
      // La contrasena puede venir vacia a proposito: al reconfigurar significa "la
      // de siempre". Se recupera la guardada para poder probar de verdad, y solo
      // falta de veras si tampoco hay ninguna.
      const password = one.password || revealStoredPassword(projectDir, one.alias);
      if (!one.server || !one.database || !one.user || !password) {
        throw new Error("Faltan datos: servidor, base de datos, usuario y contrasena.");
      }
      const probe = await probeConnection({
        datasource: one.server,
        initialcatalog: one.database,
        userid: one.user,
        password,
        ...(one.port ? { datasource: `${one.server},${one.port}` } : {}),
      });
      const alias = typed.length > 1 ? one.alias || suggested[i] : undefined;
      results.push({
        ...probe,
        manual: true,
        alias,
        name: alias || "(datos introducidos)",
      });
    }
    return results;
  }

  const resolved = resolveConfigFile(configFile);
  const results = [];
  for (const { name, alias } of names) {
    try {
      const { value, source } = readConnString(resolved, name, { environment });
      const parts = parseAdoConnectionString(value);
      const info = applyConnection({}, "MSSQL_", parts, name);
      const probe = await probeConnection(parts);
      results.push({
        name,
        alias,
        ok: true,
        target: info.target,
        database: info.database,
        source: path.basename(source),
        connected: probe.ok,
        connectError: probe.ok ? undefined : probe.error,
        hint: probe.hint,
      });
    } catch (err) {
      results.push({ name, alias, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Node DE LA MAQUINA, no el que ejecuta esto.
 *
 * El .exe empaquetado lleva su propio Node embebido (postject/SEA), asi que puede
 * detectar el proyecto y probar la conexion sin que haya Node instalado en el
 * equipo. Pero `resolveServerEntry` instala el runtime con `npm` del sistema y, si
 * eso falla, cae a una configuracion que arranca con `npx` del sistema: sin Node en
 * el PATH ninguna de las dos existe, y el formulario terminaria "bien" dejando un
 * .mcp.json que ningun cliente puede arrancar. Se comprueba aqui, antes de tocar
 * nada, en vez de dejar que resolveServerEntry falle y confiar en el aviso de la
 * forma npx (ver mas abajo): con Node ausente esa forma tampoco funciona.
 */
function checkNodeOnMachine(version = toolVersion("node")) {
  if (!version) {
    throw new Error(
      "No hay Node.js instalado en este equipo (no esta en el PATH). Instala Node " +
        "LTS desde https://nodejs.org/ y vuelve a lanzar el instalador."
    );
  }
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    throw new Error(
      `Node ${version} es demasiado antiguo. Hace falta ${MIN_NODE_MAJOR} o superior: ` +
        "instala Node LTS desde https://nodejs.org/ y vuelve a lanzar el instalador."
    );
  }
}

/**
 * `install` es inyectable para poder probar el formulario sin instalar nada de la red:
 * en produccion es la instalacion de verdad, que ocurre una sola vez.
 */
function write(payload, { install } = {}) {
  checkNodeOnMachine();
  const {
    projectDir,
    configFile,
    environment,
    connections = [],
    manualConnections = [],
    profileKey,
    sqlDirs = [],
    clients = [],
  } = payload;

  const root = path.resolve(projectDir);
  const profile = PROFILES.find((p) => p.key === profileKey) || PROFILES[0];
  const allowWrites = Boolean(payload.allowWrites) && profile.canWrite;

  for (const dir of sqlDirs) {
    if (!fs.existsSync(dir)) throw new Error(`La carpeta de .sql no existe: ${dir}`);
  }

  // Con varias conexiones el alias no es decorativo: se convierte en
  // `MSSQL_<ALIAS>_DATABASE`, y el servidor descubre las bases de datos escaneando
  // ese patron. Un alias invalido o repetido hace desaparecer una conexion sin
  // ningun error, asi que se rechaza aqui. Vale igual para las tecleadas a mano: van
  // al fichero de credenciales bajo esa misma clave.
  const checkAliases = (list, label) => {
    if (list.length < 2) return;
    const seen = [];
    for (const c of list) {
      const problem = aliasError(c.alias, seen);
      if (problem) throw new Error(`Alias de '${label(c)}': ${problem}.`);
      seen.push(c.alias);
    }
  };
  checkAliases(connections, (c) => c.name);
  checkAliases(manualConnections, (c) => c.database);

  let credentialsFile;
  if (manualConnections.length > 0) {
    credentialsFile = writeCredentialsFile(root, manualConnections);
  } else if (!configFile) {
    throw new Error("Falta el fichero de configuracion o los datos de conexion.");
  }

  const flags = buildFlags({
    configFile: configFile ? resolveConfigFile(configFile) : undefined,
    credentialsFile,
    connections,
    environment: configFile && path.extname(configFile).toLowerCase() === ".json" ? environment : undefined,
    allowWrites,
    production: profile.production,
    sqlDirs,
  });

  // El servidor se instala una vez y la configuracion apunta ahi. Resolverlo con npx
  // en cada arranque costaba ~7 segundos, y ~48 la primera vez con un pin de version
  // nuevo, contra los 30 que espera el cliente MCP antes de descartar el servidor.
  //
  // Si la instalacion falla, resolveServerEntry cae a la forma npx en silencio (ver
  // su comentario en setup.js): sin capturar `installError` aqui, el formulario
  // termina "bien" y deja escrito el .mcp.json lento sin que nadie se entere.
  let installError;
  // Sin git la reserva npx TAMPOCO arranca (resuelve el mismo spec `github:`), asi que
  // el aviso no puede decir "funciona, pero es lenta": tiene que decir que falta Git.
  let gitMissing = false;
  // Si este formulario es mas viejo que lo ya instalado, installRuntime se queda con
  // lo nuevo. Hay que decirlo: si no, quien guarda desde una ventana vieja ve
  // "escrito correctamente" y se queda sin saber por que la version no cambia.
  let keptNewer;
  const serverEntry = resolveServerEntry(flags, {
    ...(install ? { install } : {}),
    log: (r) => {
      if (!r.ok) {
        installError = r.error.message.split("\n")[0];
        gitMissing = r.error.code === "ENOGIT";
      } else if (r.keptNewer) keptNewer = r.keptNewer;
    },
  });
  const args = serverEntry.args;

  const written = [];
  for (const key of clients) {
    const client = CLIENTS[key];
    if (!client) continue;
    const result = writeClientConfig(client, root, serverEntry);
    written.push({ ...result, client: key });
  }
  if (written.length === 0) throw new Error("No se ha indicado ningun cliente MCP.");

  // ── MCP de desarrollo de producto ──
  //
  // Segunda entrada del MISMO fichero, al lado de la de SQL: los dos servidores
  // conviven en la sesion, con prefijos distintos (`mcp__ahora-sql__*` y
  // `mcp__ahora-erp__ahora_*`), y ninguno sustituye al otro.
  let productWritten = null;
  let productError;
  let productInstall = null;
  // En produccion no se ofrece, por el mismo motivo que la escritura: `ahora-mcp` no
  // tiene modo de solo lectura, asi que no hay forma de dejarlo configurado para que
  // no pueda tocar el ERP en vivo.
  const wantsProduct = Boolean(payload.product) && !profile.production;
  if (wantsProduct) {
    const pick = payload.productConnection;
    if (!pick || !pick.name) {
      throw new Error(
        "Falta la base de datos del MCP de producto: ese servidor maneja una sola por " +
          "proceso, asi que hay que elegir cual."
      );
    }
    try {
      productInstall = installProduct({
        version: payload.productVersion,
        folder: payload.productFolder,
      });
      const productEntry = productCommandFrom(
        serverEntry,
        buildProductFlags({
          serverDll: productDll(productInstall.dir),
          configFile: configFile ? resolveConfigFile(configFile) : undefined,
          credentialsFile,
          connectionName: pick.name,
          db: pick.alias,
          environment:
            configFile && path.extname(configFile).toLowerCase() === ".json"
              ? environment
              : undefined,
          production: profile.production,
        })
      );
      productWritten = [];
      for (const key of clients) {
        const client = CLIENTS[key];
        if (!client) continue;
        productWritten.push({
          ...writeProductConfig(client, root, productEntry),
          client: key,
        });
      }
    } catch (err) {
      // No tumba la escritura: el MCP de SQL ya esta configurado, y perderlo por un
      // fallo del segundo servidor seria peor que quedarse sin el segundo.
      productError = err.message.split("\n")[0];
      productInstall = null;
      productWritten = null;
    }
  } else {
    // Sin marcar, se retira la nuestra —y solo la nuestra—: si no, quien la desmarca
    // en una reinstalacion se la encuentra igualmente registrada.
    for (const key of Object.keys(CLIENTS)) {
      writeProductConfig(CLIENTS[key], root, null);
    }
  }

  // ── MCP de automatizacion de navegador ──
  //
  // Tercera entrada del mismo fichero. No se condiciona al perfil, al contrario que
  // la del MCP de producto: conduce un navegador, no toca la base de datos, asi que
  // en produccion es igual de valido — y mas util, porque es donde se mira sin tocar.
  let playwrightWritten = null;
  let playwrightError;
  let playwrightInstall = null;
  if (payload.playwright) {
    try {
      playwrightInstall = installPlaywright();
      const playwrightEntry = playwrightCommand(
        playwrightInstall.entry,
        buildPlaywrightFlags({ channel: playwrightInstall.channel })
      );
      playwrightWritten = [];
      for (const key of clients) {
        const client = CLIENTS[key];
        if (!client) continue;
        playwrightWritten.push({
          ...writePlaywrightConfig(client, root, playwrightEntry),
          client: key,
        });
      }
    } catch (err) {
      // Mismo criterio que con el MCP de producto: no tumba lo ya escrito.
      playwrightError = err.message.split("\n")[0];
      playwrightInstall = null;
      playwrightWritten = null;
    }
  } else {
    // Sin marcar se retira la nuestra, y SOLO la nuestra: un `npx @playwright/mcp`
    // puesto a mano funciona y no lo escribio este instalador.
    for (const key of Object.keys(CLIENTS)) {
      writePlaywrightConfig(CLIENTS[key], root, null);
    }
  }

  // En el fichero del cliente que NO se ha marcado, la entrada `mssql` vieja tambien
  // hay que retirarla: dejarla registrada mantiene el choque de nombres con la
  // extension nativa de VS Code y puede acabar levantando dos servidores identicos.
  const pruned = [];
  for (const key of Object.keys(CLIENTS)) {
    if (clients.includes(key)) continue;
    const target = pruneLegacyServer(CLIENTS[key], root);
    if (target) pruned.push(target);
  }

  // Reglas de permisos: sin ellas, el modo auto puede denegar hasta una lectura y
  // el mensaje no menciona el MCP.
  let permissions;
  if (payload.allowRules && clients.includes("claude")) {
    permissions = allowMcpTools(root, {
      // Las escrituras solo si se piden Y el perfil las admite.
      includeWrites: Boolean(payload.allowWriteRules) && allowWrites,
      // Las del MCP de producto van aparte: sus herramientas no comparten vocabulario
      // con las de aqui, asi que un comodin no cubre las dos.
      product: Boolean(productWritten),
      productWrites: Boolean(productWritten) && Boolean(payload.allowProductWriteRules),
      // Y las del navegador otra vez aparte: `browser_*` no lo cubre ningun comodin
      // de los anteriores, y el clic se pide por separado del mirar.
      playwright: Boolean(playwrightWritten),
      playwrightActions:
        Boolean(playwrightWritten) && Boolean(payload.allowPlaywrightActionRules),
    });
  }

  return {
    written,
    pruned,
    args,
    command: serverEntry.command,
    installError,
    gitMissing,
    keptNewer,
    credentialsFile,
    permissions,
    production: profile.production,
    allowWrites,
    dbKeys: connections.length > 0
      ? connections.map((c) => c.alias || "maindb")
      : manualConnections.map((c) => c.alias || "maindb"),
    product: productWritten
      ? {
          serverName: PRODUCT_SERVER_NAME,
          written: productWritten,
          version: productInstall.version,
          dir: productInstall.dir,
          from: productInstall.from,
          reused: productInstall.reused,
          connection: payload.productConnection.name,
        }
      : null,
    productError,
    playwright: playwrightWritten
      ? {
          serverName: PLAYWRIGHT_SERVER_NAME,
          written: playwrightWritten,
          version: playwrightInstall.version,
          dir: playwrightInstall.dir,
          channel: playwrightInstall.channel,
          chromium: playwrightInstall.chromium,
          reused: playwrightInstall.reused,
          offline: playwrightInstall.offline,
        }
      : null,
    playwrightError,
  };
}

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("cuerpo demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`cuerpo JSON no valido: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Arranca el formulario.
 *
 * `onReady` recibe { url, port, token } en cuanto escucha: es lo que permite
 * probar los endpoints sin tener que rascar la URL de la salida por consola.
 */
function startGui({
  open = true,
  host = "127.0.0.1",
  onReady,
  quiet = false,
  cwd = process.cwd(),
  install,
} = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  // Si la carpeta ya tiene nuestra entrada, la pagina se detecta sola al abrirse:
  // quien vuelve al instalador viene a cambiar algo concreto, y pulsar "Detectar"
  // para ver lo que ya tenia no decide nada.
  let yaConfigurado = false;
  try {
    yaConfigurado = readExisting(path.resolve(cwd)).found;
  } catch {
    // Una carpeta que no existe no impide abrir el formulario: se escribe otra.
  }
  // Que version hay instalada en el equipo. Sirve para delatar a un formulario
  // viejo que se haya quedado abierto: su servidor local sigue vivo hasta que se
  // cierra, y guardar ahi degradaba la instalacion sin decir nada.
  let instalada = null;
  try {
    instalada = installedVersion(runtimeDir());
  } catch {
    // No saberlo no impide instalar; solo se pierde el aviso.
  }
  const html = renderPage(token, cwd, {
    autoDetect: yaConfigurado,
    installedRuntime: instalada,
  });

  return new Promise((resolve, reject) => {
    let finished = false;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${host}`);
      const origin = req.headers.origin;

      // Solo se sirve la pagina si la URL lleva el token; el resto de peticiones
      // deben traerlo en la cabecera propia.
      if (req.method === "GET" && url.pathname === "/") {
        if (url.searchParams.get("t") !== token) {
          res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          res.end("Token no valido. Vuelve a abrir la URL que imprime el instalador.");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(html);
        return;
      }

      if (!url.pathname.startsWith("/api/")) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers[TOKEN_HEADER] !== token) {
        sendJson(res, 403, { error: "token no valido" });
        return;
      }
      if (origin && origin !== `http://${host}:${server.address().port}`) {
        sendJson(res, 403, { error: "origen no permitido" });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "usa POST" });
        return;
      }

      try {
        const body = await readBody(req);
        switch (url.pathname) {
          case "/api/detect":
            return sendJson(res, 200, detect(body.projectDir));
          case "/api/validate":
            return sendJson(res, 200, { results: await validate(body) });
          case "/api/product":
            return sendJson(res, 200, await productStatus());
          case "/api/playwright":
            return sendJson(res, 200, playwrightStatus());
          case "/api/write":
            return sendJson(res, 200, write(body, { install }));
          case "/api/quit":
            sendJson(res, 200, { ok: true });
            finished = true;
            server.close(() => resolve({ completed: true }));
            return;
          default:
            return sendJson(res, 404, { error: "endpoint desconocido" });
        }
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });

    server.on("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      const url = `http://${host}:${port}/?t=${token}`;
      if (!quiet) {
        console.log(`\nInstalador AHORA-SQL-MCP v${PKG_VERSION}`);
        console.log("─".repeat(66));
        console.log("Se abre el formulario en el navegador. Si no se abre solo,");
        console.log("copia esta direccion:");
        console.log(`\n  ${url}\n`);
        console.log("Deja esta ventana abierta mientras lo usas. Ctrl+C para salir.");
        console.log("─".repeat(66));
      }
      if (open) openBrowser(url);
      if (onReady) onReady({ url, port, token });
    });

    server.on("close", () => {
      if (!finished) resolve({ completed: false });
    });
  });
}

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * `cwd` precarga el campo de la carpeta del proyecto.
 *
 * Es lo mismo que hace el asistente de terminal al ofrecer process.cwd() como
 * valor por defecto: si lanzas el instalador desde la carpeta del proyecto no
 * tienes que teclear nada, y si no, editas el campo. El exe NO tiene que estar en
 * el proyecto.
 */
function renderPage(
  token,
  cwd = process.cwd(),
  { autoDetect = false, installedRuntime = null } = {}
) {
  // Un instalador MAS VIEJO que lo ya instalado solo puede hacer dano: al guardar
  // reinstala su propia version encima de la nueva. Ya no lo hace —installRuntime se
  // queda con la mas nueva— pero hay que decirlo, porque lo que esta mirando quien
  // abrio esto es una pantalla de otra version, con otras opciones.
  const obsoleto =
    installedRuntime && compareVersions(installedRuntime, PKG_VERSION) > 0
      ? installedRuntime
      : null;
  const profiles = PROFILES.map(
    (p) => `<option value="${p.key}" data-canwrite="${p.canWrite}">${p.label}</option>`
  ).join("");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Instalador AHORA-SQL-MCP</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#1a1d21; --card:#fff; --line:#d8dce2;
          --accent:#0b5fff; --ok:#0a7c3f; --err:#c02626; --muted:#5b6472; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#15181c; --fg:#e8eaed; --card:#1e2227; --line:#333941; --accent:#5b9bff;
            --ok:#4bc07c; --err:#ff6b6b; --muted:#9aa3b0; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px 20px 64px; background:var(--bg); color:var(--fg);
         font:15px/1.55 "Segoe UI",system-ui,sans-serif; }
  .wrap { max-width:760px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 28px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px;
            padding:20px 22px; margin-bottom:18px; }
  section[hidden] { display:none; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
       margin:0 0 14px; }
  label { display:block; font-weight:600; margin:14px 0 5px; }
  label:first-of-type { margin-top:0; }
  input[type=text], input[type=password], select { width:100%; padding:9px 11px; font-size:14px;
    border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--fg); }
  .row { display:flex; gap:10px; align-items:flex-end; }
  .row > *:first-child { flex:1; }
  button { padding:9px 16px; font-size:14px; font-weight:600; border:0; border-radius:7px;
           background:var(--accent); color:#fff; cursor:pointer; }
  button.sec { background:transparent; color:var(--accent); border:1px solid var(--line); }
  button:disabled { opacity:.5; cursor:default; }
  .hint { color:var(--muted); font-size:13px; margin:6px 0 0; }
  .list { margin:10px 0 0; padding:0; list-style:none; }
  .list li { padding:8px 10px; border:1px solid var(--line); border-radius:7px; margin-bottom:6px;
             display:flex; gap:10px; align-items:center; }
  .list input[type=radio], .list input[type=checkbox] { width:auto; margin:0; }
  .ok { color:var(--ok); } .err { color:var(--err); }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:7px; padding:12px;
        overflow-x:auto; font-size:12.5px; margin:10px 0 0; }
  .banner { padding:11px 13px; border-radius:7px; margin:0 0 14px; font-size:14px; }
  .banner.warn { background:rgba(192,38,38,.1); border:1px solid var(--err); }
  .banner.good { background:rgba(10,124,63,.1); border:1px solid var(--ok); }
  fieldset { border:1px solid var(--line); border-radius:7px; padding:12px 14px; margin:14px 0 0; }
  legend { font-weight:600; padding:0 6px; font-size:13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Instalador AHORA-SQL-MCP <span class="hint" style="font-size:.5em">v${escAttr(PKG_VERSION)}</span></h1>
  <p class="sub">Configura el acceso a base de datos del agente en la carpeta de tu proyecto.</p>
  ${
    obsoleto
      ? `<div class="banner warn"><strong>Esta ventana es del instalador v${escAttr(
          PKG_VERSION
        )}, y en este equipo ya tienes la v${escAttr(obsoleto)}.</strong>
      Es un formulario viejo que se quedo abierto: su servidor local sigue vivo hasta que
      se cierra. Cierra esta pestana y usa la ventana del instalador nuevo. Si guardas
      aqui, la instalacion se queda como esta (no se degrada), pero estaras eligiendo
      opciones de una version anterior.</div>`
      : ""
  }

  <section id="s1">
    <h2>1 · Proyecto</h2>
    <label for="dir">Carpeta raiz del proyecto</label>
    <div class="row">
      <input type="text" id="dir" value="${escAttr(cwd)}" placeholder="C:\\ruta\\a\\mi\\proyecto">
      <button id="btnDetect">Detectar</button>
    </div>
    <p class="hint">Viene rellenado con la carpeta desde la que has lanzado el instalador.
      <strong>Puedes cambiarla</strong>: el instalador no tiene que estar dentro del proyecto.
      Aqui se buscan el Web.config y el appsettings.json.</p>
    <div id="detectOut"></div>
    <div id="existingOut"></div>
  </section>

  <section id="s2" hidden>
    <h2>2 · Conexion</h2>
    <div id="fileList"></div>
    <div id="coreEnv" hidden>
      <label for="env">Entorno de appsettings</label>
      <input type="text" id="env">
      <p class="hint">En Flexygo Core las cadenas suelen estar vacias en appsettings.json
        y rellenas en appsettings.&lt;entorno&gt;.json.</p>
    </div>
    <div id="names"></div>
    <div id="manual" hidden>
      <label>Sin fichero de configuracion</label>
      <p class="hint">Mete <strong>tantas conexiones como quieras</strong>: cada una sera
        una base de datos distinta para el agente. No se guardan en el .mcp.json: van a
        un fichero fuera del repositorio y en la configuracion solo queda su ruta.</p>
      <div id="manualList"></div>
      <button type="button" class="sec" id="btnAddManual" style="margin-top:10px">
        + Anadir otra conexion</button>
      <p class="hint" id="manualAliasHint" hidden>El alias es la clave con la que el
        agente pedira la base de datos (<code>dbKey</code>). Flexygo usa
        <code>config</code> y <code>data</code>, que es lo que esperan las skills de SC0.
        Acaba dentro de un nombre de variable de entorno: solo letras, digitos y guion
        bajo, empezando por letra. Con una sola conexion se ignora y la clave es
        <code>maindb</code>.</p>
    </div>
    <div class="row" style="margin-top:16px">
      <div></div><button id="btnValidate">Validar conexion</button>
    </div>
    <div id="validateOut"></div>
  </section>

  <section id="s3" hidden>
    <h2>3 · Entorno y permisos</h2>
    <label for="profile">¿Contra que base de datos vas a trabajar?</label>
    <select id="profile">${profiles}</select>
    <div id="writeBox">
      <label style="margin-top:14px"><input type="checkbox" id="writes" style="width:auto">
        Permitir INSERT / UPDATE / DDL</label>
    </div>
    <div id="prodWarn" class="banner warn" hidden style="margin-top:14px">
      En produccion la escritura no se ofrece. La configuracion se marca como
      <strong>PRODUCCION</strong>: si alguien anade <code>--allow-writes</code> a mano,
      el servidor se negara a arrancar.
    </div>
    <label style="margin-top:16px" for="sqlDir">Carpeta con ficheros .sql de fuera del proyecto
      (opcional)</label>
    <input type="text" id="sqlDir" placeholder="C:\\Codigo GIT\\scripts-sql">
    <p class="hint">Los .sql que esten dentro del proyecto ya funcionan sin configurar nada.</p>
    <fieldset>
      <legend>Cliente MCP</legend>
      <label><input type="checkbox" id="cClaude" checked style="width:auto">
        Claude Code <span class="hint">— terminal, escritorio o extension de VS Code
        (.mcp.json)</span></label>
      <label><input type="checkbox" id="cVscode" style="width:auto">
        GitHub Copilot <span class="hint">— dentro de VS Code (.vscode/mcp.json)</span></label>
      <p class="hint">Se distinguen por el agente, no por el editor: la extension de VS Code
        <strong>es</strong> Claude Code y usa el mismo <code>.mcp.json</code>.</p>
      <p class="hint">Claude Code pedira aprobar el servidor la primera vez que abras una sesion
        sobre esta carpeta: hasta que aceptes no aparece ninguna herramienta.</p>
      <label style="margin-top:12px"><input type="checkbox" id="cRules" checked style="width:auto">
        Permitir consultas de lectura sin preguntar</label>
      <p class="hint">En modo auto, Claude Code puede denegar hasta una consulta de lectura con un
        mensaje que no menciona el MCP. Esto lo evita.</p>
      <label id="wrapWriteRules" hidden><input type="checkbox" id="cWriteRules" style="width:auto">
        Permitir tambien las <strong>escrituras</strong> sin preguntar</label>
      <p class="hint" id="hintWriteRules" hidden>Solo en tu maquina. Si no lo marcas, cada
        escritura te pedira permiso, que es el freno que interesa conservar.</p>
    </fieldset>

    <fieldset id="productBox">
      <legend>MCP de desarrollo de producto</legend>
      <label><input type="checkbox" id="cProduct" style="width:auto">
        Instalar tambien el MCP de producto (<code>ahora-mcp</code>)</label>
      <p class="hint">Servidor del equipo de producto, con 98 herramientas para
        personalizar el ERP (objetos, DDA, scripts de pantalla, campos configurables…).
        Se anade <strong>al lado</strong> del de SQL, no en su lugar: los dos funcionan
        en la misma sesion, con prefijos distintos
        (<code>mcp__ahora-sql__*</code> y <code>mcp__ahora-erp__ahora_*</code>).
        Se publica desde <code>nuget.ahorabh.com</code> y necesita el SDK de .NET 10.</p>
      <div id="productOut"></div>
      <div id="productPick" hidden>
        <label for="productDb">Base de datos del ERP</label>
        <select id="productDb"></select>
        <p class="hint">Ese servidor maneja <strong>una sola</strong> base de datos por
          proceso: su <code>ahora_connect</code> no entiende alias ni <code>dbKey</code>.
          Para exponer otra hace falta otra entrada MCP.</p>
      </div>
      <div id="productFolderBox" hidden>
        <label for="productFolder">Carpeta con el MCP ya publicado</label>
        <input type="text" id="productFolder" placeholder="C:\\gitcode\\ahora-mcp">
        <p class="hint">Sin SDK de .NET 10 no se puede publicar el paquete desde NuGet.
          Indica una carpeta que contenga <code>ahora-mcp.dll</code> con sus dependencias
          al lado y se copia tal cual, sin red.</p>
      </div>
      <div id="productWarn" class="banner warn" hidden>
        Ese servidor <strong>siempre</strong> puede escribir en el ERP
        (<code>ahora_ejecutar_dml</code>, <code>ahora_crear_*</code>,
        <code>ahora_modificar_*</code>, <code>ahora_borrar_*</code>): no tiene modo de
        solo lectura, asi que el unico freno son las reglas de permisos.
        <label style="margin-top:8px"><input type="checkbox" id="cProductWriteRules"
          style="width:auto"> Permitir sus <strong>escrituras</strong> sin preguntar</label>
      </div>
      <p class="hint" id="productProdWarn" hidden>En <strong>PRODUCCION</strong> no se
        ofrece: al no tener modo de solo lectura, no hay forma de dejarlo configurado
        para que no toque el ERP en vivo.</p>
    </fieldset>

    <fieldset id="playwrightBox">
      <legend>Automatizacion de navegador (Playwright)</legend>
      <label><input type="checkbox" id="cPlaywright" style="width:auto">
        Instalar tambien el MCP de Playwright (<code>@playwright/mcp</code>)</label>
      <p class="hint">Servidor de Microsoft que conduce un navegador. Sirve para abrir
        la pantalla del ERP y <strong>comprobar</strong> que lo que se acaba de cambiar
        en la base de datos se ve como toca. Se anade <strong>al lado</strong> de los
        otros, con sus herramientas <code>mcp__playwright__browser_*</code>.
        Se instala una vez desde npm, no se resuelve en cada arranque.</p>
      <div id="playwrightOut"></div>
      <div id="playwrightWarn" class="banner warn" hidden>
        Un <strong>clic</strong> en una pantalla del ERP ejecuta lo que haya detras del
        boton, y eso puede acabar en un INSERT que no pasa por las reglas del MCP de
        SQL. Por eso mirar (abrir, capturar, leer la consola) y tocar se piden aparte.
        <label style="margin-top:8px"><input type="checkbox" id="cPlaywrightActionRules"
          style="width:auto"> Permitir que haga <strong>clic y escriba</strong> sin
          preguntar</label>
        <p class="hint" style="margin-bottom:0">Ejecutar JavaScript en la pagina
          (<code>browser_evaluate</code>, <code>browser_run_code_unsafe</code>) pedira
          permiso siempre: una regla para eso autorizaria cualquier cosa.</p>
      </div>
    </fieldset>
    <div class="row" style="margin-top:18px">
      <div></div><button id="btnWrite">Escribir configuracion</button>
    </div>
    <div id="writeOut"></div>
  </section>

  <section id="s4" hidden>
    <h2>4 · Listo</h2>
    <div id="doneOut"></div>
  </section>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);
let detected = null, chosenFile = null, validated = null;

async function api(path, body) {
  const res = await fetch("/api/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ${JSON.stringify(TOKEN_HEADER)}: TOKEN },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "error " + res.status);
  return data;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}

$("btnDetect").onclick = async () => {
  $("detectOut").innerHTML = "Buscando…";
  try {
    detected = await api("detect", { projectDir: $("dir").value });
    $("env").value = detected.defaultEnvironment;
    const withNames = detected.files.filter((f) => f.names.length > 0);
    let html = '<p class="hint">Raiz: ' + esc(detected.root) + "</p>";
    if (detected.files.length === 0) {
      html += '<div class="banner warn">No he encontrado Web.config ni appsettings.json. ' +
              "Puedes meter los datos de conexion a mano en el paso 2.</div>";
    } else {
      html += '<div class="banner good">' + detected.files.length +
              " fichero(s) encontrado(s), " + withNames.length + " con cadenas de conexion.</div>";
    }
    $("detectOut").innerHTML = html;
    renderFiles();
    $("s2").hidden = false;
    applyExisting();
  } catch (e) { $("detectOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>"; }
};

// ── Precarga de lo que ya estaba configurado ─────────────────────────────────
// El instalador se lanza mas veces para CAMBIAR algo (otra base de datos, otro
// cliente, otro entorno) que para configurar de cero, y hasta ahora las dos cosas
// costaban lo mismo: repetir todas las respuestas y volver a marcar todas las
// casillas. Con la configuracion puesta, cambiar de base de datos es tocar un campo.

/** Misma ruta, con las barras y las mayusculas de Windows sin molestar. */
function samePath(a, b) {
  if (!a || !b) return false;
  const n = (p) => String(p).replace(/\\\\/g, "/").toLowerCase().replace(/\\/+$/, "");
  return n(a) === n(b);
}

/** La base de datos que tenia elegida el MCP de producto, para volver a marcarla. */
let productPreset = null;

function applyExisting() {
  const ex = detected.existing;
  $("existingOut").innerHTML = "";
  productPreset = null;
  if (!ex || !ex.found) return;
  productPreset = ex.product;

  if (ex.credentialsFile) applyExistingManual(ex);
  else applyExistingFile(ex);

  // Paso 3. Se pone todo aunque la seccion siga oculta: se revela sola al validar, y
  // entonces ya esta como estaba en vez de con los valores de una instalacion nueva.
  $("profile").value = ex.profileKey;
  $("profile").onchange();
  $("writes").checked = Boolean(ex.allowWrites) && !$("writeBox").hidden;
  syncWriteRules();
  // Despues de syncWriteRules, que apaga esta casilla cuando no hay escritura.
  $("cWriteRules").checked = Boolean(ex.permissions.write) && $("writes").checked;
  $("sqlDir").value = (ex.sqlDirs && ex.sqlDirs[0]) || "";
  // Los clientes son los ficheros donde esta HOY nuestra entrada. Importa dejarlos
  // como estaban: guardar con uno desmarcado no lo retira, pero deja de
  // actualizarlo, y ese se queda apuntando a la base de datos de antes.
  $("cClaude").checked = ex.clients.includes("claude");
  $("cVscode").checked = ex.clients.includes("vscode");
  $("cProductWriteRules").checked = Boolean(ex.permissions.productWrite);
  $("cPlaywrightActionRules").checked = Boolean(ex.permissions.playwrightActions);

  $("btnWrite").textContent = "Guardar cambios";

  let aviso = '<div class="banner good"><strong>Este proyecto ya estaba configurado.</strong> ' +
    "He dejado puesto lo que tenia" + (ex.credentialsFile
      ? " (conexiones guardadas fuera del repositorio; la contrasena se mantiene si dejas el hueco vacio)"
      : "") + ". Cambia solo lo que quieras y pulsa <strong>Guardar cambios</strong>.</div>";
  if (ex.unknown && ex.unknown.length) {
    // Guardar REEMPLAZA la entrada entera, asi que lo que este formulario no sabe
    // editar desaparece. Callarselo seria quitarle a alguien un ajuste que puso a
    // mano sin que se entere.
    aviso += '<div class="banner warn">La entrada actual lleva opciones que este ' +
      "formulario no edita: <code>" + esc(ex.unknown.join(" ")) + "</code>. Si guardas, " +
      "se perderan y habra que volver a ponerlas a mano en el <code>.mcp.json</code>.</div>";
  }
  $("existingOut").innerHTML = aviso;

  // Y se valida sola: con los datos ya puestos, el unico paso que queda antes de
  // poder guardar es probar la conexion, y hacerlo a mano no aporta nada.
  $("btnValidate").click();
}

/** Precarga con fichero de configuracion: marca la fuente y sus cadenas. */
function applyExistingFile(ex) {
  const idx = detected.files.findIndex((f) => samePath(f.path, ex.configFile));
  if (idx === -1) return;
  $("cfg" + idx).checked = true;
  onFileChange();
  if (ex.environment) $("env").value = ex.environment;

  const lis = [...document.querySelectorAll("#names .list li")];
  if (lis.length === 0 || ex.connections.length === 0) return;
  for (const li of lis) li.querySelector(".nm").checked = false;
  for (const conn of ex.connections) {
    const li = lis.find((l) => l.querySelector(".nm").value === conn.name);
    if (!li) continue;
    li.querySelector(".nm").checked = true;
    if (conn.alias) li.querySelector(".al").value = conn.alias;
  }
  // Ninguna casa (han renombrado las cadenas del Web.config): mejor dejar la
  // premarca de siempre que dejar el paso sin nada marcado.
  if (!lis.some((l) => l.querySelector(".nm").checked)) onFileChange();
}

/** Precarga con datos a mano: un bloque por conexion guardada, sin contrasenas. */
function applyExistingManual(ex) {
  $("cfgNone").checked = true;
  onFileChange();
  if (!ex.credentials || ex.credentials.length === 0) return;
  $("manualList").innerHTML = "";
  for (const c of ex.credentials) {
    addManual();
    const b = $("manualList").lastElementChild;
    b.querySelector(".mServer").value = c.port ? c.server + "," + c.port : c.server;
    b.querySelector(".mDb").value = c.database;
    b.querySelector(".mUser").value = c.user;
    b.querySelector(".mAlias").value = c.alias || "";
    if (c.hasPassword) {
      // Vacio significa "la de siempre": el servidor reutiliza el token cifrado sin
      // abrirlo al guardar, y lo descifra solo para probar la conexion.
      b.querySelector(".mPass").placeholder = "(se mantiene la actual)";
    }
  }
  syncManual();
}

function renderFiles() {
  const items = detected.files.map((f, i) =>
    '<li><input type="radio" name="cfg" id="cfg' + i + '" value="' + i + '">' +
    '<label for="cfg' + i + '" style="margin:0;font-weight:400">' + esc(f.rel) +
    ' <span class="hint">' + (f.type === "core" ? ".NET Core" : ".NET Framework") + " · " +
    (f.names.length ? f.names.length + " cadena(s)" : "sin cadenas") + "</span></label></li>"
  ).join("");
  $("fileList").innerHTML = '<ul class="list">' + items +
    '<li><input type="radio" name="cfg" id="cfgNone" value="none">' +
    '<label for="cfgNone" style="margin:0;font-weight:400">No hay fichero: meto los datos a mano</label></li></ul>';
  for (const el of document.querySelectorAll('input[name=cfg]')) el.onchange = onFileChange;
  if (detected.files.length > 0) { $("cfg0").checked = true; onFileChange(); }
  else { $("cfgNone").checked = true; onFileChange(); }
}

function onFileChange() {
  const val = document.querySelector('input[name=cfg]:checked').value;
  // Cambiar de fuente deshace la validacion: lo validado era de la otra.
  validated = null;
  $("s3").hidden = true;
  $("validateOut").innerHTML = "";
  if (val === "none") {
    chosenFile = null;
    $("manual").hidden = false; $("coreEnv").hidden = true; $("names").innerHTML = "";
    if (document.querySelectorAll("#manualList .mconn").length === 0) addManual();
    return;
  }
  chosenFile = detected.files[Number(val)];
  $("manual").hidden = true;
  $("coreEnv").hidden = chosenFile.type !== "core";
  const items = chosenFile.names.map((n, i) =>
    '<li><input type="checkbox" class="nm" id="nm' + i + '" value="' + esc(n) + '">' +
    '<label for="nm' + i + '" style="margin:0;font-weight:400;flex:1">' + esc(n) + "</label>" +
    '<input type="text" class="al" placeholder="alias" style="width:190px" value="' +
    esc(chosenFile.aliases[i] || "") + '">' +
    "</li>").join("");
  $("names").innerHTML = chosenFile.names.length
    ? "<label>Cadenas a exponer</label><ul class=\\"list\\">" + items + "</ul>" +
      '<p class="hint">Marca <strong>todas</strong> las que quieras: no hay limite de dos. ' +
      "Cada una sera una base de datos distinta para el agente, y el alias es la clave " +
      "con la que la pedira. Flexygo usa <code>config</code> y <code>data</code>, que es " +
      "lo que esperan las skills de SC0. Con una sola conexion el alias se ignora y la " +
      "clave es <code>maindb</code>.</p>" +
      '<p class="hint">El alias acaba dentro de un nombre de variable de entorno: solo ' +
      "letras, digitos y guion bajo, empezando por letra.</p>"
    : '<div class="banner warn">Ese fichero no declara cadenas de conexion.</div>';

  // Se premarca el caso habitual de Flexygo (configuracion + datos) si esta, y si no
  // la primera. Las demas quedan a un clic, con el alias ya sugerido.
  const conf = chosenFile.aliases.indexOf("config");
  const data = chosenFile.aliases.indexOf("data");
  if (chosenFile.names.length === 1) $("nm0").checked = true;
  else if (conf !== -1 && data !== -1) {
    $("nm" + conf).checked = true; $("nm" + data).checked = true;
  } else if (chosenFile.names.length > 1) $("nm0").checked = true;
}

function selectedNames() {
  const out = [];
  document.querySelectorAll("#names .list li").forEach((li) => {
    const cb = li.querySelector(".nm");
    if (cb && cb.checked) out.push({ name: cb.value, alias: li.querySelector(".al").value.trim() || undefined });
  });
  // Con una sola conexion la clave es siempre maindb: mandar un alias solo consigue
  // que el wrapper avise de que lo ignora.
  if (out.length === 1) out[0].alias = undefined;
  return out;
}
// ── Conexiones a mano ─────────────────────────────────────────────────────────
// Una lista, no un bloque fijo. El caso de Flexygo (configuracion + datos) tambien
// se da en carpetas sin Web.config, y con un solo bloque la segunda base de datos
// no habia forma de meterla desde aqui.
function addManual() {
  const block = document.createElement("fieldset");
  block.className = "mconn";
  block.innerHTML =
    '<legend></legend>' +
    '<label>Servidor</label>' +
    '<input type="text" class="mServer" placeholder="PC_158\\\\SQL2022">' +
    '<label>Base de datos</label><input type="text" class="mDb">' +
    '<label>Usuario</label><input type="text" class="mUser">' +
    '<label>Contrasena</label><input type="password" class="mPass">' +
    '<div class="mAliasBox" hidden><label>Alias</label>' +
    '<input type="text" class="mAlias" placeholder="config"></div>' +
    '<div class="row" style="margin-top:12px"><div></div>' +
    '<button type="button" class="sec mDel">Quitar</button></div>';
  block.querySelector(".mDel").onclick = () => { block.remove(); syncManual(); };
  // Tocar los datos obliga a volver a validar: lo que se escribe tiene que ser lo
  // que se ha probado contra el servidor, que es la razon de ser del instalador. El
  // alias queda fuera a proposito: se rellena DESPUES de validar, con la sugerencia.
  for (const sel of [".mServer", ".mDb", ".mUser", ".mPass"]) {
    block.querySelector(sel).oninput = invalidateManual;
  }
  $("manualList").appendChild(block);
  syncManual();
  block.querySelector(".mServer").focus();
}

/** Deshace la validacion: el paso 3 no vuelve hasta que se prueben los datos nuevos. */
function invalidateManual() {
  if (chosenFile) return;
  validated = null;
  $("s3").hidden = true;
  $("validateOut").innerHTML = "";
}

/**
 * Numera los bloques y ensena el alias solo cuando hace falta.
 *
 * Con una conexion la clave es siempre maindb y pedir un alias solo consigue que el
 * wrapper avise de que lo ignora; con varias es obligatorio, porque ES la clave.
 */
function syncManual() {
  const blocks = [...document.querySelectorAll("#manualList .mconn")];
  const varias = blocks.length > 1;
  blocks.forEach((b, i) => {
    b.querySelector("legend").textContent = varias ? "Conexion " + (i + 1) : "Datos de conexion";
    b.querySelector(".mAliasBox").hidden = !varias;
    b.querySelector(".mDel").hidden = blocks.length < 2;
  });
  $("manualAliasHint").hidden = !varias;
  invalidateManual();
}

/** Los bloques con algo escrito. Uno vacio del todo se ignora en vez de dar error. */
function manualBlocks() {
  return [...document.querySelectorAll("#manualList .mconn")].filter((b) =>
    [".mServer", ".mDb", ".mUser", ".mPass"].some((sel) => b.querySelector(sel).value.trim())
  );
}

function manualConnections() {
  const out = manualBlocks().map((b) => {
    const v = (sel) => b.querySelector(sel).value.trim();
    const one = { server: v(".mServer"), database: v(".mDb"), user: v(".mUser"),
                  password: b.querySelector(".mPass").value };
    const alias = v(".mAlias");
    if (alias) one.alias = alias;
    return one;
  });
  // Con una sola la clave es siempre maindb: un alias que se quedo de cuando habia
  // dos bloques cambiaria la clave sin que el campo este ni visible.
  if (out.length === 1) delete out[0].alias;
  return out;
}

$("btnAddManual").onclick = addManual;

$("btnValidate").onclick = async () => {
  $("btnValidate").disabled = true;
  $("validateOut").innerHTML = "Probando la conexion contra el servidor…";
  try {
    const manual = chosenFile ? null : manualConnections();
    const names = chosenFile ? selectedNames() : [];
    if (chosenFile && names.length === 0) throw new Error("Elige al menos una cadena de conexion.");
    if (!chosenFile && manual.length === 0) {
      throw new Error("Faltan datos: servidor, base de datos, usuario y contrasena.");
    }

    const { results } = await api("validate", {
      // La carpeta hace falta para encontrar el fichero de credenciales del que
      // recuperar una contrasena que no se ha vuelto a teclear.
      projectDir: detected.root,
      configFile: chosenFile ? chosenFile.path : null,
      environment: $("env").value,
      names, manual,
    });

    const rows = results.map((r) => {
      if (r.manual) {
        // Con varias conexiones hay que poder decir CUAL falla, asi que el alias
        // sugerido va delante: con una sola no hay ambigüedad y estorba.
        const quien = r.alias ? "<strong>" + esc(r.alias) + "</strong> → " : "";
        return r.ok
          ? '<li><span class="ok">✓</span> ' + quien + "conectado a <strong>" + esc(r.target) +
            "</strong> / " + esc(r.database) +
            (r.version ? ' <span class="hint">' + esc(r.version) + "</span>" : "") + "</li>"
          : '<li><span class="err">✗</span> ' + quien + "no conecta a <strong>" + esc(r.target) +
            '</strong><br><span class="err">' + esc(r.error) + "</span>" +
            (r.hint ? '<br><span class="hint">' + esc(r.hint) + "</span>" : "") + "</li>";
      }
      if (!r.ok) {
        return '<li><span class="err">✗</span> <strong>' + esc(r.name) + "</strong> " +
               '<span class="err">' + esc(r.error) + "</span></li>";
      }
      return '<li><span class="' + (r.connected ? "ok" : "err") + '">' + (r.connected ? "✓" : "✗") +
        "</span> <strong>" + esc(r.name) + "</strong> → " + esc(r.target) + " / " + esc(r.database) +
        ' <span class="hint">(de ' + esc(r.source) + ")</span>" +
        (r.connected ? "" : '<br><span class="err">resuelta, pero no conecta: ' + esc(r.connectError) + "</span>") +
        (r.connected || !r.hint ? "" : '<br><span class="hint">' + esc(r.hint) + "</span>") +
        "</li>";
    }).join("");
    $("validateOut").innerHTML = '<ul class="list">' + rows + "</ul>";

    // Que no resuelva es un error del que no se puede seguir: no hay datos.
    if (results.some((r) => !r.manual && !r.ok)) {
      $("validateOut").innerHTML += '<div class="banner warn">Alguna cadena no se resuelve. ' +
        "En .NET Core la causa habitual es el entorno.</div>";
      return;
    }
    // Que no conecte si puede ser circunstancial (VPN, servidor apagado), asi que
    // se puede seguir, pero hay que decirlo a proposito.
    const noConecta = results.some((r) => r.manual ? !r.ok : !r.connected);
    if (noConecta) {
      $("validateOut").innerHTML +=
        '<div class="banner warn">Los datos son legibles pero el servidor no responde. ' +
        "Puede ser la VPN, el SQL Browser parado o una errata.<br>" +
        '<label style="margin-top:8px"><input type="checkbox" id="forzar" style="width:auto"> ' +
        "Continuar de todas formas</label></div>";
      $("forzar").onchange = () => { $("s3").hidden = !$("forzar").checked; };
    }
    // El alias que ha sugerido el servidor se devuelve a los campos, para que quede
    // visible y editable antes de escribir: es la clave con la que el agente pedira
    // la base de datos, no un detalle interno.
    if (!chosenFile) {
      const cajas = manualBlocks().map((b) => b.querySelector(".mAlias"));
      results.forEach((r, i) => {
        if (r.alias && cajas[i] && !cajas[i].value.trim()) cajas[i].value = r.alias;
      });
    }
    validated = chosenFile
      ? { names: results.map((r) => ({ name: r.name, alias: r.alias })) }
      : { manual };
    // El MCP de producto elige entre las conexiones que se acaban de validar, asi
    // que su desplegable no puede rellenarse antes de este punto. Y si el proyecto
    // ya lo tenia registrado, la casilla viene marcada: dejarla siempre en "no"
    // haria que una reinstalacion lo retirase sin que nadie lo pidiera.
    if (detected.hasProduct && !$("cProduct").disabled) $("cProduct").checked = true;
    fillProductDb();
    if ($("cProduct").checked) syncProduct();
    // El de navegador no depende de la conexion, pero su casilla vive en el paso 3,
    // que hasta aqui no se ve. Y por lo mismo que el otro: si el proyecto ya lo tenia
    // registrado, viene marcada.
    if (detected.hasPlaywright && !$("cPlaywright").checked) {
      $("cPlaywright").checked = true;
      syncPlaywright();
    }
    if (!noConecta) $("s3").hidden = false;
  } catch (e) {
    $("validateOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>";
  } finally {
    $("btnValidate").disabled = false;
  }
};

function syncWriteRules() {
  // Las reglas de escritura solo tienen sentido si la escritura esta habilitada.
  const on = $("writes").checked && !$("writeBox").hidden;
  $("wrapWriteRules").hidden = !on;
  $("hintWriteRules").hidden = !on;
  if (!on) $("cWriteRules").checked = false;
}

// ── MCP de desarrollo de producto ───────────────────────────────────────────
// Se consulta el estado del equipo (SDK, feed, version ya instalada) solo al marcar
// la casilla: implica una llamada al feed, y quien no lo quiera no la paga.
let productInfo = null;

/**
 * Las conexiones ya validadas, que son entre las que hay que elegir UNA.
 *
 * Con datos tecleados a mano se releen del formulario y no de lo validado, por el
 * mismo motivo que hace la escritura del MCP de SQL: los alias se rellenan DESPUES
 * de validar (los sugiere el servidor), asi que lo validado puede llevar uno viejo
 * y el --db que se escribiria apuntaria a una conexion que ya no se llama asi.
 */
function validatedConnections() {
  if (!validated) return [];
  if (validated.names) return validated.names.map((n) => ({ name: n.name, alias: n.alias }));
  return manualConnections().map((m) => ({ name: m.database, alias: m.alias }));
}

function fillProductDb() {
  const conns = validatedConnections();
  const previo = $("productDb").value;
  $("productDb").innerHTML = conns
    .map((c, i) => '<option value="' + i + '">' + esc(c.name) +
      (c.alias ? " (alias " + esc(c.alias) + ")" : "") + "</option>")
    .join("");
  if (previo && $("productDb").querySelector('option[value="' + previo + '"]')) {
    $("productDb").value = previo;
  } else if (productPreset) {
    // La que ya tenia elegida el MCP de producto. Se busca por alias y, sin el
    // (proyecto con Web.config), por el nombre de la cadena: son las dos formas en
    // las que su lanzador puede tenerla escrita.
    const i = conns.findIndex((c) =>
      productPreset.db ? c.alias === productPreset.db : c.name === productPreset.connectionName
    );
    if (i !== -1) $("productDb").value = String(i);
  }
  $("productPick").hidden = conns.length < 2;
}

async function syncProduct() {
  const prodProfile = $("profile").selectedOptions[0].dataset.canwrite !== "true";
  $("productProdWarn").hidden = !prodProfile;
  if (prodProfile) {
    $("cProduct").checked = false;
    $("cProduct").disabled = true;
  } else {
    $("cProduct").disabled = false;
  }

  const on = $("cProduct").checked && !prodProfile;
  $("productWarn").hidden = !on;
  $("productPick").hidden = !on || validatedConnections().length < 2;
  if (!on) {
    $("productOut").innerHTML = "";
    $("productFolderBox").hidden = true;
    $("cProductWriteRules").checked = false;
    return;
  }

  fillProductDb();
  $("productOut").innerHTML = '<p class="hint">Comprobando el SDK de .NET y el feed…</p>';
  try {
    productInfo = await api("product");
  } catch (e) {
    $("productOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>";
    return;
  }
  let html = "<ul class=\\"list\\">";
  html += "<li>" + (productInfo.dotnet
    ? '<span class="ok">✓</span> SDK de .NET ' + esc(productInfo.dotnet)
    : '<span class="err">✗</span> sin SDK de .NET 10 en este equipo') + "</li>";
  html += "<li>" + (productInfo.latest
    ? '<span class="ok">✓</span> feed: ultima version <strong>' + esc(productInfo.latest) + "</strong>"
    : '<span class="err">✗</span> feed no alcanzable' +
      (productInfo.feedError ? ' <span class="hint">' + esc(productInfo.feedError) + "</span>" : "")) + "</li>";
  if (productInfo.installed) {
    html += '<li><span class="ok">✓</span> ya instalado: <strong>' +
      esc(productInfo.installed) + "</strong> en " + esc(productInfo.dir) + "</li>";
  }
  html += "</ul>";
  // El feed sirve para SABER la version, no para instalar una que ya esta: si la
  // publicacion existe en disco se reutiliza sin tocar la red. Asi que con el feed
  // caido y algo instalado se puede seguir igual, y hay que decirlo — antes el
  // formulario informaba de la version instalada y acto seguido se negaba a escribir.
  const usable = productInfo.latest || productInfo.installed;
  if (!productInfo.latest && productInfo.installed) {
    html += '<div class="banner warn">El feed no responde, pero se usara la version ' +
      "<strong>" + esc(productInfo.installed) + "</strong> que ya esta instalada en este " +
      "equipo. No se comprueba si hay una mas reciente.</div>";
  }
  $("productOut").innerHTML = html;
  // Sin SDK, sin feed y sin nada instalado, la unica salida es copiar una carpeta ya
  // publicada.
  $("productFolderBox").hidden = Boolean(productInfo.dotnet && usable);
}

$("cProduct").onchange = syncProduct;

// ── MCP de automatizacion de navegador ──────────────────────────────────────
// Sin depender del perfil: no toca la base de datos. Y el estado se consulta al
// marcar la casilla igual que el otro, aunque aqui sea barato (mirar dos rutas de
// disco), para que el formulario no haga trabajo que nadie ha pedido.
let playwrightInfo = null;

async function syncPlaywright() {
  const on = $("cPlaywright").checked;
  $("playwrightWarn").hidden = !on;
  if (!on) {
    $("playwrightOut").innerHTML = "";
    $("cPlaywrightActionRules").checked = false;
    return;
  }
  $("playwrightOut").innerHTML = '<p class="hint">Buscando el navegador…</p>';
  try {
    playwrightInfo = await api("playwright");
  } catch (e) {
    $("playwrightOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>";
    return;
  }
  let html = "<ul class=\\"list\\">";
  html += "<li>" + (playwrightInfo.channel
    ? '<span class="ok">✓</span> usara el <strong>' +
      (playwrightInfo.channel === "chrome" ? "Chrome" : "Edge") +
      "</strong> que ya tienes instalado"
    : '<span class="err">✗</span> no hay Chrome ni Edge en este equipo: habra que bajar ' +
      "Chromium (unos cientos de megas, solo la primera vez)") + "</li>";
  if (playwrightInfo.installed) {
    html += '<li><span class="ok">✓</span> ya instalado: <strong>' +
      esc(playwrightInfo.installed) + "</strong> en " + esc(playwrightInfo.dir) + "</li>";
  }
  html += "</ul>";
  $("playwrightOut").innerHTML = html;
}

$("cPlaywright").onchange = syncPlaywright;

$("profile").onchange = () => {
  const opt = $("profile").selectedOptions[0];
  const canWrite = opt.dataset.canwrite === "true";
  $("writeBox").hidden = !canWrite;
  $("prodWarn").hidden = canWrite;
  if (!canWrite) $("writes").checked = false;
  syncWriteRules();
  syncProduct();
};
$("writes").onchange = syncWriteRules;

$("btnWrite").onclick = async () => {
  $("btnWrite").disabled = true;
  $("writeOut").innerHTML = "Escribiendo…";
  try {
    // Se puede llegar aqui con la validacion deshecha: tocar los datos de una
    // conexion a mano la invalida, y el paso 3 ya estaba a la vista.
    if (!validated) throw new Error("Vuelve a validar la conexion antes de escribir.");
    const clients = [];
    if ($("cClaude").checked) clients.push("claude");
    if ($("cVscode").checked) clients.push("vscode");
    if (clients.length === 0) throw new Error("Elige al menos un cliente MCP.");
    const sqlDirs = $("sqlDir").value.trim() ? [$("sqlDir").value.trim()] : [];

    const res = await api("write", {
      projectDir: detected.root,
      configFile: chosenFile ? chosenFile.path : null,
      environment: $("env").value,
      connections: validated.names || [],
      // Se releen del formulario en vez de usar lo validado: los alias se rellenan
      // DESPUES de validar (los sugiere el servidor), asi que si se toca uno hay que
      // escribir el que se ve, no el de la validacion.
      manualConnections: validated.manual ? manualConnections() : [],
      profileKey: $("profile").value,
      allowWrites: $("writes").checked,
      allowRules: $("cRules").checked,
      allowWriteRules: $("cWriteRules").checked,
      // MCP de producto: se manda la conexion ELEGIDA, no todas, porque ese servidor
      // maneja una sola por proceso.
      product: $("cProduct").checked,
      productConnection: $("cProduct").checked
        ? validatedConnections()[Number($("productDb").value) || 0]
        : null,
      // La del feed si se ha podido consultar; si no, la que ya esta instalada, que se
      // reutiliza sin red. Sin ninguna de las dos queda la carpeta.
      productVersion: productInfo ? productInfo.latest || productInfo.installed : null,
      productFolder: $("productFolderBox").hidden ? null : $("productFolder").value.trim() || null,
      allowProductWriteRules: $("cProductWriteRules").checked,
      // MCP de navegador: no necesita conexion ni version, se resuelve en la
      // instalacion. Solo si se quiere y si sus acciones van sin preguntar.
      playwright: $("cPlaywright").checked,
      allowPlaywrightActionRules: $("cPlaywrightActionRules").checked,
      sqlDirs, clients,
    });

    let html = "<p>Ficheros escritos:</p><ul class=\\"list\\">" +
      res.written.map((w) => "<li>" + esc(w.target) +
        (w.replaced ? ' <span class="hint">(servidor ' + ${JSON.stringify(SERVER_NAME)} + " actualizado)</span>" : "") +
        (w.migrated ? '<br><span class="hint">Retirado el servidor <code>mssql</code> anterior: ' +
          "ese nombre chocaba con la extension nativa de SQL Server de VS Code.</span>" : "") +
        (w.others.length ? ' <span class="hint">· conservados: ' + esc(w.others.join(", ")) + "</span>" : "") +
        "</li>").join("") + "</ul>";
    if (res.command === "npx" && res.gitMissing) {
      html += '<div class="banner warn"><strong>Falta Git en este equipo.</strong> npm lo ' +
        "necesita para descargar el servidor de GitHub, asi que no se ha podido instalar. Se " +
        "ha escrito una configuracion de reserva con <code>npx</code>, pero <strong>tampoco " +
        "arrancara</strong> sin Git. Instala Git for Windows (<code>winget install --id " +
        "Git.Git -e</code> o https://git-scm.com/download/win), cierra y vuelve a abrir VS " +
        "Code o el terminal, y vuelve a lanzar el instalador.</div>";
    } else if (res.command === "npx") {
      html += '<div class="banner warn">No se ha podido instalar el servidor en tu maquina' +
        (res.installError ? " (" + esc(res.installError) + ")" : "") +
        ". Se ha escrito una configuracion de reserva con <code>npx</code>: funciona, pero " +
        "resuelve el paquete contra GitHub en cada arranque y puede tardar hasta un minuto o " +
        "agotar la espera del cliente MCP. Vuelve a lanzar el instalador cuando el problema " +
        "este resuelto para que quede la version rapida.</div>";
    }
    if (res.credentialsFile) {
      html += "<p>Credenciales cifradas con tu cuenta de Windows, fuera del repositorio:</p><pre>" +
        esc(res.credentialsFile) + "</pre>";
    }
    if (res.product) {
      html += '<div class="banner good">MCP de producto <code>' + esc(res.product.serverName) +
        "</code> anadido <strong>junto a</strong> <code>" + ${JSON.stringify(SERVER_NAME)} +
        "</code>, sobre la base de datos <strong>" + esc(res.product.connection) + "</strong>." +
        (res.product.version ? " Version " + esc(res.product.version) + "." : "") +
        (res.product.reused ? " Ya estaba publicado." : "") +
        "<br>Los dos conviven en la misma sesion: <code>mcp__" + ${JSON.stringify(SERVER_NAME)} +
        "__*</code> y <code>mcp__" + esc(res.product.serverName) + "__ahora_*</code>.</div>";
      html += '<div class="banner warn">Ese servidor no tiene modo de solo lectura: ' +
        "siempre puede escribir en el ERP. El unico freno son las reglas de permisos.</div>";
    }
    if (res.productError) {
      html += '<div class="banner warn">No se ha podido instalar el MCP de producto (' +
        esc(res.productError) + "). El de SQL ha quedado configurado igualmente. " +
        "Vuelve a lanzar el instalador con el SDK de .NET 10 disponible, o indica una " +
        "carpeta con el MCP de producto ya publicado.</div>";
    }
    if (res.playwright) {
      const kept = res.playwright.written.filter((w) => w.kept);
      html += '<div class="banner good">MCP de navegador <code>' + esc(res.playwright.serverName) +
        "</code> anadido" +
        (res.playwright.version ? ", version " + esc(res.playwright.version) : "") +
        (res.playwright.reused ? " (ya estaba instalado)" : "") + ". " +
        (res.playwright.channel
          ? "Conducira el <strong>" + esc(res.playwright.channel) + "</strong> de este equipo."
          : "Conducira el Chromium que ha bajado Playwright, no tu navegador.") +
        "<br>Sus herramientas salen como <code>mcp__" + esc(res.playwright.serverName) +
        "__browser_*</code>.</div>";
      if (res.playwright.offline) {
        html += '<div class="banner warn">No se ha podido comprobar si hay una version mas ' +
          "reciente (" + esc(res.playwright.offline) + "): se ha dejado la que ya estaba " +
          "instalada.</div>";
      }
      if (kept.length > 0) {
        html += '<div class="banner warn">En ' +
          kept.map((w) => "<code>" + esc(w.target) + "</code>").join(" y ") +
          " ya habia un <code>" + esc(res.playwright.serverName) + "</code> puesto a mano: " +
          "se ha dejado tal cual, para no llevarse por delante los flags que tenga. " +
          "Si quieres el nuestro, borra esa entrada y vuelve a lanzar el instalador.</div>";
      }
    }
    if (res.playwrightError) {
      html += '<div class="banner warn">No se ha podido instalar el MCP de navegador (' +
        esc(res.playwrightError) + "). El resto ha quedado configurado igualmente.</div>";
    }
    if (res.permissions) {
      html += "<p>Reglas de permisos en <code>" + esc(res.permissions.target) + "</code>:</p>" +
        (res.permissions.alreadyHadAll
          ? '<p class="hint">Ya estaban todas.</p>'
          : "<pre>" + esc(res.permissions.added.join("\\n")) + "</pre>") +
        (res.permissions.removed.length
          ? '<p class="hint">Retiradas, del nombre anterior: ' +
            res.permissions.removed.map((r) => "<code>" + esc(r) + "</code>").join(", ") + "</p>"
          : "");
    }
    if (res.production) html += '<div class="banner warn">Marcada como PRODUCCION, solo lectura.</div>';
    else if (res.allowWrites) html += '<div class="banner warn">Escritura habilitada. Solo local o pruebas.</div>';
    html += "<p><strong>Ahora abre una sesion NUEVA sobre esta carpeta</strong> — la " +
            "configuracion se lee al arrancar la sesion, y es del proyecto: una sesion abierta " +
            "sobre otra carpeta no la ve.</p><ul class=\\"list\\">" +
            "<li><strong>Claude Desktop</strong> (pestana Code): Ctrl+N y elige esta carpeta. " +
            "No hace falta cerrar la aplicacion.</li>" +
            "<li><strong>Claude Code en terminal</strong>: <code>cd</code> aqui y ejecuta " +
            "<code>claude</code>. La primera vez pedira aprobar el servidor del proyecto.</li>" +
            "<li><strong>VS Code</strong>: recarga la ventana con esta carpeta como espacio de " +
            "trabajo.</li></ul>" +
            "<p>Despues pide al agente: «lista las bases de datos configuradas». Debe responder con " +
            res.dbKeys.map((k) => "<code>" + esc(k) + "</code>").join(" y ") + ".</p>" +
            '<p style="margin-top:18px"><button class="sec" id="btnQuit">Cerrar el instalador</button></p>';
    $("doneOut").innerHTML = html;
    $("s4").hidden = false;
    $("writeOut").innerHTML = "";
    $("btnQuit").onclick = async () => {
      await api("quit");
      $("doneOut").innerHTML = "<p>Instalador cerrado. Ya puedes cerrar esta pestana.</p>";
    };
  } catch (e) {
    $("writeOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>";
    $("btnWrite").disabled = false;
  }
};

// Proyecto ya configurado: se arranca la deteccion sin esperar a que nadie pulse.
if (${autoDetect ? "true" : "false"}) $("btnDetect").click();
</script>
</body>
</html>`;
}

module.exports = {
  startGui,
  detect,
  productStatus,
  playwrightStatus,
  validate,
  write,
  checkNodeOnMachine,
  credentialsPathFor,
  writeCredentialsFile,
  renderPage,
  TOKEN_HEADER,
};
