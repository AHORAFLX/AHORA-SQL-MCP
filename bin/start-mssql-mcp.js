#!/usr/bin/env node
/**
 * Wrapper de arranque de AHORA-SQL-MCP.
 *
 * Resuelve la conexion sin duplicar credenciales en la configuracion de cada MCP.
 * Hay cuatro fuentes posibles, y hay que elegir UNA:
 *
 * 1) Web.config (.NET Framework) — Flexygo no migrado
 *      --config-file C:\repo\Web.config --connection-name DataConnectionString
 *
 * 2) appsettings.json (.NET Core) — Flexygo migrado
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
 *   ... --allow-writes
 *
 * Ficheros .sql fuera del proyecto (execute_sql_file):
 *   ... --allow-sql-dir "C:\Codigo GIT\skills"
 *
 * POLITICA: sin --allow-writes el servidor arranca en SOLO LECTURA. La variable
 * MSSQL_ENABLE_WRITES se exporta SIEMPRE de forma explicita (true o false), nunca
 * se deja sin definir, para que nada del entorno pueda activarla por accidente.
 * Lo mismo con MSSQL_SQL_DIRS: se exporta siempre, aunque este vacia.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const USAGE =
  "Uso — elige UNA fuente de conexion:\n" +
  "  a) --config-file <Web.config | appsettings.json | carpeta>\n" +
  "     --connection-name <NombreConexion[:alias]>   (repetible para multi-BD)\n" +
  "  b) --connection-string <cadena ADO.NET>         (repetible; con varias, cada una necesita --alias)\n" +
  "  c) --server <host[\\instancia]> --database <BD> --user <usuario> --password <clave>\n" +
  "  d) --from-env                                   (toma las MSSQL_* del entorno del cliente MCP)\n" +
  "  e) --credentials-file <ruta a un JSON>          (credenciales fuera del repositorio)\n" +
  "\n" +
  "Opcionales:\n" +
  "  --environment <nombre>        entorno de appsettings.<entorno>.json (def.: ASPNETCORE_ENVIRONMENT o Development)\n" +
  "  --alias <nombre>             alias para --connection-string, en el mismo orden\n" +
  "  --port <puerto>              salida si SQL Browser esta parado\n" +
  "  --encrypt <true|false>       solo con la fuente (c)\n" +
  "  --trust-server-certificate <true|false>   solo con la fuente (c)\n" +
  "  --production                 marca la conexion como produccion; incompatible con --allow-writes\n" +
  "  --allow-writes               solo local o pruebas\n" +
  "  --allow-sql-dir <carpeta>    repetible; carpetas extra para execute_sql_file";

function parseArgs(argv) {
  const out = {
    connections: [],
    connectionStrings: [],
    aliases: [],
    allowWrites: false,
    fromEnv: false,
    production: false,
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
    else if (argv[i] === "--allow-sql-dir") out.sqlDirs.push(argv[++i]);
    else if (argv[i] === "--port") out.port = argv[++i];
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
    if (!piece.trim()) continue;
    const idx = piece.indexOf("=");
    if (idx === -1) continue;
    parts[normalizeAdoKey(piece.slice(0, idx))] = piece.slice(idx + 1).trim();
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
const POLICY_VARS = new Set(["MSSQL_ENABLE_WRITES", "MSSQL_SQL_DIRS"]);

/**
 * Entorno limpio: se eliminan TODAS las MSSQL_* heredadas de la maquina.
 *
 * Motivo: el servidor decide entre modo simple y multi-BD escaneando variables
 * que encajen con MSSQL_<NOMBRE>_DATABASE. Una variable residual de otra
 * herramienta (por ejemplo de la epoca de la extension MSSQL de VS Code) podria
 * cambiar el modo o inyectar una conexion que nadie ha pedido.
 *
 * `--from-env` es la excepcion explicita: deja pasar las MSSQL_* de conexion
 * porque son justo lo que el cliente MCP quiere aportar. Las dos variables de
 * politica (MSSQL_ENABLE_WRITES y MSSQL_SQL_DIRS) se sobrescriben despues en los
 * dos casos, asi que ni con --from-env puede el entorno habilitar escrituras.
 */
function cleanEnv(keepConnectionVars = false, source = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    const upper = k.toUpperCase();
    if (!upper.startsWith("MSSQL_")) {
      env[k] = v;
      continue;
    }
    if (keepConnectionVars && !POLICY_VARS.has(upper)) env[k] = v;
  }
  return env;
}

/**
 * Descompone el "Data Source" de una cadena ADO.NET.
 *
 * Formatos admitidos: HOST, HOST\INSTANCIA, HOST,PUERTO, HOST\INSTANCIA,PUERTO,
 * HOST,PUERTO\INSTANCIA, (local), . y el prefijo de protocolo tcp:. La instancia
 * nombrada es lo habitual en los SQL Server locales de desarrollo (por ejemplo
 * PC_158\PC_158).
 */
function parseDataSource(raw) {
  let s = String(raw).trim().replace(/^(tcp|np|lpc):/i, "");
  let port;
  let instanceName;

  const commaIdx = s.lastIndexOf(",");
  if (commaIdx > -1) {
    let portPart = s.slice(commaIdx + 1).trim();
    // Forma poco ortodoxa pero real en los Web.config de produccion:
    // HOST,PUERTO\INSTANCIA. Sin separarla, el puerto quedaba como "1433\INST" y
    // solo colaba porque parseInt se detiene en la barra.
    const slashInPort = portPart.indexOf("\\");
    if (slashInPort > -1) {
      instanceName = portPart.slice(slashInPort + 1).trim();
      portPart = portPart.slice(0, slashInPort).trim();
    }
    port = portPart;
    s = s.slice(0, commaIdx).trim();
  }

  const slashIdx = s.indexOf("\\");
  if (slashIdx > -1) {
    instanceName = s.slice(slashIdx + 1).trim();
    s = s.slice(0, slashIdx).trim();
  }

  let host = s;
  if (host === "." || /^\(local\)$/i.test(host)) host = "localhost";

  return { host, instanceName, port };
}

function applyConnection(env, prefix, parts, label, portOverride) {
  const dataSource = parts.datasource || parts.server || parts.addr || parts.address;
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

  const { host, instanceName, port } = parseDataSource(dataSource);

  // El puerto explicito gana siempre: es la salida cuando SQL Browser esta
  // parado y la instancia nombrada no se puede resolver. tedious no admite
  // puerto e instancia a la vez, asi que al fijar puerto se descarta la instancia.
  const finalPort = portOverride || port;
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
 *   { "server": "PC\\INST", "database": "BD", "user": "sa", "password": "x" }
 * Multi-BD (la clave es el dbKey):
 *   { "connections": { "config": { ... }, "data": { ... } } }
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

  const toEntry = (alias, raw) => {
    const label = alias || "credenciales";
    if (!raw || typeof raw !== "object") {
      throw new Error(`[${label}] entrada no valida en ${filePath}`);
    }
    const server = raw.port ? `${raw.server},${raw.port}` : raw.server;
    return {
      alias,
      parts: partsFromFlags({
        server,
        database: raw.database,
        user: raw.user,
        password: raw.password,
        encrypt: raw.encrypt === undefined ? undefined : String(raw.encrypt),
        trustServerCertificate:
          raw.trustServerCertificate === undefined
            ? undefined
            : String(raw.trustServerCertificate),
      }),
    };
  };

  if (json.connections && typeof json.connections === "object") {
    const aliases = Object.keys(json.connections);
    if (aliases.length === 0) {
      throw new Error(`${filePath} no declara ninguna conexion dentro de "connections".`);
    }
    return aliases.map((alias) => toEntry(alias, json.connections[alias]));
  }
  return [toEntry(undefined, json)];
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
  if (args.production && args.allowWrites) {
    console.error(
      "--production y --allow-writes son incompatibles.\n" +
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
  let credentialsInArgv = false;

  try {
    if (source.kind === "env") {
      resolved.push(...describeEnvConnections(env));
    } else {
      const multi = source.entries.length > 1;
      const configFile =
        source.kind === "configFile" ? resolveConfigFile(args.configFile) : null;

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
        const parts =
          source.kind === "credentialsFile"
            ? entry.parts
            : source.kind === "flags"
              ? partsFromFlags(args)
              : parseAdoConnectionString(connString);
        const info = applyConnection(env, prefix, parts, label, args.port);
        resolved.push({ key: multi ? alias.toLowerCase() : "maindb", ...info });
      });
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Explicito siempre, en los dos sentidos. Nunca sin definir.
  env.MSSQL_ENABLE_WRITES = args.allowWrites ? "true" : "false";

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

  const mode = args.allowWrites ? "LECTURA-ESCRITURA" : "SOLO LECTURA";
  const origin = {
    configFile: `${args.configFile} (entorno ${resolveEnvironment(args.environment)})`,
    connectionString: "--connection-string",
    flags: "--server/--database/--user/--password",
    env: "MSSQL_* del entorno del cliente MCP (--from-env)",
    credentialsFile: `${args.credentialsFile} (credenciales fuera del repositorio)`,
  }[source.kind];

  console.error("─".repeat(64));
  console.error(
    `AHORA-SQL-MCP — modo ${mode}${args.production ? "  ·  PRODUCCION" : ""}`
  );
  console.error(`  Conexion desde: ${origin}`);
  for (const r of resolved) {
    console.error(`  [${r.key}] ${r.target} / ${r.database}`);
  }
  // La carpeta del proyecto depende de donde se arranque el servidor, asi que se
  // imprime: es la unica forma de ver de un vistazo que raiz esta en vigor.
  console.error(`  SQL desde: ${fs.realpathSync(process.cwd())} (carpeta del proyecto)`);
  for (const dir of resolvedSqlDirs) {
    console.error(`             ${dir} (--allow-sql-dir)`);
  }
  if (resolved.some((r) => r.viaInstance)) {
    console.error(
      "  Resolucion por instancia nombrada: requiere el servicio SQL Browser activo.\n" +
        "  Si esta parado, indica el puerto con --port."
    );
  }
  if (credentialsInArgv) {
    console.error(
      "  AVISO: la contrasena viaja en la linea de comandos, asi que queda en el\n" +
        "  .mcp.json y en el listado de procesos. Para evitarlo, usa --from-env."
    );
  }
  if (args.allowWrites) {
    console.error("  AVISO: escrituras y DDL habilitados. Solo para local o pruebas.");
  }
  console.error("─".repeat(64));

  const entry = path.join(__dirname, "..", "src", "index.js");
  const child = spawn(process.execPath, [entry], { env, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  parseAdoConnectionString,
  normalizeAdoKey,
  parseDataSource,
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
