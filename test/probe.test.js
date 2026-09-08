const test = require("node:test");
const assert = require("node:assert/strict");

const { probeConnection, sanitizeError } = require("../installer/probe");

/** mssql de mentira: permite probar los dos caminos sin servidor. */
function fakeMssql({ failOn = null, db = "BD", version = "Microsoft SQL Server 2022\nmas" } = {}) {
  const events = [];
  return {
    events,
    ConnectionPool: function ConnectionPool(config) {
      events.push(["new", config]);
      this.connect = async () => {
        events.push(["connect"]);
        if (failOn === "connect") {
          throw Object.assign(new Error("Failed to connect"), { code: "ESOCKET" });
        }
      };
      this.request = () => ({
        query: async (sql) => {
          events.push(["query", sql]);
          if (failOn === "query") throw new Error("Login failed for user");
          return { recordset: [{ db, version }] };
        },
      });
      this.close = async () => {
        events.push(["close"]);
      };
    },
  };
}

const PARTS = {
  datasource: "PC_158\\SQL2022",
  initialcatalog: "BD",
  userid: "sa",
  password: "secreta",
};

test("probeConnection: conexion buena devuelve la BD real y la version", async () => {
  const mssql = fakeMssql({ db: "JAPOFISH" });
  const r = await probeConnection(PARTS, { mssql, discover: () => null });
  assert.equal(r.ok, true);
  assert.equal(r.target, "PC_158\\SQL2022");
  assert.equal(r.database, "JAPOFISH", "la BD sale de DB_NAME(), no de lo que se pidio");
  assert.equal(r.version, "Microsoft SQL Server 2022");
  assert.ok(mssql.events.some((e) => e[0] === "close"), "el pool debe cerrarse");
});

test("probeConnection: un fallo de conexion es un resultado, no una excepcion", async () => {
  const r = await probeConnection(PARTS, {
    mssql: fakeMssql({ failOn: "connect" }),
    discover: () => null,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Failed to connect/);
  assert.match(r.error, /ESOCKET/);
});

test("probeConnection: cierra el pool aunque falle la consulta", async () => {
  const mssql = fakeMssql({ failOn: "query" });
  const r = await probeConnection(PARTS, { mssql, discover: () => null });
  assert.equal(r.ok, false);
  assert.match(r.error, /Login failed/);
  assert.ok(mssql.events.some((e) => e[0] === "close"));
});

test("probeConnection: la contrasena nunca aparece en el error", async () => {
  const mssql = {
    ConnectionPool: function () {
      this.connect = async () => {
        // Peor caso: el driver mete la cadena entera en el mensaje.
        throw new Error("cannot connect using password=secreta");
      };
      this.close = async () => {};
    },
  };
  const r = await probeConnection(PARTS, { mssql, discover: () => null });
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes("secreta"), `la contrasena se ha filtrado: ${r.error}`);
  assert.match(r.error, /\*\*\*/);
});

test("probeConnection: unos datos incompletos fallan sin intentar conectar", async () => {
  const mssql = fakeMssql();
  const r = await probeConnection({ datasource: "PC", initialcatalog: "BD" }, { mssql, discover: () => null });
  assert.equal(r.ok, false);
  assert.match(r.error, /usuario y contrasena/i);
  assert.ok(!mssql.events.some((e) => e[0] === "connect"), "no debe llegar a conectar");
});

test("probeConnection aplica un timeout acotado, para no colgar una formacion", async () => {
  const mssql = fakeMssql();
  await probeConnection(PARTS, { mssql, timeoutMs: 1234, discover: () => null });
  const [, config] = mssql.events.find((e) => e[0] === "new");
  assert.equal(config.connectionTimeout, 1234);
  assert.equal(config.requestTimeout, 1234);
  assert.equal(config.pool.max, 1, "una sola conexion: es solo una prueba");
});

test("un timeout contra instancia nombrada sugiere el SQL Browser", async () => {
  // Sin esta pista el mensaje del driver es un callejon sin salida: parece que no
  // hay acceso a la BD cuando el acceso esta bien y lo que falta es el servicio.
  const mssql = {
    ConnectionPool: function () {
      this.connect = async () => {
        throw Object.assign(new Error("Failed to connect to PC_158\\SQL2022 in 8000ms"), {
          code: "ETIMEOUT",
        });
      };
      this.close = async () => {};
    },
  };
  const r = await probeConnection(PARTS, { mssql, discover: () => null });
  assert.equal(r.ok, false);
  assert.match(r.hint, /SQL Browser/);
  assert.match(r.hint, /--port/);
});

test("un EINSTLOOKUP de 'not found in' sugiere activar TCP/IP en la instancia", async () => {
  // Este es el caso que confunde de verdad: el SQL Browser SI contesta y SI conoce la
  // instancia (no es un timeout), pero no trae un puerto tcp en su respuesta porque esa
  // instancia solo tiene Named Pipes/memoria compartida. Sin pista, "Port for X not
  // found in Y" parece un problema de red o de nombre cuando en realidad falta TCP/IP.
  const mssql = {
    ConnectionPool: function () {
      this.connect = async () => {
        throw Object.assign(new Error("Port for SQLEXPRESS not found in PC_158"), {
          code: "EINSTLOOKUP",
        });
      };
      this.close = async () => {};
    },
  };
  const r = await probeConnection(PARTS, { mssql, discover: () => null });
  assert.equal(r.ok, false);
  assert.match(r.hint, /SQL Browser/);
  assert.match(r.hint, /TCP\/IP/);
});

test("no se sugiere el SQL Browser cuando no hay instancia nombrada", async () => {
  const mssql = {
    ConnectionPool: function () {
      this.connect = async () => {
        throw Object.assign(new Error("Failed to connect in 8000ms"), { code: "ETIMEOUT" });
      };
      this.close = async () => {};
    },
  };
  const r = await probeConnection(
    { datasource: "10.0.0.9,1433", initialcatalog: "BD", userid: "sa", password: "x" },
    { mssql, discover: () => null }
  );
  assert.equal(r.ok, false);
  assert.equal(r.hint, undefined, "un host con puerto no tiene nada que ver con SQL Browser");
});

test("no se sugiere el SQL Browser si el fallo no es un timeout", async () => {
  const mssql = {
    ConnectionPool: function () {
      this.connect = async () => {
        throw Object.assign(new Error("Login failed for user"), { code: "ELOGIN" });
      };
      this.close = async () => {};
    },
  };
  const r = await probeConnection(PARTS, { mssql, discover: () => null });
  assert.equal(r.hint, undefined, "unas credenciales malas no las arregla SQL Browser");
});

test("sanitizeError tapa el secreto y conserva el codigo", () => {
  const out = sanitizeError(Object.assign(new Error("bad p4ss"), { code: "ELOGIN" }), "p4ss");
  assert.equal(out, "bad *** (ELOGIN)");
});
