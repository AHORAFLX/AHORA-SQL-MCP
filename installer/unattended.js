/**
 * Modo desatendido del instalador: `ahora-setup --answers <fichero|->`.
 *
 * Existe para que otra herramienta (la extension DevOps Ahora de VS Code) pueda dejar
 * configurada la carpeta de un cliente con los datos que ya ha pedido en su propio
 * formulario, sin abrir el navegador ni ir contestando preguntas en un terminal. Hasta
 * ahora eso era imposible: el instalador solo tenia GUI o `--cli` interactivo, y servidor,
 * base de datos y credenciales no se podian pasar de ninguna forma.
 *
 * Decisiones que no hay que deshacer:
 *
 * - **Las respuestas van en JSON por stdin (o en un fichero), nunca como argumentos.** Una
 *   contrasena en la linea de comandos queda en el historial del shell y la ve cualquiera
 *   que liste procesos. Con `-` se lee de stdin, que es lo que usa la extension.
 * - **La logica es la del formulario**, no una tercera copia: se llama a `validate` y a
 *   `write` de installer/gui.js con la misma forma de datos que manda el navegador a
 *   `/api/write`. Aqui solo hay lectura de entrada, valores por defecto y la salida.
 * - **Se valida antes de escribir y, si algo no conecta, no se escribe nada** salvo que se
 *   pida explicitamente (`allowUnreachable`). Es la razon de ser del instalador: un
 *   `.mcp.json` que apunta a una base de datos inalcanzable no falla hasta que alguien
 *   invoca una herramienta.
 * - **El resultado sale en UNA linea con prefijo fijo** (`RESULT_PREFIX`). npx puede
 *   escribir avisos propios en stdout antes de que esto arranque, y la instalacion del
 *   runtime tambien; quien lo llame busca esa linea y no tiene que adivinar donde empieza
 *   el JSON.
 * - Codigos de salida: 0 escrito, 2 rechazado sin escribir nada (entrada invalida o
 *   conexion que no responde), 1 error inesperado.
 */
const fs = require("fs");
const path = require("path");

const RESULT_PREFIX = "AHORA_SETUP_RESULT ";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_REJECTED = 2;

class AnswersError extends Error {}

function readAllStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    );
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readAnswers(source, { stdin = process.stdin } = {}) {
  if (!source)
    throw new AnswersError(
      "Falta el origen de las respuestas: --answers <fichero> o --answers -"
    );
  const raw =
    source === "-"
      ? await readAllStdin(stdin)
      : fs.readFileSync(source, "utf8");
  try {
    return JSON.parse(stripBom(raw));
  } catch (err) {
    throw new AnswersError(`Las respuestas no son JSON valido: ${err.message}`);
  }
}

/**
 * Completa y comprueba las respuestas. Devuelve el payload con la forma que espera
 * `write` de gui.js.
 *
 * Los valores por defecto son los del formulario cuando nadie toca nada, salvo uno: el
 * perfil NO tiene valor por defecto. Que alguien pueda dejar una base de datos de
 * produccion marcada como local por omision es justo el error que el instalador evita
 * preguntando por el entorno antes que por la escritura.
 */
function normalizeAnswers(input, { cwd = process.cwd(), profiles } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AnswersError("Las respuestas tienen que ser un objeto JSON.");
  }
  const projectDir = path.resolve(input.projectDir || cwd);
  if (!fs.existsSync(projectDir))
    throw new AnswersError(`No existe la carpeta del proyecto: ${projectDir}`);

  if (!input.profileKey) {
    throw new AnswersError(
      `Falta profileKey (${profiles.map((p) => p.key).join(", ")}): el entorno no tiene valor por defecto a proposito.`
    );
  }
  const profile = profiles.find((p) => p.key === input.profileKey);
  if (!profile) {
    throw new AnswersError(
      `profileKey '${input.profileKey}' no existe. Validos: ${profiles.map((p) => p.key).join(", ")}.`
    );
  }
  if (input.allowWrites && !profile.canWrite) {
    // El formulario la quita en silencio; aqui se rechaza, porque quien llama ha pedido
    // escritura de forma explicita y callarselo le dejaria creyendo que la tiene.
    throw new AnswersError(
      "La escritura no se puede activar en PRODUCCION: el servidor se negaria a arrancar."
    );
  }

  const manualConnections = Array.isArray(input.manualConnections)
    ? input.manualConnections
    : [];
  const connections = Array.isArray(input.connections) ? input.connections : [];
  if (!input.configFile && manualConnections.length === 0) {
    throw new AnswersError(
      "Falta configFile o manualConnections: no hay de donde sacar la conexion."
    );
  }
  if (input.configFile && connections.length === 0) {
    throw new AnswersError(
      "Con configFile hay que indicar connections: [{ name, alias }]."
    );
  }
  for (const m of manualConnections) {
    if (!m || !m.server || !m.database || !m.user) {
      throw new AnswersError(
        "Cada conexion manual necesita server, database y user."
      );
    }
  }

  const clients =
    Array.isArray(input.clients) && input.clients.length > 0
      ? input.clients
      : ["claude"];

  // El MCP de producto maneja UNA base de datos. Sin indicarla se usa la primera, que es
  // lo mismo que hace el asistente de terminal cuando solo hay una candidata.
  let productConnection = input.productConnection;
  if (input.product && !productConnection) {
    productConnection =
      connections.length > 0
        ? { name: connections[0].name, alias: connections[0].alias }
        : {
            name: manualConnections[0].database,
            alias: manualConnections[0].alias,
          };
  }

  return {
    projectDir,
    configFile: input.configFile
      ? path.resolve(projectDir, input.configFile)
      : undefined,
    environment: input.environment,
    connections,
    manualConnections,
    profileKey: profile.key,
    allowWrites: Boolean(input.allowWrites),
    sqlDirs: Array.isArray(input.sqlDirs) ? input.sqlDirs : [],
    clients,
    product: Boolean(input.product),
    productConnection,
    productVersion: input.productVersion,
    productFolder: input.productFolder,
    playwright: Boolean(input.playwright),
    // Las reglas de lectura si por defecto (igual que el formulario); las de escritura no.
    allowRules: input.allowRules !== false,
    allowWriteRules: Boolean(input.allowWriteRules),
    allowProductWriteRules: Boolean(input.allowProductWriteRules),
    allowPlaywrightActionRules: Boolean(input.allowPlaywrightActionRules),
    allowUnreachable: Boolean(input.allowUnreachable),
  };
}

/** ¿Alguna conexion no se ha podido resolver o no conecta? Devuelve los motivos. */
function validationProblems(results) {
  const problems = [];
  for (const r of results) {
    if (r.manual) {
      if (!r.ok)
        problems.push(`${r.name}: ${r.error}${r.hint ? ` (${r.hint})` : ""}`);
    } else if (!r.ok) {
      problems.push(`${r.name}: ${r.error}`);
    } else if (!r.connected) {
      problems.push(
        `${r.name}: no conecta: ${r.connectError}${r.hint ? ` (${r.hint})` : ""}`
      );
    }
  }
  return problems;
}

/** Igual que validationProblems, pero solo lo que impide escribir aunque se acepte una
 * conexion caida: una cadena que no existe en el fichero no se arregla con la red. */
function unresolvable(results) {
  return results
    .filter((r) => !r.manual && !r.ok)
    .map((r) => `${r.name}: ${r.error}`);
}

/**
 * Ejecuta el modo desatendido. Todo inyectable para poder probarlo sin red ni SQL.
 * Devuelve `{ code, result }`; quien lo arranca desde la linea de comandos imprime y sale.
 */
async function runUnattended({
  source,
  stdin,
  cwd,
  gui = require("./gui"),
  profiles = require("./setup").PROFILES,
  latestProductVersion,
  installedProductVersion,
  install,
} = {}) {
  let payload;
  try {
    payload = normalizeAnswers(await readAnswers(source, { stdin }), {
      cwd,
      profiles,
    });
  } catch (err) {
    if (err instanceof AnswersError)
      return {
        code: EXIT_REJECTED,
        result: { ok: false, phase: "answers", error: err.message },
      };
    throw err;
  }

  const validation = await gui.validate({
    projectDir: payload.projectDir,
    configFile: payload.configFile,
    environment: payload.environment,
    names: payload.connections,
    manual: payload.manualConnections,
  });
  const hard = unresolvable(validation);
  const problems = validationProblems(validation);
  if (hard.length > 0 || (problems.length > 0 && !payload.allowUnreachable)) {
    return {
      code: EXIT_REJECTED,
      result: {
        ok: false,
        phase: "validate",
        error: `No se ha escrito nada. ${(hard.length > 0 ? hard : problems).join(" · ")}`,
        validation: redactValidation(validation),
      },
    };
  }

  // El formulario pide la version del MCP de producto al feed cuando se marca la casilla;
  // aqui se hace lo mismo antes de escribir, con la misma regla de "la ultima, o la ya
  // instalada si el feed no responde".
  if (payload.product && !payload.productFolder && !payload.productVersion) {
    const pm = require("./product-mcp");
    const latestFn = latestProductVersion || pm.latestProductVersion;
    const installedFn =
      installedProductVersion ||
      (() => pm.installedProductVersion(pm.productRuntimeDir()));
    let latest = null;
    try {
      latest = await latestFn();
    } catch {
      latest = null;
    }
    payload.productVersion =
      pm.versionToInstall({ latest, installed: installedFn() }).version ||
      undefined;
  }

  try {
    const written = gui.write(payload, install ? { install } : {});
    return {
      code: EXIT_OK,
      result: {
        ok: true,
        phase: "write",
        validation: redactValidation(validation),
        ...written,
      },
    };
  } catch (err) {
    return {
      code: EXIT_REJECTED,
      result: { ok: false, phase: "write", error: err.message },
    };
  }
}

/** La validacion no lleva contrasenas, pero se deja solo lo que sirve para explicarla. */
function redactValidation(results) {
  return results.map((r) => ({
    name: r.name,
    alias: r.alias,
    ok: r.ok,
    connected: r.manual ? r.ok : r.connected,
    target: r.target,
    database: r.database,
    error: r.error || r.connectError,
    hint: r.hint,
  }));
}

/** Punto de entrada desde `ahora-setup --answers <origen>`. */
function runUnattendedCli(argv, { out = process.stdout } = {}) {
  const idx = argv.indexOf("--answers");
  const source = idx >= 0 ? argv[idx + 1] : undefined;
  return runUnattended({ source })
    .then(({ code, result }) => {
      out.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
      process.exitCode = code;
    })
    .catch((err) => {
      out.write(
        `${RESULT_PREFIX}${JSON.stringify({ ok: false, phase: "error", error: err.message })}\n`
      );
      process.exitCode = EXIT_ERROR;
    });
}

module.exports = {
  RESULT_PREFIX,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_REJECTED,
  AnswersError,
  readAnswers,
  normalizeAnswers,
  validationProblems,
  runUnattended,
  runUnattendedCli,
};
