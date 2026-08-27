/**
 * Fichero de credenciales, fuera del repositorio.
 *
 * Lo usan los dos frontales del instalador (terminal y formulario) para el caso en
 * que no hay Web.config ni appsettings.json: el .mcp.json se commitea, asi que las
 * credenciales no pueden vivir ahi. Solo su ruta.
 *
 * La contrasena NO se escribe en claro: va cifrada bajo la clave `passwordEnc` (ver
 * src/secrets.js). Una clave distinta y no la misma con otro contenido, porque asi
 * no hay que adivinar si lo que hay dentro esta cifrado o no: un fichero con
 * `password` es de una version anterior y se sigue leyendo, uno con `passwordEnc`
 * hay que descifrarlo.
 */
const fs = require("fs");
const path = require("path");

const { configDir, protectAll } = require("../src/secrets");

/** %APPDATA%\ahora-sql-mcp\<proyecto>.json (o ~/.config en el resto de plataformas). */
function credentialsPathFor(projectDir) {
  const name = path.basename(path.resolve(projectDir)).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(configDir(), `${name || "proyecto"}.json`);
}

function writeCredentialsFile(projectDir, connections, { warn = console.warn } = {}) {
  const target = credentialsPathFor(projectDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Todas las contrasenas en una sola pasada: cifrar cuesta un arranque de
  // PowerShell, y con la configuracion + los datos de Flexygo ya son dos.
  const encrypted = protectAll(
    connections.map((c) => c.password),
    {
      onFallback: (err) =>
        warn(
          "  Aviso: DPAPI de Windows no esta disponible " +
            `(${err.message}). Las credenciales se cifran con una clave local, ` +
            "que vive junto al fichero."
        ),
    }
  );

  const one = (c, i) => ({
    server: c.server,
    database: c.database,
    user: c.user,
    passwordEnc: encrypted[i],
    ...(c.port ? { port: c.port } : {}),
  });
  const doc =
    connections.length === 1 && !connections[0].alias
      ? one(connections[0], 0)
      : {
          connections: Object.fromEntries(
            connections.map((c, i) => [c.alias || "maindb", one(c, i)])
          ),
        };

  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // en Windows no aplica; el fichero queda igualmente fuera del repositorio
  }
  return target;
}

module.exports = { credentialsPathFor, writeCredentialsFile };
