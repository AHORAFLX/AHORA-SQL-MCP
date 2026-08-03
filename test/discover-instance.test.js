const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { parseDataSource } = require("../bin/start-mssql-mcp");
const {
  isLocalHost,
  isSafeInstanceName,
  pickAddress,
  discoverLocalInstance,
  discoverLocalInstances,
  queryWindowsInstance,
  queryWindowsInstances,
  instanceToDiscover,
  withDiscoveredPort,
} = require("../bin/discover-instance");

/**
 * PowerShell de mentira. El script pregunta por varias instancias a la vez y devuelve
 * un objeto indexado por nombre, asi que aqui se pasa ese mapa tal cual.
 */
function fakeExec(byInstance) {
  return () => JSON.stringify(byInstance);
}

/** Un fichero de cache propio de cada prueba, que se borra al terminar. */
function tempCacheFile(t) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ahora-sql-mcp-test-")),
    "ports.json"
  );
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  return file;
}

const WIN = { platform: "win32" };

// ── isLocalHost ──

test("isLocalHost reconoce los alias de esta maquina", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", ".", "(local)", "LOCALHOST"]) {
    assert.equal(isLocalHost(h), true, h);
  }
  assert.equal(isLocalHost(os.hostname()), true, "el propio nombre del equipo");
  assert.equal(isLocalHost(os.hostname().toUpperCase()), true, "sin importar mayusculas");
});

test("isLocalHost no confunde un servidor remoto con el local", () => {
  for (const h of ["192.168.9.26", "SQLIMPLANTACION", "otro-equipo", "", undefined]) {
    assert.equal(isLocalHost(h), false, String(h));
  }
});

// ── pickAddress: escucha en todas las IP o solo en loopback ──

test("pickAddress: si escucha en todas las IP, no hay que forzar direccion", () => {
  const listening = [
    { port: 1433, address: "0.0.0.0" },
    { port: 1433, address: "127.0.0.1" },
  ];
  assert.equal(pickAddress(listening, 1433), null);
});

test("pickAddress: si solo escucha en loopback, hay que usar esa direccion", () => {
  // Es el caso que hace fracasar un --port a pelo: el puerto es correcto pero
  // conectarse al nombre del equipo va a la IPv4 y ahi no escucha nadie.
  assert.equal(pickAddress([{ port: 59212, address: "::1" }], 59212), "::1");
  assert.equal(pickAddress([{ port: 1435, address: "127.0.0.1" }], 1435), "127.0.0.1");
});

test("pickAddress: ignora los puertos que no son el buscado", () => {
  const listening = [
    { port: 1433, address: "0.0.0.0" },
    { port: 59212, address: "::1" },
  ];
  assert.equal(pickAddress(listening, 59212), "::1");
  assert.equal(pickAddress(listening, 1433), null);
});

// ── queryWindowsInstance(s) ──

test("queryWindowsInstance normaliza una sola entrada a lista", () => {
  // ConvertTo-Json de PowerShell colapsa una lista de un elemento en un objeto.
  const r = queryWindowsInstance("SQL2022", {
    exec: fakeExec({ SQL2022: { staticPort: null, listening: { port: 59212, address: "::1" } } }),
  });
  assert.deepEqual(r.listening, [{ port: 59212, address: "::1" }]);
  assert.equal(r.staticPort, undefined);
});

test("queryWindowsInstance encuentra la instancia aunque cambie de mayusculas", () => {
  // Las claves de una hashtable de PowerShell no distinguen mayusculas, asi que puede
  // devolverlas con otra caja de la que se pidio.
  const r = queryWindowsInstance("sql2022", {
    exec: fakeExec({ SQL2022: { staticPort: 1433, listening: [] } }),
  });
  assert.equal(r.staticPort, 1433);
});

test("queryWindowsInstances pregunta por todas en una sola invocacion", () => {
  // Es la razon de ser del cambio: el coste no debe crecer con el numero de conexiones.
  let calls = 0;
  const r = queryWindowsInstances(["CONF", "DATA", "CONF"], {
    exec: (_cmd, argv) => {
      calls += 1;
      // Y las tres deben ir en el mismo script, sin repetir la duplicada.
      const script = argv[argv.length - 1];
      assert.match(script, /\$names = @\('CONF','DATA'\)/);
      return JSON.stringify({
        CONF: { staticPort: 1433, listening: [] },
        DATA: { staticPort: 1435, listening: [] },
      });
    },
  });
  assert.equal(calls, 1, "una sola llamada a PowerShell");
  assert.deepEqual(Object.keys(r), ["CONF", "DATA"]);
  assert.equal(r.DATA.staticPort, 1435);
});

test("queryWindowsInstances no pregunta por un nombre que no es una instancia", () => {
  // El nombre puede venir de un Web.config ajeno y acaba dentro de una consulta WQL.
  assert.equal(isSafeInstanceName("SQL_2022$A#1"), true);
  for (const bad of ["a'b", "a b", "a;b", 'a"b', ""]) {
    assert.equal(isSafeInstanceName(bad), false, bad);
  }
  const r = queryWindowsInstances(["mal'nombre"], {
    exec: () => assert.fail("no deberia invocar PowerShell"),
  });
  assert.deepEqual(r, {});
});

// ── discoverLocalInstance ──

test("discoverLocalInstance: prefiere el puerto estatico del registro", () => {
  // Si un administrador lo ha fijado, es el que hay que usar.
  const found = discoverLocalInstance("PC_158", {
    ...WIN,
    exec: fakeExec({
      PC_158: {
        staticPort: 1433,
        listening: [
          { port: 1433, address: "0.0.0.0" },
          { port: 56894, address: "127.0.0.1" },
        ],
      },
    }),
  });
  assert.deepEqual(found, { port: "1433", address: undefined });
});

test("discoverLocalInstance: sin puerto estatico, usa el que escucha de verdad", () => {
  // Es el unico dato fiable cuando el puerto es dinamico.
  const found = discoverLocalInstance("SQL2022", {
    ...WIN,
    exec: fakeExec({
      SQL2022: { staticPort: null, listening: [{ port: 59212, address: "::1" }] },
    }),
  });
  assert.deepEqual(found, { port: "59212", address: "::1" });
});

test("discoverLocalInstance: entre varios puertos observados, 1433 primero", () => {
  const found = discoverLocalInstance("X", {
    ...WIN,
    exec: fakeExec({
      X: {
        staticPort: null,
        listening: [
          { port: 56894, address: "0.0.0.0" },
          { port: 1433, address: "0.0.0.0" },
        ],
      },
    }),
  });
  assert.equal(found.port, "1433");
});

test("discoverLocalInstance: sin nada a la escucha devuelve null", () => {
  // Instancia con TCP/IP desactivado: no hay nada que descubrir.
  const found = discoverLocalInstance("SQL2025", {
    ...WIN,
    exec: fakeExec({ SQL2025: { staticPort: null, listening: [] } }),
  });
  assert.equal(found, null);
});

test("discoverLocalInstance: si falla la consulta, no revienta", () => {
  const found = discoverLocalInstance("X", {
    ...WIN,
    exec: () => {
      throw new Error("powershell no disponible");
    },
  });
  assert.equal(found, null);
});

test("discoverLocalInstance: fuera de Windows no aplica", () => {
  const found = discoverLocalInstance("X", {
    platform: "linux",
    exec: fakeExec({ X: { staticPort: 1433, listening: [] } }),
  });
  assert.equal(found, null);
});

// ── cache de puertos entre procesos ──

test("la cache evita volver a sondear en el arranque siguiente", (t) => {
  const cacheFile = tempCacheFile(t);
  const exec = fakeExec({ SQL2022: { staticPort: 1433, listening: [] } });

  const first = discoverLocalInstances(["SQL2022"], { ...WIN, exec, cacheFile, now: 1000 });
  assert.deepEqual(first.SQL2022, { port: "1433", address: undefined });

  // Segundo arranque, dentro de la ventana: no puede tocar PowerShell.
  const second = discoverLocalInstances(["SQL2022"], {
    ...WIN,
    cacheFile,
    now: 1000 + 30_000,
    exec: () => assert.fail("no deberia sondear: esta en la cache"),
  });
  assert.deepEqual(second.SQL2022, { port: "1433", address: undefined });
});

test("la cache caduca, para que un puerto dinamico nuevo se note", (t) => {
  const cacheFile = tempCacheFile(t);
  discoverLocalInstances(["SQL2022"], {
    ...WIN,
    cacheFile,
    now: 1000,
    exec: fakeExec({ SQL2022: { staticPort: null, listening: [{ port: 59212, address: "::1" }] } }),
  });

  const later = discoverLocalInstances(["SQL2022"], {
    ...WIN,
    cacheFile,
    now: 1000 + 61_000,
    exec: fakeExec({ SQL2022: { staticPort: null, listening: [{ port: 60001, address: "::1" }] } }),
  });
  assert.equal(later.SQL2022.port, "60001", "se vuelve a preguntar y gana el puerto real");
});

test("la cache guarda tambien el resultado negativo", (t) => {
  // Una instancia inexistente cuesta lo mismo que una que si esta.
  const cacheFile = tempCacheFile(t);
  const first = discoverLocalInstances(["SQL2025"], {
    ...WIN,
    cacheFile,
    now: 1000,
    exec: fakeExec({ SQL2025: { staticPort: null, listening: [] } }),
  });
  assert.equal(first.SQL2025, null);

  const second = discoverLocalInstances(["SQL2025"], {
    ...WIN,
    cacheFile,
    now: 2000,
    exec: () => assert.fail("no deberia sondear: el 'no existe' tambien se cachea"),
  });
  assert.equal(second.SQL2025, null);
});

test("solo se pregunta por lo que no esta en la cache", (t) => {
  const cacheFile = tempCacheFile(t);
  discoverLocalInstances(["CONF"], {
    ...WIN,
    cacheFile,
    now: 1000,
    exec: fakeExec({ CONF: { staticPort: 1433, listening: [] } }),
  });

  const both = discoverLocalInstances(["CONF", "DATA"], {
    ...WIN,
    cacheFile,
    now: 2000,
    exec: (_cmd, argv) => {
      assert.match(argv[argv.length - 1], /\$names = @\('DATA'\)/, "CONF ya se sabe");
      return JSON.stringify({ DATA: { staticPort: 1435, listening: [] } });
    },
  });
  assert.equal(both.CONF.port, "1433");
  assert.equal(both.DATA.port, "1435");
});

test("una cache corrupta no rompe el arranque, se vuelve a sondear", (t) => {
  // La escriben varios procesos a la vez sin bloqueo: encontrarla a medias es posible.
  const cacheFile = tempCacheFile(t);
  fs.writeFileSync(cacheFile, '{"sql2022": {"at": 1000, "fou');

  const found = discoverLocalInstances(["SQL2022"], {
    ...WIN,
    cacheFile,
    now: 1000,
    exec: fakeExec({ SQL2022: { staticPort: 1433, listening: [] } }),
  });
  assert.equal(found.SQL2022.port, "1433");
});

test("sin cacheFile no se toca ningun fichero", () => {
  // Es lo que mantiene las pruebas y el uso puntual libres de estado compartido.
  let calls = 0;
  const exec = () => {
    calls += 1;
    return JSON.stringify({ SQL2022: { staticPort: 1433, listening: [] } });
  };
  discoverLocalInstances(["SQL2022"], { ...WIN, exec });
  discoverLocalInstances(["SQL2022"], { ...WIN, exec });
  assert.equal(calls, 2);
});

// ── withDiscoveredPort ──

const CREDS = { initialcatalog: "BD", userid: "sa", password: "x" };

test("withDiscoveredPort sustituye la instancia local por host,puerto", () => {
  const { parts, discovered } = withDiscoveredPort(
    { ...CREDS, datasource: "localhost\\SQL2022" },
    parseDataSource,
    { discover: () => ({ port: "59212" }) }
  );
  assert.equal(parts.datasource, "localhost,59212");
  assert.equal(discovered.instanceName, "SQL2022");
  assert.equal(discovered.onlyLoopback, false);
});

test("withDiscoveredPort pone corchetes al IPv6, o el ':' se confunde con el puerto", () => {
  // Sin los corchetes, `::1,59212` se tokeniza mal y el host queda vacio.
  const { parts, discovered } = withDiscoveredPort(
    { ...CREDS, datasource: "localhost\\SQL2022" },
    parseDataSource,
    { discover: () => ({ port: "59212", address: "::1" }) }
  );
  assert.equal(parts.datasource, "[::1],59212");
  assert.equal(discovered.onlyLoopback, true);
  // Y el resultado tiene que volver a ser interpretable.
  const reparsed = parseDataSource(parts.datasource);
  assert.equal(reparsed.host, "::1");
  assert.equal(reparsed.port, "59212");
});

test("withDiscoveredPort no toca nada si la cadena YA trae puerto", () => {
  const original = { ...CREDS, datasource: "localhost\\SQL2022,1435" };
  const { parts, discovered } = withDiscoveredPort(original, parseDataSource, {
    discover: () => assert.fail("no deberia consultar el sistema"),
  });
  assert.equal(parts.datasource, "localhost\\SQL2022,1435");
  assert.equal(discovered, null);
});

test("withDiscoveredPort no toca nada si no hay instancia nombrada", () => {
  const { discovered } = withDiscoveredPort(
    { ...CREDS, datasource: "localhost" },
    parseDataSource,
    { discover: () => assert.fail("no deberia consultar el sistema") }
  );
  assert.equal(discovered, null);
});

test("withDiscoveredPort no consulta por un servidor remoto", () => {
  // Solo se puede preguntar al sistema por las instancias de esta maquina.
  const { discovered } = withDiscoveredPort(
    { ...CREDS, datasource: "SQLIMPLANTACION\\SQL2022IMP4" },
    parseDataSource,
    { discover: () => assert.fail("no deberia consultar el sistema") }
  );
  assert.equal(discovered, null);
});

test("withDiscoveredPort deja la conexion por nombre si no se puede averiguar", () => {
  const original = { ...CREDS, datasource: "localhost\\SQL2025" };
  const { parts, discovered } = withDiscoveredPort(original, parseDataSource, {
    discover: () => null,
  });
  assert.equal(parts.datasource, "localhost\\SQL2025", "se deja tal cual");
  assert.equal(discovered, null);
});

test("withDiscoveredPort respeta un `Port=` aparte", () => {
  const { discovered } = withDiscoveredPort(
    { ...CREDS, datasource: "localhost\\SQL2022", port: "1435" },
    parseDataSource,
    { discover: () => assert.fail("no deberia consultar el sistema") }
  );
  assert.equal(discovered, null);
});

test("withDiscoveredPort no sondea si el puerto lo ha dicho --port", () => {
  // Antes se sondeaba igualmente y se descartaba el resultado: 2 segundos para nada.
  const { parts, discovered } = withDiscoveredPort(
    { ...CREDS, datasource: "localhost\\SQL2022" },
    parseDataSource,
    {
      portOverride: "1435",
      discover: () => assert.fail("no deberia consultar el sistema"),
    }
  );
  assert.equal(parts.datasource, "localhost\\SQL2022", "lo resuelve applyConnection");
  assert.equal(discovered, null);
});

// ── instanceToDiscover: por que conexiones hay que preguntar ──

test("instanceToDiscover señala la instancia local sin puerto", () => {
  const target = instanceToDiscover(
    { ...CREDS, datasource: "localhost\\SQL2022" },
    parseDataSource
  );
  assert.deepEqual(target, { host: "localhost", instanceName: "SQL2022" });
});

test("instanceToDiscover descarta lo que no hace falta preguntar", () => {
  const cases = [
    ["sin servidor", { ...CREDS }, undefined],
    ["ya trae puerto", { ...CREDS, datasource: "localhost\\SQL2022,1435" }, undefined],
    ["sin instancia nombrada", { ...CREDS, datasource: "localhost" }, undefined],
    ["servidor remoto", { ...CREDS, datasource: "SQLIMPLANTACION\\SQL2022" }, undefined],
    ["Port= aparte", { ...CREDS, datasource: "localhost\\SQL2022", port: "1435" }, undefined],
    ["--port", { ...CREDS, datasource: "localhost\\SQL2022" }, "1435"],
  ];
  for (const [why, parts, portOverride] of cases) {
    assert.equal(instanceToDiscover(parts, parseDataSource, { portOverride }), null, why);
  }
});
