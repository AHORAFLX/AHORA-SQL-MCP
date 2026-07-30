/**
 * Fichero de credenciales, fuera del repositorio.
 *
 * Lo usan los dos frontales del instalador (terminal y formulario) para el caso en
 * que no hay Web.config ni appsettings.json: el .mcp.json se commitea, asi que las
 * credenciales no pueden vivir ahi. Solo su ruta.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/** %APPDATA%\ahora-sql-mcp\<proyecto>.json (o ~/.config en el resto de plataformas). */
function credentialsPathFor(projectDir) {
  const base =
    process.platform === "win32"
      ? path.join(process.env.APPDATA || os.homedir(), "ahora-sql-mcp")
      : path.join(
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
          "ahora-sql-mcp"
        );
  const name = path.basename(path.resolve(projectDir)).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(base, `${name || "proyecto"}.json`);
}

function writeCredentialsFile(projectDir, connections) {
  const target = credentialsPathFor(projectDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const one = (c) => ({
    server: c.server,
    database: c.database,
    user: c.user,
    password: c.password,
    ...(c.port ? { port: c.port } : {}),
  });
  const doc =
    connections.length === 1 && !connections[0].alias
      ? one(connections[0])
      : {
          connections: Object.fromEntries(
            connections.map((c) => [c.alias || "maindb", one(c)])
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
