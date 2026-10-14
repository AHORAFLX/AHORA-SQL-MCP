const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const {
  runUnattended,
  normalizeAnswers,
  EXIT_OK,
  EXIT_REJECTED,
} = require("../installer/unattended");
const { PROFILES } = require("../installer/setup");

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "unattended-")));
}

const stdinOf = (obj) => Readable.from([Buffer.from(JSON.stringify(obj))]);

/** gui de mentira: registra lo que recibe `write` y devuelve validaciones a medida. */
function fakeGui({
  validation,
  writeResult = { written: [{ target: "x/.mcp.json" }] },
} = {}) {
  const calls = { validate: [], write: [] };
  return {
    calls,
    validate: async (args) => {
      calls.validate.push(args);
      return validation;
    },
    write: (payload) => {
      calls.write.push(payload);
      return writeResult;
    },
  };
}

const MANUAL = {
  server: "PC_158\\SQL2022",
  database: "DEMO",
  user: "sa",
  password: "secreta",
};

test("sin profileKey se rechaza: el entorno no tiene valor por defecto", () => {
  assert.throws(
    () =>
      normalizeAnswers(
        { manualConnections: [MANUAL] },
        { cwd: tmpDir(), profiles: PROFILES }
      ),
    /profileKey/
  );
});

test("pedir escritura en PRODUCCION se rechaza en vez de quitarla en silencio", () => {
  assert.throws(
    () =>
      normalizeAnswers(
        {
          manualConnections: [MANUAL],
          profileKey: "produccion",
          allowWrites: true,
        },
        { cwd: tmpDir(), profiles: PROFILES }
      ),
    /PRODUCCION/
  );
});

test("valores por defecto: Claude Code, reglas de lectura si, de escritura no", () => {
  const p = normalizeAnswers(
    { manualConnections: [MANUAL], profileKey: "local" },
    { cwd: tmpDir(), profiles: PROFILES }
  );
  assert.deepEqual(p.clients, ["claude"]);
  assert.equal(p.allowRules, true);
  assert.equal(p.allowWriteRules, false);
  assert.equal(p.allowUnreachable, false);
});

test("el MCP de producto toma la primera conexion si no se indica cual", () => {
  const p = normalizeAnswers(
    {
      manualConnections: [
        { ...MANUAL, alias: "config", database: "DEMO_IC" },
        { ...MANUAL, alias: "data" },
      ],
      profileKey: "local",
      product: true,
    },
    { cwd: tmpDir(), profiles: PROFILES }
  );
  assert.deepEqual(p.productConnection, { name: "DEMO_IC", alias: "config" });
});

test("una conexion que no responde: no se escribe nada", async () => {
  const gui = fakeGui({
    validation: [{ manual: true, ok: false, name: "maindb", error: "timeout" }],
  });
  const { code, result } = await runUnattended({
    source: "-",
    stdin: stdinOf({
      projectDir: tmpDir(),
      manualConnections: [MANUAL],
      profileKey: "local",
    }),
    gui,
    profiles: PROFILES,
  });
  assert.equal(code, EXIT_REJECTED);
  assert.equal(result.phase, "validate");
  assert.match(result.error, /timeout/);
  assert.equal(gui.calls.write.length, 0);
});

test("allowUnreachable escribe aunque no conecte", async () => {
  const gui = fakeGui({
    validation: [{ manual: true, ok: false, name: "maindb", error: "timeout" }],
  });
  const { code, result } = await runUnattended({
    source: "-",
    stdin: stdinOf({
      projectDir: tmpDir(),
      manualConnections: [MANUAL],
      profileKey: "local",
      allowUnreachable: true,
    }),
    gui,
    profiles: PROFILES,
  });
  assert.equal(code, EXIT_OK);
  assert.equal(result.ok, true);
  assert.equal(gui.calls.write.length, 1);
});

test("una cadena que no existe en el fichero no se salva con allowUnreachable", async () => {
  const root = tmpDir();
  const gui = fakeGui({
    validation: [{ name: "Conf", ok: false, error: "no declarada" }],
  });
  const { code } = await runUnattended({
    source: "-",
    stdin: stdinOf({
      projectDir: root,
      configFile: "Web.config",
      connections: [{ name: "Conf" }],
      profileKey: "local",
      allowUnreachable: true,
    }),
    gui,
    profiles: PROFILES,
  });
  assert.equal(code, EXIT_REJECTED);
  assert.equal(gui.calls.write.length, 0);
});

test("todo correcto: write recibe el payload del formulario y la salida no lleva contrasenas", async () => {
  const gui = fakeGui({
    validation: [
      {
        manual: true,
        ok: true,
        name: "maindb",
        target: "PC_158\\SQL2022",
        database: "DEMO",
      },
    ],
  });
  const { code, result } = await runUnattended({
    source: "-",
    stdin: stdinOf({
      projectDir: tmpDir(),
      manualConnections: [MANUAL],
      profileKey: "pruebas",
      allowWrites: true,
    }),
    gui,
    profiles: PROFILES,
  });
  assert.equal(code, EXIT_OK);
  const sent = gui.calls.write[0];
  assert.equal(sent.profileKey, "pruebas");
  assert.equal(sent.allowWrites, true);
  assert.equal(sent.manualConnections[0].password, "secreta");
  assert.doesNotMatch(JSON.stringify(result), /secreta/);
});

test("el MCP de producto pide la version al feed antes de escribir", async () => {
  const gui = fakeGui({
    validation: [{ manual: true, ok: true, name: "maindb" }],
  });
  await runUnattended({
    source: "-",
    stdin: stdinOf({
      projectDir: tmpDir(),
      manualConnections: [MANUAL],
      profileKey: "local",
      product: true,
    }),
    gui,
    profiles: PROFILES,
    latestProductVersion: async () => "2.3.4",
    installedProductVersion: () => null,
  });
  assert.equal(gui.calls.write[0].productVersion, "2.3.4");
});

test("JSON roto se rechaza con codigo 2", async () => {
  const { code, result } = await runUnattended({
    source: "-",
    stdin: Readable.from([Buffer.from("{no es json")]),
    gui: fakeGui(),
    profiles: PROFILES,
  });
  assert.equal(code, EXIT_REJECTED);
  assert.equal(result.phase, "answers");
});
