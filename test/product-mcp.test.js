/*
 * El MCP de desarrollo de producto (`ahora-mcp`) se anade AL LADO del de SQL.
 *
 * Lo que estos tests protegen es esa convivencia y el hecho de que la contrasena del
 * ERP no acabe en el .mcp.json. Las dos cosas se rompen callando: una entrada que
 * sustituye a la otra deja al agente sin la mitad de sus herramientas sin ningun
 * error, y una cadena de conexion escrita en la configuracion se commitea sin que
 * nadie lo note hasta que es tarde.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  compareVersions,
  pickLatest,
  productRuntimeDir,
  productDll,
  installedProductVersion,
  projectFiles,
  dotnetSdkVersion,
  PRODUCT_PACKAGE,
  PRODUCT_FEED,
} = require("../installer/product-mcp");

const {
  parseArgs,
  quoteAdoValue,
  buildErpConnectionString,
  resolveConnection,
  cleanEnv,
  serverCommand,
} = require("../bin/start-ahora-mcp");

const {
  buildProductFlags,
  productCommandFrom,
  writeProductConfig,
  hasProductServer,
  writeClientConfig,
  CLIENTS,
  SERVER_NAME,
  PRODUCT_SERVER_NAME,
} = require("../installer/setup");

const { allowMcpTools, readRules, productReadRules, productWriteRules } = require("../installer/permissions");
const { protect } = require("../src/secrets");

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// ── Resolucion de version en el feed ─────────────────────────────────────────

test("pickLatest ordena por numero, no alfabeticamente", () => {
  // "0.9.0" > "0.64.0" en orden alfabetico, y el feed devuelve las versiones
  // desordenadas: instalar la 0.9.0 seria retroceder 55 versiones sin decirlo.
  assert.equal(pickLatest(["0.1.0", "0.9.0", "0.64.0", "0.10.0"]), "0.64.0");
  assert.equal(compareVersions("0.64.0", "0.9.0") > 0, true);
});

test("pickLatest descarta las preview", () => {
  // Una preview no es lo que hay que dejarle instalado a un compañero en una
  // formacion, y el feed las publica en la misma lista.
  assert.equal(pickLatest(["0.64.0", "0.65.0-beta1"]), "0.64.0");
  assert.equal(pickLatest(["1.0.0-rc"]), null);
});

// ── Carpeta de instalacion ───────────────────────────────────────────────────

test("el MCP de producto se instala en LOCALAPPDATA, no en el proyecto", () => {
  // Por usuario y sin elevacion, igual que el servidor de SQL: `%APPDATA%` se
  // sincroniza con el perfil de dominio y no interesa mover cientos de DLL por red.
  const dir = productRuntimeDir({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
  });
  assert.equal(dir, path.join("C:\\Users\\x\\AppData\\Local", "AHORA-SQL-MCP", "ahora-mcp"));
  assert.match(productDll(dir), /app[\\/]ahora-mcp\.dll$/);
});

test("installedProductVersion no da por instalada una carpeta sin el dll", () => {
  // La marca sola no basta: una publicacion a medias deja el JSON y no el binario,
  // y darla por buena escribe un .mcp.json que apunta a un fichero que no existe.
  const dir = tempDir("prod-");
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "app", "ahora-mcp-instalado.json"),
    JSON.stringify({ version: "0.64.0" })
  );
  assert.equal(installedProductVersion(dir), null);

  fs.writeFileSync(productDll(dir), "no es un dll de verdad");
  assert.equal(installedProductVersion(dir), "0.64.0");
});

// ── Proyecto que se genera para publicar ─────────────────────────────────────

test("el proyecto generado fija la version y anade el feed de AHORA", () => {
  const files = projectFiles("0.64.0");
  // Version exacta entre corchetes: sin fijarla, NuGet resolveria a la ultima que
  // encuentre y la carpeta dejaria de coincidir con la marca que escribimos.
  assert.match(files["ahora-mcp-host.csproj"], /Include="ahora-mcp" Version="\[0\.64\.0\]"/);
  assert.match(files["ahora-mcp-host.csproj"], /net10\.0-windows/);
  assert.ok(files["nuget.config"].includes(PRODUCT_FEED));
  // `<clear />` para que el nuget.config del usuario no meta una fuente que no
  // controlamos en medio de una instalacion que tiene que ser reproducible.
  assert.match(files["nuget.config"], /<clear\s*\/>/);
});

test("dotnetSdkVersion rechaza un SDK anterior al 10", () => {
  // El paquete es net10.0-windows: con un SDK 8 la restauracion falla con un error
  // de framework que no dice que lo que sobra es el SDK.
  assert.equal(dotnetSdkVersion("8.0.404"), null);
  assert.equal(dotnetSdkVersion("10.0.204"), "10.0.204");
  assert.equal(dotnetSdkVersion(null), null);
});

// ── Lanzador: la cadena de conexion ──────────────────────────────────────────

test("quoteAdoValue entrecomilla lo que partiria la cadena", () => {
  // Una contrasena con ';' parte la cadena en dos y SqlClient se queja de una
  // palabra clave desconocida, sin mencionar la contrasena por ningun lado.
  assert.equal(quoteAdoValue("simple"), "simple");
  assert.equal(quoteAdoValue("con;punto"), '"con;punto"');
  assert.equal(quoteAdoValue('con"comilla'), '"con""comilla"');
});

test("buildErpConnectionString mantiene la politica de cifrado del servidor de SQL", () => {
  // SqlClient 6+ trae Encrypt=True por defecto: omitirlo NO es neutral, tumba la
  // conexion contra un servidor interno con certificado autofirmado. La politica se
  // copia de src/config.js para que una conexion que va con ahora-sql vaya con este.
  const { connString, target, database } = buildErpConnectionString(
    { datasource: "PC_158\\SQL2022", initialcatalog: "ERPAHORA", userid: "sa", password: "x" },
    "prueba"
  );
  assert.match(connString, /Encrypt=False/);
  assert.match(connString, /TrustServerCertificate=True/);
  assert.equal(target, "PC_158\\SQL2022");
  assert.equal(database, "ERPAHORA");

  // Y lo que diga la fuente manda sobre el valor por defecto.
  const explicito = buildErpConnectionString(
    {
      datasource: "srv,1433",
      initialcatalog: "BD",
      userid: "sa",
      password: "x",
      encrypt: "true",
      trustservercertificate: "false",
    },
    "prueba"
  );
  assert.match(explicito.connString, /Encrypt=True/);
  assert.match(explicito.connString, /TrustServerCertificate=False/);
  assert.equal(explicito.target, "srv,1433");
});

test("buildErpConnectionString exige usuario y contrasena", () => {
  // El MCP de producto admite autenticacion de Windows, pero solo por su dialogo de
  // login, que no puede salir cuando quien lo arranca es un cliente MCP.
  assert.throws(
    () => buildErpConnectionString({ datasource: "srv", initialcatalog: "BD" }, "x"),
    /usuario y contrasena/
  );
});

test("parseArgs rechaza repetir --connection-name", () => {
  // Repetirlo es haber copiado una configuracion multi-BD del servidor de SQL, donde
  // SI es repetible. Quedarse callado con el ultimo conectaria a otra base de datos.
  assert.throws(
    () => parseArgs(["--connection-name", "a", "--connection-name", "b"]),
    /una sola base de datos por proceso/
  );
});

test("cleanEnv retira cualquier AHORA_MCP_* heredado de la maquina", () => {
  // Un AHORA_MCP_ERP puesto en el perfil de Windows -apuntando, por ejemplo, a la
  // base de datos de otro cliente- mandaria segun el orden de asignacion, sin que
  // nada lo dijera. Se retira siempre y se pone el nuestro de forma explicita.
  const env = cleanEnv({
    PATH: "algo",
    AHORA_MCP_ERP: "Server=el-de-otro",
    AHORA_MCP_ERP_PID: "1234",
    AHORA_MCP_TOKEN: "t",
  });
  assert.equal(env.PATH, "algo");
  assert.equal(env.AHORA_MCP_ERP, undefined);
  assert.equal(env.AHORA_MCP_ERP_PID, undefined);
  assert.equal(env.AHORA_MCP_TOKEN, undefined);
});

test("resolveConnection descifra la contrasena del fichero de credenciales", () => {
  // El servidor de producto no entiende el token cifrado: alguien tiene que abrirlo,
  // y este es el unico punto donde se puede.
  const dir = tempDir("cred-");
  const file = path.join(dir, "proyecto.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      connections: {
        config: { server: "srv", database: "IC", user: "sa", passwordEnc: protect("secreta") },
        data: { server: "srv", database: "ERPAHORA", user: "sa", passwordEnc: protect("otra") },
      },
    })
  );

  const { parts, label } = resolveConnection({ credentialsFile: file, db: "data" });
  assert.equal(label, "data");
  assert.equal(parts.initialcatalog, "ERPAHORA");
  assert.equal(parts.password, "otra");
});

test("resolveConnection exige --db cuando el fichero trae varias", () => {
  // Elegir por su cuenta seria conectar a una base de datos que nadie ha pedido.
  const dir = tempDir("cred-");
  const file = path.join(dir, "proyecto.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      connections: {
        config: { server: "srv", database: "IC", user: "sa", password: "x" },
        data: { server: "srv", database: "ERP", user: "sa", password: "x" },
      },
    })
  );
  assert.throws(() => resolveConnection({ credentialsFile: file }), /Indica cual con --db/);
  assert.throws(() => resolveConnection({ credentialsFile: file, db: "noexiste" }), /no existe/);
});

test("serverCommand lanza el dll con `dotnet exec`", () => {
  const dir = tempDir("dll-");
  const dll = path.join(dir, "ahora-mcp.dll");
  fs.writeFileSync(dll, "x");
  assert.deepEqual(serverCommand({ serverDll: dll }), {
    command: "dotnet",
    args: ["exec", dll],
  });
  // Y avisa antes de arrancar si la publicacion no esta, en lugar de dejar que el
  // cliente MCP se coma un servidor que no levanta.
  assert.throws(() => serverCommand({ serverDll: path.join(dir, "no-esta.dll") }), /No existe/);
});

// ── Configuracion escrita: los dos servidores conviven ───────────────────────

test("buildProductFlags NO escribe la cadena de conexion, solo de donde sacarla", () => {
  // Es el motivo de que exista el lanzador: el .mcp.json se commitea.
  const flags = buildProductFlags({
    serverDll: "C:\\dir\\ahora-mcp.dll",
    configFile: "C:\\repo\\Web.config",
    connectionName: "DataConnectionString",
    environment: "Development",
  });
  assert.deepEqual(flags, [
    "--server-dll",
    "C:/dir/ahora-mcp.dll",
    "--config-file",
    "C:/repo/Web.config",
    "--connection-name",
    "DataConnectionString",
    "--environment",
    "Development",
  ]);
  assert.equal(
    flags.some((f) => /password/i.test(f)),
    false,
    "ninguna credencial puede viajar en los argumentos"
  );
});

test("productCommandFrom sigue a la forma en la que quedo el servidor de SQL", () => {
  // Los dos lanzadores viven en la misma carpeta del paquete instalado: deducirlo
  // evita escribir una entrada que apunta a una instalacion que no existe.
  const instalado = productCommandFrom(
    { command: "node", args: ["C:/dir/bundle/start-mssql-mcp.cjs", "--config-file", "x"] },
    ["--server-dll", "d.dll"]
  );
  assert.equal(instalado.command, "node");
  assert.equal(instalado.args[0], "C:/dir/bundle/start-ahora-mcp.cjs");

  const npx = productCommandFrom({ command: "npx", args: [] }, ["--server-dll", "d.dll"]);
  assert.equal(npx.command, "npx");
  assert.ok(npx.args.includes("start-ahora-mcp"));
});

test("el MCP de producto se anade JUNTO al de SQL, no en su lugar", () => {
  // Es la propiedad que pidio quien lo encargo: los dos tienen que convivir. Si una
  // entrada sustituyera a la otra, el agente se quedaria sin la mitad de sus
  // herramientas sin ningun error que lo explicara.
  const root = tempDir("mcp-");
  writeClientConfig(CLIENTS.claude, root, {
    command: "node",
    args: ["C:/dir/bundle/start-mssql-mcp.cjs"],
  });
  writeProductConfig(CLIENTS.claude, root, {
    command: "node",
    args: ["C:/dir/bundle/start-ahora-mcp.cjs", "--server-dll", "d.dll"],
  });

  const doc = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(doc.mcpServers).sort(), [PRODUCT_SERVER_NAME, SERVER_NAME].sort());
  assert.equal(hasProductServer(root), true);
});

test("desmarcarlo retira la entrada nuestra y solo la nuestra", () => {
  const root = tempDir("mcp-");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: { command: "node", args: ["C:/dir/bundle/start-mssql-mcp.cjs"] },
        // Un `ahora-erp` puesto a mano apuntando al exe: no lo hemos escrito nosotros
        // y no se toca.
        [PRODUCT_SERVER_NAME]: { command: "C:/otro/ahora-mcp.exe", args: [] },
        otro: { command: "node", args: ["cosa.js"] },
      },
    })
  );
  assert.equal(writeProductConfig(CLIENTS.claude, root, null), null);

  const doc = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.equal(doc.mcpServers[PRODUCT_SERVER_NAME].command, "C:/otro/ahora-mcp.exe");
  assert.ok(doc.mcpServers.otro, "los demas servidores no se tocan");
});

// ── Permisos: reglas propias, sin pisar las del MCP de SQL ───────────────────

test("las reglas de los dos servidores conviven en el mismo settings.local.json", () => {
  // Las herramientas del MCP de producto no comparten vocabulario con las de aqui
  // (`ahora_leer_*` frente a `list_*`), asi que un comodin no cubre las dos y hacen
  // falta reglas propias. Lo que no puede pasar es que anadir unas retire las otras:
  // la skill de resolucion de tickets depende de `mcp__ahora-sql__*`.
  const root = tempDir("perm-");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const perms = allowMcpTools(root, { product: true });

  const doc = JSON.parse(
    fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8")
  );
  for (const rule of readRules()) assert.ok(doc.permissions.allow.includes(rule), rule);
  for (const rule of productReadRules()) assert.ok(doc.permissions.allow.includes(rule), rule);
  // Las escrituras del MCP de producto NO entran sin pedirlas: ese servidor no tiene
  // modo de solo lectura, asi que estas reglas son el unico freno que queda.
  for (const rule of productWriteRules()) {
    assert.equal(doc.permissions.allow.includes(rule), false, rule);
  }
  assert.ok(perms.added.length > 0);

  const conEscrituras = allowMcpTools(root, { product: true, productWrites: true });
  assert.deepEqual(conEscrituras.added, productWriteRules());
});

test("las reglas de lectura del MCP de producto salen del tools/list real", () => {
  // Su documentacion las nombra en PascalCase (`AhoraLeerObjeto`), pero el servidor
  // las registra en snake_case. Escribir reglas contra la documentacion las dejaria
  // sin cubrir ninguna herramienta, en silencio.
  const rules = productReadRules();
  assert.ok(rules.includes(`mcp__${PRODUCT_SERVER_NAME}__ahora_leer_*`));
  assert.ok(rules.includes(`mcp__${PRODUCT_SERVER_NAME}__ahora_consulta_segura`));
  assert.equal(
    rules.some((r) => /Ahora[A-Z]/.test(r)),
    false,
    "ninguna regla puede estar en PascalCase"
  );
  assert.equal(PRODUCT_PACKAGE, "ahora-mcp");
});
