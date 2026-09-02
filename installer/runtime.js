/**
 * Instalacion del servidor en la maquina, UNA vez, en lugar de resolverlo en cada
 * arranque.
 *
 * El motivo es medido, no estetico. La configuracion escribia `command: "npx"` con
 * `--package=github:AHORAFLX/AHORA-SQL-MCP#v<version>`, asi que cada arranque del MCP
 * resolvia el spec de git contra GitHub: ~48 segundos la primera vez con un pin de
 * version nuevo, y ~7 segundos en cada arranque posterior. El cliente MCP espera 30
 * segundos por defecto (MCP_TIMEOUT) y al agotarse descarta el servidor entero, asi
 * que sus tools no aparecen. En frio no llegaba nunca, y de ahi el sintoma que
 * reportaban los companeros: "las conexiones MCP estan inestables", justo despues de
 * reinstalar para coger el nombre nuevo — reinstalar estrena el pin, y el pin nuevo
 * estrena la cache de npx.
 *
 * Instalado una vez, la configuracion apunta a `node <ruta>/bundle/start-mssql-mcp.cjs` y
 * el arranque baja a 254-283 ms medidos, frente a los 95 s del spec `github:` en frio.
 * No cambia la promesa de INSTALAR.md: quien instala sigue sin clonar nada, lo hace el
 * instalador por el.
 *
 * La carpeta es por usuario y no necesita permisos de administrador, a diferencia de
 * `npm install --global`, que en muchos equipos del equipo pide elevacion.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/** `npm` no es un ejecutable en Windows, es un .cmd. */
function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Carpeta estable donde queda instalado el servidor.
 *
 * En Windows, `%LOCALAPPDATA%`: es por usuario, no se sincroniza con el perfil de
 * dominio —lo que si haria `%APPDATA%`, y no interesa mover node_modules por la red—
 * y no requiere elevacion.
 */
function runtimeDir({ platform = process.platform, env = process.env, home } = {}) {
  const homeDir = home || os.homedir();
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "AHORA-SQL-MCP");
  }
  return path.join(env.XDG_DATA_HOME || path.join(homeDir, ".local", "share"), "ahora-sql-mcp");
}

/**
 * El script que arranca el servidor dentro de la instalacion.
 *
 * Es `bundle/start-mssql-mcp.cjs` y no `bin/start-mssql-mcp.js`: el paquete publicado
 * solo lleva bundle/ (ver el campo `files` del package.json), porque asi su instalacion
 * no resuelve ningun arbol de dependencias. `bin/` es la fuente y no viaja, asi que
 * apuntar ahi escribiria un .mcp.json que no arranca.
 */
function entryPath(dir) {
  return path.join(
    dir,
    "node_modules",
    "@ahoraflx",
    "sql-mcp",
    "bundle",
    "start-mssql-mcp.cjs"
  );
}

/**
 * ¿Esta ya instalada esta version exacta?
 *
 * Se compara con la version del package.json instalado, no con la carpeta a secas: una
 * instalacion de una version anterior existe pero hay que renovarla.
 */
function installedVersion(dir) {
  try {
    const manifest = path.join(dir, "node_modules", "@ahoraflx", "sql-mcp", "package.json");
    return JSON.parse(fs.readFileSync(manifest, "utf8")).version || null;
  } catch {
    return null;
  }
}

/**
 * Instala el servidor en la carpeta estable y devuelve la ruta de su script.
 *
 * `--omit=dev` importa: sin el, npm se trae eslint, prettier y nodemon, que no hacen
 * falta para ejecutar y multiplican el tiempo de instalacion.
 */
function installRuntime({
  spec,
  version,
  dir = runtimeDir(),
  exec = execFileSync,
  platform = process.platform,
  force = false,
} = {}) {
  const entry = entryPath(dir);
  if (!force && version && installedVersion(dir) === version && fs.existsSync(entry)) {
    return { entry, dir, reused: true };
  }

  fs.mkdirSync(dir, { recursive: true });
  // npm necesita un package.json en el prefix: sin el sube buscando uno y puede acabar
  // instalando en una carpeta padre que no es la nuestra.
  const manifest = path.join(dir, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      `${JSON.stringify({ name: "ahora-sql-mcp-runtime", version: "0.0.0", private: true }, null, 2)}\n`,
      "utf8"
    );
  }

  exec(
    npmCommand(platform),
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error", spec],
    {
      // La carpeta va por `cwd`, no por `--prefix`, y no es un detalle de estilo: en
      // Windows npm es un .cmd, y Node se niega a lanzar un .cmd sin shell (EINVAL)
      // desde la correccion de CVE-2024-27980. Con shell, los argumentos se pegan sin
      // entrecomillar, asi que una ruta con espacios —`C:\Users\Juan Perez\...`, que es
      // la norma en cuanto el usuario de dominio lleva apellido— se partiria en dos.
      // Por `cwd` no pasa por la linea de comandos y el problema no existe.
      cwd: dir,
      shell: platform === "win32",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600000,
    }
  );

  if (!fs.existsSync(entry)) {
    throw new Error(
      `La instalacion termino sin errores pero no aparece ${entry}. ` +
        "Revisa que el paquete se llame @ahoraflx/sql-mcp."
    );
  }
  return { entry, dir, reused: false };
}

module.exports = {
  npmCommand,
  runtimeDir,
  entryPath,
  installedVersion,
  installRuntime,
};
