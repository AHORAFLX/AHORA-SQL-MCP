const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const secrets = require("../src/secrets");

function tempKey() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "secrets-")), "secret.key");
}

/** Respaldo AES: se puede probar en cualquier plataforma forzando `platform`. */
const aes = (keyFile) => ({ platform: "linux", keyFile });

test("AES: ida y vuelta, incluidos caracteres no ASCII", () => {
  const keyFile = tempKey();
  const claves = ["p4ss", "contraseña con ñ y €", 'comillas "y" \\barras'];
  const tokens = secrets.protectAll(claves, aes(keyFile));

  for (const t of tokens) {
    assert.ok(t.startsWith("aes-256-gcm:v1:"), `sin etiqueta de esquema: ${t}`);
  }
  assert.deepEqual(secrets.revealAll(tokens, aes(keyFile)), claves);
});

test("AES: el texto cifrado no contiene la contrasena", () => {
  const keyFile = tempKey();
  const token = secrets.protect("contrasena-secreta", aes(keyFile));
  assert.ok(!token.includes("contrasena-secreta"));
});

test("AES: la misma contrasena da dos textos cifrados distintos", () => {
  // El IV es aleatorio. Si no lo fuera, ver dos ficheros iguales delataria que la
  // contrasena es la misma en las dos maquinas.
  const keyFile = tempKey();
  const [a, b] = secrets.protectAll(["misma", "misma"], aes(keyFile));
  assert.notEqual(a, b);
});

test("AES: la clave se guarda fuera del JSON y con permisos restringidos", () => {
  const keyFile = tempKey();
  secrets.protect("x", aes(keyFile));
  assert.ok(fs.existsSync(keyFile));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  }
});

test("AES: con otra clave no se descifra", () => {
  const token = secrets.protect("x", aes(tempKey()));
  assert.throws(() => secrets.revealAll([token], aes(tempKey())), /clave/i);
});

test("AES: un texto cifrado manipulado se rechaza, no devuelve basura", () => {
  // GCM autentica: cambiar un byte tiene que fallar, no descifrar a otra cosa.
  const keyFile = tempKey();
  const token = secrets.protect("x", aes(keyFile));
  const raw = Buffer.from(token.slice("aes-256-gcm:v1:".length), "base64");
  raw[raw.length - 1] ^= 0xff;
  assert.throws(() =>
    secrets.revealAll([`aes-256-gcm:v1:${raw.toString("base64")}`], aes(keyFile))
  );
});

test("lo que no lleva etiqueta se devuelve tal cual", () => {
  // Los ficheros de credenciales anteriores guardaban la contrasena en claro y
  // tienen que seguir arrancando; si no, actualizar deja el MCP muerto.
  assert.deepEqual(secrets.revealAll(["en-claro", undefined]), ["en-claro", undefined]);
  assert.equal(secrets.isProtected("en-claro"), false);
  assert.equal(secrets.isProtected("dpapi:v1:AQAA"), true);
  assert.equal(secrets.isProtected("aes-256-gcm:v1:AQAA"), true);
});

test("DPAPI: se cifra en bloque, con una sola invocacion de PowerShell", () => {
  // Cada arranque de PowerShell cuesta ~0,3 s, y descifrar ocurre al arrancar el
  // servidor, mientras el cliente MCP cuenta hacia su MCP_TIMEOUT.
  let calls = 0;
  const exec = (cmd, argv, opts) => {
    calls++;
    assert.equal(cmd, "powershell");
    // La contrasena no puede viajar en la linea de comandos: el listado de procesos
    // es legible por cualquiera.
    assert.ok(!argv.join(" ").includes("secreta"));
    return opts.input
      .trim()
      .split("\n")
      .map((l) => `X${l}`)
      .join("\n");
  };

  const tokens = secrets.protectAll(["secreta-1", "secreta-2"], {
    platform: "win32",
    exec,
  });
  assert.equal(calls, 1);
  assert.deepEqual(tokens, [
    `dpapi:v1:X${Buffer.from("secreta-1").toString("base64")}`,
    `dpapi:v1:X${Buffer.from("secreta-2").toString("base64")}`,
  ]);

  const unexec = (cmd, argv, opts) =>
    opts.input
      .trim()
      .split("\n")
      .map((l) => l.slice(1))
      .join("\n");
  assert.deepEqual(secrets.revealAll(tokens, { platform: "win32", exec: unexec }), [
    "secreta-1",
    "secreta-2",
  ]);
});

test("DPAPI: si no esta disponible se cifra igualmente y se avisa", () => {
  // Quedarse en claro no es una opcion aceptable; el respaldo si, avisando de que su
  // clave vive en disco.
  const keyFile = tempKey();
  const avisos = [];
  const token = secrets.protect("x", {
    platform: "win32",
    keyFile,
    exec: () => {
      throw new Error("powershell no encontrado");
    },
    onFallback: (err) => avisos.push(err.message),
  });
  assert.ok(token.startsWith("aes-256-gcm:v1:"));
  assert.equal(avisos.length, 1);
  assert.equal(secrets.reveal(token, aes(keyFile)), "x");
});

test("DPAPI: un fallo al descifrar explica la causa habitual", () => {
  // Cifrado con otra cuenta de Windows: el mensaje del sistema no lo dice.
  assert.throws(
    () =>
      secrets.revealAll(["dpapi:v1:AQAA"], {
        platform: "win32",
        exec: () => {
          throw new Error("Key not valid for use in specified state");
        },
      }),
    /otra cuenta de Windows/
  );
});

test("DPAPI: fuera de Windows se explica en vez de reventar", () => {
  assert.throws(
    () => secrets.revealAll(["dpapi:v1:AQAA"], { platform: "linux" }),
    /solo se pueden descifrar en Windows/
  );
});

test("DPAPI: si vuelven menos resultados de los pedidos, se falla", () => {
  // Sin esta comprobacion, una salida truncada asignaria la contrasena de una
  // conexion a otra.
  assert.throws(
    () =>
      secrets.protectAll(["a", "b"], {
        platform: "win32",
        keyFile: tempKey(),
        exec: () => "solo-una",
        onFallback: (err) => {
          throw err;
        },
      }),
    /1 resultados para 2 secretos/
  );
});
