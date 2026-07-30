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
 * Se puede lanzar sin instalar nada:
 *   npx --yes --package=github:AHORAFLX/AHORA-SQL-MCP#v1.1.0 ahora-setup
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

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    say(`✗ Node ${process.versions.node} es demasiado antiguo. Hace falta ${MIN_NODE_MAJOR} o superior.`);
    say("  Instala Node LTS desde https://nodejs.org/ y vuelve a lanzar esto.");
    process.exit(1);
  }
  say(`✓ Node ${process.versions.node}`);
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

const CLIENTS = {
  claude: {
    label: "Claude Code  (.mcp.json, clave mcpServers)",
    file: (root) => path.join(root, ".mcp.json"),
    key: "mcpServers",
  },
  vscode: {
    label: "VS Code / Copilot  (.vscode/mcp.json, clave servers)",
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

function buildArgs({
  configFile,
  credentialsFile,
  connections,
  environment,
  allowWrites,
  production,
  sqlDirs,
}) {
  const args = ["--yes", `--package=${PKG_SPEC}`, "start-mssql-mcp"];
  if (credentialsFile) {
    args.push("--credentials-file", credentialsFile.replace(/\\/g, "/"));
  } else {
    args.push("--config-file", configFile.replace(/\\/g, "/"));
    for (const { name, alias } of connections) {
      args.push("--connection-name", alias ? `${name}:${alias}` : name);
    }
    if (environment) args.push("--environment", environment);
  }
  for (const dir of sqlDirs) args.push("--allow-sql-dir", dir.replace(/\\/g, "/"));
  if (production) args.push("--production");
  if (allowWrites) args.push("--allow-writes");
  return args;
}

function writeClientConfig(client, root, args) {
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
  const replaced = Boolean(doc[client.key].mssql);
  doc[client.key].mssql = { command: "npx", args };

  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return { target, replaced, others: Object.keys(doc[client.key]).filter((k) => k !== "mssql") };
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
    let configFile;
    if (candidates.length === 0) {
      say("No he encontrado ninguno.");
      configFile = path.resolve(await ask(rl, "Ruta del Web.config o appsettings.json"));
    } else {
      say(`Encontrados ${candidates.length}:`);
      const options = [...candidates.map((c) => path.relative(root, c) || c), "otra ruta…"];
      const chosen = await pickFromList(rl, options, "Cual uso");
      configFile =
        chosen === "otra ruta…"
          ? path.resolve(await ask(rl, "Ruta"))
          : path.join(root, chosen);
    }

    let resolved;
    try {
      resolved = resolveConfigFile(configFile);
    } catch (err) {
      say(`✗ ${err.message}`);
      process.exit(1);
    }
    const isCore = path.extname(resolved).toLowerCase() === ".json";
    say(`✓ ${resolved}   (${isCore ? ".NET Core" : ".NET Framework"})`);

    // ── Cadenas de conexion, con validacion ──
    title("3/5  Cadenas de conexion");
    let environment = isCore
      ? await ask(rl, "Entorno de appsettings", resolveEnvironment(undefined))
      : undefined;

    let names = listConnectionNames(resolved, { environment });
    if (names.length === 0) {
      say("✗ Ese fichero no declara ninguna cadena de conexion.");
      process.exit(1);
    }
    say(`Declaradas: ${names.join(", ")}`);

    const connections = [];
    const validate = (name, alias) => {
      try {
        const { value, source } = readConnString(resolved, name, { environment });
        const probe = {};
        const info = applyConnection(probe, "MSSQL_", parseAdoConnectionString(value), name);
        say(`   ✓ ${name} → ${info.target} / ${info.database}   (de ${path.basename(source)})`);
        connections.push({ name, alias });
        return true;
      } catch (err) {
        say(`   ✗ ${name}: ${err.message}`);
        return false;
      }
    };

    const flexygo =
      names.length >= 2 &&
      (await askYesNo(
        rl,
        "¿Es Flexygo (necesita la BD de configuracion y la de datos)?",
        true
      ));

    if (flexygo) {
      say("Elige la de CONFIGURACION:");
      const confName = await pickFromList(rl, names, "Configuracion");
      say("Elige la de DATOS:");
      const dataName = await pickFromList(rl, names.filter((n) => n !== confName), "Datos");
      say();
      say("Validando contra el fichero real:");
      if (!validate(confName, "config") || !validate(dataName, "data")) {
        say();
        say("✗ Alguna cadena no se ha podido resolver. Nada escrito.");
        if (isCore) {
          say("  En .NET Core la causa habitual es el entorno: prueba otro nombre");
          say("  (el error de arriba dice en que ficheros ha buscado).");
        }
        process.exit(1);
      }
    } else {
      const only = names.length === 1 ? names[0] : await pickFromList(rl, names, "Cual expongo");
      say();
      say("Validando contra el fichero real:");
      if (!validate(only, undefined)) {
        say();
        say("✗ La cadena no se ha podido resolver. Nada escrito.");
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
    const args = buildArgs({
      configFile: resolved,
      connections,
      environment: isCore ? environment : undefined,
      allowWrites,
      production: profile.production,
      sqlDirs,
    });

    for (const key of clientKeys) {
      const { target, replaced, others } = writeClientConfig(CLIENTS[key], root, args);
      say(`✓ ${target}${replaced ? "   (servidor 'mssql' actualizado)" : ""}`);
      if (others.length > 0) say(`   Se han conservado: ${others.join(", ")}`);
    }

    // ── Cierre ──
    title("Listo");
    say("Siguiente paso, y es imprescindible:");
    say();
    say("  1. REINICIA el cliente MCP. Sin reiniciar no lee la configuracion.");
    say("  2. Pide al agente: «lista las bases de datos configuradas».");
    say(
      `     Debe responder con ${connections.map((c) => `'${c.alias || "maindb"}'`).join(" y ")}.`
    );
    say();
    say("Si no aparece ninguna herramienta de SQL, es que no has reiniciado.");
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

// En el .exe empaquetado no hay un `module` de entrada con el que comparar, asi que
// esta comprobacion no se cumple: alli el arranque lo fuerza installer/exe-entry.js.
if (require.main === module) run();

module.exports = {
  main,
  run,
  runCli,
  Prompter,
  InputClosedError,
  findConfigFiles,
  buildArgs,
  writeClientConfig,
  CLIENTS,
  PROFILES,
  PKG_SPEC,
};
