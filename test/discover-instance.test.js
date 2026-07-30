const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const { parseDataSource } = require("../bin/start-mssql-mcp");
const {
  isLocalHost,
  pickAddress,
  discoverLocalInstance,
  queryWindowsInstance,
  withDiscoveredPort,
} = require("../bin/discover-instance");

/** PowerShell de mentira: devuelve el JSON que devolveria el sistema. */
function fakeExec(payload) {
  return () => JSON.stringify(payload);
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

// ── queryWindowsInstance ──

test("queryWindowsInstance normaliza una sola entrada a lista", () => {
  // ConvertTo-Json de PowerShell colapsa una lista de un elemento en un objeto.
  const r = queryWindowsInstance("SQL2022", {
    exec: fakeExec({ staticPort: null, listening: { port: 59212, address: "::1" } }),
  });
  assert.deepEqual(r.listening, [{ port: 59212, address: "::1" }]);
  assert.equal(r.staticPort, undefined);
});

// ── discoverLocalInstance ──

test("discoverLocalInstance: prefiere el puerto estatico del registro", () => {
  // Si un administrador lo ha fijado, es el que hay que usar.
  const found = discoverLocalInstance("PC_158", {
    ...WIN,
    exec: fakeExec({
      staticPort: 1433,
      listening: [
        { port: 1433, address: "0.0.0.0" },
        { port: 56894, address: "127.0.0.1" },
      ],
    }),
  });
  assert.deepEqual(found, { port: "1433", address: undefined });
});

test("discoverLocalInstance: sin puerto estatico, usa el que escucha de verdad", () => {
  // Es el unico dato fiable cuando el puerto es dinamico.
  const found = discoverLocalInstance("SQL2022", {
    ...WIN,
    exec: fakeExec({ staticPort: null, listening: [{ port: 59212, address: "::1" }] }),
  });
  assert.deepEqual(found, { port: "59212", address: "::1" });
});

test("discoverLocalInstance: entre varios puertos observados, 1433 primero", () => {
  const found = discoverLocalInstance("X", {
    ...WIN,
    exec: fakeExec({
      staticPort: null,
      listening: [
        { port: 56894, address: "0.0.0.0" },
        { port: 1433, address: "0.0.0.0" },
      ],
    }),
  });
  assert.equal(found.port, "1433");
});

test("discoverLocalInstance: sin nada a la escucha devuelve null", () => {
  // Instancia con TCP/IP desactivado: no hay nada que descubrir.
  const found = discoverLocalInstance("SQL2025", {
    ...WIN,
    exec: fakeExec({ staticPort: null, listening: [] }),
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
    exec: fakeExec({ staticPort: 1433, listening: [] }),
  });
  assert.equal(found, null);
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
