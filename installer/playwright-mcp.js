/**
 * Instalacion del MCP de automatizacion de navegador (`@playwright/mcp`).
 *
 * Es un servidor de Microsoft, publicado en npm. Aqui no se compila ni se mantiene:
 * solo se deja instalado y registrado al lado de `ahora-sql`, igual que se hace con el
 * MCP de producto. Sirve para lo que a este equipo se le queda fuera del alcance del
 * SQL: abrir la pantalla del ERP y COMPROBAR que el cambio de configuracion que se
 * acaba de escribir en la base de datos se ve como toca.
 *
 * POR QUE SE INSTALA EN LUGAR DE ESCRIBIR `npx @playwright/mcp@latest`
 *
 * Esa es la forma que documenta Microsoft, y es la que este instalador ya se quito de
 * encima para su propio servidor por una razon medida (ver installer/runtime.js): npx
 * resuelve el paquete en CADA arranque del MCP, el cliente corta a los 30 segundos y
 * al agotarse descarta el servidor entero, asi que sus herramientas no aparecen y el
 * sintoma que llega es "el MCP va inestable". Instalado una vez, la configuracion
 * apunta a un `cli.js` en disco y el arranque no depende de la red.
 *
 * POR QUE NO SE BAJAN LOS NAVEGADORES DE PLAYWRIGHT
 *
 * `@playwright/mcp` son 3 paquetes y ~3 segundos, pero el `postinstall` de `playwright`
 * baja ademas Chromium, Firefox y WebKit: del orden de medio giga desde el CDN de
 * Playwright. En una formacion, o en una red donde ese CDN esta cortado, eso es la
 * diferencia entre que el instalador termine y que no.
 *
 * No hace falta: `--browser chrome|msedge` hace que Playwright conduzca el navegador
 * que YA esta en la maquina, y en Windows 11 Edge esta siempre. Asi que la instalacion
 * va con `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` y el navegador se elige entre los que
 * hay. Solo si no hay ninguno de los dos —fuera de Windows, basicamente— se baja
 * Chromium, y entonces se baja SOLO Chromium y con su propio aviso, no las tres
 * familias por sorpresa dentro de un `npm install`.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { npmCommand } = require("./runtime");

const PLAYWRIGHT_PACKAGE = "@playwright/mcp";

/** Lo que se instala si no se pide otra cosa: la ultima publicada en npm. */
const PLAYWRIGHT_SPEC = `${PLAYWRIGHT_PACKAGE}@latest`;

/**
 * Carpeta estable donde queda instalado.
 *
 * HERMANA de las otras dos, por lo mismo que documenta installer/product-mcp.js:
 * colgarla de `%LOCALAPPDATA%\\AHORA-SQL-MCP` haria que desinstalar el MCP de SQL
 * borrando su carpeta —que es el gesto natural— se llevara por delante este, dejando
 * la entrada del .mcp.json apuntando a un cli.js inexistente.
 */
function playwrightRuntimeDir({ platform = process.platform, env = process.env, home } = {}) {
  const homeDir = home || os.homedir();
  if (platform === "win32") {
    return path.join(
      env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"),
      "playwright-mcp"
    );
  }
  return path.join(
    env.XDG_DATA_HOME || path.join(homeDir, ".local", "share"),
    "playwright-mcp"
  );
}

/** El script que arranca el servidor dentro de la instalacion. */
function playwrightEntry(dir) {
  return path.join(dir, "node_modules", "@playwright", "mcp", "cli.js");
}

/** El CLI de Playwright, que es quien sabe bajar navegadores. */
function playwrightCli(dir) {
  return path.join(dir, "node_modules", "playwright", "cli.js");
}

function installedPlaywrightVersion(dir) {
  try {
    const manifest = path.join(dir, "node_modules", "@playwright", "mcp", "package.json");
    const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version || null;
    return fs.existsSync(playwrightEntry(dir)) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Rutas donde Windows deja Chrome y Edge.
 *
 * Se miran los ficheros y no el PATH: ninguno de los dos se anade al PATH al
 * instalarse, asi que `where chrome` no encuentra un Chrome que si esta.
 */
function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return [
      { channel: "chrome", file: path.join(pf, "Google", "Chrome", "Application", "chrome.exe") },
      { channel: "chrome", file: path.join(pf86, "Google", "Chrome", "Application", "chrome.exe") },
      { channel: "chrome", file: path.join(local, "Google", "Chrome", "Application", "chrome.exe") },
      { channel: "msedge", file: path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe") },
      { channel: "msedge", file: path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe") },
    ];
  }
  if (platform === "darwin") {
    return [
      {
        channel: "chrome",
        file: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      {
        channel: "msedge",
        file: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      },
    ];
  }
  return [
    { channel: "chrome", file: "/usr/bin/google-chrome" },
    { channel: "chrome", file: "/opt/google/chrome/chrome" },
    { channel: "msedge", file: "/usr/bin/microsoft-edge" },
  ];
}

/**
 * El canal de navegador que se le va a pedir a Playwright, o null si no hay ninguno.
 *
 * Chrome antes que Edge porque es el que suele tener el desarrollador abierto y con
 * sus extensiones; Edge es la red de seguridad, que en Windows 11 esta siempre.
 * `null` significa "no hay navegador del sistema", y es lo que dispara la descarga de
 * Chromium.
 */
function detectBrowserChannel({
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
} = {}) {
  for (const { channel, file } of browserCandidates({ platform, env })) {
    if (exists(file)) return channel;
  }
  return null;
}

/**
 * Baja SOLO Chromium, para el caso en el que no hay navegador del sistema.
 *
 * Aparte de la instalacion del paquete a proposito: es la parte lenta y la que puede
 * no llegar, y quien la dispara tiene que poder verla fallar por si misma en lugar de
 * dentro de un `npm install` que parecia ir de otra cosa.
 */
function installChromium({ dir = playwrightRuntimeDir(), exec = execFileSync } = {}) {
  const cli = playwrightCli(dir);
  if (!fs.existsSync(cli)) {
    throw new Error(
      `No aparece ${cli}: el paquete ${PLAYWRIGHT_PACKAGE} no ha quedado instalado del todo.`
    );
  }
  // `chromium` entero y no `--only-shell`: el servidor arranca en modo headed por
  // defecto —que es lo que interesa para mirar una pantalla del ERP— y el shell sin
  // interfaz no sirve para eso.
  exec(process.execPath, [cli, "install", "chromium"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 900000,
  });
}

/**
 * Instala el MCP de Playwright y devuelve con que arrancarlo.
 *
 * Siempre se intenta traer la ultima: son 3 paquetes y unos segundos, y fijar una
 * version de un paquete que no es nuestro solo consigue quedarse atras. Pero si la
 * red no llega y ya hay una instalada, se reutiliza esa en lugar de dejar al
 * instalador sin poder terminar — mismo criterio que con el feed del MCP de producto.
 */
function installPlaywrightMcp({
  spec = PLAYWRIGHT_SPEC,
  dir = playwrightRuntimeDir(),
  exec = execFileSync,
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
  channel,
  force = false,
} = {}) {
  const entry = playwrightEntry(dir);
  const previa = installedPlaywrightVersion(dir);

  // La version pedida, cuando el spec la fija. `latest` no lo es: eso es "la que haya
  // ahora en npm", y solo npm sabe cual es.
  const pedida = spec.startsWith(`${PLAYWRIGHT_PACKAGE}@`)
    ? spec.slice(PLAYWRIGHT_PACKAGE.length + 1)
    : null;

  let reused = false;
  let offline = null;
  if (!force && previa && pedida && pedida === previa) {
    // Se ha pedido una version concreta y es exactamente la que hay: no hay nada que
    // resolver, y llamar a npm solo anadiria una espera y una dependencia de la red.
    reused = true;
  } else {
    fs.mkdirSync(dir, { recursive: true });
    // npm necesita un package.json en la carpeta: sin el sube buscando uno y puede
    // acabar instalando en un directorio padre que no es el nuestro.
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) {
      fs.writeFileSync(
        manifest,
        `${JSON.stringify({ name: "playwright-mcp-runtime", version: "0.0.0", private: true }, null, 2)}\n`,
        "utf8"
      );
    }
    try {
      exec(
        npmCommand(platform),
        ["install", "--no-audit", "--no-fund", "--loglevel=error", spec],
        {
          // Por `cwd` y no por `--prefix`, y con `shell` solo en Windows, por lo que
          // documenta installer/runtime.js: npm ahi es un .cmd que Node no lanza sin
          // shell, y con shell una ruta con espacios se partiria si viajara en la
          // linea de comandos.
          cwd: dir,
          shell: platform === "win32",
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 600000,
          // Los navegadores no se bajan aqui: ver la cabecera del fichero.
          env: { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
        }
      );
    } catch (err) {
      if (!previa || !fs.existsSync(entry)) throw err;
      // La instalada sigue sirviendo: quedarse sin MCP por no poder comprobar si hay
      // una version mas nueva seria cambiar un problema de red por uno de verdad.
      reused = true;
      offline = err.message.split("\n")[0];
    }
  }

  if (!fs.existsSync(entry)) {
    throw new Error(
      `La instalacion termino sin errores pero no aparece ${entry}. ` +
        `Revisa que el paquete se llame ${PLAYWRIGHT_PACKAGE}.`
    );
  }

  const canal = channel === undefined ? detectBrowserChannel({ platform, env, exists }) : channel;
  // Sin navegador del sistema no hay `--browser` que escribir, y Playwright arrancaria
  // pidiendo un Chromium que nadie ha bajado. Ese es el unico caso en el que se baja.
  let chromium = false;
  if (!canal) {
    installChromium({ dir, exec });
    chromium = true;
  }

  return {
    entry,
    dir,
    version: installedPlaywrightVersion(dir),
    channel: canal,
    chromium,
    reused,
    offline,
  };
}

module.exports = {
  PLAYWRIGHT_PACKAGE,
  PLAYWRIGHT_SPEC,
  playwrightRuntimeDir,
  playwrightEntry,
  playwrightCli,
  installedPlaywrightVersion,
  browserCandidates,
  detectBrowserChannel,
  installChromium,
  installPlaywrightMcp,
};
