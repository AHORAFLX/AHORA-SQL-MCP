#!/usr/bin/env node
/**
 * Instalador guiado de AHORA-SQL-MCP.
 *
 * Hace UNA cosa: dejar el MCP de SQL configurado en la carpeta de un proyecto. No
 * instala skills ni toca nada mas.
 *
 * Pensado para las formaciones uno a uno: se ejecuta en la maquina del compañero,
 * detecta el proyecto, VALIDA la conexion contra el fichero de configuracion real y
 * escribe el fichero de configuracion del cliente MCP que corresponda.
 *
 * La validacion es el motivo de que esto exista. Un .mcp.json escrito a mano no
 * falla hasta que alguien invoca una herramienta y no entiende el error; aqui el
 * fallo sale en el momento, delante de quien esta formando.
 *
 * Funciona igual sobre una carpeta vacia: si no hay ningun fichero de configuracion
 * del que leer la conexion, se piden los datos y se guardan fuera del repositorio.
 *
 * Se puede lanzar sin instalar nada:
 *   npx --yes --package=github:AHORAFLX/AHORA-SQL-MCP ahora-setup
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const {
  resolveConfigFile,
  listConnectionNames,
  readConnString,
  parseAdoConnectionString,
  applyConnection,
  resolveEnvironment,
} = require("../bin/start-mssql-mcp");
const { writeCredentialsFile } = require("./credentials");
const { probeConnection } = require("./probe");
const { allowMcpTools } = require("./permissions");
const {
  SERVER_NAME,
  LEGACY_SERVER_NAME,
  PRODUCT_SERVER_NAME,
  isOurServerEntry,
  isOurProductEntry,
} = require("./server-name");
const { installRuntime } = require("./runtime");
const { toolVersion } = require("./tools");
const {
  PRODUCT_PACKAGE,
  productRuntimeDir,
  productDll,
  installedProductVersion,
  latestProductVersion,
  dotnetSdkVersion,
  installProductMcp,
  installProductFromFolder,
} = require("./product-mcp");

const PKG_VERSION = require("../package.json").version;
const PKG_SPEC = `github:AHORAFLX/AHORA-SQL-MCP#v${PKG_VERSION}`;
const MIN_NODE_MAJOR = 18;

const LINE = "─".repeat(66);

function say(msg = "") {
  console.log(msg);
}

function title(msg) {
  say();
  say(LINE);
  say(msg);
  say(LINE);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Comprueba el Node DE LA MAQUINA, no el que ejecuta esto.
 *
 * Es una distincion que importa: el .exe lleva su propio Node embebido, asi que
 * mirar process.versions.node siempre da ✓ aunque en el equipo no haya Node
 * instalado. Y la configuracion que escribimos arranca el servidor con `npx`, asi
 * que sin Node en el PATH el instalador terminaria "bien" dejando un .mcp.json que
 * no funciona.
 */
function checkNode() {
  const nodeVersion = toolVersion("node");
  if (!nodeVersion) {
    say("✗ No hay Node.js instalado en este equipo (no esta en el PATH).");
    say("  La configuracion que se escribe arranca el servidor con `npx`, asi que");
    say("  Node es imprescindible aunque este instalador funcione sin el.");
    say("  Instala Node LTS desde https://nodejs.org/ y vuelve a lanzar esto.");
    process.exit(1);
  }
  const major = Number(String(nodeVersion).replace(/^v/, "").split(".")[0]);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    say(`✗ Node ${nodeVersion} es demasiado antiguo. Hace falta ${MIN_NODE_MAJOR} o superior.`);
    say("  Instala Node LTS desde https://nodejs.org/ y vuelve a lanzar esto.");
    process.exit(1);
  }
  if (!toolVersion("npx")) {
    say(`✗ Node ${nodeVersion} esta instalado, pero npx no responde.`);
    say("  Reinstala Node LTS: npx viene con el.");
    process.exit(1);
  }
  say(`✓ Node ${nodeVersion} en el equipo`);
}

/**
 * Busca ficheros de configuracion de .NET en el proyecto.
 *
 * Profundidad limitada y con las carpetas de ruido descartadas: en una solucion de
 * Flexygo un recorrido completo tarda demasiado para una sesion en vivo.
 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "bin", "obj", "packages", ".vs", "dist", "wwwroot",
]);

function findConfigFiles(root, depth = 3) {
  const found = [];
  const walk = (dir, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) walk(full, level + 1);
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (lower === "web.config" || lower === "appsettings.json") found.push(full);
    }
  };
  walk(root, 0);
  // Los que tienen cadenas de conexion primero: un Web.config de una subcarpeta
  // (Account/, Errors/) no lleva ninguna y solo confunde.
  return found.sort((a, b) => {
    const score = (p) => {
      try {
        return listConnectionNames(p).length > 0 ? 0 : 1;
      } catch {
        return 1;
      }
    };
    return score(a) - score(b) || a.length - b.length;
  });
}

/**
 * Cola de lineas de entrada.
 *
 * No se usa readline/promises a proposito: con la entrada canalizada emite todas
 * las lineas del primer trozo de stdin de golpe, y las que llegan sin una pregunta
 * esperando SE PIERDEN; despues el proceso se queda sin nada que hacer y termina
 * con codigo 0 sin haber instalado nada. Encolando las lineas funciona igual de
 * forma interactiva y ademas se puede probar de forma automatica.
 */
class Prompter {
  constructor(input = process.stdin, output = process.stdout) {
    this.output = output;
    this.lines = [];
    this.waiting = [];
    this.closed = false;
    this.rl = readline.createInterface({ input, output: undefined, terminal: false });
    this.rl.on("line", (line) => {
      const waiter = this.waiting.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiting.splice(0)) waiter(null);
    });
  }

  next() {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  write(text) {
    this.output.write(text);
  }

  close() {
    this.rl.close();
  }
}

class InputClosedError extends Error {
  constructor() {
    super("se ha cerrado la entrada antes de terminar");
  }
}

async function ask(rl, question, fallback = "") {
  const suffix = fallback ? ` [${fallback}]` : "";
  rl.write(`${question}${suffix}: `);
  const line = await rl.next();
  if (line === null) throw new InputClosedError();
  rl.write("\n");
  return line.trim() || fallback;
}

async function askYesNo(rl, question, fallback = false) {
  const def = fallback ? "s" : "n";
  const answer = (await ask(rl, `${question} (s/n)`, def)).toLowerCase();
  return answer.startsWith("s");
}

async function pickFromList(rl, items, label) {
  items.forEach((item, i) => say(`   ${i + 1}) ${item}`));
  while (true) {
    const raw = await ask(rl, `${label} (numero)`, "1");
    const idx = Number.parseInt(raw, 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= items.length) return items[idx - 1];
    say("   Numero no valido.");
  }
}

/**
 * Seleccion multiple: "1,3" o "todas".
 *
 * Existe porque el asistente solo sabia coger DOS cadenas (la de configuracion y la
 * de datos de Flexygo) y las descartaba en silencio a partir de la tercera, aunque
 * el wrapper acepta las que hagan falta con `--connection-name NOMBRE:alias`.
 */
async function pickManyFromList(rl, items, label, fallback = "1") {
  items.forEach((item, i) => say(`   ${i + 1}) ${item}`));
  while (true) {
    const raw = await ask(rl, `${label} (numeros separados por comas, o 'todas')`, fallback);
    if (/^tod[ao]s$/i.test(raw.trim())) return [...items];

    const picked = [];
    let bad = null;
    for (const piece of raw.split(/[,\s]+/).filter(Boolean)) {
      const idx = Number.parseInt(piece, 10);
      if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
        bad = piece;
        break;
      }
      if (!picked.includes(items[idx - 1])) picked.push(items[idx - 1]);
    }
    if (bad !== null) {
      say(`   '${bad}' no es un numero de la lista.`);
      continue;
    }
    if (picked.length === 0) {
      say("   Elige al menos una.");
      continue;
    }
    return picked;
  }
}

/**
 * El alias acaba dentro de un nombre de variable de entorno.
 *
 * El wrapper exporta `MSSQL_<ALIAS>_DATABASE` y el servidor descubre las bases de
 * datos escaneando justo ese patron, asi que un alias con guiones, espacios o
 * acentos produce una variable que no se puede definir en Windows y la conexion
 * desaparece sin error. Con `config` y `data` fijos nunca se noto; en cuanto el
 * alias lo escribe una persona, hay que validarlo.
 */
const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function aliasError(alias, taken = []) {
  if (!alias) return "el alias no puede estar vacio";
  if (!ALIAS_RE.test(alias)) {
    return "solo letras, digitos y guion bajo, empezando por letra (acaba en un nombre de variable de entorno)";
  }
  if (taken.some((t) => t.toLowerCase() === alias.toLowerCase())) {
    return `'${alias}' ya esta usado por otra conexion`;
  }
  return null;
}

/**
 * Alias razonable a partir del nombre de la cadena.
 *
 * Se mantienen `config` y `data` para los nombres de Flexygo, que es lo que esperan
 * las skills de SC0; el resto se deriva del nombre para no obligar a inventarlo.
 */
function aliasFromName(name) {
  const stripped = String(name)
    .replace(/connection\s*string$/i, "")
    .replace(/connection$/i, "")
    .trim();
  if (/^conf/i.test(stripped)) return "config";
  if (/^dat/i.test(stripped)) return "data";
  const slug = stripped.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return ALIAS_RE.test(slug) ? slug : `db_${slug}`.replace(/_+$/, "") || "db";
}

/** Alias sugeridos para un conjunto de nombres, ya desambiguados entre si. */
function suggestAliases(names) {
  const taken = [];
  return names.map((name) => {
    let alias = aliasFromName(name);
    let n = 2;
    while (taken.some((t) => t.toLowerCase() === alias.toLowerCase())) {
      alias = `${aliasFromName(name)}_${n++}`;
    }
    taken.push(alias);
    return alias;
  });
}

/** Lee un JSON existente sin reventar por un BOM ni por comentarios sueltos. */
function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (err) {
    say(`   ⚠ ${file} existe pero no es JSON valido (${err.message}).`);
    return undefined; // distinto de null: existe pero no se puede fusionar
  }
}

/**
 * Los dos clientes se distinguen por el AGENTE, no por el editor.
 *
 * Es la confusion facil: la extension de VS Code ES Claude Code corriendo dentro
 * del editor, y usa el mismo `.mcp.json` que la terminal y el escritorio. La
 * opcion de VS Code es para GitHub Copilot, que es otro agente con su propio
 * fichero. Etiquetar esto como "VS Code" a secas lleva a elegir el equivocado.
 */
const CLIENTS = {
  claude: {
    label: "Claude Code  —  terminal, escritorio o extension de VS Code  (.mcp.json)",
    file: (root) => path.join(root, ".mcp.json"),
    key: "mcpServers",
  },
  vscode: {
    label: "GitHub Copilot dentro de VS Code  (.vscode/mcp.json)",
    file: (root) => path.join(root, ".vscode", "mcp.json"),
    key: "servers",
  },
};

/**
 * Perfiles de entorno.
 *
 * Se pregunta el entorno ANTES de la escritura, y en produccion la escritura ni se
 * ofrece. Preguntar "¿necesita escribir?" a secas deja la decision en alguien que
 * puede no saber la consecuencia; preguntar "¿que base de datos es?" no.
 */
const PROFILES = [
  { key: "local", label: "Local / desarrollo  (mi maquina)", canWrite: true, production: false },
  { key: "pruebas", label: "Pruebas / preproduccion", canWrite: true, production: false },
  { key: "produccion", label: "PRODUCCION", canWrite: false, production: true },
];

/** Los argumentos del servidor, sin la parte de como se lanza. */
function buildFlags({
  configFile,
  credentialsFile,
  connections,
  environment,
  allowWrites,
  production,
  sqlDirs,
}) {
  const flags = [];
  if (credentialsFile) {
    flags.push("--credentials-file", credentialsFile.replace(/\\/g, "/"));
  } else {
    flags.push("--config-file", configFile.replace(/\\/g, "/"));
    for (const { name, alias } of connections) {
      flags.push("--connection-name", alias ? `${name}:${alias}` : name);
    }
    if (environment) flags.push("--environment", environment);
  }
  for (const dir of sqlDirs) flags.push("--allow-sql-dir", dir.replace(/\\/g, "/"));
  if (production) flags.push("--production");
  if (allowWrites) flags.push("--allow-writes");
  return flags;
}

/**
 * Forma instalada: `node` contra la ruta fija de la instalacion. Es la que se escribe,
 * y arranca en ~0,2 segundos.
 */
function nodeCommand(entry, flags) {
  return { command: "node", args: [entry.replace(/\\/g, "/"), ...flags] };
}

/**
 * Forma npx, de reserva.
 *
 * Resuelve el paquete contra GitHub en CADA arranque. Medido: 95 s hasta el `initialize`
 * con la cache de npm vacia, y en caliente tres tomas de 8,5 s, 11 s y 75,8 s -npx
 * revalida la referencia contra GitHub aunque el paquete ya este descargado-, contra los
 * 30 s que espera el cliente MCP antes de descartar el servidor.
 *
 * Solo se escribe si la instalacion no ha podido hacerse, porque un arranque lento es
 * mejor que ningun servidor. `--prefer-offline` hace que npm se quede con lo que ya tenga
 * en cache y solo vaya a la red a por lo que falte: ayuda en los arranques siguientes, no
 * en el primero de cada maquina. Es un paliativo, no el arreglo; el arreglo es que la
 * instalacion funcione y se escriba `nodeCommand`.
 */
function npxCommand(flags) {
  return {
    command: "npx",
    args: [
      "--yes",
      "--prefer-offline",
      `--package=${PKG_SPEC}`,
      "start-mssql-mcp",
      ...flags,
    ],
  };
}

/** La forma npx completa, que es lo que escribia el instalador antes. */
function buildArgs(options) {
  return npxCommand(buildFlags(options)).args;
}

/**
 * Como se lanzara el servidor: instalado si se puede, npx si no.
 *
 * La reserva no es decorativa. Si el equipo no puede alcanzar GitHub para instalar,
 * escribir la forma npx deja una configuracion que al menos funcionara cuando la red
 * vuelva, en lugar de no dejar nada.
 */
function resolveServerEntry(flags, { install = installRuntime, log = () => {} } = {}) {
  try {
    const installed = install({ spec: PKG_SPEC, version: PKG_VERSION });
    log({ ok: true, ...installed });
    return nodeCommand(installed.entry, flags);
  } catch (err) {
    log({ ok: false, error: err });
    return npxCommand(flags);
  }
}

function writeClientConfig(client, root, { command, args }) {
  const target = client.file(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const existing = readJsonIfExists(target);
  if (existing === undefined) {
    const backup = `${target}.bak`;
    fs.copyFileSync(target, backup);
    say(`   Se ha guardado copia del anterior en ${backup}`);
  }
  const doc = existing && typeof existing === "object" ? existing : {};
  // Se conservan los demas servidores MCP del fichero: sobrescribir el fichero
  // entero es la forma facil de romperle a alguien una configuracion que ya tenia.
  doc[client.key] = doc[client.key] && typeof doc[client.key] === "object" ? doc[client.key] : {};
  const servers = doc[client.key];

  // Migracion del nombre anterior. Si la entrada `mssql` es nuestra hay que
  // BORRARLA, no solo anadir la nueva: dejarla mantiene el choque con la extension
  // nativa de VS Code, que es justo lo que el renombrado viene a quitar. Si es de
  // otra herramienta se deja donde esta.
  const migrated = Boolean(
    servers[LEGACY_SERVER_NAME] && isOurServerEntry(servers[LEGACY_SERVER_NAME])
  );
  if (migrated) delete servers[LEGACY_SERVER_NAME];

  const replaced = Boolean(servers[SERVER_NAME]);
  servers[SERVER_NAME] = { command, args };

  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return {
    target,
    replaced,
    migrated,
    others: Object.keys(servers).filter((k) => k !== SERVER_NAME),
  };
}

/**
 * Los argumentos del lanzador del MCP de producto.
 *
 * Deliberadamente NO llevan la cadena de conexion, solo de donde sacarla: el
 * .mcp.json se commitea, y la contrasena del ERP no puede viajar ahi. La resuelve
 * bin/start-ahora-mcp.js en cada arranque, igual que hace el servidor de SQL.
 *
 * Una sola base de datos, porque `ahora-mcp` maneja una por proceso: su
 * `ahora_connect` solo acepta servidor y base de datos, sin alias ni `dbKey`.
 */
function buildProductFlags({
  serverDll,
  configFile,
  credentialsFile,
  connectionName,
  db,
  environment,
  production,
}) {
  const flags = ["--server-dll", serverDll.replace(/\\/g, "/")];
  if (credentialsFile) {
    flags.push("--credentials-file", credentialsFile.replace(/\\/g, "/"));
    if (db) flags.push("--db", db);
  } else {
    flags.push("--config-file", configFile.replace(/\\/g, "/"));
    flags.push("--connection-name", connectionName);
    if (environment) flags.push("--environment", environment);
  }
  if (production) flags.push("--production");
  return flags;
}

/**
 * Como se lanza el MCP de producto, deducido de como quedo el de SQL.
 *
 * Los dos lanzadores viven en la misma carpeta del paquete instalado, asi que no hay
 * que resolver nada por segunda vez: si el servidor de SQL arranca instalado, este
 * tambien; si aquel cayo a la forma npx, este cae igual. Deducirlo evita el caso raro
 * de escribir una entrada que apunta a una instalacion que no existe.
 */
function productCommandFrom(serverEntry, flags) {
  if (serverEntry.command === "npx") {
    return {
      command: "npx",
      args: [
        "--yes",
        "--prefer-offline",
        `--package=${PKG_SPEC}`,
        "start-ahora-mcp",
        ...flags,
      ],
    };
  }
  const bundleDir = path.posix.dirname(String(serverEntry.args[0]).replace(/\\/g, "/"));
  return { command: "node", args: [`${bundleDir}/start-ahora-mcp.cjs`, ...flags] };
}

/**
 * Escribe (o retira) la entrada del MCP de producto en un fichero de cliente.
 *
 * SUMA, nunca sustituye: la entrada `ahora-sql` se queda donde esta y las dos
 * conviven en la misma sesion. Es lo que permite que la skill de resolucion de
 * tickets siga usando `mcp__ahora-sql__*` mientras el MCP de producto expone sus
 * `mcp__ahora-erp__*` al lado.
 *
 * Con `entry` a null se retira, y SOLO si es la nuestra: alguien puede tener un
 * `ahora-erp` propio apuntando al exe a mano, y ese no se toca.
 */
function writeProductConfig(client, root, entry) {
  const target = client.file(root);
  const existing = readJsonIfExists(target);
  const doc = existing && typeof existing === "object" ? existing : {};

  if (entry === null) {
    const servers = doc[client.key];
    if (!servers || typeof servers !== "object") return null;
    if (!servers[PRODUCT_SERVER_NAME] || !isOurProductEntry(servers[PRODUCT_SERVER_NAME])) {
      return null;
    }
    delete servers[PRODUCT_SERVER_NAME];
    fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    return { target, removed: true };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  doc[client.key] = doc[client.key] && typeof doc[client.key] === "object" ? doc[client.key] : {};
  const servers = doc[client.key];
  const replaced = Boolean(servers[PRODUCT_SERVER_NAME]);
  servers[PRODUCT_SERVER_NAME] = { command: entry.command, args: entry.args };

  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return { target, replaced, removed: false };
}

/** ¿Este proyecto ya tiene registrado nuestro MCP de producto? */
function hasProductServer(root) {
  for (const client of Object.values(CLIENTS)) {
    const doc = readJsonIfExists(client.file(root));
    const servers = doc && typeof doc === "object" ? doc[client.key] : null;
    if (servers && typeof servers === "object" && isOurProductEntry(servers[PRODUCT_SERVER_NAME])) {
      return true;
    }
  }
  return false;
}

/**
 * Deja el MCP de producto instalado y devuelve la ruta de su .dll.
 *
 * Con `folder` se copia una carpeta ya publicada; sin el, se publica `version` desde
 * el feed. La carpeta no es un capricho: la restauracion necesita alcanzar
 * api.nuget.org —el feed de AHORA solo hospeda `ahora-mcp`, sus dependencias de
 * Microsoft no— y hay redes donde eso no llega. En ese caso, copiar la carpeta que
 * reparte el equipo de producto deja exactamente el mismo resultado sin red ni SDK.
 */
function installProduct({ version, folder, dir = productRuntimeDir() } = {}) {
  if (folder) {
    return { ...installProductFromFolder({ source: folder, dir }), from: "carpeta" };
  }
  return { ...installProductMcp({ version, dir }), from: "feed" };
}

/**
 * Retira la entrada `mssql` nuestra de un fichero de cliente que NO se esta
 * configurando.
 *
 * Hace falta porque la migracion vivia dentro de `writeClientConfig`, y esa solo corre
 * para los clientes que se marcan. Quien tenia el MCP en Claude Code y en Copilot y
 * reinstalaba marcando uno solo se quedaba la entrada vieja en el otro: seguia
 * registrada, con lo que el choque de nombres que el renombrado viene a quitar
 * continuaba, y podian acabar corriendo dos servidores identicos a la vez.
 *
 * No crea ficheros ni escribe si no hay nada que retirar.
 */
function pruneLegacyServer(client, root) {
  const target = client.file(root);
  const doc = readJsonIfExists(target);
  if (!doc || typeof doc !== "object") return null;

  const servers = doc[client.key];
  if (!servers || typeof servers !== "object") return null;
  if (!servers[LEGACY_SERVER_NAME] || !isOurServerEntry(servers[LEGACY_SERVER_NAME])) return null;

  delete servers[LEGACY_SERVER_NAME];
  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return target;
}

/**
 * Instrucciones de "reinicio" concretas por cliente.
 *
 * La configuracion se lee al arrancar la sesion, y es de ambito PROYECTO: si la
 * sesion no se abre sobre la carpeta donde acabamos de escribir, no la ve.
 */
function restartHint(clientKeys) {
  const lines = [];
  if (clientKeys.includes("claude")) {
    lines.push(
      "· Claude Desktop (pestana Code): Ctrl+N, sesion nueva, y elige esta carpeta.",
      "  No hace falta cerrar la aplicacion.",
      "· Claude Code en terminal: cd a esta carpeta y ejecuta `claude`."
    );
    lines.push("  La primera vez te pedira APROBAR el servidor del proyecto: acepta.");
  }
  if (clientKeys.includes("vscode")) {
    lines.push(
      "· VS Code: recarga la ventana con la carpeta abierta como espacio de trabajo,",
      "  o arranca el servidor desde la lista de servidores MCP."
    );
  }
  return lines;
}

async function main() {
  title(`Instalador AHORA-SQL-MCP  v${PKG_VERSION}`);
  say("Deja el MCP de SQL configurado en la carpeta de tu proyecto.");
  say();
  checkNode();

  const rl = new Prompter();
  try {
    // ── Proyecto ──
    title("1/5  Proyecto");
    const root = path.resolve(await ask(rl, "Carpeta raiz del proyecto", process.cwd()));
    if (!fs.existsSync(root)) {
      say(`✗ No existe: ${root}`);
      process.exit(1);
    }

    // ── Fichero de configuracion ──
    title("2/5  Fichero de configuracion");
    say("Buscando Web.config / appsettings.json...");
    const candidates = findConfigFiles(root);
    const MANUAL = "No hay ninguno: introduzco los datos de conexion a mano";
    let configFile = null;

    if (candidates.length === 0) {
      // Carpeta sin proyecto .NET: es un caso normal, no un error. Un implantador
      // que solo quiere mirar una base de datos no tiene Web.config ninguno.
      say("No he encontrado ninguno en esta carpeta.");
      const options = ["Indico la ruta de un Web.config o appsettings.json", MANUAL];
      const chosen = await pickFromList(rl, options, "Que hago");
      if (chosen !== MANUAL) configFile = path.resolve(await ask(rl, "Ruta"));
    } else {
      say(`Encontrados ${candidates.length}:`);
      const options = [
        ...candidates.map((c) => path.relative(root, c) || c),
        "otra ruta…",
        MANUAL,
      ];
      const chosen = await pickFromList(rl, options, "Cual uso");
      if (chosen === MANUAL) configFile = null;
      else if (chosen === "otra ruta…") configFile = path.resolve(await ask(rl, "Ruta"));
      else configFile = path.join(root, chosen);
    }

    let resolved = null;
    let isCore = false;
    if (configFile) {
      try {
        resolved = resolveConfigFile(configFile);
      } catch (err) {
        say(`✗ ${err.message}`);
        process.exit(1);
      }
      isCore = path.extname(resolved).toLowerCase() === ".json";
      say(`✓ ${resolved}   (${isCore ? ".NET Core" : ".NET Framework"})`);
    } else {
      say("✓ Sin fichero de configuracion: los datos se pediran a continuacion.");
    }

    // ── Cadenas de conexion, con validacion ──
    title("3/5  Conexion");
    const connections = [];
    const manualConnections = [];
    const probes = [];
    let environment;

    if (!resolved) {
      // Datos a mano, tantas conexiones como haga falta. Sin fichero de
      // configuracion del que leerlas, la unica forma de exponer la de configuracion
      // y la de datos de Flexygo -o cualquier otro par- es teclear las dos: antes
      // solo cabia una, y el resto de la cadena (fichero de credenciales, wrapper y
      // servidor) ya soportaba varias.
      //
      // Aqui la prueba de conexion no es un lujo: lo que falla normalmente es una
      // errata al teclear, y sin conectar no se ve.
      say("Puedes meter varias: cada una sera una base de datos distinta para el");
      say("agente. Se piden de una en una y se prueban al momento.");
      while (true) {
        const n = manualConnections.length;
        say();
        const server =
          n === 0
            ? await ask(rl, "Servidor (p. ej. PC_158\\SQL2022 o 10.0.0.9,1433)")
            : await ask(rl, `Servidor de la conexion ${n + 1} (vacio para terminar)`);
        if (!server) {
          if (n > 0) break;
          say("✗ Faltan datos. Nada escrito.");
          process.exit(1);
        }
        const database = await ask(rl, "Base de datos");
        const user = await ask(rl, "Usuario");
        const password = await ask(rl, "Contrasena");
        if (!database || !user || !password) {
          say("✗ Faltan datos. Nada escrito.");
          process.exit(1);
        }
        const manual = { server, database, user, password };

        say();
        say("Probando la conexion de verdad...");
        const result = await probeConnection({
          datasource: server,
          initialcatalog: database,
          userid: user,
          password,
        });
        if (result.ok) {
          say(`   ✓ conectado a ${result.target} / ${result.database}`);
          if (result.version) say(`     ${result.version}`);
        } else {
          say(`   ✗ no he podido conectar: ${result.error}`);
          if (result.hint) say(`     ${result.hint}`);
          say();
          if (!(await askYesNo(rl, "¿Sigo de todas formas?", false))) {
            say("✗ Nada escrito. Corrige los datos y vuelve a lanzarlo.");
            process.exit(1);
          }
        }
        manualConnections.push(manual);
      }

      // Con una sola conexion la clave es siempre `maindb`, asi que no se pregunta.
      // Con varias, el alias ES la clave con la que el agente pide la base de datos
      // y ademas acaba dentro del nombre de una variable de entorno: uno invalido o
      // repetido hace desaparecer una conexion sin ningun error.
      if (manualConnections.length > 1) {
        say();
        say("Alias de cada una. Es la clave con la que el agente pedira la base de");
        say("datos ('dbKey'); en Flexygo las skills de SC0 esperan config y data.");
        const suggested = suggestAliases(manualConnections.map((c) => c.database));
        const taken = [];
        for (const [i, conn] of manualConnections.entries()) {
          while (true) {
            const alias = await ask(
              rl,
              `   Alias de ${conn.database} (${conn.server})`,
              suggested[i]
            );
            const problem = aliasError(alias, taken);
            if (!problem) {
              conn.alias = alias;
              taken.push(alias);
              break;
            }
            say(`   ✗ ${problem}.`);
          }
        }
      }
    } else {
      environment = isCore
        ? await ask(rl, "Entorno de appsettings", resolveEnvironment(undefined))
        : undefined;

      const names = listConnectionNames(resolved, { environment });
      if (names.length === 0) {
        say("✗ Ese fichero no declara ninguna cadena de conexion.");
        process.exit(1);
      }
      say(`Declaradas: ${names.join(", ")}`);

      /**
       * Resolver la cadena y CONECTAR son dos comprobaciones distintas con
       * soluciones distintas, asi que se reportan por separado. Que no conecte no
       * aborta: puede ser la VPN o el SQL Browser parado.
       */
      const validate = async (name, alias) => {
        let parts;
        let source;
        try {
          const read = readConnString(resolved, name, { environment });
          source = read.source;
          parts = parseAdoConnectionString(read.value);
          const info = applyConnection({}, "MSSQL_", parts, name);
          say(`   ✓ ${name} → ${info.target} / ${info.database}   (de ${path.basename(source)})`);
        } catch (err) {
          say(`   ✗ ${name}: ${err.message}`);
          return false;
        }
        const probe = await probeConnection(parts);
        if (probe.ok) {
          say(`     conecta ✓${probe.version ? "  " + probe.version : ""}`);
        } else {
          say(`     resuelta, pero NO conecta: ${probe.error}`);
          if (probe.hint) say(`     ${probe.hint}`);
          probes.push(name);
        }
        connections.push({ name, alias });
        return true;
      };

      // Cuantas se exponen lo decide quien instala, sin tope. Antes solo cabian dos
      // (la de configuracion y la de datos de Flexygo) y la tercera se perdia en
      // silencio, aunque el resto de la cadena la soporta perfectamente.
      let chosen;
      if (names.length === 1) {
        chosen = names;
      } else {
        say();
        say("Cada cadena que elijas sera una base de datos distinta para el agente.");
        // El caso de Flexygo (configuracion + datos) sigue siendo el habitual, asi
        // que se ofrece hecho como valor por defecto en vez de como una pregunta.
        const flexygoIdx = ["conf", "dat"]
          .map((p) => names.findIndex((n) => new RegExp(`^${p}`, "i").test(n)) + 1)
          .filter((i) => i > 0);
        const fallback = flexygoIdx.length === 2 ? flexygoIdx.join(",") : "1";
        chosen = await pickManyFromList(rl, names, "Cuales expongo", fallback);
      }

      // Con una sola conexion la clave es siempre `maindb` y el alias se ignora, asi
      // que no se pregunta.
      const aliases = [];
      if (chosen.length > 1) {
        say();
        say("Alias de cada una. Es la clave con la que el agente pedira la base de");
        say("datos ('dbKey'); en Flexygo las skills de SC0 esperan config y data.");
        const suggested = suggestAliases(chosen);
        for (const [i, name] of chosen.entries()) {
          while (true) {
            const alias = await ask(rl, `   Alias de ${name}`, suggested[i]);
            const problem = aliasError(alias, aliases);
            if (!problem) {
              aliases.push(alias);
              break;
            }
            say(`   ✗ ${problem}.`);
          }
        }
      }

      say();
      say("Validando contra el fichero real:");
      let allOk = true;
      for (const [i, name] of chosen.entries()) {
        if (!(await validate(name, aliases[i]))) allOk = false;
      }
      if (!allOk) {
        say();
        say("✗ Alguna cadena no se ha podido resolver. Nada escrito.");
        if (isCore) {
          say("  En .NET Core la causa habitual es el entorno: prueba otro nombre");
          say("  (el error de arriba dice en que ficheros ha buscado).");
        }
        process.exit(1);
      }
    }

    // ── Opciones ──
    title("4/5  Opciones");
    say("¿Contra que base de datos vas a trabajar?");
    const profileLabel = await pickFromList(rl, PROFILES.map((p) => p.label), "Entorno");
    const profile = PROFILES.find((p) => p.label === profileLabel);

    let allowWrites = false;
    if (profile.canWrite) {
      allowWrites = await askYesNo(
        rl,
        "¿El agente debe poder ejecutar INSERT/UPDATE/DDL?",
        false
      );
    } else {
      // En produccion no se pregunta: no hay respuesta correcta que se pueda dar
      // en una formacion de cinco minutos.
      say("   La escritura queda deshabilitada y la configuracion se marca como");
      say("   PRODUCCION: anadir --allow-writes a mano mas tarde hara que el");
      say("   servidor se niegue a arrancar.");
    }

    const sqlDirs = [];
    if (
      await askYesNo(rl, "¿Vas a ejecutar ficheros .sql de FUERA de la carpeta del proyecto?", false)
    ) {
      while (true) {
        const dir = await ask(rl, "   Carpeta (vacio para terminar)");
        if (!dir) break;
        if (!fs.existsSync(dir)) {
          say("   ✗ No existe.");
          continue;
        }
        sqlDirs.push(fs.realpathSync(dir));
      }
    }

    // ── MCP de desarrollo de producto ──
    //
    // Es un servidor APARTE, del equipo de producto, que se registra AL LADO del de
    // SQL: los dos conviven en la misma sesion. Se pregunta aqui y no antes porque
    // la respuesta depende del entorno que se acaba de elegir.
    const product = { install: false };
    say();
    if (profile.production) {
      // Mismo criterio que con la escritura: en produccion no se ofrece. Y aqui pesa
      // mas, porque `ahora-mcp` no tiene modo de solo lectura que poder imponerle —
      // no hay ningun conmutador que desactive ahora_ejecutar_dml ni la familia
      // ahora_crear_*/ahora_modificar_*/ahora_borrar_*.
      say(`El MCP de desarrollo de producto (${PRODUCT_PACKAGE}) no se ofrece en PRODUCCION:`);
      say("ese servidor no tiene modo de solo lectura, asi que no hay forma de");
      say("configurarlo para que no pueda escribir en el ERP en vivo.");
    } else {
      const yaEstaba = hasProductServer(root);
      say(`MCP de desarrollo de producto (${PRODUCT_PACKAGE}), del equipo de producto.`);
      say("Se anade AL LADO del de SQL, no en su lugar: los dos funcionan a la vez.");
      say("Trae 98 herramientas para personalizar el ERP (objetos, DDA, scripts de");
      say("pantalla, campos configurables...). Necesita el SDK de .NET 10.");
      product.install = await askYesNo(rl, "¿Instalo tambien el MCP de producto?", yaEstaba);

      if (product.install) {
        // Una sola base de datos: `ahora-mcp` maneja una por proceso.
        const candidatas =
          connections.length > 0
            ? connections.map((c) => ({ name: c.name, alias: c.alias }))
            : manualConnections.map((c) => ({ name: c.database, alias: c.alias }));
        if (candidatas.length === 1) {
          product.pick = candidatas[0];
        } else {
          say();
          say("Ese servidor maneja UNA base de datos por proceso, asi que hay que");
          say("elegir cual de las que acabas de configurar usa.");
          const etiquetas = candidatas.map((c) =>
            c.alias ? `${c.name}  (alias ${c.alias})` : c.name
          );
          const elegida = await pickFromList(rl, etiquetas, "Base de datos del ERP");
          product.pick = candidatas[etiquetas.indexOf(elegida)];
        }

        if (!dotnetSdkVersion()) {
          say();
          say("   ⚠ No hay SDK de .NET 10 en este equipo, asi que no se puede publicar");
          say("     el paquete desde NuGet. Puedes indicar una carpeta con el MCP de");
          say("     producto ya publicado (la que trae ahora-mcp.dll con sus");
          say("     dependencias al lado) y se copia tal cual.");
          const carpeta = await ask(rl, "   Carpeta (vacio para no instalarlo)");
          if (!carpeta) product.install = false;
          else product.folder = path.resolve(carpeta);
        }
      }
    }

    const clientKeys = [];
    say();
    say("¿Que cliente usas?");
    const clientChoice = await pickFromList(
      rl,
      [CLIENTS.claude.label, CLIENTS.vscode.label, "los dos"],
      "Cliente"
    );
    if (clientChoice === CLIENTS.claude.label) clientKeys.push("claude");
    else if (clientChoice === CLIENTS.vscode.label) clientKeys.push("vscode");
    else clientKeys.push("claude", "vscode");

    // ── Escribir ──
    title("5/5  Escribiendo configuracion");

    // Sin fichero de configuracion, las credenciales van a %APPDATA%: el .mcp.json
    // se commitea y no puede llevarlas dentro. La contrasena se cifra ademas con la
    // cuenta de Windows, para que ese JSON no la lleve legible.
    let credentialsFile;
    if (manualConnections.length > 0) {
      credentialsFile = writeCredentialsFile(root, manualConnections, { warn: say });
      say(`✓ Credenciales cifradas, fuera del repositorio: ${credentialsFile}`);
    }

    const flags = buildFlags({
      configFile: resolved,
      credentialsFile,
      connections,
      environment: isCore ? environment : undefined,
      allowWrites,
      production: profile.production,
      sqlDirs,
    });

    // El servidor se instala UNA vez en una carpeta del usuario, y la configuracion
    // apunta ahi. La alternativa —`npx --package=github:...` en la propia
    // configuracion— resolvia el paquete contra GitHub en cada arranque: ~7 segundos
    // cada vez, ~48 la primera con un pin nuevo, contra los 30 que espera el cliente
    // MCP antes de descartar el servidor y dejar al agente sin tools.
    say("Instalando el servidor (una sola vez, no en cada arranque)…");
    const serverEntry = resolveServerEntry(flags, {
      log: (r) => {
        if (r.ok) {
          say(`✓ ${r.dir}${r.reused ? "   (ya estaba esta version)" : ""}`);
        } else {
          say(`⚠ No se ha podido instalar: ${r.error.message.split("\n")[0]}`);
          say("   Se escribe la forma con npx, que funciona pero resuelve el paquete en");
          say("   cada arranque y puede agotar la espera del cliente MCP.");
        }
      },
    });

    for (const key of clientKeys) {
      const { target, replaced, migrated, others } = writeClientConfig(
        CLIENTS[key],
        root,
        serverEntry
      );
      say(`✓ ${target}${replaced ? `   (servidor '${SERVER_NAME}' actualizado)` : ""}`);
      if (migrated) {
        say(`   Se ha retirado el servidor '${LEGACY_SERVER_NAME}' anterior: ese nombre`);
        say("   chocaba con la extension nativa de SQL Server de VS Code.");
      }
      if (others.length > 0) say(`   Se han conservado: ${others.join(", ")}`);
    }

    // ── MCP de producto, como SEGUNDA entrada del mismo fichero ──
    let productInstalled = null;
    if (product.install) {
      say();
      try {
        let version;
        if (!product.folder) {
          say(`Consultando la ultima version de ${PRODUCT_PACKAGE} en el feed...`);
          version = await latestProductVersion();
          const ya = installedProductVersion(productRuntimeDir());
          say(
            ya === version
              ? `✓ ${PRODUCT_PACKAGE} ${version} ya estaba publicado.`
              : `Publicando ${PRODUCT_PACKAGE} ${version} (una sola vez, no en cada arranque)…`
          );
        }
        productInstalled = installProduct({ version, folder: product.folder });
        say(
          `✓ ${PRODUCT_PACKAGE}${productInstalled.version ? ` ${productInstalled.version}` : ""}` +
            ` en ${productInstalled.dir}${productInstalled.reused ? "   (ya estaba)" : ""}`
        );
      } catch (err) {
        // No aborta la instalacion: el MCP de SQL ya esta escrito y funcionando, y
        // perderlo por un fallo del segundo servidor seria peor que quedarse sin el
        // segundo. Se dice claro que ha fallado y por que.
        say(`⚠ No se ha podido instalar el MCP de producto: ${err.message.split("\n")[0]}`);
        say("   El MCP de SQL queda configurado igualmente. Para el de producto, vuelve");
        say("   a lanzar el instalador con el SDK de .NET 10 disponible, o indica una");
        say("   carpeta con el ya publicado.");
        product.install = false;
      }
    }

    if (productInstalled) {
      const productFlags = buildProductFlags({
        serverDll: productDll(productInstalled.dir),
        configFile: resolved,
        credentialsFile,
        connectionName: product.pick.name,
        db: product.pick.alias,
        environment: isCore ? environment : undefined,
        production: profile.production,
      });
      const productEntry = productCommandFrom(serverEntry, productFlags);
      for (const key of clientKeys) {
        const result = writeProductConfig(CLIENTS[key], root, productEntry);
        say(
          `✓ ${result.target}   (servidor '${PRODUCT_SERVER_NAME}' ${
            result.replaced ? "actualizado" : "anadido"
          }, junto a '${SERVER_NAME}')`
        );
      }
      say(`   Base de datos del ERP: ${product.pick.name}`);
      say("   AVISO: ese servidor SIEMPRE puede escribir en el ERP. No tiene modo de");
      say("   solo lectura, asi que el unico freno son las reglas de permisos.");
    } else if (!product.install) {
      // Desmarcarlo a proposito retira la nuestra, y solo la nuestra: si no, quien lo
      // quita en una reinstalacion se lo encuentra igualmente registrado.
      for (const key of Object.keys(CLIENTS)) {
        const result = writeProductConfig(CLIENTS[key], root, null);
        if (result) say(`✓ ${result.target}   (retirado el '${PRODUCT_SERVER_NAME}' anterior)`);
      }
    }

    // Y en los ficheros del cliente que NO se ha configurado, la entrada vieja tambien
    // hay que retirarla: dejarla registrada mantiene el choque de nombres y puede
    // acabar levantando dos servidores identicos.
    for (const key of Object.keys(CLIENTS)) {
      if (clientKeys.includes(key)) continue;
      const pruned = pruneLegacyServer(CLIENTS[key], root);
      if (pruned) {
        say(`✓ ${pruned}   (retirado el '${LEGACY_SERVER_NAME}' anterior que quedaba ahi)`);
      }
    }

    // Reglas de permisos. En modo auto, Claude Code puede denegar hasta una
    // consulta de lectura, y el mensaje que sale ("Blocked by classifier") no
    // menciona el MCP por ningun lado.
    if (clientKeys.includes("claude")) {
      say();
      say("En modo auto, Claude Code puede denegar las llamadas al MCP sin avisar");
      say("de que vienen de aqui. Puedo permitir de antemano la introspeccion y las");
      say("consultas de lectura.");
      if (await askYesNo(rl, "¿Anado esas reglas?", true)) {
        // Las escrituras se ofrecen aparte y por defecto NO: son el freno que
        // interesa conservar, sobre todo si la BD no es la maquina de uno.
        let includeWrites = false;
        if (allowWrites) {
          includeWrites = await askYesNo(
            rl,
            "   ¿Permitir tambien las ESCRITURAS sin preguntar? (solo en tu maquina)",
            false
          );
        }
        // El MCP de producto lleva sus propias reglas: sus herramientas no comparten
        // vocabulario con las de aqui (`ahora_leer_*` frente a `list_*`), asi que un
        // comodin no cubre las dos. Y sus escrituras se preguntan aparte porque ese
        // servidor no tiene modo de solo lectura: estas reglas son el unico freno.
        let productWrites = false;
        if (productInstalled) {
          productWrites = await askYesNo(
            rl,
            "   ¿Permitir las ESCRITURAS del MCP de producto sin preguntar? (solo en tu maquina)",
            false
          );
        }
        const perms = allowMcpTools(root, {
          includeWrites,
          product: Boolean(productInstalled),
          productWrites,
        });
        say(`✓ ${perms.target}`);
        if (perms.alreadyHadAll) say("   (ya estaban todas)");
        else say(`   Anadidas: ${perms.added.join(", ")}`);
        if (perms.removed.length > 0) {
          say(`   Retiradas, del nombre anterior: ${perms.removed.join(", ")}`);
        }
        if (!includeWrites) {
          say("   Las escrituras seguiran pidiendote permiso.");
        }
        if (perms.backup) say(`   El fichero anterior no era JSON; copia en ${perms.backup}`);
      }
    }


    // ── Cierre ──
    title("Listo");
    say("Siguiente paso, y es imprescindible:");
    say();
    // "Reinicia el cliente" no le dice nada a nadie: en el escritorio no hay que
    // cerrar la aplicacion, y la configuracion es del PROYECTO, asi que la sesion
    // tiene que abrirse sobre esta carpeta o no la vera.
    say(`  1. Abre una sesion NUEVA sobre esta carpeta:`);
    say(`     ${root}`);
    for (const line of restartHint(clientKeys)) say(`     ${line}`);
    say("  2. Pide al agente: «lista las bases de datos configuradas».");
    say(
      `     Debe responder con ${
        (connections.length > 0 ? connections : manualConnections)
          .map((c) => `'${c.alias || "maindb"}'`)
          .join(" y ") || "'maindb'"
      }.`
    );
    if (productInstalled) {
      say("  3. Y para el MCP de producto: «prueba la conexion con el ERP»");
      say(`     (herramienta ahora_test_connection de '${PRODUCT_SERVER_NAME}').`);
      say();
      say(`Los dos servidores conviven: '${SERVER_NAME}' expone sus tools como`);
      say(`mcp__${SERVER_NAME}__* y '${PRODUCT_SERVER_NAME}' las suyas como`);
      say(`mcp__${PRODUCT_SERVER_NAME}__ahora_*. No se pisan.`);
    }
    say();
    say("Si no aparece ninguna herramienta de SQL, casi siempre es una de dos:");
    say("no has abierto una sesion nueva, o la has abierto sobre otra carpeta.");
    say("Para reconfigurar, vuelve a lanzar este instalador.");
    say();
  } finally {
    rl.close();
  }
}

/**
 * Arranque. Por defecto abre el formulario en el navegador; --cli fuerza el
 * asistente de terminal, que es lo unico que funciona por RDP sin navegador.
 */
function run(argv = process.argv.slice(2)) {
  if (!argv.includes("--cli") && !argv.includes("--consola")) {
    // Requerido aqui y no arriba: gui.js importa de este modulo, y hacerlo en la
    // cabecera crearia un ciclo con los exports a medio definir.
    const { startGui } = require("./gui");
    // --no-open imprime la URL sin lanzar el navegador: util por RDP y para probar.
    return startGui({ open: !argv.includes("--no-open") }).catch((err) => {
      say();
      say(`✗ No se ha podido abrir el formulario: ${err.message}`);
      say("  Prueba el asistente de terminal:  ahora-setup --cli");
      process.exit(1);
    });
  }
  return runCli();
}

/** Asistente de terminal, con el tratamiento de errores de cara al usuario. */
function runCli() {
  return main().catch((err) => {
    say();
    if (err instanceof InputClosedError) {
      // Antes esto era una salida silenciosa con codigo 0: el instalador parecia
      // haber terminado bien sin haber escrito nada.
      say("✗ Instalacion incompleta: se ha cerrado la entrada antes de terminar.");
      say("  No se ha escrito ninguna configuracion. Vuelve a lanzarlo.");
    } else {
      say(`✗ Error inesperado: ${err.message}`);
    }
    process.exit(1);
  });
}

module.exports = {
  main,
  run,
  runCli,
  Prompter,
  InputClosedError,
  findConfigFiles,
  buildArgs,
  buildFlags,
  nodeCommand,
  npxCommand,
  toolVersion,
  resolveServerEntry,
  writeClientConfig,
  pruneLegacyServer,
  buildProductFlags,
  productCommandFrom,
  writeProductConfig,
  hasProductServer,
  installProduct,
  pickManyFromList,
  aliasFromName,
  suggestAliases,
  aliasError,
  CLIENTS,
  PROFILES,
  PKG_SPEC,
  SERVER_NAME,
  LEGACY_SERVER_NAME,
  PRODUCT_SERVER_NAME,
  MIN_NODE_MAJOR,
};

// DESPUES de module.exports, y no antes, porque el ciclo con gui.js es real: run()
// hace require("./gui") y gui.js importa de este modulo en su cabecera. Arrancando
// aqui arriba, gui.js recibia el module.exports todavia vacio y reventaba al leer
// PROFILES. Requerir gui.js dentro de run() evita el ciclo al cargar, pero no este,
// que es de orden de evaluacion.
//
// En el .exe empaquetado no hay un `module` de entrada con el que comparar, asi que
// esta comprobacion no se cumple: alli el arranque lo fuerza installer/exe-entry.js.
if (require.main === module) run();
