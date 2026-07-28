const test = require("node:test");
const assert = require("node:assert");

const {
  parseArgs,
  parseAdoConnectionString,
  parseDataSource,
  cleanEnv,
  applyConnection,
} = require("../bin/start-mssql-mcp");

test("parseDataSource: host suelto", () => {
  assert.deepStrictEqual(parseDataSource("10.0.0.9"), {
    host: "10.0.0.9",
    instanceName: undefined,
    port: undefined,
  });
});

test("parseDataSource: instancia nombrada", () => {
  assert.deepStrictEqual(parseDataSource("PC_158\\PC_158"), {
    host: "PC_158",
    instanceName: "PC_158",
    port: undefined,
  });
});

test("parseDataSource: host con puerto", () => {
  assert.deepStrictEqual(parseDataSource("PC_158,1433"), {
    host: "PC_158",
    instanceName: undefined,
    port: "1433",
  });
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
  assert.strictEqual(parts["user id"], "sa");
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
