#!/usr/bin/env node
/**
 * Lanzador del MCP de desarrollo de producto (`ahora-mcp`).
 *
 * El servidor lo publica otro equipo y se configura con UNA variable de entorno,
 * `AHORA_MCP_ERP`, con la cadena de conexion completa del ERP. Comprobado contra el
 * binario: con ella presente arranca sin abrir su dialogo de login
 * ("AHORA_MCP_ERP environment variable present - skipping login dialog") y responde
 * el `initialize` de MCP por stdio con sus 98 herramientas.
 *
 * POR QUE HACE FALTA ESTE ENVOLTORIO
 *
 * La alternativa es escribir la cadena tal cual en el bloque `env` de la entrada del
 * .mcp.json. Ese fichero se commitea: la contrasena del ERP acabaria en el
 * repositorio. Todo lo demas de este proyecto existe para evitar justo eso, asi que
 * aqui se hace igual que con el servidor de SQL — la configuracion guarda de donde
 * SACAR la cadena, no la cadena — y la resolucion ocurre en cada arranque:
 *
 *   a) del Web.config / appsettings.json del proyecto, que es la fuente que ya usa
 *      la aplicacion y no hay que mantener por duplicado
 *   b) del fichero de credenciales de %APPDATA%, cifrado con la cuenta de Windows,
 *      para las carpetas sin fichero de configuracion
 *
 * UNA SOLA BASE DE DATOS, Y NO ES UNA LIMITACION DE AQUI
 *
 * `ahora-mcp` maneja una conexion por proceso: su herramienta `ahora_connect` solo
 * acepta servidor y base de datos con autenticacion Windows, y no hay ningun
 * concepto de alias ni de multi-BD como el `dbKey` del servidor de SQL. Por eso este
 * lanzador resuelve exactamente una y falla si se le piden varias, en lugar de
 * elegir por su cuenta.
 *
 * Uso:
 *   start-ahora-mcp --server-dll <ruta a ahora-mcp.dll>
 *     --config-file <Web.config|appsettings.json> --connection-name <Nombre>
 *     [--environment <entorno>]
 *
 *   start-ahora-mcp --server-dll <ruta a ahora-mcp.dll>
 *     --credentials-file <ruta a un JSON> [--db <alias>]
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const {
  resolveConfigFile,
  readConnString,
  readCredentialsFile,
  parseAdoConnectionString,
  parseDataSource,
  resolveEnvironment,
  listConnectionNames,
} = require("./start-mssql-mcp");
const { reveal } = require("../src/secrets");

const USAGE =
  "Uso — hace falta el servidor y UNA fuente de conexion:\n" +
  "  --server-dll <ruta>            ahora-mcp.dll publicado (se lanza con `dotnet exec`)\n" +
  "  --server-exe <ruta>            alternativa: el ejecutable, si la publicacion trae apphost\n" +
  "\n" +
  "  a) --config-file <Web.config | appsettings.json | carpeta>\n" +
  "     --connection-name <NombreConexion>\n" +
  "     [--environment <nombre>]    entorno de appsettings.<entorno>.json\n" +
  "  b) --credentials-file <ruta a un JSON>   (credenciales cifradas, fuera del repositorio)\n" +
  "     [--db <alias>]              cual de las conexiones del fichero, si trae varias\n" +
  "\n" +
  "Opcionales:\n" +
  "  --production                   marca la conexion como produccion (solo aviso: este\n" +
  "                                 servidor no tiene modo de solo lectura)";

function parseArgs(argv) {
  const out = { production: false };
  const takes = {
    "--server-dll": "serverDll",
    "--server-exe": "serverExe",
    "--config-file": "configFile",
    "--connection-name": "connectionName",
    "--environment": "environment",
    "--credentials-file": "credentialsFile",
    "--db": "db",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--production") {
      out.production = true;
      continue;
    }
    const key = takes[flag];
    if (!key) throw new Error(`Argumento no reconocido: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} necesita un valor.`);
    }
    // Repetir un argumento aqui casi siempre es haber copiado una configuracion de
    // multi-BD del servidor de SQL, donde --connection-name SI es repetible. Avisar
    // es mejor que quedarse en silencio con el ultimo y conectar a otra base de datos.
    if (out[key] !== undefined) {
      throw new Error(
        `${flag} solo puede aparecer una vez: el MCP de producto maneja una sola base ` +
          "de datos por proceso. Para exponer otra, registra otro servidor MCP."
      );
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

/**
 * Valor de una cadena ADO.NET, entrecomillado si lo necesita.
 *
 * Una contrasena con `;` parte la cadena en dos y el error que sale no menciona la
 * contrasena por ningun lado: SqlClient se queja de una palabra clave desconocida.
 * La regla de ADO.NET es entrecomillar con comillas dobles y duplicar las de dentro.
 */
function quoteAdoValue(value) {
  const s = String(value);
  if (!/[;"'=\s]/.test(s)) return s;
  return `"${s.split('"').join('""')}"`;
}

/**
 * Cadena de conexion para SqlClient a partir de las `parts` ya normalizadas.
 *
 * El cifrado sigue la MISMA politica que el servidor de SQL de este repositorio (ver
 * src/config.js): `Encrypt` desactivado salvo que la fuente diga lo contrario, y
 * `TrustServerCertificate` activo salvo que la fuente diga lo contrario. No es una
 * decision nueva: es la que ya rige para las mismas bases de datos, y cambiarla aqui
 * haria que una conexion que funciona con `ahora-sql` fallara con `ahora-erp`.
 *
 * SqlClient 6 y posteriores traen `Encrypt=True` por defecto, asi que omitirlo NO es
 * neutral: contra un servidor interno con certificado autofirmado —lo normal en las
 * instalaciones de AHORA— la conexion se cae con un error de cadena de confianza.
 */
function buildErpConnectionString(parts, label) {
  const dataSource =
    parts.datasource || parts.server || parts.addr || parts.address || parts.networkaddress;
  const database = parts.initialcatalog || parts.database;
  const user = parts.userid || parts.uid || parts.user;
  const password = parts.password || parts.pwd;

  if (!dataSource) throw new Error(`[${label}] No se pudo determinar el servidor.`);
  if (!database) throw new Error(`[${label}] No se pudo determinar la base de datos.`);
  if (!user || !password) {
    throw new Error(
      `[${label}] La cadena de conexion no lleva usuario y contrasena. El MCP de ` +
        "producto admite autenticacion de Windows, pero solo por su dialogo de login, " +
        "que no puede salir cuando lo arranca un cliente MCP."
    );
  }

  const { host, instanceName, port } = parseDataSource(dataSource);
  if (!host) throw new Error(`[${label}] No se pudo interpretar el servidor '${dataSource}'.`);

  const finalPort = port || parts.port;
  const target = host + (finalPort ? `,${finalPort}` : instanceName ? `\\${instanceName}` : "");

  const encrypt = (parts.encrypt || "").toLowerCase() === "true";
  const trust = (parts.trustservercertificate || "").toLowerCase() !== "false";

  const connString = [
    `Data Source=${quoteAdoValue(target)}`,
    `Initial Catalog=${quoteAdoValue(database)}`,
    `User ID=${quoteAdoValue(user)}`,
    `Password=${quoteAdoValue(password)}`,
    `Encrypt=${encrypt ? "True" : "False"}`,
    `TrustServerCertificate=${trust ? "True" : "False"}`,
  ].join(";");

  return { connString, target, database };
}

/**
 * Las `parts` de la unica conexion a exponer, con la contrasena ya en claro.
 *
 * Descifrar aqui, y no mas adelante, no cuesta un arranque de proceso de mas: el
 * servidor de producto no entiende el token cifrado, asi que alguien tiene que
 * abrirlo y este es el unico punto donde se puede.
 */
function resolveConnection(args) {
  const sources = [
    args.configFile && "--config-file",
    args.credentialsFile && "--credentials-file",
  ].filter(Boolean);

  if (sources.length === 0) return null;
  if (sources.length > 1) {
    throw new Error(`Elige una sola fuente de conexion. Se han indicado: ${sources.join(", ")}.`);
  }

  if (args.credentialsFile) {
    const entries = readCredentialsFile(args.credentialsFile);
    let entry;
    if (entries.length === 1) {
      entry = entries[0];
      if (args.db && entry.alias && entry.alias.toLowerCase() !== args.db.toLowerCase()) {
        throw new Error(
          `--db '${args.db}' no coincide con la unica conexion del fichero ('${entry.alias}').`
        );
      }
    } else {
      const aliases = entries.map((e) => e.alias).filter(Boolean);
      if (!args.db) {
        throw new Error(
          `${args.credentialsFile} declara varias conexiones (${aliases.join(", ")}) y el MCP ` +
            "de producto solo maneja una. Indica cual con --db <alias>."
        );
      }
      entry = entries.find(
        (e) => (e.alias || "").toLowerCase() === String(args.db).toLowerCase()
      );
      if (!entry) {
        throw new Error(
          `--db '${args.db}' no existe en ${args.credentialsFile}. Disponibles: ${aliases.join(", ")}.`
        );
      }
    }
    const label = entry.alias || "credenciales";
    const parts = { ...entry.parts };
    if (parts.password) parts.password = reveal(parts.password);
    return { parts, label, origin: `${args.credentialsFile} (credenciales cifradas)` };
  }

  const configFile = resolveConfigFile(args.configFile);
  if (!args.connectionName) {
    const names = listConnectionNames(configFile, { environment: args.environment });
    throw new Error(
      "Falta --connection-name." +
        (names.length > 0 ? ` Disponibles en ${configFile}: ${names.join(", ")}.` : "")
    );
  }
  const { value, source } = readConnString(configFile, args.connectionName, {
    environment: args.environment,
  });
  return {
    parts: parseAdoConnectionString(value),
    label: args.connectionName,
    origin: `${configFile} (${path.basename(source)}, entorno ${resolveEnvironment(args.environment)})`,
  };
}

/**
 * Entorno del proceso hijo, sin nada del ERP heredado de la maquina.
 *
 * Mismo motivo que el `cleanEnv` del servidor de SQL: si alguien tiene un
 * `AHORA_MCP_ERP` puesto en su perfil de Windows —apuntando, por ejemplo, a la base
 * de datos de un cliente— y aqui se dejara pasar, mandaria el suyo o el nuestro
 * segun el orden de asignacion, sin que nada lo dijera. Se retira siempre y se pone
 * el que toca de forma explicita.
 *
 * `AHORA_MCP_ERP_PID` y `AHORA_MCP_TOKEN` son las otras dos vias por las que ese
 * servidor toma credenciales (la tuberia con el ERP en marcha): tampoco pueden
 * llegar del entorno de quien arranca el cliente MCP.
 */
function cleanEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^AHORA_MCP_/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Como se lanza el servidor: el .dll con `dotnet exec`, o el .exe si lo hay. */
function serverCommand(args) {
  if (args.serverExe) {
    if (!fs.existsSync(args.serverExe)) {
      throw new Error(`No existe el ejecutable del MCP de producto: ${args.serverExe}`);
    }
    return { command: args.serverExe, args: [] };
  }
  if (!args.serverDll) {
    throw new Error("Falta --server-dll (o --server-exe): sin el no hay servidor que lanzar.");
  }
  if (!fs.existsSync(args.serverDll)) {
    throw new Error(
      `No existe ${args.serverDll}. Vuelve a lanzar el instalador para publicar el MCP ` +
        "de producto."
    );
  }
  // `dotnet exec` y no `dotnet <dll>`: es la forma que documenta el propio paquete en
  // su buildTransitive/ahora-mcp.targets, y la que se ha comprobado equivalente al exe.
  return { command: "dotnet", args: ["exec", args.serverDll] };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(1);
  }

  let connection;
  let launcher;
  try {
    connection = resolveConnection(args);
    if (!connection) {
      console.error(`Faltan argumentos.\n\n${USAGE}`);
      process.exit(1);
    }
    launcher = serverCommand(args);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let erp;
  try {
    erp = buildErpConnectionString(connection.parts, connection.label);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const env = cleanEnv();
  env.AHORA_MCP_ERP = erp.connString;

  console.error("─".repeat(64));
  console.error(`AHORA-ERP-MCP — MCP de desarrollo de producto${args.production ? "  ·  PRODUCCION" : ""}`);
  console.error(`  Conexion desde: ${connection.origin}`);
  console.error(`  [${connection.label}] ${erp.target} / ${erp.database}`);
  // No hay modo de solo lectura que imponer: este servidor trae ahora_ejecutar_dml y
  // toda la familia ahora_crear_*/ahora_modificar_*/ahora_borrar_*, y no acepta
  // ningun conmutador para desactivarlas. Decirlo es lo unico que se puede hacer.
  console.error(
    "  AVISO: este servidor SIEMPRE puede escribir (ahora_ejecutar_dml, ahora_crear_*,\n" +
      "  ahora_modificar_*, ahora_borrar_*). No tiene modo de solo lectura."
  );
  if (args.production) {
    console.error(
      "  Y esta apuntando a PRODUCCION. Cada cambio va contra el ERP en vivo."
    );
  }
  console.error("─".repeat(64));

  const child = spawn(launcher.command, launcher.args, { env, stdio: "inherit" });
  child.on("error", (err) => {
    console.error(
      `No se ha podido lanzar el MCP de producto: ${err.message}` +
        (launcher.command === "dotnet"
          ? "\nComprueba que el runtime de .NET este instalado y en el PATH."
          : "")
    );
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`El MCP de producto ha terminado por la senal ${signal}.`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  quoteAdoValue,
  buildErpConnectionString,
  resolveConnection,
  cleanEnv,
  serverCommand,
  USAGE,
};
