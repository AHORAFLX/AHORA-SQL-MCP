const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
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
  appSettingsChain,
  resolveConfigFile,
  resolveEnvironment,
  resolveSources,
  describeEnvConnections,
} = require("../bin/start-mssql-mcp");

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Args por defecto, para poder probar resolveSources con un solo campo puesto. */
function args(overrides = {}) {
  return {
    connections: [],
    connectionStrings: [],
    aliases: [],
    allowWrites: false,
    fromEnv: false,
    sqlDirs: [],
    ...overrides,
  };
}

// ── parseDataSource: todas las formas en que se escribe un Data Source ──
//
// La tabla DS_CASES sustituye a los tests uno-a-uno que habia antes: cubre los
// mismos casos y ademas el resto de formas, comprobando campo por campo en vez de
// comparar el objeto entero (que se rompe al anadir un campo nuevo como `protocol`).

const DS_CASES = [
  // [entrada, host, instancia, puerto]
  ["PC_158", "PC_158", undefined, undefined],
  ["PC_158\\SQL2022", "PC_158", "SQL2022", undefined],
  ["PC_158,1433", "PC_158", undefined, "1433"],
  ["PC_158\\SQL2022,1435", "PC_158", "SQL2022", "1435"],
  // Forma real de un Web.config de produccion: el puerto antes de la instancia.
  ["192.168.9.26,1433\\AHORA_R", "192.168.9.26", "AHORA_R", "1433"],
  // Punto y coma como separador: el ';' ya partio el par ADO, pero si el puerto
  // viaja pegado al Data Source hay que recogerlo igual.
  ["PC_158;1435", "PC_158", undefined, "1435"],
  ["PC_158\\SQL2022;1435", "PC_158", "SQL2022", "1435"],
  // Dos puntos, que es como se escribe en otros ecosistemas.
  ["PC_158:1435", "PC_158", undefined, "1435"],
  // Alias locales, con y sin instancia.
  [".", "localhost", undefined, undefined],
  [".\\SQL2022", "localhost", "SQL2022", undefined],
  ["(local)", "localhost", undefined, undefined],
  ["(LOCAL)\\SQL2022", "localhost", "SQL2022", undefined],
  // Espacios y comillas alrededor del valor.
  ["  PC_158 , 1433  ", "PC_158", undefined, "1433"],
  ['"PC_158\\SQL2022"', "PC_158", "SQL2022", undefined],
  ["'PC_158,1433'", "PC_158", undefined, "1433"],
  // IPv6 entre corchetes: lleva ':' dentro y no se puede tokenizar igual.
  ["[::1]", "::1", undefined, undefined],
  ["[::1],1433", "::1", undefined, "1433"],
];

for (const [input, host, instanceName, port] of DS_CASES) {
  test(`parseDataSource: ${JSON.stringify(input)}`, () => {
    const r = parseDataSource(input);
    assert.strictEqual(r.host, host, "host");
    assert.strictEqual(r.instanceName, instanceName, "instancia");
    assert.strictEqual(r.port, port, "puerto");
  });
}

test("parseDataSource: MSSQLSERVER es la instancia por defecto, no una nombrada", () => {
  // Tratarla como nombrada obligaria al SQL Browser sin ninguna necesidad.
  const r = parseDataSource("PC_158\\MSSQLSERVER");
  assert.strictEqual(r.host, "PC_158");
  assert.strictEqual(r.instanceName, undefined);
});

test("parseDataSource: reconoce el protocolo para poder rechazarlo despues", () => {
  assert.strictEqual(parseDataSource("tcp:PC_158,1433").protocol, "tcp");
  assert.strictEqual(parseDataSource("np:PC_158").protocol, "np");
  assert.strictEqual(parseDataSource("lpc:PC_158").protocol, "lpc");
  assert.strictEqual(parseDataSource("PC_158").protocol, undefined);
});

test("parseDataSource: canalizacion nombrada explicita se marca como np", () => {
  const r = parseDataSource("\\\\PC_158\\pipe\\MSSQL$SQL2022\\sql\\query");
  assert.strictEqual(r.host, "PC_158");
  assert.strictEqual(r.protocol, "np");
});

test("applyConnection: rechaza en claro los protocolos que el driver no habla", () => {
  for (const proto of ["np", "lpc"]) {
    const parts = parseAdoConnectionString(
      `Data Source=${proto}:PC_158;Initial Catalog=BD;User ID=sa;Password=x`
    );
    assert.throws(
      () => applyConnection({}, "MSSQL_", parts, "test"),
      /solo TCP/,
      `${proto} deberia rechazarse con un mensaje claro`
    );
  }
});

test("applyConnection: usa el puerto de un `Port=` aparte", () => {
  // Algunas herramientas lo escriben asi en vez de pegarlo al Data Source.
  const env = {};
  const parts = parseAdoConnectionString(
    "Data Source=PC_158\\SQL2022;Port=1435;Initial Catalog=BD;User ID=sa;Password=x"
  );
  const info = applyConnection(env, "MSSQL_", parts, "test");
  assert.strictEqual(env.MSSQL_PORT, "1435");
  assert.ok(!("MSSQL_INSTANCE_NAME" in env), "con puerto se descarta la instancia");
  assert.strictEqual(info.viaInstance, false, "y ya no depende del SQL Browser");
});

test("applyConnection: recoge un puerto suelto tras el punto y coma", () => {
  // `Data Source=PC\INSTANCIA;1435` — el ';' parte el par y el 1435 queda solo.
  const env = {};
  const parts = parseAdoConnectionString(
    "Data Source=PC_158\\SQL2022;1435;Initial Catalog=BD;User ID=sa;Password=x"
  );
  applyConnection(env, "MSSQL_", parts, "test");
  assert.strictEqual(env.MSSQL_PORT, "1435");
});

test("applyConnection: acepta los alias Address / Network Address", () => {
  for (const key of ["Address", "Addr", "Network Address"]) {
    const env = {};
    const parts = parseAdoConnectionString(
      `${key}=PC_158,1433;Initial Catalog=BD;User ID=sa;Password=x`
    );
    applyConnection(env, "MSSQL_", parts, "test");
    assert.strictEqual(env.MSSQL_SERVER, "PC_158", `alias ${key}`);
    assert.strictEqual(env.MSSQL_PORT, "1433", `alias ${key}`);
  }
});

// ── --port por alias ──

test("portFor: un numero suelto vale para todas las conexiones", () => {
  assert.strictEqual(portFor(["1433"], "config"), "1433");
  assert.strictEqual(portFor(["1433"], "data"), "1433");
  assert.strictEqual(portFor(["1433"], "maindb"), "1433");
});

test("portFor: alias:puerto solo afecta a esa conexion", () => {
  // El caso real: cada BD en una instancia distinta con su propio puerto, donde un
  // unico --port para todas no sirve.
  const ports = ["config:1433", "data:1435"];
  assert.strictEqual(portFor(ports, "config"), "1433");
  assert.strictEqual(portFor(ports, "data"), "1435");
  assert.strictEqual(portFor(ports, "otra"), undefined, "sin regla, sin puerto");
});

test("portFor: el alias es insensible a mayusculas y tolera espacios", () => {
  assert.strictEqual(portFor([" Config : 1433 "], "config"), "1433");
  assert.strictEqual(portFor(["DATA:1435"], "data"), "1435");
});

test("portFor: se pueden combinar un puerto general y excepciones por alias", () => {
  const ports = ["1433", "data:1435"];
  assert.strictEqual(portFor(ports, "config"), "1433", "cae en el general");
  assert.strictEqual(portFor(ports, "data"), "1435", "la excepcion gana");
});

test("portFor: sin --port no hay puerto y se usa la instancia nombrada", () => {
  assert.strictEqual(portFor([], "config"), undefined);
  assert.strictEqual(portFor(undefined, "config"), undefined);
});

test("parseArgs: --port acumula, y conserva el numero suelto en `port`", () => {
  const a = parseArgs([
    "--config-file", "W.config",
    "--connection-name", "Conf:config",
    "--connection-name", "Data:data",
    "--port", "config:1433",
    "--port", "data:1435",
  ]);
  assert.deepStrictEqual(a.ports, ["config:1433", "data:1435"]);
  assert.strictEqual(a.port, undefined, "no hay numero suelto");

  const b = parseArgs(["--config-file", "W.config", "--connection-name", "X", "--port", "1433"]);
  assert.deepStrictEqual(b.ports, ["1433"]);
  assert.strictEqual(b.port, "1433", "la forma simple sigue igual");
});

test("parseDataSource: prefijo de protocolo y alias locales", () => {
  assert.strictEqual(parseDataSource("tcp:PC_158\\PC_158").instanceName, "PC_158");
  assert.strictEqual(parseDataSource(".").host, "localhost");
  assert.strictEqual(parseDataSource("(local)").host, "localhost");
});

test("cleanEnv elimina toda variable MSSQL_ heredada", () => {
  process.env.MSSQL_RESIDUAL_DATABASE = "BASURA";
  process.env.MSSQL_ENABLE_WRITES = "true";
  try {
    const env = cleanEnv();
    assert.ok(!("MSSQL_RESIDUAL_DATABASE" in env));
    assert.ok(!("MSSQL_ENABLE_WRITES" in env));
    assert.ok("PATH" in env || "Path" in env);
  } finally {
    delete process.env.MSSQL_RESIDUAL_DATABASE;
    delete process.env.MSSQL_ENABLE_WRITES;
  }
});

test("applyConnection: instancia nombrada exporta INSTANCE_NAME y no PORT", () => {
  const env = {};
  const parts = parseAdoConnectionString(
    "Data Source=PC_158\\PC_158;Initial Catalog=JapofishBD;User ID=sa;Password=x"
  );
  const info = applyConnection(env, "MSSQL_", parts, "test");

  assert.strictEqual(env.MSSQL_SERVER, "PC_158");
  assert.strictEqual(env.MSSQL_INSTANCE_NAME, "PC_158");
  assert.ok(!("MSSQL_PORT" in env));
  assert.strictEqual(info.viaInstance, true);
});

test("applyConnection: --port descarta la instancia (son excluyentes en tedious)", () => {
  const env = {};
  const parts = parseAdoConnectionString(
    "Data Source=PC_158\\PC_158;Initial Catalog=JapofishBD;User ID=sa;Password=x"
  );
  const info = applyConnection(env, "MSSQL_", parts, "test", "1433");

  assert.strictEqual(env.MSSQL_PORT, "1433");
  assert.ok(!("MSSQL_INSTANCE_NAME" in env));
  assert.strictEqual(info.viaInstance, false);
});

test("applyConnection: rechaza cadenas sin usuario y contrasena", () => {
  const parts = parseAdoConnectionString(
    "Data Source=PC_158\\PC_158;Initial Catalog=JapofishBD;Integrated Security=True"
  );
  assert.throws(
    () => applyConnection({}, "MSSQL_", parts, "test"),
    /autenticacion integrada de Windows/
  );
});

test("parseAdoConnectionString: acepta contrasenas con caracteres especiales", () => {
  const parts = parseAdoConnectionString("Data Source=x;Password=-a123456;User ID=sa");
  assert.strictEqual(parts.password, "-a123456");
  assert.strictEqual(parts.userid, "sa");
});

test("normalizeAdoKey: las claves con y sin espacios son la misma", () => {
  assert.strictEqual(normalizeAdoKey("Trust Server Certificate"), "trustservercertificate");
  assert.strictEqual(normalizeAdoKey("TrustServerCertificate"), "trustservercertificate");
  assert.strictEqual(normalizeAdoKey("Initial Catalog"), "initialcatalog");
});

test("applyConnection: reconoce 'Trust Server Certificate' con espacios (forma de Core)", () => {
  const env = {};
  const parts = parseAdoConnectionString(
    "Data Source=PC;Initial Catalog=BD;User ID=sa;Password=x;Encrypt=False;Trust Server Certificate=False"
  );
  applyConnection(env, "MSSQL_", parts, "test");
  assert.strictEqual(env.MSSQL_TRUST_SERVER_CERTIFICATE, "false");
  assert.strictEqual(env.MSSQL_ENCRYPT, "false");
});

test("applyConnection: sigue reconociendo la forma sin espacios (Framework)", () => {
  const env = {};
  const parts = parseAdoConnectionString(
    "Data Source=PC;Initial Catalog=BD;Persist Security Info=True;User ID=sa;Password=x;TrustServerCertificate=True"
  );
  applyConnection(env, "MSSQL_", parts, "test");
  assert.strictEqual(env.MSSQL_TRUST_SERVER_CERTIFICATE, "true");
});

test("partsFromFlags produce las claves que applyConnection espera", () => {
  const env = {};
  const parts = partsFromFlags({
    server: "PC_158\\PC_158",
    database: "BD",
    user: "sa",
    password: "x",
  });
  const info = applyConnection(env, "MSSQL_", parts, "flags");
  assert.strictEqual(env.MSSQL_SERVER, "PC_158");
  assert.strictEqual(env.MSSQL_INSTANCE_NAME, "PC_158");
  assert.strictEqual(env.MSSQL_DATABASE, "BD");
  assert.strictEqual(info.viaInstance, true);
});

test("parseArgs: recoge conexiones repetidas, puerto y allow-writes", () => {
  const a = parseArgs([
    "--config-file", "W.config",
    "--connection-name", "Conf:config",
    "--connection-name", "Data:data",
    "--port", "1433",
    "--allow-writes",
  ]);
  assert.strictEqual(a.configFile, "W.config");
  assert.deepStrictEqual(a.connections, ["Conf:config", "Data:data"]);
  assert.strictEqual(a.port, "1433");
  assert.strictEqual(a.allowWrites, true);
});

test("parseArgs: allowWrites es false por defecto", () => {
  const a = parseArgs(["--config-file", "W.config", "--connection-name", "Data"]);
  assert.strictEqual(a.allowWrites, false);
});

test("parseArgs: --allow-writes-for se acumula, uno por conexion", () => {
  const a = parseArgs([
    "--config-file", "W.config",
    "--connection-name", "Conf:config",
    "--connection-name", "Data:data",
    "--allow-writes-for", "data",
  ]);
  assert.deepStrictEqual(a.allowWritesFor, ["data"]);
  assert.strictEqual(a.allowWrites, false);
});

test("parseArgs: allowWritesFor es una lista vacia por defecto", () => {
  const a = parseArgs(["--config-file", "W.config", "--connection-name", "Data"]);
  assert.deepStrictEqual(a.allowWritesFor, []);
});

test("parseArgs: acumula varios --allow-sql-dir", () => {
  const a = parseArgs([
    "--config-file", "W.config",
    "--connection-name", "Data",
    "--allow-sql-dir", "C:\\Codigo GIT\\skills",
    "--allow-sql-dir", "D:\\scripts",
  ]);
  assert.deepStrictEqual(a.sqlDirs, ["C:\\Codigo GIT\\skills", "D:\\scripts"]);
});

test("parseArgs: sqlDirs es una lista vacia por defecto", () => {
  const a = parseArgs(["--config-file", "W.config", "--connection-name", "Data"]);
  assert.deepStrictEqual(a.sqlDirs, []);
});

test("cleanEnv elimina un MSSQL_SQL_DIRS heredado", () => {
  process.env.MSSQL_SQL_DIRS = "C:\\cualquier-cosa";
  try {
    assert.ok(!("MSSQL_SQL_DIRS" in cleanEnv()));
  } finally {
    delete process.env.MSSQL_SQL_DIRS;
  }
});

test("parseArgs: recoge las fuentes nuevas y el entorno", () => {
  const a = parseArgs([
    "--connection-string", "Data Source=A;Initial Catalog=1",
    "--alias", "config",
    "--connection-string", "Data Source=B;Initial Catalog=2",
    "--alias", "data",
    "--environment", "Staging",
    "--from-env",
    "--server", "PC",
    "--database", "BD",
    "--user", "sa",
    "--password", "x",
    "--encrypt", "false",
    "--trust-server-certificate", "true",
  ]);
  assert.deepStrictEqual(a.connectionStrings, [
    "Data Source=A;Initial Catalog=1",
    "Data Source=B;Initial Catalog=2",
  ]);
  assert.deepStrictEqual(a.aliases, ["config", "data"]);
  assert.strictEqual(a.environment, "Staging");
  assert.strictEqual(a.fromEnv, true);
  assert.strictEqual(a.server, "PC");
  assert.strictEqual(a.encrypt, "false");
  assert.strictEqual(a.trustServerCertificate, "true");
});

// ── appsettings.json (.NET Core) ──

test("resolveEnvironment: --environment, luego ASPNETCORE_ENVIRONMENT, luego Development", () => {
  assert.strictEqual(resolveEnvironment("Staging", {}), "Staging");
  assert.strictEqual(
    resolveEnvironment(undefined, { ASPNETCORE_ENVIRONMENT: "Production" }),
    "Production"
  );
  assert.strictEqual(resolveEnvironment(undefined, {}), "Development");
});

/** El caso real de Flexygo Core: declarada y vacia en base, rellena en Development. */
function coreProject() {
  const dir = tempDir("wrapper-core-");
  fs.writeFileSync(
    path.join(dir, "appsettings.json"),
    JSON.stringify({
      ConnectionStrings: { ConfConnectionString: "", DataConnectionString: "" },
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "appsettings.Development.json"),
    JSON.stringify({
      ConnectionStrings: {
        ConfConnectionString:
          "Data Source=PC\\PC;Initial Catalog=Conf;User ID=sa;Password=x;Trust Server Certificate=True",
        DataConnectionString:
          "Data Source=PC\\PC;Initial Catalog=Datos;User ID=sa;Password=x;Trust Server Certificate=True",
      },
    }),
    "utf8"
  );
  return dir;
}

test("readConnString: una cadena vacia en appsettings.json no cuenta, gana appsettings.Development.json", () => {
  const dir = coreProject();
  const r = readConnString(path.join(dir, "appsettings.json"), "DataConnectionString");
  assert.match(r.value, /Initial Catalog=Datos/);
  assert.strictEqual(path.basename(r.source), "appsettings.Development.json");
});

test("readConnString: apuntar directamente al fichero de entorno tambien funciona", () => {
  const dir = coreProject();
  const r = readConnString(
    path.join(dir, "appsettings.Development.json"),
    "ConfConnectionString"
  );
  assert.match(r.value, /Initial Catalog=Conf/);
});

test("readConnString: el nombre de la conexion es insensible a mayusculas", () => {
  const dir = coreProject();
  const r = readConnString(path.join(dir, "appsettings.json"), "dataconnectionstring");
  assert.match(r.value, /Initial Catalog=Datos/);
});

test("readConnString: --environment elige otro fichero de entorno", () => {
  const dir = coreProject();
  fs.writeFileSync(
    path.join(dir, "appsettings.Staging.json"),
    JSON.stringify({
      ConnectionStrings: {
        DataConnectionString:
          "Data Source=STG;Initial Catalog=Staging;User ID=sa;Password=x",
      },
    }),
    "utf8"
  );
  const r = readConnString(path.join(dir, "appsettings.json"), "DataConnectionString", {
    environment: "Staging",
  });
  assert.match(r.value, /Initial Catalog=Staging/);
});

test("readConnString: si solo hay cadena vacia, el error lo dice y sugiere el entorno", () => {
  const dir = tempDir("wrapper-empty-");
  fs.writeFileSync(
    path.join(dir, "appsettings.json"),
    JSON.stringify({ ConnectionStrings: { DataConnectionString: "" } }),
    "utf8"
  );
  assert.throws(
    () => readConnString(path.join(dir, "appsettings.json"), "DataConnectionString"),
    (err) =>
      /esta vacia/.test(err.message) &&
      /appsettings\.Development\.json/.test(err.message)
  );
});

test("readConnString: un nombre inexistente lista los disponibles", () => {
  const dir = coreProject();
  assert.throws(
    () => readConnString(path.join(dir, "appsettings.json"), "NoExiste"),
    /Disponibles: .*DataConnectionString/
  );
});

test("readConnString: tolera BOM en el appsettings.json", () => {
  const dir = tempDir("wrapper-bom-");
  const body = JSON.stringify({
    ConnectionStrings: {
      DataConnectionString: "Data Source=PC;Initial Catalog=BD;User ID=sa;Password=x",
    },
  });
  fs.writeFileSync(path.join(dir, "appsettings.json"), "\uFEFF" + body, "utf8");
  const r = readConnString(path.join(dir, "appsettings.json"), "DataConnectionString");
  assert.match(r.value, /Initial Catalog=BD/);
});

test("appSettingsChain: entorno primero, luego el fichero dado, luego su base", () => {
  const dir = coreProject();
  const chain = appSettingsChain(path.join(dir, "appsettings.json"), "Development");
  assert.deepStrictEqual(
    chain.map((p) => path.basename(p)),
    ["appsettings.Development.json", "appsettings.json"]
  );
});

test("resolveConfigFile: una carpeta resuelve a su appsettings.json", () => {
  const dir = coreProject();
  assert.strictEqual(resolveConfigFile(dir), path.join(dir, "appsettings.json"));
});

test("resolveConfigFile: una carpeta sin fichero de configuracion falla claro", () => {
  const dir = tempDir("wrapper-vacio-");
  assert.throws(() => resolveConfigFile(dir), /no contiene appsettings\.json ni Web\.config/);
});

test("listConnectionNames recorre toda la cadena de ficheros", () => {
  const dir = coreProject();
  const names = listConnectionNames(path.join(dir, "appsettings.json")).sort();
  assert.deepStrictEqual(names, ["ConfConnectionString", "DataConnectionString"]);
});

// ── Web.config (.NET Framework) ──

test("readWebConfigConnections: se acota a <connectionStrings> y no confunde otras secciones", () => {
  const dir = tempDir("wrapper-fw-");
  const file = path.join(dir, "Web.config");
  fs.writeFileSync(
    file,
    `<?xml version="1.0"?>
<configuration>
  <connectionStrings>
    <add name="DataConnectionString"
         connectionString="Data Source=PC;Initial Catalog=BD;User ID=sa;Password=x&amp;y" />
  </connectionStrings>
  <system.data>
    <DbProviderFactories>
      <add name="DataConnectionString" invariant="trampa" />
    </DbProviderFactories>
  </system.data>
</configuration>`,
    "utf8"
  );
  const conns = readWebConfigConnections(file);
  assert.deepStrictEqual(Object.keys(conns), ["DataConnectionString"]);
  // Y las entidades XML se decodifican.
  assert.match(conns.DataConnectionString, /Password=x&y/);
});

test("readWebConfigConnections: un <clear /> inicial no corta la seccion", () => {
  // Forma real de los Web.config de Flexygo: <clear /> antes de las entradas, para
  // descartar las cadenas heredadas de machine.config.
  const dir = tempDir("wrapper-clear-");
  const file = path.join(dir, "Web.config");
  fs.writeFileSync(
    file,
    `<?xml version="1.0"?>
<configuration>
  <connectionStrings>
    <clear />
    <add name="ConfConnectionString"
         connectionString="Data Source=PC;Initial Catalog=Conf;User ID=sa;Password=x" />
    <add name="DataConnectionString"
         connectionString="Data Source=PC;Initial Catalog=Datos;User ID=sa;Password=x" />
  </connectionStrings>
</configuration>`,
    "utf8"
  );
  const conns = readWebConfigConnections(file);
  assert.deepStrictEqual(Object.keys(conns), [
    "ConfConnectionString",
    "DataConnectionString",
  ]);
  assert.match(conns.DataConnectionString, /Initial Catalog=Datos/);
});

test("readWebConfigConnections: admite <add></add> no autocerrado", () => {
  const dir = tempDir("wrapper-fw2-");
  const file = path.join(dir, "Web.config");
  fs.writeFileSync(
    file,
    `<configuration><connectionStrings>
      <add name="X" connectionString="Data Source=PC;Initial Catalog=BD"></add>
    </connectionStrings></configuration>`,
    "utf8"
  );
  assert.match(readWebConfigConnections(file).X, /Initial Catalog=BD/);
});

test("readWebConfigConnections: sigue configSource a un fichero externo", () => {
  const dir = tempDir("wrapper-fw3-");
  fs.writeFileSync(
    path.join(dir, "Web.config"),
    `<configuration><connectionStrings configSource="connections.config" /></configuration>`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "connections.config"),
    `<connectionStrings><add name="X" connectionString="Data Source=PC;Initial Catalog=Externa" /></connectionStrings>`,
    "utf8"
  );
  const r = readConnString(path.join(dir, "Web.config"), "X");
  assert.match(r.value, /Initial Catalog=Externa/);
});

test("readWebConfigConnections: un configSource inexistente falla nombrandolo", () => {
  const dir = tempDir("wrapper-fw4-");
  fs.writeFileSync(
    path.join(dir, "Web.config"),
    `<configuration><connectionStrings configSource="no-existe.config" /></configuration>`,
    "utf8"
  );
  assert.throws(
    () => readWebConfigConnections(path.join(dir, "Web.config")),
    /no-existe\.config/
  );
});

// ── Eleccion de fuente ──

test("resolveSources: sin argumentos devuelve 'none'", () => {
  assert.strictEqual(resolveSources(args()).kind, "none");
});

test("resolveSources: rechaza mezclar fuentes", () => {
  assert.throws(
    () =>
      resolveSources(
        args({ configFile: "W.config", connections: ["X"], fromEnv: true })
      ),
    /una sola fuente/
  );
});

test("resolveSources: --config-file sin --connection-name lista los nombres disponibles", () => {
  const dir = coreProject();
  assert.throws(
    () => resolveSources(args({ configFile: dir })),
    (err) =>
      /Falta --connection-name/.test(err.message) &&
      /DataConnectionString/.test(err.message)
  );
});

test("resolveSources: varias --connection-string exigen tantos --alias", () => {
  assert.throws(
    () => resolveSources(args({ connectionStrings: ["a", "b"], aliases: ["solo-uno"] })),
    /hacen falta 2 --alias/
  );
  assert.strictEqual(
    resolveSources(args({ connectionStrings: ["a", "b"], aliases: ["c", "d"] })).kind,
    "connectionString"
  );
});

test("resolveSources: una sola --connection-string no necesita alias", () => {
  assert.strictEqual(
    resolveSources(args({ connectionStrings: ["a"] })).kind,
    "connectionString"
  );
});

test("resolveSources: los datos sueltos deben estar completos", () => {
  assert.throws(
    () => resolveSources(args({ server: "PC", database: "BD" })),
    /--user, --password/
  );
  assert.strictEqual(
    resolveSources(args({ server: "PC", database: "BD", user: "sa", password: "x" }))
      .kind,
    "flags"
  );
});

// ── --from-env ──

test("cleanEnv(true) deja pasar las MSSQL_* de conexion pero nunca las de politica", () => {
  const env = cleanEnv(true, {
    PATH: "x",
    MSSQL_SERVER: "PC",
    MSSQL_DATABASE: "BD",
    MSSQL_ENABLE_WRITES: "true",
    MSSQL_SQL_DIRS: "C:\\trampa",
  });
  assert.strictEqual(env.MSSQL_SERVER, "PC");
  assert.strictEqual(env.MSSQL_DATABASE, "BD");
  assert.ok(!("MSSQL_ENABLE_WRITES" in env), "la politica no puede venir del entorno");
  assert.ok(!("MSSQL_SQL_DIRS" in env), "la politica no puede venir del entorno");
});

test("cleanEnv(true) tampoco deja pasar una MSSQL_<ALIAS>_ENABLE_WRITES heredada", () => {
  const env = cleanEnv(true, {
    MSSQL_CONFIG_DATABASE: "BD1",
    MSSQL_DATA_DATABASE: "BD2",
    MSSQL_DATA_ENABLE_WRITES: "true",
  });
  assert.strictEqual(env.MSSQL_CONFIG_DATABASE, "BD1");
  assert.strictEqual(env.MSSQL_DATA_DATABASE, "BD2");
  assert.ok(
    !("MSSQL_DATA_ENABLE_WRITES" in env),
    "la escritura por alias tampoco puede venir del entorno heredado"
  );
});

test("describeEnvConnections: modo simple y modo multi", () => {
  assert.deepStrictEqual(
    describeEnvConnections({ MSSQL_SERVER: "PC", MSSQL_DATABASE: "BD" }),
    [{ key: "maindb", target: "PC", database: "BD", viaInstance: false }]
  );
  const multi = describeEnvConnections({
    MSSQL_SERVER: "PC",
    MSSQL_CONFIG_DATABASE: "Conf",
    MSSQL_DATA_DATABASE: "Datos",
  });
  assert.deepStrictEqual(multi.map((c) => c.key).sort(), ["config", "data"]);
});

test("describeEnvConnections: sin MSSQL_* de conexion falla explicando que poner", () => {
  assert.throws(() => describeEnvConnections({ PATH: "x" }), /--from-env no ha encontrado/);
});

// ── --credentials-file ──

function writeCreds(doc) {
  const dir = tempDir("wrapper-creds-");
  const file = path.join(dir, "creds.json");
  fs.writeFileSync(file, JSON.stringify(doc), "utf8");
  return file;
}

test("readCredentialsFile: el wrapper NO descifra; pasa el token tal cual", () => {
  // El descifrado cuesta un arranque de PowerShell y aqui se pagaria antes de que el
  // servidor exista, dentro del CONNECT_TIMEOUT del cliente. Lo abre el servidor en el
  // primer uso (src/config.js); este test fija que el wrapper no lo toque.
  const { protect } = require("../src/secrets");
  const token = protect("contrasena-secreta");
  const file = writeCreds({
    server: "PC",
    database: "BD",
    user: "sa",
    passwordEnc: token,
  });
  assert.ok(
    !fs.readFileSync(file, "utf8").includes("contrasena-secreta"),
    "el fichero no puede tener la contrasena en claro"
  );
  const env = {};
  applyConnection(env, "MSSQL_", readCredentialsFile(file)[0].parts, "creds");
  assert.equal(env.MSSQL_PASSWORD, token);
  assert.ok(
    !JSON.stringify(env).includes("contrasena-secreta"),
    "la contrasena en claro no puede aparecer en el entorno que prepara el wrapper"
  );
});

test("readCredentialsFile: un passwordEnc sin marca reconocible falla al arrancar", () => {
  // Comprobar la FORMA es gratis (no lanza PowerShell), asi que un fichero corrupto
  // sigue fallando aqui y no en la primera consulta.
  const file = writeCreds({
    server: "PC",
    database: "BD",
    user: "sa",
    passwordEnc: "esto-no-es-un-token",
  });
  assert.throws(() => readCredentialsFile(file), /marca de cifrado reconocible/);
});

test("readCredentialsFile: multi-BD cifrado, cada clave con su token", () => {
  // Si el orden se cruzara, cada BD arrancaria con la contrasena de la otra y el error
  // no diria por que.
  const { protectAll } = require("../src/secrets");
  const [conf, data] = protectAll(["clave-conf", "clave-data"]);
  const file = writeCreds({
    connections: {
      config: { server: "PC", database: "Conf", user: "sa", passwordEnc: conf },
      data: { server: "PC", database: "Datos", user: "sa", passwordEnc: data },
    },
  });
  const entries = readCredentialsFile(file);
  const env = {};
  applyConnection(env, "MSSQL_CONFIG_", entries[0].parts, "config");
  applyConnection(env, "MSSQL_DATA_", entries[1].parts, "data");
  assert.equal(env.MSSQL_CONFIG_PASSWORD, conf);
  assert.equal(env.MSSQL_DATA_PASSWORD, data);

  // Y el servidor las abre en el orden correcto, que es lo que de verdad importa.
  const { loadConfigsFromEnv, _resetForTests } = require("../src/config");
  _resetForTests();
  const { configs } = loadConfigsFromEnv({
    ...env,
    MSSQL_CONFIG_SERVER: "PC",
    MSSQL_DATA_SERVER: "PC",
    MSSQL_CONFIG_USER: "sa",
    MSSQL_DATA_USER: "sa",
  });
  assert.equal(configs.config.password, "clave-conf");
  assert.equal(configs.data.password, "clave-data");
});

test("readCredentialsFile: forma simple", () => {
  const file = writeCreds({
    server: "PC_158\\SQL2022",
    database: "BD",
    user: "sa",
    password: "x",
  });
  const entries = readCredentialsFile(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].alias, undefined);

  const env = {};
  const info = applyConnection(env, "MSSQL_", entries[0].parts, "creds");
  assert.equal(env.MSSQL_SERVER, "PC_158");
  assert.equal(env.MSSQL_INSTANCE_NAME, "SQL2022");
  assert.equal(env.MSSQL_DATABASE, "BD");
  assert.equal(info.database, "BD");
});

test("readCredentialsFile: el puerto explicito descarta la instancia", () => {
  const file = writeCreds({
    server: "10.0.0.9",
    port: 1433,
    database: "BD",
    user: "sa",
    password: "x",
  });
  const env = {};
  applyConnection(env, "MSSQL_", readCredentialsFile(file)[0].parts, "creds");
  assert.equal(env.MSSQL_PORT, "1433");
  assert.ok(!("MSSQL_INSTANCE_NAME" in env));
});

test("readCredentialsFile: forma multi-BD, la clave es el dbKey", () => {
  const file = writeCreds({
    connections: {
      config: { server: "PC", database: "Conf", user: "sa", password: "x" },
      data: { server: "PC", database: "Datos", user: "sa", password: "x" },
    },
  });
  const entries = readCredentialsFile(file);
  assert.deepEqual(
    entries.map((e) => e.alias),
    ["config", "data"]
  );
});

test("readCredentialsFile: encrypt y trustServerCertificate booleanos se aceptan", () => {
  const file = writeCreds({
    server: "PC",
    database: "BD",
    user: "sa",
    password: "x",
    encrypt: false,
    trustServerCertificate: true,
  });
  const env = {};
  applyConnection(env, "MSSQL_", readCredentialsFile(file)[0].parts, "creds");
  assert.equal(env.MSSQL_ENCRYPT, "false");
  assert.equal(env.MSSQL_TRUST_SERVER_CERTIFICATE, "true");
});

test("readCredentialsFile: errores accionables", () => {
  assert.throws(() => readCredentialsFile("C:\\no-existe\\creds.json"), /No existe el fichero/);

  const dir = tempDir("wrapper-creds-malo-");
  const roto = path.join(dir, "roto.json");
  fs.writeFileSync(roto, "{ no soy json", "utf8");
  assert.throws(() => readCredentialsFile(roto), /no se pudo interpretar|No se pudo interpretar/i);

  assert.throws(() => readCredentialsFile(writeCreds({ connections: {} })), /no declara ninguna conexion/);
});

test("resolveSources: --credentials-file es una fuente y excluye a las demas", () => {
  const file = writeCreds({ server: "PC", database: "BD", user: "sa", password: "x" });
  assert.equal(resolveSources(args({ credentialsFile: file })).kind, "credentialsFile");
  assert.throws(
    () => resolveSources(args({ credentialsFile: file, fromEnv: true })),
    /una sola fuente/
  );
});

// ── --production ──

test("parseArgs: --production se recoge y por defecto es false", () => {
  assert.equal(parseArgs(["--production"]).production, true);
  assert.equal(parseArgs([]).production, false);
});
