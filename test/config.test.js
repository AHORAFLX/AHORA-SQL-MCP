const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfigsFromEnv } = require("../src/config");

test("single-db mode loads from MSSQL_* variables", () => {
  const env = {
    MSSQL_SERVER: "s",
    MSSQL_USER: "u",
    MSSQL_PASSWORD: "p",
    MSSQL_DATABASE: "d",
    MSSQL_ENCRYPT: "true",
  };
  const { configs, mode } = loadConfigsFromEnv(env);
  assert.equal(mode, "single");
  assert.ok(configs.maindb);
  assert.equal(configs.maindb.server, "s");
  assert.equal(configs.maindb.options.encrypt, true);
  assert.equal(configs.maindb.options.trustServerCertificate, true);
});

test("trustServerCertificate honors MSSQL_TRUST_SERVER_CERTIFICATE=false", () => {
  const { configs } = loadConfigsFromEnv({
    MSSQL_SERVER: "s",
    MSSQL_USER: "u",
    MSSQL_PASSWORD: "p",
    MSSQL_DATABASE: "d",
    MSSQL_TRUST_SERVER_CERTIFICATE: "false",
  });
  assert.equal(configs.maindb.options.trustServerCertificate, false);
});

test("multi-db mode loads each MSSQL_<NAME>_DATABASE", () => {
  const env = {
    MSSQL_REPORTING_SERVER: "r",
    MSSQL_REPORTING_USER: "u",
    MSSQL_REPORTING_PASSWORD: "p",
    MSSQL_REPORTING_DATABASE: "rd",
    MSSQL_ANALYTICS_SERVER: "a",
    MSSQL_ANALYTICS_USER: "u",
    MSSQL_ANALYTICS_PASSWORD: "p",
    MSSQL_ANALYTICS_DATABASE: "ad",
  };
  const { configs, mode } = loadConfigsFromEnv(env);
  assert.equal(mode, "multi");
  assert.deepEqual(
    new Set(Object.keys(configs)),
    new Set(["reporting", "analytics"])
  );
  assert.equal(configs.reporting.database, "rd");
  assert.equal(configs.analytics.database, "ad");
});

test("multi-db keys are lowercased", () => {
  const env = {
    MSSQL_MAINDB_SERVER: "s",
    MSSQL_MAINDB_USER: "u",
    MSSQL_MAINDB_PASSWORD: "p",
    MSSQL_MAINDB_DATABASE: "d",
  };
  const { configs } = loadConfigsFromEnv(env);
  assert.ok(configs.maindb);
});

test("multi-db falls back to global creds when per-db creds missing", () => {
  const env = {
    MSSQL_USER: "u",
    MSSQL_PASSWORD: "p",
    MSSQL_SERVER: "s",
    MSSQL_FOO_DATABASE: "foo",
  };
  const { configs } = loadConfigsFromEnv(env);
  assert.equal(configs.foo.user, "u");
  assert.equal(configs.foo.server, "s");
});

test("throws when no config present", () => {
  assert.throws(
    () => loadConfigsFromEnv({}),
    /No valid database configuration/
  );
});

test("port is coerced to number", () => {
  const { configs } = loadConfigsFromEnv({
    MSSQL_SERVER: "s",
    MSSQL_USER: "u",
    MSSQL_PASSWORD: "p",
    MSSQL_DATABASE: "d",
    MSSQL_PORT: "1433",
  });
  assert.equal(configs.maindb.port, 1433);
});

// -- descifrado perezoso de la contrasena --
//
// El wrapper ya no descifra antes de arrancar: manda el token en MSSQL_*_PASSWORD y se
// abre aqui, en el primer uso. Estos tests fijan las tres cosas que eso exige: que se
// abra, que no se llame al descifrador cuando no hace falta, y que un solo lote cubra
// todas las conexiones.

test("una contrasena cifrada se descifra al construir la configuracion", () => {
  const { protect } = require("../src/secrets");
  const token = protect("clave-en-claro");
  const { configs } = loadConfigsFromEnv({
    MSSQL_SERVER: "s",
    MSSQL_USER: "u",
    MSSQL_PASSWORD: token,
    MSSQL_DATABASE: "d",
  });
  assert.equal(configs.maindb.password, "clave-en-claro");
});

test("sin nada cifrado no se llama al descifrador", () => {
  // Importa porque descifrar lanza PowerShell: el camino de --from-env con la
  // contrasena en claro no puede depender de que DPAPI este disponible.
  let llamadas = 0;
  const reveal = (vals) => {
    llamadas++;
    return vals;
  };
  const { configs } = loadConfigsFromEnv(
    {
      MSSQL_SERVER: "s",
      MSSQL_USER: "u",
      MSSQL_PASSWORD: "en-claro",
      MSSQL_DATABASE: "d",
    },
    { reveal }
  );
  assert.equal(llamadas, 0);
  assert.equal(configs.maindb.password, "en-claro");
});

test("multi-BD: un solo lote de descifrado para todas las conexiones", () => {
  // Uno por conexion serian tantos arranques de PowerShell como bases de datos.
  const { protectAll } = require("../src/secrets");
  const [a, b] = protectAll(["clave-a", "clave-b"]);
  let lotes = 0;
  const reveal = (vals) => {
    lotes++;
    const { revealAll } = require("../src/secrets");
    return revealAll(vals);
  };
  const { configs } = loadConfigsFromEnv(
    {
      MSSQL_SERVER: "s",
      MSSQL_USER: "u",
      MSSQL_CONFIG_DATABASE: "Conf",
      MSSQL_CONFIG_PASSWORD: a,
      MSSQL_DATA_DATABASE: "Datos",
      MSSQL_DATA_PASSWORD: b,
    },
    { reveal }
  );
  assert.equal(lotes, 1, "un unico lote, no uno por conexion");
  assert.equal(configs.config.password, "clave-a");
  assert.equal(configs.data.password, "clave-b");
});
