const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const {
  instanceToResolve,
  resolveEndpoint,
  invalidateEndpoint,
  getResolvedEndpoints,
  _resetForTests,
} = require("../src/db/endpoint");

test.beforeEach(() => _resetForTests());

/** Una config como la que deja `buildConfig`, con instancia y sin puerto. */
function withInstance(overrides = {}) {
  return {
    server: "localhost",
    user: "sa",
    password: "x",
    database: "BD",
    options: {
      encrypt: false,
      trustServerCertificate: true,
      instanceName: "SQL2022",
    },
    connectionTimeout: 30000,
    requestTimeout: 30000,
    ...overrides,
  };
}

/** Un sondeo de mentira que apunta lo que se le pregunta. */
function fakeDiscover(answer) {
  const calls = [];
  return {
    calls,
    discover: async (names, options) => {
      calls.push({ names, refresh: Boolean(options.refresh) });
      return Object.fromEntries(names.map((n) => [n, answer]));
    },
  };
}

const quiet = () => {};

// ── instanceToResolve ────────────────────────────────────────────────────────

test("instanceToResolve: instancia local sin puerto, si", () => {
  assert.equal(instanceToResolve(withInstance()), "SQL2022");
});

test("instanceToResolve: sin instancia, no hay nada que resolver", () => {
  const cfg = withInstance({
    options: { encrypt: false, trustServerCertificate: true },
  });
  assert.equal(instanceToResolve(cfg), null);
});

test("instanceToResolve: con puerto ya resuelto, no", () => {
  assert.equal(instanceToResolve(withInstance({ port: 1433 })), null);
});

test("instanceToResolve: una instancia REMOTA no se puede sondear desde aqui", () => {
  assert.equal(
    instanceToResolve(withInstance({ server: "OTRO_EQUIPO" })),
    null
  );
});

test("instanceToResolve: el nombre de esta maquina cuenta como local", () => {
  const cfg = withInstance({ server: os.hostname() });
  assert.equal(instanceToResolve(cfg), "SQL2022");
});

// ── resolveEndpoint ──────────────────────────────────────────────────────────

test("resolveEndpoint: sin nada que resolver devuelve la MISMA config, sin sondear", async () => {
  const cfg = withInstance({ port: 1433 });
  const { discover, calls } = fakeDiscover({ port: "9999" });
  const out = await resolveEndpoint("k", cfg, { discover, log: quiet });
  assert.equal(out, cfg, "la misma referencia, no una copia");
  assert.equal(calls.length, 0);
});

test("resolveEndpoint: pone el puerto averiguado y quita la instancia", async () => {
  // tedious rechaza puerto e instancia a la vez, asi que la instancia TIENE que salir.
  const { discover } = fakeDiscover({ port: "54220" });
  const out = await resolveEndpoint("k", withInstance(), {
    discover,
    log: quiet,
  });
  assert.equal(out.port, 54220);
  assert.equal("instanceName" in out.options, false);
  assert.equal(out.server, "localhost");
  // El resto de la config viaja intacta.
  assert.equal(out.database, "BD");
  assert.equal(out.requestTimeout, 30000);
});

test("resolveEndpoint: si la instancia solo escucha en loopback, cambia el host", async () => {
  const { discover } = fakeDiscover({ port: "54220", address: "127.0.0.1" });
  const out = await resolveEndpoint(
    "k",
    withInstance({ server: os.hostname() }),
    {
      discover,
      log: quiet,
    }
  );
  assert.equal(out.server, "127.0.0.1");
  assert.equal(out.port, 54220);
});

test("resolveEndpoint: solo sondea una vez por conexion", async () => {
  const { discover, calls } = fakeDiscover({ port: "54220" });
  const cfg = withInstance();
  const first = await resolveEndpoint("k", cfg, { discover, log: quiet });
  const second = await resolveEndpoint("k", cfg, { discover, log: quiet });
  assert.equal(first, second);
  assert.equal(
    calls.length,
    1,
    "cuatro segundos de PowerShell se pagan una sola vez"
  );
});

test("resolveEndpoint: un sondeo sin resultado deja la config tal cual", async () => {
  // Se intenta por nombre de instancia, que es lo que se hacia antes de sondear nada:
  // mejor eso que no intentarlo.
  const { discover } = fakeDiscover(null);
  const cfg = withInstance();
  const out = await resolveEndpoint("k", cfg, { discover, log: quiet });
  assert.equal(out, cfg);
  assert.equal(out.options.instanceName, "SQL2022");
});

test("invalidateEndpoint: la siguiente resolucion vuelve a preguntar, saltandose la cache", async () => {
  // Es el caso que antes exigia reiniciar el proceso: el servicio SQL arranca con otro
  // puerto dinamico y el que teniamos apuntado ya no lleva a ninguna parte.
  const primero = fakeDiscover({ port: "54220" });
  const cfg = withInstance();
  const antes = await resolveEndpoint("k", cfg, {
    discover: primero.discover,
    log: quiet,
  });
  assert.equal(antes.port, 54220);

  invalidateEndpoint("k");

  const segundo = fakeDiscover({ port: "60001" });
  const despues = await resolveEndpoint("k", cfg, {
    discover: segundo.discover,
    log: quiet,
  });
  assert.equal(despues.port, 60001);
  assert.equal(
    segundo.calls[0].refresh,
    true,
    "con refresh: la cache en disco tiene el puerto viejo y reutilizarla seria repetir el fallo"
  );
});

test("resolveEndpoint: cada conexion resuelve la suya", async () => {
  const { discover, calls } = fakeDiscover({ port: "54220" });
  await resolveEndpoint("config", withInstance(), { discover, log: quiet });
  await resolveEndpoint("data", withInstance(), { discover, log: quiet });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(getResolvedEndpoints()), ["config", "data"]);
});

test("getResolvedEndpoints: cuenta lo resuelto y si esta en sospecha", async () => {
  const { discover } = fakeDiscover({ port: "54220" });
  await resolveEndpoint("k", withInstance(), { discover, log: quiet });
  assert.deepEqual(getResolvedEndpoints().k, {
    server: "localhost",
    port: 54220,
    instanceName: undefined,
    stale: false,
  });
  invalidateEndpoint("k");
  assert.equal(getResolvedEndpoints().k.stale, true);
});
