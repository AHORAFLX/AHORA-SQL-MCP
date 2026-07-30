/**
 * Formulario local del instalador.
 *
 * Levanta un servidor en 127.0.0.1, abre el navegador y sirve un formulario
 * autocontenido. No hay dependencias: solo `http` y un HTML con el CSS y el JS
 * dentro. El exe no crece nada y funciona en cualquier maquina con navegador.
 *
 * La logica es la MISMA que la del asistente de terminal (installer/setup.js) y la
 * del wrapper: aqui solo hay presentacion y transporte.
 *
 * SEGURIDAD: un servidor local que escribe ficheros es alcanzable por cualquier
 * pagina que el usuario tenga abierta. Contra eso:
 *   - escucha solo en 127.0.0.1,
 *   - cada peticion a /api necesita un token aleatorio que solo viaja en la URL
 *     que abrimos nosotros, enviado en una cabecera propia (una peticion
 *     cross-origin no puede poner cabeceras propias sin un preflight, que no
 *     respondemos),
 *   - se rechaza cualquier peticion con cabecera Origin ajena.
 */
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const {
  resolveConfigFile,
  listConnectionNames,
  readConnString,
  parseAdoConnectionString,
  applyConnection,
  resolveEnvironment,
} = require("../bin/start-mssql-mcp");

const {
  findConfigFiles,
  buildArgs,
  writeClientConfig,
  CLIENTS,
  PROFILES,
} = require("./setup");

const PKG_VERSION = require("../package.json").version;
const TOKEN_HEADER = "x-ahora-token";

/** Donde se guardan las credenciales cuando el proyecto no tiene fichero de configuracion. */
function credentialsPathFor(projectDir) {
  const base =
    process.platform === "win32"
      ? path.join(process.env.APPDATA || os.homedir(), "ahora-sql-mcp")
      : path.join(
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
          "ahora-sql-mcp"
        );
  const name = path.basename(path.resolve(projectDir)).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(base, `${name || "proyecto"}.json`);
}

function writeCredentialsFile(projectDir, connections) {
  const target = credentialsPathFor(projectDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const one = (c) => ({
    server: c.server,
    database: c.database,
    user: c.user,
    password: c.password,
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

  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // en Windows no aplica; el fichero queda igualmente fuera del repositorio
  }
  return target;
}

/** Detecta los ficheros de configuracion de un proyecto y sus nombres de conexion. */
function detect(projectDir) {
  const root = path.resolve(projectDir);
  if (!fs.existsSync(root)) throw new Error(`No existe la carpeta: ${root}`);

  const files = findConfigFiles(root).map((file) => {
    let names = [];
    let error = null;
    try {
      names = listConnectionNames(file);
    } catch (err) {
      error = err.message;
    }
    return {
      path: file,
      rel: path.relative(root, file) || path.basename(file),
      type: path.extname(file).toLowerCase() === ".json" ? "core" : "framework",
      names,
      error,
    };
  });
  return { root, files, defaultEnvironment: resolveEnvironment(undefined) };
}

/** Valida cada conexion elegida contra el fichero real. */
function validate({ configFile, environment, names }) {
  const resolved = resolveConfigFile(configFile);
  return names.map(({ name, alias }) => {
    try {
      const { value, source } = readConnString(resolved, name, { environment });
      const info = applyConnection({}, "MSSQL_", parseAdoConnectionString(value), name);
      return {
        name,
        alias,
        ok: true,
        target: info.target,
        database: info.database,
        source: path.basename(source),
      };
    } catch (err) {
      return { name, alias, ok: false, error: err.message };
    }
  });
}

function write(payload) {
  const {
    projectDir,
    configFile,
    environment,
    connections = [],
    manualConnections = [],
    profileKey,
    sqlDirs = [],
    clients = [],
  } = payload;

  const root = path.resolve(projectDir);
  const profile = PROFILES.find((p) => p.key === profileKey) || PROFILES[0];
  const allowWrites = Boolean(payload.allowWrites) && profile.canWrite;

  for (const dir of sqlDirs) {
    if (!fs.existsSync(dir)) throw new Error(`La carpeta de .sql no existe: ${dir}`);
  }

  let credentialsFile;
  if (manualConnections.length > 0) {
    credentialsFile = writeCredentialsFile(root, manualConnections);
  } else if (!configFile) {
    throw new Error("Falta el fichero de configuracion o los datos de conexion.");
  }

  const args = buildArgs({
    configFile: configFile ? resolveConfigFile(configFile) : undefined,
    credentialsFile,
    connections,
    environment: configFile && path.extname(configFile).toLowerCase() === ".json" ? environment : undefined,
    allowWrites,
    production: profile.production,
    sqlDirs,
  });

  const written = [];
  for (const key of clients) {
    const client = CLIENTS[key];
    if (!client) continue;
    const result = writeClientConfig(client, root, args);
    written.push({ ...result, client: key });
  }
  if (written.length === 0) throw new Error("No se ha indicado ningun cliente MCP.");

  return {
    written,
    args,
    credentialsFile,
    production: profile.production,
    allowWrites,
    dbKeys: connections.length > 0
      ? connections.map((c) => c.alias || "maindb")
      : manualConnections.map((c) => c.alias || "maindb"),
  };
}

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("cuerpo demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`cuerpo JSON no valido: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Arranca el formulario.
 *
 * `onReady` recibe { url, port, token } en cuanto escucha: es lo que permite
 * probar los endpoints sin tener que rascar la URL de la salida por consola.
 */
function startGui({ open = true, host = "127.0.0.1", onReady, quiet = false } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  const html = renderPage(token);

  return new Promise((resolve, reject) => {
    let finished = false;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${host}`);
      const origin = req.headers.origin;

      // Solo se sirve la pagina si la URL lleva el token; el resto de peticiones
      // deben traerlo en la cabecera propia.
      if (req.method === "GET" && url.pathname === "/") {
        if (url.searchParams.get("t") !== token) {
          res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          res.end("Token no valido. Vuelve a abrir la URL que imprime el instalador.");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(html);
        return;
      }

      if (!url.pathname.startsWith("/api/")) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers[TOKEN_HEADER] !== token) {
        sendJson(res, 403, { error: "token no valido" });
        return;
      }
      if (origin && origin !== `http://${host}:${server.address().port}`) {
        sendJson(res, 403, { error: "origen no permitido" });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "usa POST" });
        return;
      }

      try {
        const body = await readBody(req);
        switch (url.pathname) {
          case "/api/detect":
            return sendJson(res, 200, detect(body.projectDir));
          case "/api/validate":
            return sendJson(res, 200, { results: validate(body) });
          case "/api/write":
            return sendJson(res, 200, write(body));
          case "/api/quit":
            sendJson(res, 200, { ok: true });
            finished = true;
            server.close(() => resolve({ completed: true }));
            return;
          default:
            return sendJson(res, 404, { error: "endpoint desconocido" });
        }
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });

    server.on("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      const url = `http://${host}:${port}/?t=${token}`;
      if (!quiet) {
        console.log(`\nInstalador AHORA-SQL-MCP v${PKG_VERSION}`);
        console.log("─".repeat(66));
        console.log("Se abre el formulario en el navegador. Si no se abre solo,");
        console.log("copia esta direccion:");
        console.log(`\n  ${url}\n`);
        console.log("Deja esta ventana abierta mientras lo usas. Ctrl+C para salir.");
        console.log("─".repeat(66));
      }
      if (open) openBrowser(url);
      if (onReady) onReady({ url, port, token });
    });

    server.on("close", () => {
      if (!finished) resolve({ completed: false });
    });
  });
}

function renderPage(token) {
  const profiles = PROFILES.map(
    (p) => `<option value="${p.key}" data-canwrite="${p.canWrite}">${p.label}</option>`
  ).join("");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Instalador AHORA-SQL-MCP</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#1a1d21; --card:#fff; --line:#d8dce2;
          --accent:#0b5fff; --ok:#0a7c3f; --err:#c02626; --muted:#5b6472; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#15181c; --fg:#e8eaed; --card:#1e2227; --line:#333941; --accent:#5b9bff;
            --ok:#4bc07c; --err:#ff6b6b; --muted:#9aa3b0; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px 20px 64px; background:var(--bg); color:var(--fg);
         font:15px/1.55 "Segoe UI",system-ui,sans-serif; }
  .wrap { max-width:760px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 28px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px;
            padding:20px 22px; margin-bottom:18px; }
  section[hidden] { display:none; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
       margin:0 0 14px; }
  label { display:block; font-weight:600; margin:14px 0 5px; }
  label:first-of-type { margin-top:0; }
  input[type=text], input[type=password], select { width:100%; padding:9px 11px; font-size:14px;
    border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--fg); }
  .row { display:flex; gap:10px; align-items:flex-end; }
  .row > *:first-child { flex:1; }
  button { padding:9px 16px; font-size:14px; font-weight:600; border:0; border-radius:7px;
           background:var(--accent); color:#fff; cursor:pointer; }
  button.sec { background:transparent; color:var(--accent); border:1px solid var(--line); }
  button:disabled { opacity:.5; cursor:default; }
  .hint { color:var(--muted); font-size:13px; margin:6px 0 0; }
  .list { margin:10px 0 0; padding:0; list-style:none; }
  .list li { padding:8px 10px; border:1px solid var(--line); border-radius:7px; margin-bottom:6px;
             display:flex; gap:10px; align-items:center; }
  .list input[type=radio], .list input[type=checkbox] { width:auto; margin:0; }
  .ok { color:var(--ok); } .err { color:var(--err); }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:7px; padding:12px;
        overflow-x:auto; font-size:12.5px; margin:10px 0 0; }
  .banner { padding:11px 13px; border-radius:7px; margin:0 0 14px; font-size:14px; }
  .banner.warn { background:rgba(192,38,38,.1); border:1px solid var(--err); }
  .banner.good { background:rgba(10,124,63,.1); border:1px solid var(--ok); }
  fieldset { border:1px solid var(--line); border-radius:7px; padding:12px 14px; margin:14px 0 0; }
  legend { font-weight:600; padding:0 6px; font-size:13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Instalador AHORA-SQL-MCP</h1>
  <p class="sub">Configura el acceso a base de datos del agente en la carpeta de tu proyecto.</p>

  <section id="s1">
    <h2>1 · Proyecto</h2>
    <label for="dir">Carpeta raiz del proyecto</label>
    <div class="row">
      <input type="text" id="dir" placeholder="C:\\ruta\\a\\mi\\proyecto">
      <button id="btnDetect">Detectar</button>
    </div>
    <p class="hint">Se buscan Web.config y appsettings.json dentro de la carpeta.</p>
    <div id="detectOut"></div>
  </section>

  <section id="s2" hidden>
    <h2>2 · Conexion</h2>
    <div id="fileList"></div>
    <div id="coreEnv" hidden>
      <label for="env">Entorno de appsettings</label>
      <input type="text" id="env">
      <p class="hint">En Flexygo Core las cadenas suelen estar vacias en appsettings.json
        y rellenas en appsettings.&lt;entorno&gt;.json.</p>
    </div>
    <div id="names"></div>
    <fieldset id="manual" hidden>
      <legend>Sin fichero de configuracion</legend>
      <label for="mServer">Servidor</label>
      <input type="text" id="mServer" placeholder="PC_158\\SQL2022">
      <label for="mDb">Base de datos</label>
      <input type="text" id="mDb">
      <label for="mUser">Usuario</label>
      <input type="text" id="mUser">
      <label for="mPass">Contrasena</label>
      <input type="password" id="mPass">
      <p class="hint">No se guardan en el .mcp.json: van a un fichero fuera del
        repositorio y en la configuracion solo queda su ruta.</p>
    </fieldset>
    <div class="row" style="margin-top:16px">
      <div></div><button id="btnValidate">Validar conexion</button>
    </div>
    <div id="validateOut"></div>
  </section>

  <section id="s3" hidden>
    <h2>3 · Entorno y permisos</h2>
    <label for="profile">¿Contra que base de datos vas a trabajar?</label>
    <select id="profile">${profiles}</select>
    <div id="writeBox">
      <label style="margin-top:14px"><input type="checkbox" id="writes" style="width:auto">
        Permitir INSERT / UPDATE / DDL</label>
    </div>
    <div id="prodWarn" class="banner warn" hidden style="margin-top:14px">
      En produccion la escritura no se ofrece. La configuracion se marca como
      <strong>PRODUCCION</strong>: si alguien anade <code>--allow-writes</code> a mano,
      el servidor se negara a arrancar.
    </div>
    <label style="margin-top:16px" for="sqlDir">Carpeta con ficheros .sql de fuera del proyecto
      (opcional)</label>
    <input type="text" id="sqlDir" placeholder="C:\\Codigo GIT\\scripts-sql">
    <p class="hint">Los .sql que esten dentro del proyecto ya funcionan sin configurar nada.</p>
    <fieldset>
      <legend>Cliente MCP</legend>
      <label><input type="checkbox" id="cClaude" checked style="width:auto">
        Claude Code <span class="hint">(.mcp.json)</span></label>
      <label><input type="checkbox" id="cVscode" style="width:auto">
        VS Code / Copilot <span class="hint">(.vscode/mcp.json)</span></label>
    </fieldset>
    <div class="row" style="margin-top:18px">
      <div></div><button id="btnWrite">Escribir configuracion</button>
    </div>
    <div id="writeOut"></div>
  </section>

  <section id="s4" hidden>
    <h2>4 · Listo</h2>
    <div id="doneOut"></div>
  </section>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);
let detected = null, chosenFile = null, validated = null;

async function api(path, body) {
  const res = await fetch("/api/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ${JSON.stringify(TOKEN_HEADER)}: TOKEN },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "error " + res.status);
  return data;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}

$("btnDetect").onclick = async () => {
  $("detectOut").innerHTML = "Buscando…";
  try {
    detected = await api("detect", { projectDir: $("dir").value });
    $("env").value = detected.defaultEnvironment;
    const withNames = detected.files.filter((f) => f.names.length > 0);
    let html = '<p class="hint">Raiz: ' + esc(detected.root) + "</p>";
    if (detected.files.length === 0) {
      html += '<div class="banner warn">No he encontrado Web.config ni appsettings.json. ' +
              "Puedes meter los datos de conexion a mano en el paso 2.</div>";
    } else {
      html += '<div class="banner good">' + detected.files.length +
              " fichero(s) encontrado(s), " + withNames.length + " con cadenas de conexion.</div>";
    }
    $("detectOut").innerHTML = html;
    renderFiles();
    $("s2").hidden = false;
  } catch (e) { $("detectOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>"; }
};

function renderFiles() {
  const items = detected.files.map((f, i) =>
    '<li><input type="radio" name="cfg" id="cfg' + i + '" value="' + i + '">' +
    '<label for="cfg' + i + '" style="margin:0;font-weight:400">' + esc(f.rel) +
    ' <span class="hint">' + (f.type === "core" ? ".NET Core" : ".NET Framework") + " · " +
    (f.names.length ? f.names.length + " cadena(s)" : "sin cadenas") + "</span></label></li>"
  ).join("");
  $("fileList").innerHTML = '<ul class="list">' + items +
    '<li><input type="radio" name="cfg" id="cfgNone" value="none">' +
    '<label for="cfgNone" style="margin:0;font-weight:400">No hay fichero: meto los datos a mano</label></li></ul>';
  for (const el of document.querySelectorAll('input[name=cfg]')) el.onchange = onFileChange;
  if (detected.files.length > 0) { $("cfg0").checked = true; onFileChange(); }
  else { $("cfgNone").checked = true; onFileChange(); }
}

function onFileChange() {
  const val = document.querySelector('input[name=cfg]:checked').value;
  if (val === "none") {
    chosenFile = null;
    $("manual").hidden = false; $("coreEnv").hidden = true; $("names").innerHTML = "";
    return;
  }
  chosenFile = detected.files[Number(val)];
  $("manual").hidden = true;
  $("coreEnv").hidden = chosenFile.type !== "core";
  const items = chosenFile.names.map((n, i) =>
    '<li><input type="checkbox" class="nm" id="nm' + i + '" value="' + esc(n) + '">' +
    '<label for="nm' + i + '" style="margin:0;font-weight:400;flex:1">' + esc(n) + "</label>" +
    '<input type="text" class="al" placeholder="alias (config / data)" style="width:190px">' +
    "</li>").join("");
  $("names").innerHTML = chosenFile.names.length
    ? "<label>Cadenas a exponer</label><ul class=\\"list\\">" + items + "</ul>" +
      '<p class="hint">Flexygo necesita dos: alias <code>config</code> y <code>data</code>. ' +
      "Con una sola conexion el alias se ignora y la clave es <code>maindb</code>.</p>"
    : '<div class="banner warn">Ese fichero no declara cadenas de conexion.</div>';
  if (chosenFile.names.length === 2) {
    $("nm0").checked = $("nm1").checked = true;
    const al = document.querySelectorAll(".al");
    al[0].value = "config"; al[1].value = "data";
  } else if (chosenFile.names.length === 1) { $("nm0").checked = true; }
}

function selectedNames() {
  const out = [];
  document.querySelectorAll("#names .list li").forEach((li) => {
    const cb = li.querySelector(".nm");
    if (cb && cb.checked) out.push({ name: cb.value, alias: li.querySelector(".al").value.trim() || undefined });
  });
  return out;
}
function manualConnection() {
  return { server: $("mServer").value.trim(), database: $("mDb").value.trim(),
           user: $("mUser").value.trim(), password: $("mPass").value };
}

$("btnValidate").onclick = async () => {
  $("validateOut").innerHTML = "Validando…";
  try {
    if (!chosenFile) {
      const m = manualConnection();
      if (!m.server || !m.database || !m.user || !m.password) {
        throw new Error("Faltan datos: servidor, base de datos, usuario y contrasena.");
      }
      validated = { manual: [m] };
      $("validateOut").innerHTML = '<div class="banner good">Datos completos. ' +
        "Se guardaran fuera del repositorio.</div>";
    } else {
      const names = selectedNames();
      if (names.length === 0) throw new Error("Elige al menos una cadena de conexion.");
      const { results } = await api("validate", {
        configFile: chosenFile.path, environment: $("env").value, names,
      });
      const rows = results.map((r) => r.ok
        ? '<li><span class="ok">✓</span> <strong>' + esc(r.name) + "</strong> → " +
          esc(r.target) + " / " + esc(r.database) + ' <span class="hint">(de ' + esc(r.source) + ")</span></li>"
        : '<li><span class="err">✗</span> <strong>' + esc(r.name) + "</strong> " +
          '<span class="err">' + esc(r.error) + "</span></li>").join("");
      $("validateOut").innerHTML = '<ul class="list">' + rows + "</ul>";
      if (results.some((r) => !r.ok)) {
        $("validateOut").innerHTML += '<div class="banner warn">Alguna cadena no se resuelve. ' +
          "En .NET Core la causa habitual es el entorno.</div>";
        return;
      }
      validated = { names: results.map((r) => ({ name: r.name, alias: r.alias })) };
    }
    $("s3").hidden = false;
  } catch (e) { $("validateOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>"; }
};

$("profile").onchange = () => {
  const opt = $("profile").selectedOptions[0];
  const canWrite = opt.dataset.canwrite === "true";
  $("writeBox").hidden = !canWrite;
  $("prodWarn").hidden = canWrite;
  if (!canWrite) $("writes").checked = false;
};

$("btnWrite").onclick = async () => {
  $("btnWrite").disabled = true;
  $("writeOut").innerHTML = "Escribiendo…";
  try {
    const clients = [];
    if ($("cClaude").checked) clients.push("claude");
    if ($("cVscode").checked) clients.push("vscode");
    if (clients.length === 0) throw new Error("Elige al menos un cliente MCP.");
    const sqlDirs = $("sqlDir").value.trim() ? [$("sqlDir").value.trim()] : [];

    const res = await api("write", {
      projectDir: detected.root,
      configFile: chosenFile ? chosenFile.path : null,
      environment: $("env").value,
      connections: validated.names || [],
      manualConnections: validated.manual || [],
      profileKey: $("profile").value,
      allowWrites: $("writes").checked,
      sqlDirs, clients,
    });

    let html = "<p>Ficheros escritos:</p><ul class=\\"list\\">" +
      res.written.map((w) => "<li>" + esc(w.target) +
        (w.replaced ? ' <span class="hint">(servidor mssql actualizado)</span>' : "") +
        (w.others.length ? ' <span class="hint">· conservados: ' + esc(w.others.join(", ")) + "</span>" : "") +
        "</li>").join("") + "</ul>";
    if (res.credentialsFile) {
      html += '<p>Credenciales, fuera del repositorio:</p><pre>' + esc(res.credentialsFile) + "</pre>";
    }
    if (res.production) html += '<div class="banner warn">Marcada como PRODUCCION, solo lectura.</div>';
    else if (res.allowWrites) html += '<div class="banner warn">Escritura habilitada. Solo local o pruebas.</div>';
    html += "<p><strong>Ahora reinicia el cliente MCP</strong> — sin reiniciar no lee la " +
            "configuracion. Despues pide al agente: «lista las bases de datos configuradas». " +
            "Debe responder con " + res.dbKeys.map((k) => "<code>" + esc(k) + "</code>").join(" y ") + ".</p>" +
            '<p style="margin-top:18px"><button class="sec" id="btnQuit">Cerrar el instalador</button></p>';
    $("doneOut").innerHTML = html;
    $("s4").hidden = false;
    $("writeOut").innerHTML = "";
    $("btnQuit").onclick = async () => {
      await api("quit");
      $("doneOut").innerHTML = "<p>Instalador cerrado. Ya puedes cerrar esta pestana.</p>";
    };
  } catch (e) {
    $("writeOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>";
    $("btnWrite").disabled = false;
  }
};
</script>
</body>
</html>`;
}

module.exports = {
  startGui,
  detect,
  validate,
  write,
  credentialsPathFor,
  writeCredentialsFile,
  renderPage,
  TOKEN_HEADER,
};
