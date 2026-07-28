#!/usr/bin/env node
/**
 * Wrapper de arranque de AHORA-SQL-MCP.
 *
 * Lee la cadena de conexion desde el Web.config (.NET Framework) o
 * appsettings.json (.NET Core) del proyecto, para no duplicar credenciales en la
 * configuracion de cada MCP. Reutilizable entre proyectos: solo cambian
 * --config-file y --connection-name.
 *
 * Uso (una sola base de datos):
 *   node bin/start-mssql-mcp.js --config-file C:\repo\Web.config \
 *                              --connection-name DataConnectionString
 *
 * Uso (Flexygo, configuracion + datos):
 *   node bin/start-mssql-mcp.js --config-file C:\repo\Web.config \
 *                              --connection-name ConfigDatabaseName:config \
 *                              --connection-name DataConnectionString:data
 *
 * Escritura (solo local o pruebas):
 *   ... --allow-writes
 *
 * POLITICA: sin --allow-writes el servidor arranca en SOLO LECTURA. La variable
 * MSSQL_ENABLE_WRITES se exporta SIEMPRE de forma explicita (true o false), nunca
 * se deja sin definir, para que nada del entorno pueda activarla por accidente.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function parseArgs(argv) {
  const out = { connections: [], allowWrites: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config-file") out.configFile = argv[++i];
    else if (argv[i] === "--connection-name") out.connections.push(argv[++i]);
    else if (argv[i] === "--allow-writes") out.allowWrites = true;
    else if (argv[i] === "--port") out.port = argv[++i];
    else {
      console.error(`Argumento no reconocido: ${argv[i]}`);
      process.exit(1);
    }
  }
  return out;
}

function parseAdoConnectionString(connString) {
  const parts = {};
  for (const piece of connString.split(";")) {
    if (!piece.trim()) continue;
    const idx = piece.indexOf("=");
    if (idx === -1) continue;
    parts[piece.slice(0, idx).trim().toLowerCase()] = piece.slice(idx + 1).trim();
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

function getConnStringFromWebConfig(filePath, name) {
  const xml = fs.readFileSync(filePath, "utf8");
  for (const tag of xml.match(/<add\b[^>]*\/>/g) || []) {
    const nameMatch = tag.match(/\bname\s*=\s*"([^"]*)"/);
    if (!nameMatch || nameMatch[1] !== name) continue;
    const connMatch = tag.match(/\bconnectionString\s*=\s*"([^"]*)"/);
    if (connMatch) return decodeXmlEntities(connMatch[1]);
  }
  throw new Error(`No se encontro la cadena de conexion '${name}' en ${filePath}`);
}

function getConnStringFromAppSettings(filePath, name) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const value = json.ConnectionStrings && json.ConnectionStrings[name];
  if (!value) {
    throw new Error(
      `No se encontro la cadena de conexion '${name}' en ${filePath} (seccion ConnectionStrings)`
    );
  }
  return value;
}

function readConnString(configFile, name) {
  const ext = path.extname(configFile).toLowerCase();
  if (ext === ".config") return getConnStringFromWebConfig(configFile, name);
  if (ext === ".json") return getConnStringFromAppSettings(configFile, name);
  throw new Error(`Extension no soportada '${ext}'. Usa un Web.config o appsettings.json.`);
}

/**
 * Entorno limpio: se eliminan TODAS las MSSQL_* heredadas de la maquina.
 *
 * Motivo: el servidor decide entre modo simple y multi-BD escaneando variables
 * que encajen con MSSQL_<NOMBRE>_DATABASE. Una variable residual de otra
 * herramienta (por ejemplo de la epoca de la extension MSSQL de VS Code) podria
 * cambiar el modo o inyectar una conexion que nadie ha pedido.
 */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith("MSSQL_")) env[k] = v;
  }
  return env;
}

/**
 * Descompone el "Data Source" de una cadena ADO.NET.
 *
 * Formatos admitidos: HOST, HOST\INSTANCIA, HOST,PUERTO, (local), . y el
 * prefijo de protocolo tcp:. La instancia nombrada es lo habitual en los
 * SQL Server locales de desarrollo (por ejemplo PC_158\PC_158).
 */
function parseDataSource(raw) {
  let s = String(raw).trim().replace(/^(tcp|np|lpc):/i, "");
  let port;
  let instanceName;

  const commaIdx = s.lastIndexOf(",");
  if (commaIdx > -1) {
    port = s.slice(commaIdx + 1).trim();
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
  const dataSource = parts["data source"] || parts["server"];
  const database = parts["initial catalog"] || parts["database"];
  const user = parts["user id"] || parts["uid"];
  const password = parts["password"] || parts["pwd"];

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
  if (parts["encrypt"]) env[`${prefix}ENCRYPT`] = parts["encrypt"].toLowerCase();
  if (parts["trustservercertificate"]) {
    env[`${prefix}TRUST_SERVER_CERTIFICATE`] = parts["trustservercertificate"].toLowerCase();
  }

  return {
    target:
      host +
      (finalPort ? `,${finalPort}` : instanceName ? `\\${instanceName}` : ""),
    database,
    viaInstance: Boolean(!finalPort && instanceName),
  };
}

function main() {
  const { configFile, connections, allowWrites, port } = parseArgs(process.argv.slice(2));

  if (!configFile || connections.length === 0) {
    console.error(
      "Faltan argumentos. Uso:\n" +
        "  --config-file <ruta a Web.config o appsettings.json>\n" +
        "  --connection-name <NombreConexion[:alias]>   (repetible para multi-BD)\n" +
        "  --port <puerto>                              (opcional; salida si SQL Browser esta parado)\n" +
        "  --allow-writes                               (opcional, solo local o pruebas)"
    );
    process.exit(1);
  }
  if (!fs.existsSync(configFile)) {
    console.error(`No existe el archivo de configuracion: ${configFile}`);
    process.exit(1);
  }

  const env = cleanEnv();
  const multi = connections.length > 1;
  const resolved = [];

  try {
    for (const entry of connections) {
      const [name, alias] = entry.split(":");
      if (!name) throw new Error(`--connection-name vacio en '${entry}'`);
      if (multi && !alias) {
        throw new Error(
          `Con varias conexiones cada una necesita alias: --connection-name ${name}:<alias>`
        );
      }
      const prefix = multi ? `MSSQL_${alias.toUpperCase()}_` : "MSSQL_";
      const parts = parseAdoConnectionString(readConnString(configFile, name));
      const info = applyConnection(env, prefix, parts, alias || name, port);
      resolved.push({ key: multi ? alias.toLowerCase() : "maindb", ...info });
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Explicito siempre, en los dos sentidos. Nunca sin definir.
  env.MSSQL_ENABLE_WRITES = allowWrites ? "true" : "false";

  const mode = allowWrites ? "LECTURA-ESCRITURA" : "SOLO LECTURA";
  console.error("─".repeat(64));
  console.error(`AHORA-SQL-MCP — modo ${mode}`);
  for (const r of resolved) {
    console.error(`  [${r.key}] ${r.target} / ${r.database}`);
  }
  if (resolved.some((r) => r.viaInstance)) {
    console.error(
      "  Resolucion por instancia nombrada: requiere el servicio SQL Browser activo.\n" +
        "  Si esta parado, indica el puerto con --port."
    );
  }
  if (allowWrites) {
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
  parseDataSource,
  cleanEnv,
  applyConnection,
};
