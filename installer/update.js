/**
 * `ahora-setup --update`: actualizar el servidor UNA vez y dejar al dia TODOS los
 * proyectos del equipo, sin abrir el formulario de ninguno.
 *
 * Hasta ahora actualizar era "relanzar el instalador en un proyecto y pulsar Guardar",
 * y la extension DevOps Ahora lo hacia asi: abria el formulario del proyecto abierto.
 * Quien tiene quince proyectos configurados entendia —con razon, porque nada decia lo
 * contrario— que habia que repetirlo en los quince. No hace falta: el `.mcp.json` apunta
 * a `entryPath(runtimeDir())`, una ruta que NO lleva version, asi que reinstalar el
 * runtime una vez actualiza todos los proyectos que ya usan la forma instalada.
 *
 * Lo que si se queda atras en cada proyecto es el LANZADOR, y eso es lo que este modo
 * repara sin tocar nada mas de la entrada:
 *
 *   - `node .../@ahoraflx/sql-mcp/bin/start-mssql-mcp.js`: la forma de antes de bundle/.
 *     El paquete publicado ya no lleva bin/, asi que esa entrada no arranca. Caso real:
 *     dos proyectos de un mismo equipo seguian asi tras actualizar.
 *   - `npx --package=github:...#vX.Y.Z start-mssql-mcp`: la reserva que se escribe
 *     cuando la instalacion falla. Lleva la version fijada y es lenta en cada arranque.
 *
 * Los flags que van detras del lanzador (conexiones, entorno, escritura…) se copian tal
 * cual, sin reinterpretarlos: este modo no decide nada de configuracion, solo como se
 * arranca. Por eso no valida conexiones ni pide contrasenas.
 *
 * Los proyectos salen de tres sitios, porque ninguno basta solo:
 *   1. El registro que deja el instalador cada vez que escribe un fichero de cliente
 *      (`projects.json` en la carpeta del runtime). Solo existe desde esta version.
 *   2. Los proyectos que Claude Code recuerda (`~/.claude.json`), que cubren los
 *      configurados antes de que hubiera registro.
 *   3. Las carpetas que se pasen con `--scan <carpeta>` (la extension pasa las del
 *      workspace), recorridas a poca profundidad.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  runtimeDir,
  entryPath,
  installedVersion,
  installRuntime,
} = require("./runtime");
const {
  SERVER_NAME,
  LEGACY_SERVER_NAME,
  PRODUCT_SERVER_NAME,
  isOurServerEntry,
  isOurProductEntry,
} = require("./server-name");

/** Mismo prefijo que el modo desatendido: la extension ya sabe leerlo. */
const RESULT_PREFIX = "AHORA_SETUP_RESULT ";
const EXIT_OK = 0;
const EXIT_ERROR = 1;

/** Los ficheros de cliente, igual que `CLIENTS` de setup.js (sin importarlo: ciclo). */
const CLIENT_FILES = [
  { key: "mcpServers", file: (root) => path.join(root, ".mcp.json") },
  { key: "servers", file: (root) => path.join(root, ".vscode", "mcp.json") },
];

/** Carpetas que no merece la pena recorrer buscando proyectos. */
const NO_RECORRER = new Set([
  "node_modules",
  ".git",
  "bin",
  "obj",
  "dist",
  "packages",
]);

function norm(p) {
  return path.resolve(String(p)).replace(/\\/g, "/").toLowerCase();
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ── Registro de proyectos ────────────────────────────────────────────────────

function registryPath(dir = runtimeDir()) {
  return path.join(dir, "projects.json");
}

function readRegistry(dir = runtimeDir()) {
  try {
    const json = JSON.parse(
      stripBom(fs.readFileSync(registryPath(dir), "utf8"))
    );
    return Array.isArray(json.projects) ? json.projects.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Apunta el proyecto en el registro. NUNCA lanza: lo llama `writeClientConfig` justo
 * despues de escribir la configuracion, y un fallo aqui no puede deshacer eso.
 */
function registerProject(root, dir = runtimeDir(), { tmp = os.tmpdir() } = {}) {
  try {
    // Lo que se escribe en temporales (los tests, un proyecto de prueba) no es un
    // proyecto del equipo, y llenaria el registro del usuario de carpetas que ya no estan.
    if (`${norm(root)}/`.startsWith(`${norm(tmp)}/`)) return;
    const actuales = readRegistry(dir);
    if (actuales.some((p) => norm(p) === norm(root))) return;
    fs.mkdirSync(dir, { recursive: true });
    const projects = [...actuales, path.resolve(root)];
    fs.writeFileSync(
      registryPath(dir),
      `${JSON.stringify({ projects }, null, 2)}\n`,
      "utf8"
    );
  } catch {
    // El registro es una ayuda para --update, no parte de la configuracion.
  }
}

/** Las carpetas de proyecto que Claude Code tiene registradas. */
function claudeProjects(home = os.homedir()) {
  try {
    const json = JSON.parse(
      stripBom(fs.readFileSync(path.join(home, ".claude.json"), "utf8"))
    );
    return Object.keys((json && json.projects) || {});
  } catch {
    return [];
  }
}

/** Carpetas bajo `root` (incluida) que tienen algun fichero de cliente MCP. */
function scanForProjects(root, depth = 4) {
  const out = [];
  const visitar = (dir, nivel) => {
    if (CLIENT_FILES.some((c) => fs.existsSync(c.file(dir)))) out.push(dir);
    if (nivel >= depth) return;
    let hijos;
    try {
      hijos = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const h of hijos) {
      if (!h.isDirectory() || NO_RECORRER.has(h.name.toLowerCase())) continue;
      if (h.name.startsWith(".") && h.name !== ".vscode") continue;
      visitar(path.join(dir, h.name), nivel + 1);
    }
  };
  visitar(path.resolve(root), 0);
  return out;
}

/** Todos los candidatos, sin repetir y solo los que existen. */
function collectProjects({
  scan = [],
  runtime = runtimeDir(),
  home = os.homedir(),
} = {}) {
  const vistos = new Map();
  const add = (p) => {
    if (!p) return;
    const k = norm(p);
    if (vistos.has(k)) return;
    try {
      if (!fs.statSync(p).isDirectory()) return;
    } catch {
      return;
    }
    vistos.set(k, path.resolve(p));
  };
  readRegistry(runtime).forEach(add);
  claudeProjects(home).forEach(add);
  for (const root of scan) scanForProjects(root).forEach(add);
  return [...vistos.values()];
}

// ── Reparacion del lanzador ──────────────────────────────────────────────────

/**
 * Separa el lanzador de los flags de una entrada nuestra.
 *
 * Devuelve null si la entrada no tiene una forma que sepamos reescribir sin riesgo: un
 * `node` contra un clon de desarrollo, por ejemplo, es deliberado y no se toca.
 *
 * @param bin `start-mssql-mcp` o `start-ahora-mcp`
 */
function splitLauncher(entry, bin, runtime) {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const command = String(entry.command || "");

  if (/^npx(\.cmd)?$/i.test(command)) {
    const idx = args.indexOf(bin);
    const spec = args.find((a) => a.startsWith("--package="));
    if (idx === -1 || !spec || !spec.includes("AHORA-SQL-MCP")) return null;
    return { flags: args.slice(idx + 1), form: "npx" };
  }

  if (/^node(\.exe)?$/i.test(command) && args.length > 0) {
    const script = args[0].replace(/\\/g, "/");
    // Solo lo que vive dentro de NUESTRA carpeta de runtime.
    if (!script.toLowerCase().startsWith(`${norm(runtime)}/`)) return null;
    if (!path.posix.basename(script).startsWith(bin)) return null;
    return { flags: args.slice(1), form: "node" };
  }
  return null;
}

/** Ruta del lanzador de producto, al lado del de SQL en la misma instalacion. */
function productEntryPath(runtime) {
  return path.join(path.dirname(entryPath(runtime)), "start-ahora-mcp.cjs");
}

/**
 * Deja al dia el lanzador de nuestras entradas en UN fichero de cliente.
 *
 * Devuelve lo que ha cambiado (o cambiaria, con `dryRun`). Un JSON roto no se toca: se
 * informa y se sigue con el resto.
 */
function repairClientFile(
  file,
  clientKey,
  { runtime = runtimeDir(), dryRun = false } = {}
) {
  if (!fs.existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (err) {
    return { file, error: `JSON no valido: ${err.message}`, changes: [] };
  }
  const servers = doc && typeof doc === "object" ? doc[clientKey] : null;
  if (!servers || typeof servers !== "object") return null;

  const changes = [];
  const sqlEntry = entryPath(runtime).replace(/\\/g, "/");
  const productEntry = productEntryPath(runtime).replace(/\\/g, "/");

  const reparar = (name, bin, target) => {
    const entry = servers[name];
    if (!entry || typeof entry !== "object") return;
    const split = splitLauncher(entry, bin, runtime);
    if (!split) return;
    const next = { ...entry, command: "node", args: [target, ...split.flags] };
    const igual =
      entry.command === next.command &&
      JSON.stringify(entry.args) === JSON.stringify(next.args);
    if (igual) return;
    servers[name] = next;
    changes.push({
      server: name,
      from: split.form,
      before: (entry.args || [])[0],
    });
  };

  // El nombre anterior se migra igual que lo hace writeClientConfig, pero solo si no
  // hay ya un `ahora-sql`: con los dos, elegir cual vale es cosa del formulario.
  if (
    servers[LEGACY_SERVER_NAME] &&
    !servers[SERVER_NAME] &&
    isOurServerEntry(servers[LEGACY_SERVER_NAME])
  ) {
    servers[SERVER_NAME] = servers[LEGACY_SERVER_NAME];
    delete servers[LEGACY_SERVER_NAME];
    changes.push({ server: SERVER_NAME, from: `nombre ${LEGACY_SERVER_NAME}` });
  }
  if (isOurServerEntry(servers[SERVER_NAME])) {
    reparar(SERVER_NAME, "start-mssql-mcp", sqlEntry);
  }
  if (isOurProductEntry(servers[PRODUCT_SERVER_NAME])) {
    reparar(PRODUCT_SERVER_NAME, "start-ahora-mcp", productEntry);
  }

  if (changes.length > 0 && !dryRun) {
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }
  return { file, changes };
}

/** Repara todos los ficheros de cliente de un proyecto. */
function repairProject(root, options = {}) {
  const files = [];
  let configured = false;
  for (const client of CLIENT_FILES) {
    const file = client.file(root);
    const r = repairClientFile(file, client.key, options);
    if (!r) continue;
    configured =
      configured || r.error !== undefined || hasOurEntry(file, client.key);
    if (r.error || r.changes.length > 0) files.push(r);
  }
  return { root, configured, files };
}

function hasOurEntry(file, clientKey) {
  try {
    const doc = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
    const servers = (doc && doc[clientKey]) || {};
    return (
      isOurServerEntry(servers[SERVER_NAME]) ||
      isOurProductEntry(servers[PRODUCT_SERVER_NAME])
    );
  } catch {
    return false;
  }
}

// ── Orquestacion ─────────────────────────────────────────────────────────────

/**
 * El MCP de producto se actualiza solo si ya estaba instalado: este modo deja al dia lo
 * que hay, no instala piezas nuevas. Su fallo (sin SDK de .NET, feed caido, dll en uso
 * por una sesion abierta) no tumba la actualizacion del servidor de SQL.
 */
async function updateProduct({ pm = require("./product-mcp") } = {}) {
  const dir = pm.productRuntimeDir();
  const installed = pm.installedProductVersion(dir);
  if (!installed) return { skipped: "no instalado" };
  let latest;
  try {
    latest = await pm.latestProductVersion();
  } catch (err) {
    return {
      installed,
      error: `no se ha podido consultar la ultima version: ${err.message}`,
    };
  }
  if (!latest || pm.compareVersions(latest, installed) <= 0) {
    return { installed, latest, upToDate: true };
  }
  try {
    pm.installProductMcp({ version: latest, dir });
    return { installed, latest, updated: true };
  } catch (err) {
    return {
      installed,
      latest,
      error: err.message.split("\n")[0],
      advice: pm.productFailureAdvice(err),
    };
  }
}

/**
 * Actualiza el runtime y repara los proyectos.
 *
 * Si la instalacion del runtime falla, NO se reparan los proyectos: reescribir un
 * lanzador para que apunte a un bundle/ que no existe romperia los que hoy funcionan.
 */
async function runUpdate({
  spec,
  version,
  scan = [],
  dryRun = false,
  runtime = runtimeDir(),
  home = os.homedir(),
  install = installRuntime,
  product = updateProduct,
  log = () => {},
} = {}) {
  const before = installedVersion(runtime);
  let runtimeResult;
  if (dryRun) {
    runtimeResult = { before, skipped: "dry-run" };
  } else {
    try {
      const r = install({ spec, version, dir: runtime });
      runtimeResult = {
        before,
        after: installedVersion(runtime),
        reused: r.reused,
        keptNewer: r.keptNewer,
      };
    } catch (err) {
      return {
        code: EXIT_ERROR,
        result: {
          ok: false,
          phase: "runtime",
          before,
          error: err.message.split("\n")[0],
        },
      };
    }
  }
  log(runtimeResult);

  const productResult = dryRun ? { skipped: "dry-run" } : await product();

  const projects = collectProjects({ scan, runtime, home })
    .map((root) => repairProject(root, { runtime, dryRun }))
    .filter((p) => p.configured);

  return {
    code: EXIT_OK,
    result: {
      ok: true,
      phase: "update",
      dryRun,
      runtime: runtimeResult,
      product: productResult,
      projects: projects.map((p) => ({
        root: p.root,
        repaired: p.files.flatMap((f) =>
          f.changes.map((c) => ({ file: f.file, ...c }))
        ),
        errors: p.files
          .filter((f) => f.error)
          .map((f) => ({ file: f.file, error: f.error })),
      })),
    },
  };
}

/** Resumen legible, antes de la linea de resultado. */
function printSummary(result, out) {
  const w = (s = "") => out.write(`${s}\n`);
  const rt = result.runtime || {};
  if (rt.skipped)
    w(`Servidor de SQL: v${rt.before || "?"} (sin cambios: ${rt.skipped})`);
  else if (rt.keptNewer)
    w(
      `Servidor de SQL: se mantiene v${rt.keptNewer}, mas nueva que este instalador.`
    );
  else if (rt.reused) w(`Servidor de SQL: ya estaba en v${rt.after}.`);
  else w(`Servidor de SQL: v${rt.before || "(no instalado)"} -> v${rt.after}.`);

  const p = result.product || {};
  if (p.updated) w(`MCP de producto: v${p.installed} -> v${p.latest}.`);
  else if (p.upToDate) w(`MCP de producto: al dia (v${p.installed}).`);
  else if (p.error)
    w(`MCP de producto: NO actualizado (${p.error}). ${p.advice || ""}`.trim());

  const reparados = result.projects.filter((x) => x.repaired.length > 0);
  w(`Proyectos configurados encontrados: ${result.projects.length}.`);
  if (reparados.length === 0) {
    w(
      "Ninguno necesitaba cambios: todos apuntan a la instalacion, que ya esta actualizada."
    );
  }
  for (const proj of reparados) {
    w(`  ${result.dryRun ? "(se repararia)" : "reparado"}  ${proj.root}`);
    for (const r of proj.repaired)
      w(`      ${r.server}: lanzador ${r.from} -> instalado`);
  }
  for (const proj of result.projects.filter((x) => x.errors.length > 0)) {
    for (const e of proj.errors) w(`  ! ${e.file}: ${e.error}`);
  }
  w(
    "Reinicia las sesiones de Claude abiertas para que carguen la version nueva."
  );
}

/** Punto de entrada desde `ahora-setup --update [--scan <carpeta>]... [--dry-run]`. */
function runUpdateCli(argv, { spec, version, out = process.stdout } = {}) {
  const scan = [];
  argv.forEach((a, i) => {
    if (a === "--scan" && argv[i + 1]) scan.push(argv[i + 1]);
  });
  return runUpdate({ spec, version, scan, dryRun: argv.includes("--dry-run") })
    .then(({ code, result }) => {
      if (result.ok) printSummary(result, out);
      else
        out.write(`No se ha podido actualizar el servidor: ${result.error}\n`);
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
  registryPath,
  readRegistry,
  registerProject,
  claudeProjects,
  scanForProjects,
  collectProjects,
  splitLauncher,
  repairClientFile,
  repairProject,
  updateProduct,
  runUpdate,
  runUpdateCli,
};
