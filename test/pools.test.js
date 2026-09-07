const test = require("node:test");
const assert = require("node:assert/strict");
const tarn = require("tarn");
const {
  getPool,
  withAcquireReset,
  closeAllPools,
  getConnectionStatus,
  _resetForTests,
} = require("../src/db/pools");
const { getResolvedEndpoints } = require("../src/db/endpoint");

test.beforeEach(() => _resetForTests());
test.afterEach(async () => {
  await closeAllPools();
  _resetForTests();
});

function makeFakeMssql(opts = {}) {
  const events = { connects: 0, closes: 0 };
  const created = [];
  function ConnectionPool(cfg) {
    this.cfg = cfg;
    const handlers = {};
    this.connect = async () => {
      events.connects++;
      if (opts.gate) await opts.gate;
      if (opts.failConnect) throw new Error("boom");
      this.connected = true;
      return this;
    };
    this.close = async () => {
      events.closes++;
      this.connected = false;
    };
    this.on = (name, fn) => {
      (handlers[name] = handlers[name] || []).push(fn);
    };
    /** Dispara un evento del pool, como haria mssql al perder la conexion. */
    this.emit = (name, ...args) => {
      for (const fn of handlers[name] || []) fn(...args);
    };
    created.push(this);
  }
  return { ConnectionPool, events, created };
}

/** Un error de los que hacen sospechar del endpoint. */
function endpointError(code) {
  const err = new Error("se ha caido");
  err.code = code;
  return err;
}

test("getPool returns the same pool for the same dbKey (single connect)", async () => {
  const { ConnectionPool, events } = makeFakeMssql();
  const p1 = await getPool("k", { server: "x" }, { ConnectionPool });
  const p2 = await getPool("k", { server: "x" }, { ConnectionPool });
  assert.equal(p1, p2);
  assert.equal(events.connects, 1);
});

test("getPool resolves concurrent calls to one pool", async () => {
  const { ConnectionPool, events } = makeFakeMssql();
  const [p1, p2] = await Promise.all([
    getPool("k", {}, { ConnectionPool }),
    getPool("k", {}, { ConnectionPool }),
  ]);
  assert.equal(p1, p2);
  assert.equal(events.connects, 1);
});

test("closeAllPools closes every cached pool", async () => {
  const { ConnectionPool, events } = makeFakeMssql();
  await getPool("a", {}, { ConnectionPool });
  await getPool("b", {}, { ConnectionPool });
  await closeAllPools();
  assert.equal(events.closes, 2);
});

test("getPool retries after a failed connect", async () => {
  const { ConnectionPool: FailingPool } = makeFakeMssql({ failConnect: true });
  await assert.rejects(() => getPool("z", {}, { ConnectionPool: FailingPool }));
  const status = getConnectionStatus();
  assert.equal(status.z.status, "error");

  const { ConnectionPool: GoodPool, events } = makeFakeMssql();
  await getPool("z", {}, { ConnectionPool: GoodPool });
  assert.equal(events.connects, 1, "second attempt should connect");
  assert.equal(getConnectionStatus().z.status, "connected");
});

test("getPool stores sanitized error (no raw message)", async () => {
  function PoolWithRichError() {
    this.connect = async () => {
      const err = new Error(
        "Login failed for user 'sa' with password='secret'"
      );
      err.name = "ConnectionError";
      err.code = "ELOGIN";
      throw err;
    };
    this.close = async () => {};
    this.on = () => {};
  }
  await assert.rejects(() =>
    getPool("leaky", {}, { ConnectionPool: PoolWithRichError })
  );
  const status = getConnectionStatus();
  assert.equal(status.leaky.lastError.name, "ConnectionError");
  assert.equal(status.leaky.lastError.code, "ELOGIN");
  // Critical: must NOT carry the raw message
  assert.equal(status.leaky.lastError.message, undefined);
  const serialized = JSON.stringify(status.leaky.lastError);
  assert.equal(/password=/.test(serialized), false);
  assert.equal(/secret/.test(serialized), false);
});

test("getPool adds an actionable hint for connection codes, from the code alone", async () => {
  // A bare ECONNRESET tells the caller nothing, so the hint has to point at the endpoint
  // itself - and at the fact that a retry now re-discovers it.
  function PoolThatResets() {
    this.connect = async () => {
      const err = new Error("Failed to connect to ::1:64357 - read ECONNRESET");
      err.name = "ConnectionError";
      err.code = "ECONNRESET";
      throw err;
    };
    this.close = async () => {};
    this.on = () => {};
  }
  await assert.rejects(() =>
    getPool("reset", {}, { ConnectionPool: PoolThatResets })
  );
  const { reset } = getConnectionStatus();
  assert.equal(reset.lastError.code, "ECONNRESET");
  assert.match(reset.lastError.hint, /--port/);
  // Still derived from the code, never from the message.
  assert.equal(/64357/.test(JSON.stringify(reset.lastError)), false);
});

test("getPool leaves no hint for a code it does not know", async () => {
  function PoolOddError() {
    this.connect = async () => {
      const err = new Error("boom");
      err.code = "EWHATEVER";
      throw err;
    };
    this.close = async () => {};
    this.on = () => {};
  }
  await assert.rejects(() => getPool("odd", {}, { ConnectionPool: PoolOddError }));
  assert.equal(getConnectionStatus().odd.lastError.hint, undefined);
});

// ── un pool roto se reemplaza solo ──────────────────────────────────────────

test("getPool reemplaza un pool que se rompio despues de conectar", async () => {
  // El caso real: el servicio SQL se reinicia, o el portatil suspende. Antes el pool
  // roto se quedaba cacheado para siempre y todas las tools fallaban hasta reiniciar
  // el servidor entero.
  const { ConnectionPool, events, created } = makeFakeMssql();
  const primero = await getPool("k", {}, { ConnectionPool });
  assert.equal(getConnectionStatus().k.status, "connected");

  created[0].emit("error", endpointError("ECONNRESET"));
  assert.equal(getConnectionStatus().k.status, "error");

  const segundo = await getPool("k", {}, { ConnectionPool });
  assert.notEqual(segundo, primero, "hace falta un pool nuevo, no el roto");
  assert.equal(events.connects, 2);
  assert.equal(getConnectionStatus().k.status, "connected");
});

test("getPool cierra el pool que descarta, sin esperar a que el cierre acabe", async () => {
  const { ConnectionPool, events, created } = makeFakeMssql();
  await getPool("k", {}, { ConnectionPool });
  created[0].emit("error", endpointError("ESOCKET"));
  await getPool("k", {}, { ConnectionPool });
  // El cierre va suelto: se le da un turno al bucle de eventos para verlo.
  await new Promise((r) => setImmediate(r));
  assert.equal(events.closes, 1, "el pool viejo no se queda abierto");
});

test("getPool descarta el endpoint del pool roto, para volver a averiguar el puerto", async () => {
  // Un pool que conectaba y deja de conectar apunta al puerto: una instancia dinamica
  // estrena puerto en cada arranque del servicio.
  const { ConnectionPool, created } = makeFakeMssql();
  await getPool("k", {}, { ConnectionPool });
  assert.equal(getResolvedEndpoints().k.stale, false);
  created[0].emit("error", endpointError("ECONNRESET"));
  await getPool("k", {}, { ConnectionPool });
  assert.equal(
    getResolvedEndpoints().k.stale,
    false,
    "resuelto de nuevo, asi que la sospecha ya se ha atendido"
  );
});

test("un connect fallido por el endpoint deja la resolucion en sospecha", async () => {
  function PoolThatResets() {
    this.connect = async () => {
      throw endpointError("ECONNRESET");
    };
    this.close = async () => {};
    this.on = () => {};
  }
  await assert.rejects(() => getPool("k", {}, { ConnectionPool: PoolThatResets }));
  assert.equal(getResolvedEndpoints().k.stale, true);
});

test("un connect fallido por credenciales NO toca la resolucion", async () => {
  // Sondear otra vez costaria cuatro segundos por intento y el endpoint es correcto.
  function PoolThatRejectsLogin() {
    this.connect = async () => {
      throw endpointError("ELOGIN");
    };
    this.close = async () => {};
    this.on = () => {};
  }
  await assert.rejects(() => getPool("k", {}, { ConnectionPool: PoolThatRejectsLogin }));
  assert.equal(getResolvedEndpoints().k.stale, false);
});

test("dos llamadas concurrentes no se tiran el pool que la otra esta creando", async () => {
  // Con la marca de roto en el mapa `status` compartido en vez de en la entrada, este es
  // el caso que se rompia: `status` sigue diciendo "error" por el intento ANTERIOR
  // mientras el pool nuevo todavia esta conectando.
  const { ConnectionPool: Failing } = makeFakeMssql({ failConnect: true });
  await assert.rejects(() => getPool("k", {}, { ConnectionPool: Failing }));
  assert.equal(getConnectionStatus().k.status, "error");

  let abrir;
  const gate = new Promise((r) => (abrir = r));
  const { ConnectionPool, events } = makeFakeMssql({ gate });
  const a = getPool("k", {}, { ConnectionPool });
  const b = getPool("k", {}, { ConnectionPool });
  abrir();
  const [p1, p2] = await Promise.all([a, b]);
  assert.equal(p1, p2);
  assert.equal(events.connects, 1, "un solo connect, no uno por llamada");
});

// -- el saneado al coger conexion del pool ---------------------------------

test("getPool monta el saneado al adquirir, sin perder las opciones del pool", async () => {
  // Esta es la cura que hace que el fallo se cure solo: sin un validate propio, una
  // conexion que quedo con @@TRANCOUNT > 0 se reparte tal cual a la siguiente llamada.
  const { ConnectionPool, created } = makeFakeMssql();
  await getPool(
    "k",
    { server: "x", pool: { max: 7, min: 1, idleTimeoutMillis: 1234 } },
    { ConnectionPool }
  );
  const { pool } = created[0].cfg;
  assert.equal(typeof pool.validate, "function", "hay validate propio");
  assert.deepEqual(
    { max: pool.max, min: pool.min, idleTimeoutMillis: pool.idleTimeoutMillis },
    { max: 7, min: 1, idleTimeoutMillis: 1234 },
    "y las opciones configuradas siguen ahi"
  );
});

test("withAcquireReset no toca la config original ni pierde el resto de campos", () => {
  const original = { server: "x", requestTimeout: 30000, pool: { max: 3 } };
  const out = withAcquireReset(original);
  assert.equal(out.server, "x");
  assert.equal(out.requestTimeout, 30000);
  assert.equal(out.pool.max, 3);
  assert.equal(original.pool.validate, undefined, "la config de entrada no se muta");
});

test("withAcquireReset produce opciones que tarn acepta", () => {
  // tarn valida las claves que recibe y revienta con cualquiera que no conozca, asi que
  // colar aqui una opcion inventada rompe TODAS las conexiones al primer uso.
  const { pool } = withAcquireReset({
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  });
  const built = new tarn.Pool({
    create: () => Promise.resolve({}),
    destroy: () => {},
    propagateCreateError: true,
    ...pool,
  });
  assert.equal(built.validate, pool.validate, "tarn se queda con nuestro validate");
  return built.destroy();
});

test("withAcquireReset aguanta una config sin bloque pool", () => {
  const { pool } = withAcquireReset({ server: "x" });
  assert.equal(typeof pool.validate, "function");
});
