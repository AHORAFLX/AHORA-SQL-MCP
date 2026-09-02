#!/usr/bin/env node
/**
 * Wrapper de arranque de AHORA-SQL-MCP.
 *
 * Resuelve la conexion sin duplicar credenciales en la configuracion de cada MCP.
 * Hay cuatro fuentes posibles, y hay que elegir UNA:
 *
 * 1) Web.config (.NET Framework) â€” Flexygo no migrado
 *      --config-file C:\repo\Web.config --connection-name DataConnectionString
 *
 * 2) appsettings.json (.NET Core) â€” Flexygo migrado
 *      --config-file C:\repo\conf\appsettings.json --connection-name DataConnectionString
 *
 *    En Core las cadenas suelen estar VACIAS en appsettings.json y rellenas en
 *    appsettings.Development.json. El wrapper aplica la misma superposicion que
 *    ASP.NET Core: appsettings.<entorno>.json gana sobre appsettings.json, con el
 *    entorno tomado de --environment, o de ASPNETCORE_ENVIRONMENT, o Development.
 *
 * 3) Cadena de conexion suelta, sin fichero de configuracion
 *      --connection-string "Data Source=PC\PC;Initial Catalog=BD;User ID=sa;Password=x"
 *
 * 4) Datos sueltos, sin fichero de configuracion
 *      --server PC\PC --database BD --user sa --password x
 *
 *    En 3 y 4 la contrasena viaja en la linea de comandos, y por tanto acaba en el
 *    .mcp.json y en el listado de procesos. Si eso importa, usa --from-env y pon
 *    las MSSQL_* en el bloque "env" del cliente MCP:
 *      --from-env
 *
 * Flexygo necesita configuracion + datos a la vez; con varias conexiones cada una
 * lleva alias:
 *   --connection-name ConfConnectionString:config --connection-name DataConnectionString:data
 *   --connection-string "<cadena conf>" --alias config --connection-string "<cadena datos>" --alias data
 *
 * Escritura (solo local o pruebas):
 *   ... --allow-writes                    todas las conexiones
 *   ... --allow-writes-for data           solo el alias 'data' (repetible)
 *
 * Ficheros .sql fuera del proyecto (execute_sql_file):
 *   ... --allow-sql-dir "C:\Codigo GIT\skills"
 *
 * POLITICA: sin --allow-writes el servidor arranca en SOLO LECTURA. La variable
 * MSSQL_ENABLE_WRITES se exporta SIEMPRE de forma explicita (true o false), nunca
 * se deja sin definir, para que nada del entorno pueda activarla por accidente.
 * Lo mismo con MSSQL_SQL_DIRS: se exporta siempre, aunque este vacia.
 *
 * Con varias conexiones, --allow-writes-for <alias> (repetible) habilita la
 * escritura SOLO para ese alias via MSSQL_<ALIAS>_ENABLE_WRITES, dejando el resto
 * en solo lectura aunque no se pase --allow-writes. Estas variables por alias son
 * politica igual que MSSQL_ENABLE_WRITES: tampoco puede aportarlas el entorno.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { instanceToDiscover } = require("./discover-instance");
const { revealAll } = require("../src/secrets");

const USAGE =
  "Uso â€” elige UNA fuente de conexion:\n" +
  "  a) --config-file <Web.config | appsettings.json | carpeta>\n" +
  "     --connection-name <NombreConexion[:alias]>   (repetible para multi-BD)\n" +
  "  b) --connection-string <cadena ADO.NET>         (repetible; con varias, cada una necesita --alias)\n" +
  "  c) --server <host[\\instancia]> --database <BD> --user <usuario> --password <clave>\n" +
  "  d) --from-env                                   (toma las MSSQL_* del entorno del cliente MCP)\n" +
  "  e) --credentials-file <ruta a un JSON>          (credenciales cifradas, fuera del repositorio)\n" +
  "\n" +
  "Opcionales:\n" +
  "  --environment <nombre>        entorno de appsettings.<entorno>.json (def.: ASPNETCORE_ENVIRONMENT o Development)\n" +
  "  --alias <nombre>             alias para --connection-string, en el mismo orden\n" +
  "  --port <puerto>              salida si SQL Browser esta parado; vale para todas\n" +
  "  --port <alias>:<puerto>      repetible; puerto de UNA conexion, cuando cada BD\n" +
  "                               esta en una instancia con su propio puerto\n" +
  "  --encrypt <true|false>       solo con la fuente (c)\n" +
  "  --trust-server-certificate <true|false>   solo con la fuente (c)\n" +
  "  --production                 marca la conexion como produccion; incompatible con --allow-writes\n" +
  "  --allow-writes               solo local o pruebas; habilita escritura en TODAS las conexiones\n" +
  "  --allow-writes-for <alias>  repetible; habilita escritura solo en esa conexion (multi-BD)\n" +
  "  --allow-sql-dir <carpeta>    repetible; carpetas extra para execute_sql_file";

function parseArgs(argv) {
  const out = {
    connections: [],
    connectionStrings: [],
    aliases: [],
    allowWrites: false,
    allowWritesFor: [],
    fromEnv: false,
    production: false,
    ports: [],
    sqlDirs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config-file") out.configFile = argv[++i];
    else if (argv[i] === "--connection-name") out.connections.push(argv[++i]);
    else if (argv[i] === "--connection-string")
      out.connectionStrings.push(argv[++i]);
    else if (argv[i] === "--alias") out.aliases.push(argv[++i]);
    else if (argv[i] === "--environment") out.environment = argv[++i];
    else if (argv[i] === "--server") out.server = argv[++i];
    else if (argv[i] === "--database") out.database = argv[++i];
    else if (argv[i] === "--user") out.user = argv[++i];
    else if (argv[i] === "--password") out.password = argv[++i];
    else if (argv[i] === "--encrypt") out.encrypt = argv[++i];
    else if (argv[i] === "--trust-server-certificate")
      out.trustServerCertificate = argv[++i];
    else if (argv[i] === "--from-env") out.fromEnv = true;
    else if (argv[i] === "--credentials-file") out.credentialsFile = argv[++i];
    else if (argv[i] === "--production") out.production = true;
    else if (argv[i] === "--allow-writes") out.allowWrites = true;
    else if (argv[i] === "--allow-writes-for") out.allowWritesFor.push(argv[++i]);
    else if (argv[i] === "--allow-sql-dir") out.sqlDirs.push(argv[++i]);
    else if (argv[i] === "--port") {
      const value = argv[++i];
      out.ports.push(value);
      // Se conserva `port` para la forma simple (un numero para todas), que es
      // como se ha usado siempre.
      if (/^\d+$/.test(String(value ?? "").trim())) out.port = String(value).trim();
    }
    else {
      console.error(`Argumento no reconocido: ${argv[i]}`);
      process.exit(1);
    }
  }
  return out;
}

/**
 * Normaliza una palabra clave de cadena ADO.NET.
 *
 * SqlClient admite la misma clave con y sin espacios: "Trust Server Certificate"
 * y "TrustServerCertificate" son la misma cosa, y en la practica Framework escribe
 * una y Core la otra. Sin quitar los espacios, la version de Core se ignoraba en
 * silencio y el ajuste no llegaba nunca a tedious.
 */
function normalizeAdoKey(key) {
  return String(key).toLowerCase().replace(/\s+/g, "");
}

function parseAdoConnectionString(connString) {
  const parts = {};
  for (const piece of String(connString).split(";")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) {
      // Trozo sin '=': si es solo digitos, se toma como puerto. Cubre la forma
      // `Data Source=PC\INSTANCIA;1435`, donde el ';' ya ha partido el par y el
      // puerto se perdia en silencio.
      if (/^\d+$/.test(trimmed) && !parts.port) parts.port = trimmed;
      continue;
    }
    parts[normalizeAdoKey(trimmed.slice(0, idx))] = trimmed.slice(idx + 1).trim();
  }
  return parts;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Aisla la seccion <connectionStrings> de un Web.config.
 *
 * El cierre se busca en </connectionStrings>, no en el primer "/>": la seccion
 * empieza casi siempre por <clear /> (para descartar las cadenas heredadas de
 * machine.config), y cortar ahi dejaba la seccion sin ninguna entrada.
 */
function extractConnectionStringsSection(xml) {
  const open = xml.match(/<connectionStrings\b([^>]*?)(\/?)>/i);
  if (!open) return null;

  const attrs = open[1];
  if (open[2] === "/") return { attrs, body: "" };

  const start = open.index + open[0].length;
  const closeIdx = xml.toLowerCase().indexOf("</connectionstrings>", start);
  return { attrs, body: closeIdx === -1 ? xml.slice(start) : xml.slice(start, closeIdx) };
}

/**
 * Extrae las entradas de <connectionStrings> de un Web.config.
 *
 * Se acota a la seccion antes de buscar <add> porque otras secciones tambien usan
 * el atributo `name` (DbProviderFactories, httpModules...), y un nombre repetido
 * devolveria la entrada equivocada. Admite <add/> y <add></add>, y el atributo
 * configSource, que en Framework es la forma habitual de sacar las credenciales a
 * un fichero aparte no versionado.
 */
function readWebConfigConnections(filePath, seen = new Set()) {
  const real = path.resolve(filePath);
  if (seen.has(real)) return {};
  seen.add(real);

  const section = extractConnectionStringsSection(fs.readFileSync(real, "utf8"));
  if (!section) return {};

  const configSource = section.attrs.match(/\bconfigSource\s*=\s*"([^"]*)"/i);
  if (configSource) {
    const external = path.resolve(path.dirname(real), configSource[1]);
    if (!fs.existsSync(external)) {
      throw new Error(
        `El Web.config apunta a configSource="${configSource[1]}" pero no existe: ${external}`
      );
    }
    return readWebConfigConnections(external, seen);
  }

  const out = {};
  for (const tag of section.body.match(/<add\b[\s\S]*?(?:\/>|<\/add>)/gi) || []) {
    const name = tag.match(/\bname\s*=\s*"([^"]*)"/);
    const conn = tag.match(/\bconnectionString\s*=\s*"([^"]*)"/);
    if (name && conn) out[name[1]] = decodeXmlEntities(conn[1]);
  }
  return out;
}

function readAppSettingsConnections(filePath) {
  let json;
  try {
    json = JSON.parse(stripBom(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    throw new Error(`No se pudo interpretar ${filePath} como JSON: ${err.message}`);
  }
  // La configuracion de .NET es insensible a mayusculas, tambien en el nombre de
  // la seccion.
  const sectionKey = Object.keys(json).find(
    (k) => k.toLowerCase() === "connectionstrings"
  );
  const section = sectionKey ? json[sectionKey] : null;
  if (!section || typeof section !== "object") return {};

  const out = {};
  for (const [name, value] of Object.entries(section)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

function resolveEnvironment(environment, env = process.env) {
  return environment || env.ASPNETCORE_ENVIRONMENT || "Development";
}

/**
 * Cadena de ficheros appsettings a consultar, del mas especifico al menos.
 *
 * Replica la superposicion de ASP.NET Core: appsettings.<entorno>.json pisa a
 * appsettings.json. Importa porque en Flexygo Core las cadenas estan declaradas
 * pero VACIAS en appsettings.json, y las reales viven en el fichero de entorno.
 * Funciona igual si apuntas directamente al fichero de entorno: se anade su base
 * como respaldo.
 */
function appSettingsChain(filePath, environment) {
  const dir = path.dirname(filePath);
  const file = path.basename(filePath);
  const match = file.match(/^(appsettings)\.(.+)\.json$/i);
  const base = match ? `${match[1]}.json` : file;

  const candidates = [
    path.join(dir, `appsettings.${environment}.json`),
    filePath,
    path.join(dir, base),
  ];

  const seen = new Set();
  return candidates.filter((p) => {
    const key = process.platform === "win32" ? p.toLowerCase() : p;
    if (seen.has(key) || !fs.existsSync(p)) return false;
    seen.add(key);
    return true;
  });
}

/** Ficheros a consultar para un --config-file, del mas especifico al menos. */
function configChain(configFile, environment) {
  const ext = path.extname(configFile).toLowerCase();
  if (ext === ".config") return [configFile];
  if (ext === ".json") return appSettingsChain(configFile, environment);
  throw new Error(
    `Extension no soportada '${ext}'. Usa un Web.config o un appsettings.json.`
  );
}

function readConnectionsFrom(file) {
  return path.extname(file).toLowerCase() === ".config"
    ? readWebConfigConnections(file)
    : readAppSettingsConnections(file);
}

/**
 * Busca una cadena de conexion por nombre en la cadena de ficheros.
 *
 * Una cadena vacia cuenta como ausente, no como encontrada: es exactamente lo que
 * declara appsettings.json en Core, y tratarla como valida daba el error
 * "No se pudo determinar el servidor" en lugar de mirar el fichero de entorno.
 */
function readConnString(configFile, name, { environment } = {}) {
  const env = resolveEnvironment(environment);
  const chain = configChain(configFile, env);
  if (chain.length === 0) {
    throw new Error(`No existe el archivo de configuracion: ${configFile}`);
  }

  const empty = [];
  const available = new Set();
  for (const file of chain) {
    const connections = readConnectionsFrom(file);
    for (const key of Object.keys(connections)) available.add(key);
    const key = Object.keys(connections).find(
      (k) => k.toLowerCase() === String(name).toLowerCase()
    );
    if (key === undefined) continue;
    if (connections[key].trim() === "") {
      empty.push(file);
      continue;
    }
    return { value: connections[key], source: file };
  }

  const detail = [];
  if (empty.length > 0) {
    detail.push(
      `Existe pero esta vacia en: ${empty.join(", ")}. ` +
        `En .NET Core el valor real suele estar en appsettings.${env}.json; ` +
        `usa --environment si tu entorno no es ${env}.`
    );
  }
  if (available.size > 0) {
    detail.push(`Disponibles: ${[...available].join(", ")}.`);
  }
  throw new Error(
    `No se encontro la cadena de conexion '${name}'. ` +
      `Consultado: ${chain.join(", ")}. ${detail.join(" ")}`.trim()
  );
}

/** Nombres de conexion presentes en la cadena de ficheros, para los mensajes. */
function listConnectionNames(configFile, { environment } = {}) {
  const names = new Set();
  try {
    for (const file of configChain(configFile, resolveEnvironment(environment))) {
      for (const key of Object.keys(readConnectionsFrom(file))) names.add(key);
    }
  } catch {
    // el error real ya se reporta en readConnString
  }
  return [...names];
}

/**
 * Si --config-file apunta a una carpeta, busca dentro el fichero habitual.
 *
 * En Core la ruta que la gente tiene a mano es la del directorio `conf`, no la del
 * appsettings.json.
 */
function resolveConfigFile(configFile) {
  if (!fs.existsSync(configFile)) {
    throw new Error(`No existe el archivo de configuracion: ${configFile}`);
  }
  if (!fs.statSync(configFile).isDirectory()) return configFile;

  for (const candidate of ["appsettings.json", "Web.config"]) {
    const p = path.join(configFile, candidate);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `La carpeta ${configFile} no contiene appsettings.json ni Web.config.`
  );
}

/** Variables que fija el wrapper y que el entorno nunca puede aportar. */
const POLICY_VARS = new Set(["MSSQL_SQL_DIRS"]);
// MSSQL_ENABLE_WRITES (global) y MSSQL_<ALIAS>_ENABLE_WRITES (por conexion) son
// la misma politica: ninguna de las dos formas puede venir del entorno heredado.
const ENABLE_WRITES_RE = /^MSSQL_(.+_)?ENABLE_WRITES$/i;

function isPolicyVar(upper) {
  return POLICY_VARS.has(upper) || ENABLE_WRITES_RE.test(upper);
}

/**
 * Entorno limpio: se eliminan TODAS las MSSQL_* heredadas de la maquina.
 *
 * Motivo: el servidor decide entre modo simple y multi-BD escaneando variables
 * que encajen con MSSQL_<NOMBRE>_DATABASE. Una variable residual de otra
 * herramienta (por ejemplo de la epoca de la extension MSSQL de VS Code) podria
 * cambiar el modo o inyectar una conexion que nadie ha pedido.
 *
 * `--from-env` es la excepcion explicita: deja pasar las MSSQL_* de conexion
 * porque son justo lo que el cliente MCP quiere aportar. Las variables de
 * politica (MSSQL_ENABLE_WRITES, MSSQL_<ALIAS>_ENABLE_WRITES y MSSQL_SQL_DIRS)
 * se sobrescriben despues en los dos casos, asi que ni con --from-env puede el
 * entorno habilitar escrituras.
 */
function cleanEnv(keepConnectionVars = false, source = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    const upper = k.toUpperCase();
    if (!upper.startsWith("MSSQL_")) {
      env[k] = v;
      continue;
    }
    if (keepConnectionVars && !isPolicyVar(upper)) env[k] = v;
  }
  return env;
}

/**
 * Descompone el "Data Source" de una cadena ADO.NET, en cualquiera de sus formas.
 *
 * El objetivo es no perder NADA de lo que ponga el Web.config: si trae un puerto
 * escrito de cualquier manera, se usa, y entonces no hace falta ni el servicio SQL
 * Browser ni tocar nada. Lo que se admite:
 *
 *   HOST                        PC_158
 *   HOST\INSTANCIA              PC_158\SQL2022
 *   HOST,PUERTO                 PC_158,1433
 *   HOST\INSTANCIA,PUERTO       PC_158\SQL2022,1435
 *   HOST,PUERTO\INSTANCIA       192.168.9.26,1433\AHORA_R   (visto en produccion)
 *   HOST;PUERTO                 PC_158;1435
 *   HOST\INSTANCIA;PUERTO       PC_158\SQL2022;1435
 *   HOST:PUERTO                 PC_158:1435
 *   [IPv6]  y  [IPv6],PUERTO    [::1],1433
 *   (local), (local)\INST, .    y .\INSTANCIA
 *   prefijos de protocolo       tcp: np: lpc: admin:
 *   valor entre comillas        "PC_158\SQL2022"
 *
 * Devuelve tambien `protocol`, porque np (canalizaciones nombradas) y lpc (memoria
 * compartida) NO los soporta tedious: hay que decirlo en claro en lugar de tratarlos
 * como TCP y dar un tiempo de espera que no explica nada. Es justo la trampa de
 * creer que "si SSMS conecta, esto tambien": en local SSMS usa memoria compartida.
 *
 * Y `MSSQLSERVER` como nombre de instancia es la instancia POR DEFECTO, asi que se
 * descarta: tratarla como nombrada obligaria al SQL Browser sin ninguna necesidad.
 */
function parseDataSource(raw) {
  let s = String(raw ?? "").trim();

  // Valor entre comillas: Data Source="PC_158\SQL2022"
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) s = s.slice(1, -1).trim();

  let protocol;
  const proto = s.match(/^(tcp|np|lpc|admin)\s*:/i);
  if (proto) {
    protocol = proto[1].toLowerCase();
    s = s.slice(proto[0].length).trim();
  }

  // Canalizacion nombrada explicita: \\HOST\pipe\MSSQL$INST\sql\query
  if (s.startsWith("\\\\")) {
    const pipe = s.slice(2).split("\\");
    return { host: pipe[0] || "", instanceName: undefined, port: undefined, protocol: "np" };
  }

  // Host IPv6 entre corchetes, que lleva ':' dentro y no se puede tokenizar igual.
  let bracketed;
  const bracket = s.match(/^\[([^\]]*)\]\s*(.*)$/);
  if (bracket) {
    bracketed = bracket[1].trim();
    s = bracket[2].trim().replace(/^[,;:]\s*/, "");
  }

  let host = bracketed || "";
  let instanceName;
  let port;

  // ',' ';' y ':' son separadores equivalentes aqui. Se recorren los trozos en vez
  // de asumir un orden, porque el puerto aparece antes y despues de la instancia.
  for (const token of s.split(/[,;:]/).map((t) => t.trim()).filter(Boolean)) {
    if (/^\d+$/.test(token)) {
      if (!port) port = token;
      continue;
    }
    if (token.includes("\\")) {
      const [left, right] = token.split("\\");
      const leftTrimmed = left.trim();
      // En `HOST,PUERTO\INSTANCIA` el trozo de la izquierda es el PUERTO, no el
      // host: sin esto el puerto se perdia y la conexion pasaba a depender del
      // SQL Browser sin motivo.
      if (/^\d+$/.test(leftTrimmed)) {
        if (!port) port = leftTrimmed;
      } else if (!host) {
        host = leftTrimmed;
      }
      if (right && !instanceName) instanceName = right.trim();
      continue;
    }
    if (!host) host = token;
    else if (!instanceName) instanceName = token;
  }

  if (host === "." || /^\(local\)$/i.test(host)) host = "localhost";
  // La instancia por defecto no necesita resolucion por nombre.
  if (instanceName && /^MSSQLSERVER$/i.test(instanceName)) instanceName = undefined;

  return { host, instanceName, port, protocol };
}

/**
 * Puerto a aplicar a una conexion concreta.
 *
 * `--port 1433` vale para todas. `--port <alias>:<puerto>` vale solo para esa, y es
 * lo que hace falta cuando cada base de datos vive en una instancia distinta con su
 * propio puerto â€” el caso tipico de un Flexygo en una maquina con varias instancias,
 * donde un unico puerto para todas no sirve de nada.
 */
function portFor(ports, alias) {
  let bare;
  for (const raw of ports || []) {
    const value = String(raw ?? "").trim();
    const named = value.match(/^(.+?)\s*:\s*(\d+)$/);
    if (named) {
      if (alias && named[1].trim().toLowerCase() === String(alias).toLowerCase()) {
        return named[2];
      }
      continue;
    }
    if (/^\d+$/.test(value)) bare = value;
  }
  return bare;
}

function applyConnection(env, prefix, parts, label, portOverride) {
  // Todos los alias que SqlClient acepta para el servidor.
  const dataSource =
    parts.datasource ||
    parts.server ||
    parts.addr ||
    parts.address ||
    parts.networkaddress;
  const database = parts.initialcatalog || parts.database;
  const user = parts.userid || parts.uid || parts.user;
  const password = parts.password || parts.pwd;

  if (!dataSource) throw new Error(`[${label}] No se pudo determinar el servidor.`);
  if (!database) throw new Error(`[${label}] No se pudo determinar la base de datos.`);
  if (!user || !password) {
    throw new Error(
      `[${label}] La cadena de conexion no lleva usuario y contrasena. ` +
        `El servidor todavia no soporta autenticacion integrada de Windows.`
    );
  }

  const { host, instanceName, port, protocol } = parseDataSource(dataSource);

  if (!host) throw new Error(`[${label}] No se pudo interpretar el servidor '${dataSource}'.`);

  // np = canalizaciones nombradas, lpc = memoria compartida. tedious solo habla
  // TCP, asi que tratarlos como TCP produce un tiempo de espera que no explica
  // nada. Es la misma trampa que "si SSMS conecta, esto tambien": en local SSMS
  // usa memoria compartida.
  if (protocol === "np" || protocol === "lpc") {
    throw new Error(
      `[${label}] El Data Source usa el protocolo '${protocol}' ` +
        `(${protocol === "np" ? "canalizaciones nombradas" : "memoria compartida"}), ` +
        `que este servidor no soporta porque su driver es solo TCP. ` +
        `Usa 'tcp:HOST,PUERTO' o 'HOST\\INSTANCIA'.`
    );
  }

  // Cualquier puerto escrito en la cadena vale, aunque venga en un `Port=` aparte
  // o como un trozo suelto tras un ';'. Un puerto explicito evita depender del
  // servicio SQL Browser; tedious no admite puerto e instancia a la vez, asi que al
  // fijar puerto se descarta la instancia.
  const finalPort = portOverride || port || parts.port;
  if (finalPort) {
    env[`${prefix}PORT`] = String(finalPort);
  } else if (instanceName) {
    env[`${prefix}INSTANCE_NAME`] = instanceName;
  }

  env[`${prefix}SERVER`] = host;
  env[`${prefix}DATABASE`] = database;
  env[`${prefix}USER`] = user;
  env[`${prefix}PASSWORD`] = password;
  if (parts.encrypt) env[`${prefix}ENCRYPT`] = parts.encrypt.toLowerCase();
  if (parts.trustservercertificate) {
    env[`${prefix}TRUST_SERVER_CERTIFICATE`] =
      parts.trustservercertificate.toLowerCase();
  }

  return {
    target:
      host +
      (finalPort ? `,${finalPort}` : instanceName ? `\\${instanceName}` : ""),
    database,
    viaInstance: Boolean(!finalPort && instanceName),
  };
}

/**
 * Lee credenciales de un JSON que vive FUERA del repositorio.
 *
 * Es la salida para los proyectos sin Web.config ni appsettings.json: las
 * credenciales no pueden ir en el .mcp.json porque ese fichero se commitea, asi
 * que se guardan en %APPDATA% y aqui solo viaja la ruta.
 *
 * Forma simple:
 *   { "server": "PC\\INST", "database": "BD", "user": "sa", "passwordEnc": "dpapi:v1:..." }
 * Multi-BD (la clave es el dbKey):
 *   { "connections": { "config": { ... }, "data": { ... } } }
 *
 * La contrasena viene cifrada en `passwordEnc` y se descifra aqui, en memoria, para
 * pasarla al servidor por el entorno del proceso hijo. Los ficheros de versiones
 * anteriores traen `password` en claro y se siguen aceptando: si no, actualizar
 * dejaria sin arrancar a quien ya lo tenia instalado.
 */
function readCredentialsFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`No existe el fichero de credenciales: ${filePath}`);
  }
  let json;
  try {
    json = JSON.parse(stripBom(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    throw new Error(`No se pudo interpretar ${filePath} como JSON: ${err.message}`);
  }

  const check = (alias, raw) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`[${alias || "credenciales"}] entrada no valida en ${filePath}`);
    }
    return raw;
  };

  const raws =
    json.connections && typeof json.connections === "object"
      ? Object.keys(json.connections).map((alias) => ({
          alias,
          raw: check(alias, json.connections[alias]),
        }))
      : [{ alias: undefined, raw: check(undefined, json) }];

  if (json.connections && raws.length === 0) {
    throw new Error(`${filePath} no declara ninguna conexion dentro de "connections".`);
  }

  // Todas de una vez: descifrar cuesta un arranque de PowerShell, y hacerlo por
  // conexion es justo lo que agota el MCP_TIMEOUT del cliente.
  const passwords = revealAll(
    raws.map(({ raw }) => (raw.passwordEnc === undefined ? raw.password : raw.passwordEnc))
  );

  return raws.map(({ alias, raw }, i) => ({
    alias,
    parts: partsFromFlags({
      server: raw.port ? `${raw.server},${raw.port}` : raw.server,
      database: raw.database,
      user: raw.user,
      password: passwords[i],
      encrypt: raw.encrypt === undefined ? undefined : String(raw.encrypt),
      trustServerCertificate:
        raw.trustServerCertificate === undefined
          ? undefined
          : String(raw.trustServerCertificate),
    }),
  }));
}

function partsFromFlags({
  server,
  database,
  user,
  password,
  encrypt,
  trustServerCertificate,
}) {
  const parts = {};
  if (server) parts.datasource = server;
  if (database) parts.initialcatalog = database;
  if (user) parts.userid = user;
  if (password) parts.password = password;
  if (encrypt) parts.encrypt = encrypt;
  if (trustServerCertificate) parts.trustservercertificate = trustServerCertificate;
  return parts;
}

/**
 * Decide la fuente de conexion y devuelve las entradas a resolver.
 *
 * Exactamente una fuente. Mezclarlas seria ambiguo: no hay un orden de precedencia
 * que alguien pueda adivinar mirando el .mcp.json.
 */
function resolveSources(args) {
  const hasFlags = Boolean(args.server || args.database || args.user || args.password);
  const used = [
    args.configFile && "--config-file",
    args.connectionStrings.length > 0 && "--connection-string",
    hasFlags && "--server/--database/--user/--password",
    args.fromEnv && "--from-env",
    args.credentialsFile && "--credentials-file",
  ].filter(Boolean);

  if (used.length === 0) return { kind: "none" };
  if (used.length > 1) {
    throw new Error(
      `Elige una sola fuente de conexion. Se han indicado varias: ${used.join(", ")}.`
    );
  }

  if (args.fromEnv) return { kind: "env" };

  if (args.credentialsFile) {
    return {
      kind: "credentialsFile",
      entries: readCredentialsFile(args.credentialsFile),
    };
  }

  if (args.configFile) {
    if (args.connections.length === 0) {
      const configFile = resolveConfigFile(args.configFile);
      const names = listConnectionNames(configFile, {
        environment: args.environment,
      });
      throw new Error(
        `Falta --connection-name.` +
          (names.length > 0 ? ` Disponibles en ${configFile}: ${names.join(", ")}.` : "")
      );
    }
    return { kind: "configFile", entries: args.connections };
  }

  if (args.connectionStrings.length > 0) {
    if (args.connectionStrings.length > 1 &&
        args.aliases.length !== args.connectionStrings.length) {
      throw new Error(
        `Con ${args.connectionStrings.length} --connection-string hacen falta ` +
          `${args.connectionStrings.length} --alias, en el mismo orden. ` +
          `Hay ${args.aliases.length}.`
      );
    }
    return { kind: "connectionString", entries: args.connectionStrings };
  }

  const missing = ["server", "database", "user", "password"].filter((k) => !args[k]);
  if (missing.length > 0) {
    throw new Error(
      `Faltan datos de conexion: ${missing.map((m) => `--${m}`).join(", ")}.`
    );
  }
  return { kind: "flags", entries: [null] };
}

/** Describe las conexiones que el servidor va a deducir de las MSSQL_* del entorno. */
function describeEnvConnections(env) {
  const multi = Object.keys(env).filter((k) => /^MSSQL_(.+)_DATABASE$/i.test(k));
  if (multi.length > 0) {
    return multi.map((k) => {
      const raw = k.match(/^MSSQL_(.+)_DATABASE$/i)[1];
      const prefix = `MSSQL_${raw}_`;
      return {
        key: raw.toLowerCase(),
        target: env[`${prefix}SERVER`] || env.MSSQL_SERVER || "(sin MSSQL_SERVER)",
        database: env[k],
        viaInstance: Boolean(env[`${prefix}INSTANCE_NAME`] || env.MSSQL_INSTANCE_NAME),
      };
    });
  }
  if (env.MSSQL_SERVER || env.MSSQL_DATABASE) {
    return [
      {
        key: "maindb",
        target: env.MSSQL_SERVER || "(sin MSSQL_SERVER)",
        database: env.MSSQL_DATABASE || "(sin MSSQL_DATABASE)",
        viaInstance: Boolean(env.MSSQL_INSTANCE_NAME),
      },
    ];
  }
  throw new Error(
    "--from-env no ha encontrado ninguna MSSQL_* de conexion en el entorno. " +
      "Define MSSQL_SERVER/MSSQL_DATABASE/MSSQL_USER/MSSQL_PASSWORD (o las " +
      "MSSQL_<ALIAS>_* para multi-BD) en el bloque \"env\" del cliente MCP."
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // La decision de "esto es produccion" se toma una vez, al configurar, y queda
  // escrita en el .mcp.json. Aqui se hace cumplir: anadir --allow-writes a mano
  // mas tarde falla al arrancar en lugar de limitarse a avisar.
  if (args.production && (args.allowWrites || args.allowWritesFor.length > 0)) {
    console.error(
      "--production y --allow-writes/--allow-writes-for son incompatibles.\n" +
        "Esta configuracion esta marcada como PRODUCCION. Si de verdad necesitas\n" +
        "escribir, quita --production a conciencia y asume lo que implica."
    );
    process.exit(1);
  }

  let source;
  try {
    source = resolveSources(args);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (source.kind === "none") {
    console.error(`Faltan argumentos.\n\n${USAGE}`);
    process.exit(1);
  }

  const env = cleanEnv(source.kind === "env");
  const resolved = [];
  const pendingInstances = [];
  let credentialsInArgv = false;

  try {
    if (source.kind === "env") {
      resolved.push(...describeEnvConnections(env));
    } else {
      const multi = source.entries.length > 1;
      const configFile =
        source.kind === "configFile" ? resolveConfigFile(args.configFile) : null;

      // Interpretar cada conexion, sin preguntar nada al sistema: el arranque del wrapper
      // no habla ni con el registro ni con PowerShell (salvo descifrar credenciales).
      const prepared = [];
      source.entries.forEach((entry, i) => {
        let connString;
        let alias;
        let label;

        if (source.kind === "credentialsFile") {
          alias = entry.alias;
          label = alias || "credenciales";
        } else if (source.kind === "configFile") {
          const [name, aliasFromEntry] = String(entry).split(":");
          if (!name) throw new Error(`--connection-name vacio en '${entry}'`);
          if (multi && !aliasFromEntry) {
            throw new Error(
              `Con varias conexiones cada una necesita alias: --connection-name ${name}:<alias>`
            );
          }
          alias = aliasFromEntry;
          label = aliasFromEntry || name;
          connString = readConnString(configFile, name, {
            environment: args.environment,
          }).value;
        } else if (source.kind === "connectionString") {
          credentialsInArgv = true;
          alias = args.aliases[i];
          label = alias || `connection-string ${i + 1}`;
          connString = entry;
        } else {
          credentialsInArgv = Boolean(args.password);
          alias = args.aliases[0];
          label = alias || "maindb";
        }

        // En modo simple la clave es siempre `maindb`, por compatibilidad con las
        // skills SC0. Si alguien pasa un alias con una sola conexion se avisa, en
        // lugar de ignorarlo en silencio.
        if (!multi && alias) {
          console.error(
            `  Nota: con una sola conexion la clave es 'maindb'; el alias '${alias}' no se usa.`
          );
        }
        const prefix = multi ? `MSSQL_${alias.toUpperCase()}_` : "MSSQL_";
        const rawParts =
          source.kind === "credentialsFile"
            ? entry.parts
            : source.kind === "flags"
              ? partsFromFlags(args)
              : parseAdoConnectionString(connString);

        // En modo simple la clave es `maindb`, asi que `--port maindb:1433` tambien
        // funciona para una sola conexion.
        prepared.push({
          key: multi ? alias.toLowerCase() : "maindb",
          label,
          prefix,
          rawParts,
          portOverride: portFor(args.ports, alias || "maindb"),
        });
      });

      // Si la cadena nombra una instancia local y no trae puerto, hay que averiguar el
      // puerto real preguntando al sistema. Eso se hacia AQUI, y era el problema: cuesta
      // ~4 segundos de PowerShell y el servidor todavia no estaba levantado, asi que ese
      // tiempo se lo comia el cliente esperando el saludo `initialize`. Con 30 segundos de
      // MCP_TIMEOUT por defecto y el servidor entero descartado al agotarse, las tools no
      // llegaban a aparecer; al reiniciar caia dentro del minuto de cache del sondeo y
      // entonces si. De ahi el "a veces hay que reiniciar el MCP".
      //
      // Ahora aqui solo se ANOTA cual habra que resolver, para poder decirlo en el
      // resumen. Lo resuelve el servidor en el primer uso de esa conexion
      // (src/db/endpoint.js), donde ya no hay ningun reloj corriendo, y ademas puede
      // repetirlo si el puerto cambia -antes eso exigia reiniciar el proceso.
      //
      // Con --port no hay nada que averiguar: el puerto ya lo ha dicho quien arranca. Lo
      // que se pierde en ese caso es detectar que la instancia solo escucha en la
      // loopback, y por eso se avisa mas abajo.
      for (const p of prepared) {
        const natural = instanceToDiscover(p.rawParts, parseDataSource);
        const skippedByPort = Boolean(natural && p.portOverride);
        const pendingInstance =
          natural && !p.portOverride ? natural.instanceName : null;

        const info = applyConnection(env, p.prefix, p.rawParts, p.label, p.portOverride);
        if (pendingInstance) {
          pendingInstances.push({ label: p.label, instanceName: pendingInstance });
        }
        resolved.push({ key: p.key, ...info, skippedByPort, pendingInstance });
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Explicito siempre, en los dos sentidos. Nunca sin definir.
  env.MSSQL_ENABLE_WRITES = args.allowWrites ? "true" : "false";

  // Por-alias: solo se fija cuando se pide (positivo), y solo si coincide con una
  // conexion de verdad - un alias con una errata pasaria desapercibido si no.
  const writeOverrides = [];
  for (const raw of args.allowWritesFor) {
    const alias = String(raw ?? "").trim();
    const match = resolved.find((r) => r.key.toLowerCase() === alias.toLowerCase());
    if (!match) {
      console.error(
        `--allow-writes-for '${alias}' no coincide con ninguna conexion. ` +
          `Disponibles: ${resolved.map((r) => r.key).join(", ")}.`
      );
      process.exit(1);
    }
    env[`MSSQL_${match.key.toUpperCase()}_ENABLE_WRITES`] = "true";
    writeOverrides.push(match.key);
  }

  // Carpetas extra para execute_sql_file. La carpeta del proyecto (el cwd) va
  // permitida siempre y la resuelve el servidor; aqui solo se anaden las extras.
  // Se exporta siempre, aunque este vacia, por el mismo motivo que
  // MSSQL_ENABLE_WRITES: que nada del entorno pueda autorizar carpetas.
  const resolvedSqlDirs = [];
  for (const dir of args.sqlDirs) {
    if (!fs.existsSync(dir)) {
      console.error(`No existe la carpeta indicada en --allow-sql-dir: ${dir}`);
      process.exit(1);
    }
    resolvedSqlDirs.push(fs.realpathSync(dir));
  }
  env.MSSQL_SQL_DIRS = resolvedSqlDirs.join(path.delimiter);

  const anyWrites = args.allowWrites || writeOverrides.length > 0;
  const mode = args.allowWrites
    ? "LECTURA-ESCRITURA"
    : writeOverrides.length > 0
      ? "LECTURA-ESCRITURA PARCIAL"
      : "SOLO LECTURA";
  const origin = {
    configFile: `${args.configFile} (entorno ${resolveEnvironment(args.environment)})`,
    connectionString: "--connection-string",
    flags: "--server/--database/--user/--password",
    env: "MSSQL_* del entorno del cliente MCP (--from-env)",
    credentialsFile: `${args.credentialsFile} (credenciales cifradas, fuera del repositorio)`,
  }[source.kind];

  console.error("â”€".repeat(64));
  console.error(
    `AHORA-SQL-MCP â€” modo ${mode}${args.production ? "  Â·  PRODUCCION" : ""}`
  );
  console.error(`  Conexion desde: ${origin}`);
  for (const r of resolved) {
    const dbWrites = args.allowWrites || writeOverrides.includes(r.key);
    console.error(
      `  [${r.key}] ${r.target} / ${r.database}${dbWrites ? "  (lectura-escritura)" : ""}`
    );
  }
  // La carpeta del proyecto depende de donde se arranque el servidor, asi que se
  // imprime: es la unica forma de ver de un vistazo que raiz esta en vigor.
  console.error(`  SQL desde: ${fs.realpathSync(process.cwd())} (carpeta del proyecto)`);
  for (const dir of resolvedSqlDirs) {
    console.error(`             ${dir} (--allow-sql-dir)`);
  }
  for (const d of pendingInstances) {
    console.error(
      `  [${d.label}] instancia local ${d.instanceName}: el puerto se averigua en el ` +
        "primer uso, no aqui (y se vuelve a averiguar si deja de servir)"
    );
  }
  if (resolved.some((r) => r.skippedByPort)) {
    console.error(
      "  Con --port no se pregunta al sistema por la instancia, asi que tampoco se\n" +
        "  detecta si solo escucha en la loopback. Si la conexion falla con el puerto\n" +
        "  correcto, pon 127.0.0.1 como servidor en lugar del nombre del equipo."
    );
  }
  // Solo las REMOTAS: una instancia local la resuelve el servidor sondeando el sistema,
  // que es justo la via que no necesita SQL Browser.
  if (resolved.some((r) => r.viaInstance && !r.pendingInstance)) {
    console.error(
      "  Instancia nombrada REMOTA: la resuelve el SQL Browser del otro equipo, que\n" +
        "  tiene que estar activo, o el TCP/IP habilitado en esa instancia. Si falla,\n" +
        "  indica el puerto con --port <alias>:<puerto>."
    );
  }
  if (credentialsInArgv) {
    console.error(
      "  AVISO: la contrasena viaja en la linea de comandos, asi que queda en el\n" +
        "  .mcp.json y en el listado de procesos. Para evitarlo, usa --from-env."
    );
  }
  if (anyWrites) {
    console.error(
      `  AVISO: escrituras y DDL habilitados${
        args.allowWrites ? "" : ` para: ${writeOverrides.join(", ")}`
      }. Solo para local o pruebas.`
    );
  }
  console.error("â”€".repeat(64));

  const entry = path.join(__dirname, "..", "src", "index.js");
  const child = spawn(process.execPath, [entry], { env, stdio: "inherit" });
  // Sin escuchar 'error', un fallo al lanzar node (ruta mala, permisos, antivirus) llega
  // como evento sin oyente y tumba el wrapper con un volcado que no explica nada.
  child.on("error", (err) => {
    console.error(`No se ha podido lanzar el servidor: ${err.message}`);
    process.exit(1);
  });
  // Muerto por senal, `code` es null: el `?? 0` de antes le decia al cliente que todo
  // habia ido bien, asi que un servidor matado desde fuera desaparecia sin que nada lo
  // reportara. Un codigo distinto de 0 y una linea en stderr es lo minimo para que se vea.
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`El servidor ha terminado por la senal ${signal}.`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  parseAdoConnectionString,
  normalizeAdoKey,
  parseDataSource,
  portFor,
  cleanEnv,
  applyConnection,
  partsFromFlags,
  readCredentialsFile,
  readConnString,
  listConnectionNames,
  readWebConfigConnections,
  readAppSettingsConnections,
  appSettingsChain,
  configChain,
  resolveConfigFile,
  resolveEnvironment,
  resolveSources,
  describeEnvConnections,
};
