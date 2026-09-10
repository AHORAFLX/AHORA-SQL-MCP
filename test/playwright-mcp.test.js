/*
 * El MCP de navegador (`@playwright/mcp`) es la TERCERA entrada del mismo fichero.
 *
 * Lo que estos tests protegen son las tres cosas que se rompen calladas:
 *
 *   1. Que se anada AL LADO de `ahora-sql` y `ahora-erp`, no en su lugar. Una entrada
 *      que sustituye a otra deja al agente sin la mitad de sus herramientas sin dar
 *      ningun error.
 *   2. Que no se pise ni se retire un `playwright` configurado A MANO. El paquete no es
 *      nuestro y la forma que documenta Microsoft funciona: reemplazarla en silencio se
 *      lleva por delante los flags de quien la puso.
 *   3. Que las reglas de permisos separen mirar de tocar, y que `browser_evaluate` y
 *      `browser_run_code_unsafe` no entren en ninguna de las dos: una regla para ellas
 *      autoriza cualquier cosa que se pueda escribir en JavaScript.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  PLAYWRIGHT_PACKAGE,
  playwrightRuntimeDir,
  playwrightEntry,
  installedPlaywrightVersion,
  detectBrowserChannel,
  installPlaywrightMcp,
} = require("../installer/playwright-mcp");

const {
  buildPlaywrightFlags,
  playwrightCommand,
  writePlaywrightConfig,
  hasPlaywrightServer,
  writeClientConfig,
  CLIENTS,
  SERVER_NAME,
  PLAYWRIGHT_SERVER_NAME,
} = require("../installer/setup");

const {
  isPlaywrightEntry,
  isOurPlaywrightEntry,
} = require("../installer/server-name");

const {
  allowMcpTools,
  readRules,
  playwrightReadRules,
  playwrightActionRules,
} = require("../installer/permissions");

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Instalacion de mentira: los ficheros que se miran de verdad, y nada mas. */
function fakeInstall(dir, version = "0.0.80") {
  const pkg = path.join(dir, "node_modules", "@playwright", "mcp");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "cli.js"), "// falso\n", "utf8");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: PLAYWRIGHT_PACKAGE, version }),
    "utf8"
  );
  // El CLI de `playwright`, que llega como dependencia y es quien baja navegadores.
  const core = path.join(dir, "node_modules", "playwright");
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(path.join(core, "cli.js"), "// falso\n", "utf8");
  return dir;
}

// ── Donde se instala ─────────────────────────────────────────────────────────

test("el MCP de navegador se instala en LOCALAPPDATA, no en el proyecto", () => {
  const dir = playwrightRuntimeDir({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
  });
  assert.equal(dir, path.join("C:\\Users\\x\\AppData\\Local", "playwright-mcp"));
});

test("no cuelga de la carpeta del MCP de SQL", () => {
  // Desinstalar el MCP de SQL es borrar %LOCALAPPDATA%\AHORA-SQL-MCP. Si este colgara
  // de ahi, ese gesto se lo llevaria por delante y la entrada del .mcp.json quedaria
  // apuntando a un cli.js que ya no existe: un fallo que no aparece al desinstalar,
  // sino al abrir la sesion siguiente.
  const dir = playwrightRuntimeDir({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
  });
  assert.ok(!dir.includes("AHORA-SQL-MCP"));
});

test("installedPlaywrightVersion no da por instalada una carpeta sin cli.js", () => {
  const dir = tempDir("pw-");
  assert.equal(installedPlaywrightVersion(dir), null);

  const pkg = path.join(dir, "node_modules", "@playwright", "mcp");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.0.80" }), "utf8");
  assert.equal(installedPlaywrightVersion(dir), null, "sin cli.js no hay nada que arrancar");

  fakeInstall(dir, "0.0.80");
  assert.equal(installedPlaywrightVersion(dir), "0.0.80");
});

// ── Navegador ────────────────────────────────────────────────────────────────

test("se prefiere el Chrome del equipo y Edge es la red de seguridad", () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
  };
  const conChrome = (file) => file.endsWith("chrome.exe");
  const conEdge = (file) => file.endsWith("msedge.exe");

  assert.equal(detectBrowserChannel({ platform: "win32", env, exists: conChrome }), "chrome");
  assert.equal(detectBrowserChannel({ platform: "win32", env, exists: conEdge }), "msedge");
  assert.equal(
    detectBrowserChannel({ platform: "win32", env, exists: () => false }),
    null,
    "sin ninguno de los dos hay que bajar Chromium, y eso lo decide quien llama"
  );
});

test("sin canal no se escribe --browser, y con canal si", () => {
  // Sin el flag, Playwright busca su propio Chromium, que este instalador no baja si
  // hay navegador del sistema: la entrada arrancaria con un "browser not installed"
  // que no menciona nada de esto.
  assert.deepEqual(buildPlaywrightFlags({ channel: "msedge" }), ["--browser", "msedge"]);
  assert.deepEqual(buildPlaywrightFlags({ channel: null }), []);
  assert.deepEqual(buildPlaywrightFlags(), []);
});

test("la entrada apunta al cli.js instalado, nunca a npx", () => {
  // npx resuelve el paquete contra la red en CADA arranque, el cliente MCP corta a los
  // 30 s y descarta el servidor entero: es el fallo que installer/runtime.js documenta
  // para el servidor de SQL, y no hay que volver a introducirlo por la puerta de atras.
  const entry = playwrightCommand(
    playwrightEntry("C:\\Users\\x\\AppData\\Local\\playwright-mcp"),
    buildPlaywrightFlags({ channel: "chrome" })
  );
  assert.equal(entry.command, "node");
  assert.ok(entry.args[0].endsWith("/playwright-mcp/node_modules/@playwright/mcp/cli.js"));
  assert.ok(!entry.args.includes("npx"));
  assert.deepEqual(entry.args.slice(1), ["--browser", "chrome"]);
});

// ── Instalacion ──────────────────────────────────────────────────────────────

test("los navegadores de Playwright NO se bajan dentro del npm install", () => {
  // El postinstall de `playwright` baja Chromium, Firefox y WebKit: medio giga desde
  // su CDN, dentro de un `npm install` que parecia ir de otra cosa. En una formacion,
  // o en una red donde ese CDN esta cortado, es la diferencia entre terminar y no.
  const dir = tempDir("pw-");
  let visto = null;
  installPlaywrightMcp({
    dir,
    platform: "win32",
    env: { PATH: "x" },
    channel: "msedge",
    exec: (cmd, args, options) => {
      visto = { cmd, args, options };
      fakeInstall(dir, "0.0.80");
      return "";
    },
  });
  assert.equal(visto.options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "1");
  assert.ok(visto.args.includes(`${PLAYWRIGHT_PACKAGE}@latest`));
  assert.equal(visto.options.cwd, dir, "la carpeta va por cwd, no por --prefix");
});

test("sin navegador del sistema se baja Chromium, y solo entonces", () => {
  const dir = tempDir("pw-");
  const llamadas = [];
  const exec = (cmd, args) => {
    llamadas.push(args);
    fakeInstall(dir, "0.0.80");
    return "";
  };

  const conEdge = installPlaywrightMcp({
    dir,
    platform: "win32",
    env: {},
    channel: "msedge",
    exec,
  });
  assert.equal(conEdge.chromium, false);
  assert.equal(llamadas.length, 1, "solo el npm install");

  llamadas.length = 0;
  const sinNada = installPlaywrightMcp({ dir, platform: "win32", env: {}, channel: null, exec });
  assert.equal(sinNada.chromium, true);
  assert.deepEqual(llamadas[1], [
    path.join(dir, "node_modules", "playwright", "cli.js"),
    "install",
    "chromium",
  ]);
});

test("si npm no llega pero ya hay una version instalada, se usa esa", () => {
  // Mismo criterio que con el feed del MCP de producto: quedarse sin MCP por no poder
  // comprobar si hay una version mas nueva seria cambiar un problema de red por uno
  // de verdad.
  const dir = fakeInstall(tempDir("pw-"), "0.0.79");
  const r = installPlaywrightMcp({
    dir,
    platform: "win32",
    env: {},
    channel: "chrome",
    exec: () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    },
  });
  assert.equal(r.version, "0.0.79");
  assert.equal(r.reused, true);
  assert.match(r.offline, /ENOTFOUND/);
});

test("si npm no llega y no hay nada instalado, se propaga el fallo", () => {
  const dir = tempDir("pw-");
  assert.throws(
    () =>
      installPlaywrightMcp({
        dir,
        platform: "win32",
        env: {},
        channel: "chrome",
        exec: () => {
          throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
        },
      }),
    /ENOTFOUND/
  );
});

// ── Convivencia en el fichero del cliente ────────────────────────────────────

test("el MCP de navegador se anade JUNTO a los otros, no en su lugar", () => {
  const root = tempDir("pw-proy-");
  writeClientConfig(CLIENTS.claude, root, { command: "node", args: ["start-mssql-mcp.js"] });
  writePlaywrightConfig(
    CLIENTS.claude,
    root,
    playwrightCommand("C:/x/playwright-mcp/node_modules/@playwright/mcp/cli.js", [
      "--browser",
      "chrome",
    ])
  );

  const doc = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.ok(doc.mcpServers[SERVER_NAME], "el de SQL no se puede perder");
  assert.ok(doc.mcpServers[PLAYWRIGHT_SERVER_NAME]);
  assert.equal(hasPlaywrightServer(root), true);
});

test("desmarcarlo retira la entrada nuestra", () => {
  const root = tempDir("pw-proy-");
  writeClientConfig(CLIENTS.claude, root, { command: "node", args: ["start-mssql-mcp.js"] });
  writePlaywrightConfig(
    CLIENTS.claude,
    root,
    playwrightCommand("C:/x/playwright-mcp/node_modules/@playwright/mcp/cli.js")
  );

  const quitada = writePlaywrightConfig(CLIENTS.claude, root, null);
  assert.equal(quitada.removed, true);
  const doc = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.ok(!doc.mcpServers[PLAYWRIGHT_SERVER_NAME]);
  assert.ok(doc.mcpServers[SERVER_NAME], "retirar el de navegador no toca el de SQL");
});

test("un `playwright` puesto a mano no se retira al desmarcar la casilla", () => {
  // El paquete no es nuestro: `npx @playwright/mcp@latest` es la forma que documenta
  // Microsoft y funciona. Retirarla porque la casilla venga desmarcada es romper algo
  // que este instalador no puso.
  const root = tempDir("pw-proy-");
  const aMano = { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] };
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { [PLAYWRIGHT_SERVER_NAME]: aMano } }),
    "utf8"
  );

  assert.equal(writePlaywrightConfig(CLIENTS.claude, root, null), null);
  const doc = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(doc.mcpServers[PLAYWRIGHT_SERVER_NAME], aMano);
});

test("un `playwright` puesto a mano tampoco se pisa al marcarla", () => {
  const root = tempDir("pw-proy-");
  const aMano = { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] };
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { [PLAYWRIGHT_SERVER_NAME]: aMano } }),
    "utf8"
  );

  const r = writePlaywrightConfig(
    CLIENTS.claude,
    root,
    playwrightCommand("C:/x/playwright-mcp/node_modules/@playwright/mcp/cli.js")
  );
  assert.equal(r.kept, true, "hay que decir que no se ha tocado, no callarlo");
  const doc = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(
    doc.mcpServers[PLAYWRIGHT_SERVER_NAME],
    aMano,
    "sus flags (--headless aqui) no se pueden perder"
  );
});

test("hasPlaywrightServer cuenta tambien el puesto a mano", () => {
  // Sirve para premarcar la casilla: si dejara de contarlo, reinstalar la traeria
  // desmarcada y la rama de "retirar" se ejecutaria sobre un proyecto que si lo tiene.
  const root = tempDir("pw-proy-");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: { [PLAYWRIGHT_SERVER_NAME]: { command: "npx", args: ["@playwright/mcp@latest"] } },
    }),
    "utf8"
  );
  assert.equal(hasPlaywrightServer(root), true);
});

test("isOurPlaywrightEntry distingue la nuestra de cualquier otra forma", () => {
  const nuestra = {
    command: "node",
    args: ["C:/x/playwright-mcp/node_modules/@playwright/mcp/cli.js", "--browser", "chrome"],
  };
  const aMano = { command: "npx", args: ["-y", "@playwright/mcp@latest"] };
  const ajeno = { command: "node", args: ["mi-servidor.js"] };

  assert.equal(isOurPlaywrightEntry(nuestra), true);
  assert.equal(isOurPlaywrightEntry(aMano), false);
  assert.equal(isPlaywrightEntry(aMano), true, "es un Playwright MCP, aunque no el nuestro");
  assert.equal(isPlaywrightEntry(ajeno), false);
  assert.equal(isPlaywrightEntry(undefined), false);
});

test("la entrada de Windows se reconoce con barras invertidas", () => {
  // Es la forma en la que la escribe path.join en Windows si algun dia se deja de
  // normalizar: no reconocerla haria que desmarcar la casilla no retirase nada.
  assert.equal(
    isOurPlaywrightEntry({
      command: "node",
      args: ["C:\\x\\playwright-mcp\\node_modules\\@playwright\\mcp\\cli.js"],
    }),
    true
  );
});

// ── Reglas de permisos ───────────────────────────────────────────────────────

test("las reglas del navegador salen del tools/list real, no de la documentacion", () => {
  const reglas = [...playwrightReadRules(), ...playwrightActionRules()];
  for (const nombre of [
    "browser_navigate",
    "browser_snapshot",
    "browser_take_screenshot",
    "browser_console_messages",
    "browser_network_requests",
    "browser_click",
    "browser_type",
    "browser_fill_form",
    "browser_select_option",
    "browser_file_upload",
  ]) {
    assert.ok(
      reglas.includes(`mcp__${PLAYWRIGHT_SERVER_NAME}__${nombre}`),
      `falta ${nombre}, que si existe en el servidor`
    );
  }
});

test("ejecutar JavaScript en la pagina no tiene regla, ni de lectura ni de accion", () => {
  // `browser_evaluate` y `browser_run_code_unsafe` ejecutan el codigo que les pasen
  // dentro de la pagina: una regla para ellas autoriza cualquier cosa que se pueda
  // escribir en JavaScript, incluido salirse de lo que estas reglas describen.
  const reglas = [...playwrightReadRules(), ...playwrightActionRules()].join(" ");
  assert.ok(!reglas.includes("browser_evaluate"));
  assert.ok(!reglas.includes("browser_run_code_unsafe"));
  assert.ok(!reglas.includes("browser_*"), "un comodin las metaria a las dos");
});

test("mirar y tocar se piden aparte", () => {
  const root = tempDir("pw-perms-");
  const soloMirar = allowMcpTools(root, { playwright: true });
  assert.ok(soloMirar.added.includes(`mcp__${PLAYWRIGHT_SERVER_NAME}__browser_snapshot`));
  assert.ok(
    !soloMirar.added.includes(`mcp__${PLAYWRIGHT_SERVER_NAME}__browser_click`),
    "un clic ejecuta lo que haya detras del boton: no entra sin pedirlo"
  );

  const conClic = allowMcpTools(root, { playwright: true, playwrightActions: true });
  assert.ok(conClic.added.includes(`mcp__${PLAYWRIGHT_SERVER_NAME}__browser_click`));
});

test("sin la casilla del navegador no se cuela ninguna regla suya", () => {
  const root = tempDir("pw-perms-");
  const perms = allowMcpTools(root, { playwrightActions: true });
  assert.ok(!perms.added.some((r) => r.includes(PLAYWRIGHT_SERVER_NAME)));
});

test("las reglas de los tres servidores conviven en el mismo settings.local.json", () => {
  const root = tempDir("pw-perms-");
  allowMcpTools(root, { product: true });
  const perms = allowMcpTools(root, { product: true, playwright: true });

  const doc = JSON.parse(
    fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8")
  );
  const allow = doc.permissions.allow;
  for (const regla of readRules()) assert.ok(allow.includes(regla), `falta ${regla}`);
  assert.ok(allow.some((r) => r.startsWith("mcp__ahora-erp__")));
  assert.ok(allow.some((r) => r.startsWith(`mcp__${PLAYWRIGHT_SERVER_NAME}__`)));
  assert.equal(perms.removed.length, 0, "anadir el tercero no puede retirar los otros");
});
