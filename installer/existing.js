/**
 * Lo que YA hay configurado en un proyecto, leido de vuelta.
 *
 * El instalador siempre ha ido en una sola direccion: `buildFlags` (setup.js)
 * convierte las respuestas en los argumentos del `.mcp.json` y ahi se acaba. Sin el
 * camino de vuelta, reconfigurar un proyecto obliga a repetir TODO —el fichero de
 * configuracion, las cadenas, los alias, el entorno, la escritura, los clientes y
 * cada casilla— aunque solo se quiera cambiar de base de datos, que es lo que se
 * hace al saltar de un cliente a otro o de pruebas a local.
 *
 * Este modulo es esa direccion que faltaba: localiza nuestras entradas en los
 * ficheros de cliente y reconstruye con que opciones se escribieron, para que el
 * formulario y el asistente puedan ofrecerlas ya puestas.
 *
 * DOS REGLAS, y las dos por el mismo motivo —esto corre ANTES de que el usuario haya
 * hecho nada, sobre ficheros que puede haber tocado a mano—:
 *
 *   1. No lanza nunca. Un `.mcp.json` roto, un fichero de credenciales de otra
 *      version o una entrada escrita a mano dan "no hay nada que precargar", no un
 *      instalador que se cae antes de enseñar la primera pantalla.
 *   2. No descarta en silencio lo que no entiende. Los argumentos desconocidos se
 *      devuelven en `unknown`: precargar el formulario y volver a escribir la entrada
 *      la REEMPLAZA, asi que un `--allow-writes-for` o un `--port` puestos a mano se
 *      perderian sin que nadie se entere. Quien llama avisa antes de guardar.
 */
const fs = require("fs");
const path = require("path");

const {
  SERVER_NAME,
  PRODUCT_SERVER_NAME,
  PLAYWRIGHT_SERVER_NAME,
  isOurServerEntry,
  isOurProductEntry,
  isPlaywrightEntry,
} = require("./server-name");
const { credentialsPathFor, readExistingSecrets } = require("./credentials");
const { reveal } = require("../src/secrets");
const {
  permissionsPath,
  readRules,
  writeRules,
  productWriteRules,
  playwrightActionRules,
} = require("./permissions");

/** Los flags de `buildFlags` que llevan valor detras. */
const CON_VALOR = new Set([
  "--config-file",
  "--connection-name",
  "--environment",
  "--allow-sql-dir",
  "--credentials-file",
]);

/** Los de `buildFlags` que son un interruptor. */
const BOOLEANOS = new Set(["--production", "--allow-writes"]);

/**
 * Dos rutas que apuntan al mismo sitio.
 *
 * En Windows las mayusculas no distinguen y las barras van en los dos sentidos: la
 * ruta guardada en el `.mcp.json` se escribio con `/` y la que devuelve el buscador
 * de ficheros trae la invertida. Sin normalizar, la fuente con la que se configuro el
 * proyecto no casaria nunca con la lista y la precarga se quedaria sin marcar.
 */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p)).replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/** Quita el BOM que dejan algunos editores, igual que hace installer/setup.js. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** JSON que puede no existir, o no ser JSON, sin que eso sea un error. */
function leerJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const texto = stripBom(fs.readFileSync(file, "utf8"));
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

/**
 * Los argumentos de una entrada `ahora-sql`, de vuelta a las opciones que los
 * generaron. Es la inversa exacta de `buildFlags` (installer/setup.js).
 *
 * Se salta la ruta del lanzador (el primer argumento que no empieza por `--`, o los
 * de `npx`): lo que interesa empieza en el primer flag.
 */
function parseServerArgs(args = []) {
  const out = {
    configFile: null,
    credentialsFile: null,
    environment: null,
    connections: [],
    sqlDirs: [],
    production: false,
    allowWrites: false,
    unknown: [],
  };
  const lista = (Array.isArray(args) ? args : []).map((a) => String(a));
  let empezado = false;

  for (let i = 0; i < lista.length; i++) {
    const arg = lista[i];
    if (!arg.startsWith("--")) {
      // Antes del primer flag CONOCIDO esta el lanzador (la ruta del .cjs, o el
      // `--yes --package=… start-mssql-mcp` de la forma npx): no es configuracion.
      if (!empezado) continue;
      out.unknown.push(arg);
      continue;
    }

    if (CON_VALOR.has(arg)) {
      empezado = true;
      const valor = lista[++i];
      if (valor === undefined) {
        out.unknown.push(arg);
        continue;
      }
      if (arg === "--config-file") out.configFile = valor;
      else if (arg === "--credentials-file") out.credentialsFile = valor;
      else if (arg === "--environment") out.environment = valor;
      else if (arg === "--allow-sql-dir") out.sqlDirs.push(valor);
      else out.connections.push(parseConnectionName(valor));
      continue;
    }
    if (BOOLEANOS.has(arg)) {
      empezado = true;
      if (arg === "--production") out.production = true;
      else out.allowWrites = true;
      continue;
    }

    // Lo que no conocemos se conserva entero (flag y valor) para poder avisar. El
    // `--package=github:…` de la forma npx no cuenta: es del lanzador, no nuestro.
    if (arg.startsWith("--package=") || arg === "--yes" || arg === "--prefer-offline") {
      continue;
    }
    empezado = true;
    out.unknown.push(arg);
    const siguiente = lista[i + 1];
    if (siguiente !== undefined && !String(siguiente).startsWith("--")) {
      out.unknown.push(String(siguiente));
      i++;
    }
  }
  return out;
}

/**
 * `Nombre:alias` → `{ name, alias }`.
 *
 * Con una sola conexion el instalador escribe el nombre a secas y la clave es
 * siempre `maindb`, asi que `alias` queda vacio, igual que lo esperan `buildFlags` y
 * el formulario.
 */
function parseConnectionName(valor) {
  const idx = String(valor).indexOf(":");
  if (idx === -1) return { name: valor, alias: "" };
  return { name: valor.slice(0, idx), alias: valor.slice(idx + 1) };
}

/** Los argumentos del lanzador del MCP de producto que elige su base de datos. */
function parseProductArgs(args = []) {
  const out = { connectionName: null, db: null };
  const lista = (Array.isArray(args) ? args : []).map((a) => String(a));
  for (let i = 0; i < lista.length; i++) {
    if (lista[i] === "--connection-name") out.connectionName = lista[++i] ?? null;
    else if (lista[i] === "--db") out.db = lista[++i] ?? null;
  }
  return out;
}

/**
 * Las conexiones de un fichero de credenciales, SIN la contrasena.
 *
 * La contrasena cifrada no sale de aqui: el formulario vive en un navegador y no
 * tiene por que recibirla ni para enseñarla en blanco. Lo unico que viaja es
 * `hasPassword`, que basta para poner el "(se mantiene la actual)" en el hueco. Al
 * guardar, `writeCredentialsFile` la reutiliza leyendo el fichero otra vez.
 *
 * Se lee el JSON a pelo y no con `readCredentialsFile` del wrapper: aquella devuelve
 * la conexion ya montada en `parts` —lo que necesita el servidor— y lanza con un
 * fichero de una version anterior o con un cifrado que no reconoce. Aqui hacen falta
 * los campos sueltos para rellenar cada hueco, y un fichero raro tiene que acabar en
 * "no precargo nada", no en una excepcion.
 */
function readCredentials(file) {
  const json = leerJson(file);
  if (!json || typeof json !== "object") return [];

  const una = (alias, raw) => {
    if (!raw || typeof raw !== "object") return null;
    return {
      alias: alias || "",
      server: typeof raw.server === "string" ? raw.server : "",
      database: typeof raw.database === "string" ? raw.database : "",
      user: typeof raw.user === "string" ? raw.user : "",
      port: raw.port ? String(raw.port) : "",
      hasPassword: Boolean(raw.passwordEnc || raw.password),
    };
  };

  if (json.connections && typeof json.connections === "object") {
    return Object.keys(json.connections)
      .map((alias) => una(alias, json.connections[alias]))
      .filter(Boolean);
  }
  const sola = una("", json);
  return sola && sola.server ? [sola] : [];
}

/**
 * La contrasena guardada de una conexion, en claro.
 *
 * Al reconfigurar no se pide volver a teclearla: el hueco vacio significa "la de
 * siempre", y al guardar se reutiliza el token cifrado sin abrirlo. Pero PROBAR la
 * conexion si necesita la contrasena de verdad, y probar es la razon de ser del
 * instalador: sin esto, reconfigurar escribiria sin haber comprobado nada.
 *
 * Solo se descifra cuando el hueco viene vacio —cada descifrado cuesta un arranque
 * de PowerShell— y el resultado no se guarda ni se devuelve a ninguna pantalla: se
 * usa para la prueba y se tira.
 */
function revealStoredPassword(projectDir, alias) {
  if (!projectDir) return null;
  try {
    const target = credentialsPathFor(projectDir);
    const guardadas = readExistingSecrets(target);
    // Con una sola guardada se reutiliza aunque el alias no case, igual que hace
    // `writeCredentialsFile`: es el caso de haberlo renombrado.
    const token =
      guardadas.get(alias || "") ??
      (guardadas.size === 1 ? [...guardadas.values()][0] : undefined);
    return token ? reveal(token) : null;
  } catch {
    // Sin contrasena que reutilizar, la prueba fallara con su mensaje de login, que
    // dice mas que una excepcion aqui.
    return null;
  }
}

/** ¿Estan ya concedidas TODAS estas reglas en el settings.local.json del proyecto? */
function tieneReglas(concedidas, reglas) {
  if (reglas.length === 0) return false;
  return reglas.every((r) => concedidas.includes(r));
}

/** Las reglas de permisos que el proyecto ya tiene puestas. */
function readPermissions(root) {
  let concedidas = [];
  const json = leerJson(permissionsPath(root));
  const allow = json && json.permissions ? json.permissions.allow : null;
  if (Array.isArray(allow)) concedidas = allow.filter((r) => typeof r === "string");
  return {
    read: tieneReglas(concedidas, readRules()),
    write: tieneReglas(concedidas, writeRules()),
    productWrite: tieneReglas(concedidas, productWriteRules()),
    playwrightActions: tieneReglas(concedidas, playwrightActionRules()),
  };
}

/**
 * Que hay configurado en `root`, listo para precargar el formulario.
 *
 * `clients` son los ficheros donde esta nuestra entrada, que es justo la casilla que
 * hay que dejar marcada: reinstalar con la de VS Code desmarcada no la retira, pero
 * si deja de actualizarla, y entonces esa apunta a la base de datos de antes.
 *
 * Devuelve `{ found: false }` si no hay ninguna entrada nuestra: un proyecto nuevo,
 * que es el camino de siempre y no precarga nada.
 */
function readExisting(root) {
  // Perezoso a proposito: `setup.js` acaba requiriendo este modulo, y hacerlo en la
  // cabecera cerraria el ciclo con los exports a medio definir. Mismo motivo por el
  // que `run()` requiere `./gui` dentro de la funcion.
  const { CLIENTS } = require("./setup");

  // El "no hay nada" trae la forma completa, con los valores neutros: asi quien
  // precarga puede leer `previo.sqlDirs` o `previo.permissions.write` sin preguntar
  // antes si habia algo, que es donde se cuelan los olvidos.
  const vacio = {
    found: false,
    clients: [],
    configFile: null,
    credentialsFile: null,
    environment: null,
    connections: [],
    sqlDirs: [],
    production: false,
    allowWrites: false,
    profileKey: "local",
    credentials: [],
    product: null,
    playwright: false,
    permissions: { read: false, write: false, productWrite: false, playwrightActions: false },
    unknown: [],
  };
  let sql = null;
  let product = null;
  let playwright = false;
  const clients = [];

  for (const [key, client] of Object.entries(CLIENTS)) {
    const doc = leerJson(client.file(root));
    const servers = doc && typeof doc === "object" ? doc[client.key] : null;
    if (!servers || typeof servers !== "object") continue;

    if (isOurServerEntry(servers[SERVER_NAME])) {
      clients.push(key);
      // El primero manda. Los dos ficheros los escribe la misma pasada del
      // instalador, asi que dicen lo mismo salvo que alguien haya editado uno.
      if (!sql) sql = parseServerArgs(servers[SERVER_NAME].args);
    }
    if (!product && isOurProductEntry(servers[PRODUCT_SERVER_NAME])) {
      product = parseProductArgs(servers[PRODUCT_SERVER_NAME].args);
    }
    if (!playwright && isPlaywrightEntry(servers[PLAYWRIGHT_SERVER_NAME])) {
      playwright = true;
    }
  }

  if (!sql) return vacio;

  return {
    found: true,
    clients,
    configFile: sql.configFile,
    credentialsFile: sql.credentialsFile,
    environment: sql.environment,
    connections: sql.connections,
    sqlDirs: sql.sqlDirs,
    production: sql.production,
    allowWrites: sql.allowWrites,
    // El perfil no viaja en los argumentos, y no hace falta: `local` y `pruebas` se
    // comportan igual (los dos permiten escritura y ninguno marca produccion), asi
    // que lo unico que hay que recuperar es si era PRODUCCION.
    profileKey: sql.production ? "produccion" : "local",
    credentials: sql.credentialsFile ? readCredentials(sql.credentialsFile) : [],
    product,
    playwright,
    permissions: readPermissions(root),
    unknown: sql.unknown,
  };
}

module.exports = {
  readExisting,
  samePath,
  revealStoredPassword,
  parseServerArgs,
  parseProductArgs,
  parseConnectionName,
  readCredentials,
  readPermissions,
};
