/**
 * Fichero de credenciales, fuera del repositorio.
 *
 * Lo usan los dos frontales del instalador (terminal y formulario) para el caso en
 * que no hay Web.config ni appsettings.json: el .mcp.json se commitea, asi que las
 * credenciales no pueden vivir ahi. Solo su ruta.
 *
 * La contrasena NO se escribe en claro: va cifrada bajo la clave `passwordEnc` (ver
 * src/secrets.js). Una clave distinta y no la misma con otro contenido, porque asi
 * no hay que adivinar si lo que hay dentro esta cifrado o no: un fichero con
 * `password` es de una version anterior y se sigue leyendo, uno con `passwordEnc`
 * hay que descifrarlo.
 */
const fs = require("fs");
const path = require("path");

const { configDir, protectAll } = require("../src/secrets");

/** %APPDATA%\ahora-sql-mcp\<proyecto>.json (o ~/.config en el resto de plataformas). */
function credentialsPathFor(projectDir) {
  const name = path.basename(path.resolve(projectDir)).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(configDir(), `${name || "proyecto"}.json`);
}

/** Quita el BOM que dejan algunos editores, igual que hace installer/setup.js. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Las contrasenas ya cifradas que hay en el fichero, por alias.
 *
 * Sirven para reconfigurar sin volver a teclearlas. Cambiar de base de datos no
 * deberia obligar a recordar la contrasena del SQL de un cliente: se deja el hueco
 * en blanco y se reutiliza el token que ya estaba. Se copia tal cual, sin descifrar
 * —descifrar cuesta un arranque de PowerShell por contrasena y aqui no hace ninguna
 * falta: el formato de salida es el mismo que el de entrada—.
 *
 * La clave es el alias, y `""` la forma de una sola conexion sin alias.
 */
function readExistingSecrets(target) {
  const previos = new Map();
  try {
    if (!fs.existsSync(target)) return previos;
    const json = JSON.parse(stripBom(fs.readFileSync(target, "utf8")));
    const anota = (alias, raw) => {
      if (raw && typeof raw === "object" && typeof raw.passwordEnc === "string") {
        previos.set(alias, raw.passwordEnc);
      }
    };
    if (json && json.connections && typeof json.connections === "object") {
      for (const alias of Object.keys(json.connections)) anota(alias, json.connections[alias]);
    } else {
      anota("", json);
    }
  } catch {
    // Un fichero ilegible no es un error aqui: solo significa que no hay nada que
    // reutilizar y que habra que teclear la contrasena.
  }
  return previos;
}

function writeCredentialsFile(projectDir, connections, { warn = console.warn } = {}) {
  const target = credentialsPathFor(projectDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Reconfigurar reescribe este fichero entero, asi que lo que no se vuelve a
  // teclear hay que traerlo de la version anterior o se pierde.
  const previos = readExistingSecrets(target);
  const anterior = (c) => {
    const guardado = previos.get(c.alias || "");
    if (guardado !== undefined) return guardado;
    // Con una sola conexion a cada lado se reutiliza aunque el alias no case: es el
    // caso de renombrarlo, y pedir la contrasena por un cambio de nombre no ayuda a
    // nadie.
    if (previos.size === 1 && connections.length === 1) return [...previos.values()][0];
    return undefined;
  };

  // Solo se cifra lo tecleado: cada contrasena cuesta un arranque de PowerShell, y
  // van todas en una sola pasada porque con la configuracion + los datos de Flexygo
  // ya son dos.
  const tecleadas = connections.filter((c) => c.password);
  const cifradas = protectAll(
    tecleadas.map((c) => c.password),
    {
      onFallback: (err) =>
        warn(
          "  Aviso: DPAPI de Windows no esta disponible " +
            `(${err.message}). Las credenciales se cifran con una clave local, ` +
            "que vive junto al fichero."
        ),
    }
  );
  const nuevas = new Map(tecleadas.map((c, i) => [c, cifradas[i]]));

  const secreto = (c) => {
    if (nuevas.has(c)) return nuevas.get(c);
    const guardado = anterior(c);
    if (guardado !== undefined) return guardado;
    throw new Error(
      `Falta la contrasena de ${c.alias || c.database || c.server}: no hay ninguna ` +
        "guardada que reutilizar, asi que hay que escribirla."
    );
  };

  const one = (c) => ({
    server: c.server,
    database: c.database,
    user: c.user,
    passwordEnc: secreto(c),
    ...(c.port ? { port: c.port } : {}),
  });
  const doc =
    connections.length === 1 && !connections[0].alias
      ? one(connections[0])
      : {
          connections: Object.fromEntries(
            connections.map((c) => [c.alias || "maindb", one(c)])
          ),
        };

  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // en Windows no aplica; el fichero queda igualmente fuera del repositorio
  }
  return target;
}

module.exports = { credentialsPathFor, writeCredentialsFile, readExistingSecrets };
