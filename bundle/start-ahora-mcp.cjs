#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// bin/discover-instance.js
var require_discover_instance = __commonJS({
  "bin/discover-instance.js"(exports2, module2) {
    var os = require("os");
    var fs2 = require("fs");
    var path2 = require("path");
    var { execFile, execFileSync } = require("child_process");
    var DEFAULT_CACHE_FILE = path2.join(os.tmpdir(), "ahora-sql-mcp-ports.json");
    var CACHE_TTL_MS = 6e4;
    var CACHE_VERSION = 2;
    var QUERY_TIMEOUT_MS = 5e3;
    function isLocalHost(host) {
      const h = String(host || "").trim().toLowerCase();
      if (!h) return false;
      if (["localhost", "127.0.0.1", "::1", ".", "(local)"].includes(h)) return true;
      const name = String(os.hostname() || "").toLowerCase();
      return h === name || h === name.split(".")[0];
    }
    function isSafeInstanceName(name) {
      return /^[A-Za-z0-9_$#-]+$/.test(String(name || ""));
    }
    function asList(value) {
      if (value === void 0 || value === null) return [];
      return Array.isArray(value) ? value : [value];
    }
    function buildScript(names) {
      const list = names.map((n) => `'${n}'`).join(",");
      const filter = names.map((n) => "Name='MSSQL`$" + n + "'").join(" OR ");
      return `
$ErrorActionPreference = 'SilentlyContinue'
$names = @(${list})
$probed = @{}
function Test-Tds($addr, $port) {
  $key = "$addr|$port"
  if ($probed.ContainsKey($key)) { return $probed[$key] }
  # Un puerto puede estar a la escucha y no ser el de la instancia. Se le manda el
  # saludo TDS mas corto que existe: el que contesta es un SQL Server de verdad.
  # La loopback basta para preguntarlo, asi que el sondeo no sale de la maquina.
  $probe = $addr
  if ($addr -eq '0.0.0.0') { $probe = '127.0.0.1' }
  elseif ($addr -eq '::') { $probe = '::1' }
  $ok = $false
  $sock = $null
  try {
    # Un TcpClient sin familia es IPv4 y ni siquiera intenta conectar a un '::1'.
    $fam = [Net.Sockets.AddressFamily]::InterNetwork
    if ($probe.Contains(':')) { $fam = [Net.Sockets.AddressFamily]::InterNetworkV6 }
    $sock = New-Object Net.Sockets.TcpClient -ArgumentList $fam
    $iar = $sock.BeginConnect($probe, $port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(300, $false)) {
      $sock.EndConnect($iar)
      $stream = $sock.GetStream()
      $stream.ReadTimeout = 300
      $pre = [byte[]](0x12,0x01,0x00,0x14,0x00,0x00,0x01,0x00,
                      0x00,0x00,0x06,0x00,0x06,0xFF,
                      0x10,0x00,0x00,0x00,0x00,0x00)
      $stream.Write($pre, 0, $pre.Length)
      $buf = New-Object byte[] 8
      $ok = ($stream.Read($buf, 0, 8) -gt 0)
    }
  } catch { $ok = $false } finally { if ($sock) { $sock.Close() } }
  $probed[$key] = $ok
  return $ok
}
$reg = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL'
$owners = @{}
foreach ($s in Get-CimInstance Win32_Service -Filter "${filter}") {
  if ($s.ProcessId) { $owners[[string]$s.Name] = [int]$s.ProcessId }
}
$byOwner = @{}
if ($owners.Count -gt 0) {
  foreach ($c in Get-NetTCPConnection -State Listen) {
    $owner = [int]$c.OwningProcess
    if (-not $byOwner.ContainsKey($owner)) { $byOwner[$owner] = @() }
    $byOwner[$owner] += @{ port = [int]$c.LocalPort; address = [string]$c.LocalAddress }
  }
}
$out = @{}
foreach ($inst in $names) {
  $staticPort = $null
  $dynamicPort = $null
  $id = $reg.$inst
  if ($id) {
    $tcp = Get-ItemProperty ("HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\" + $id + "\\MSSQLServer\\SuperSocketNetLib\\Tcp\\IPAll")
    if ($tcp.TcpPort -match '^\\d+$') { $staticPort = [int]$tcp.TcpPort }
    # Con puerto dinamico este es el que el servicio anoto al arrancar. Es el dato que
    # distingue el puerto de la instancia de cualquier otro que tenga abierto el proceso.
    if ($tcp.TcpDynamicPorts -match '^\\d+$') { $dynamicPort = [int]$tcp.TcpDynamicPorts }
  }
  $listen = @()
  $owner = $owners[('MSSQL$' + $inst)]
  if ($owner -and $byOwner.ContainsKey($owner)) {
    foreach ($l in $byOwner[$owner]) {
      $listen += @{ port = $l.port; address = $l.address; tds = (Test-Tds $l.address $l.port) }
    }
  }
  $out[$inst] = @{ staticPort = $staticPort; dynamicPort = $dynamicPort; listening = $listen }
}
$out | ConvertTo-Json -Depth 5 -Compress
`;
    }
    function askableNames(instanceNames) {
      return [...new Set(asList(instanceNames).map(String))].filter(isSafeInstanceName);
    }
    function powershellArgs(names) {
      return ["-NoProfile", "-NonInteractive", "-Command", buildScript(names)];
    }
    function parseInstances(names, out) {
      const parsed = JSON.parse(String(out).trim() || "{}");
      const byLower = new Map(
        Object.entries(parsed).map(([key, value]) => [String(key).toLowerCase(), value])
      );
      const result = {};
      for (const name of names) {
        const entry = byLower.get(name.toLowerCase()) || {};
        result[name] = {
          staticPort: entry.staticPort || void 0,
          dynamicPort: entry.dynamicPort || void 0,
          listening: asList(entry.listening)
        };
      }
      return result;
    }
    function queryWindowsInstances(instanceNames, { exec = execFileSync } = {}) {
      const names = askableNames(instanceNames);
      if (!names.length) return {};
      const out = exec("powershell", powershellArgs(names), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: QUERY_TIMEOUT_MS
      });
      return parseInstances(names, out);
    }
    function execFileAsync(file, args, options) {
      return new Promise((resolve, reject) => {
        execFile(
          file,
          args,
          options,
          (err, stdout) => err ? reject(err) : resolve(stdout)
        );
      });
    }
    async function queryWindowsInstancesAsync(instanceNames, { execAsync = execFileAsync } = {}) {
      const names = askableNames(instanceNames);
      if (!names.length) return {};
      const out = await execAsync("powershell", powershellArgs(names), {
        encoding: "utf8",
        timeout: QUERY_TIMEOUT_MS,
        windowsHide: true
      });
      return parseInstances(names, out);
    }
    function queryWindowsInstance(instanceName, options = {}) {
      const result = queryWindowsInstances([instanceName], options);
      return result[instanceName] || { staticPort: void 0, dynamicPort: void 0, listening: [] };
    }
    function isWildcard(entry) {
      return entry.address === "0.0.0.0" || entry.address === "::";
    }
    function tdsVerdict(entries) {
      if (entries.some((l) => l.tds === true)) return "ok";
      if (entries.length && entries.every((l) => l.tds === false)) return "dead";
      return "unknown";
    }
    function pickAddress(listening, port) {
      const forPort = listening.filter((l) => Number(l.port) === Number(port));
      if (forPort.some((l) => l.address === "0.0.0.0" || l.address === "::")) return null;
      const loopback = forPort.find((l) => l.address === "127.0.0.1" || l.address === "::1");
      return loopback ? loopback.address : null;
    }
    function chooseEndpoint(info) {
      if (!info) return null;
      const byPort = /* @__PURE__ */ new Map();
      for (const entry of asList(info.listening)) {
        const port2 = Number(entry.port);
        if (!port2) continue;
        if (!byPort.has(port2)) byPort.set(port2, []);
        byPort.get(port2).push(entry);
      }
      const rankOf = (port2, entries) => {
        if (Number(info.staticPort) === port2) return 0;
        if (Number(info.dynamicPort) === port2) return 1;
        if (port2 === 1433) return 2;
        if (entries.some(isWildcard)) return 3;
        return 4;
      };
      const usable = [...byPort.entries()].filter(([, entries]) => tdsVerdict(entries) !== "dead").sort(([a, ea], [b, eb]) => rankOf(a, ea) - rankOf(b, eb) || a - b);
      const port = byPort.size === 0 ? info.staticPort : usable.length ? usable[0][0] : null;
      if (!port) return null;
      return {
        port: String(port),
        address: pickAddress(asList(info.listening), port) || void 0
      };
    }
    function readCache(file, now) {
      try {
        const raw = JSON.parse(fs2.readFileSync(file, "utf8"));
        if (!raw || typeof raw !== "object") return {};
        const fresh = {};
        for (const [key, entry] of Object.entries(raw)) {
          if (!entry || typeof entry !== "object") continue;
          if (entry.v !== CACHE_VERSION) continue;
          if (typeof entry.at !== "number" || now - entry.at > CACHE_TTL_MS) continue;
          fresh[key] = entry;
        }
        return fresh;
      } catch {
        return {};
      }
    }
    function writeCache(file, data) {
      try {
        fs2.writeFileSync(file, JSON.stringify(data), { encoding: "utf8", mode: 384 });
      } catch {
      }
    }
    function discoveryPlan(instanceNames, options) {
      const names = [...new Set(asList(instanceNames).filter(Boolean).map(String))];
      const now = options.now || Date.now();
      const cacheFile = options.cacheFile;
      const cache = cacheFile ? readCache(cacheFile, now) : {};
      const found = {};
      const missing = [];
      for (const name of names) {
        const hit = options.refresh ? void 0 : cache[name.toLowerCase()];
        if (hit) {
          found[name] = hit.found ? { port: String(hit.found.port), address: hit.found.address || void 0 } : null;
        } else {
          missing.push(name);
        }
      }
      return { names, now, cacheFile, cache, found, missing };
    }
    function applyDiscovery(plan, info) {
      for (const name of plan.missing) {
        plan.found[name] = chooseEndpoint(info[name]) || null;
        plan.cache[name.toLowerCase()] = {
          v: CACHE_VERSION,
          at: plan.now,
          found: plan.found[name]
        };
      }
      if (plan.cacheFile) writeCache(plan.cacheFile, plan.cache);
      return plan.found;
    }
    function discoverLocalInstances(instanceNames, options = {}) {
      if ((options.platform || process.platform) !== "win32") return {};
      const plan = discoveryPlan(instanceNames, options);
      if (!plan.names.length) return {};
      if (!plan.missing.length) return plan.found;
      let info;
      try {
        info = queryWindowsInstances(plan.missing, options);
      } catch {
        info = {};
      }
      return applyDiscovery(plan, info);
    }
    async function discoverLocalInstancesAsync(instanceNames, options = {}) {
      if ((options.platform || process.platform) !== "win32") return {};
      const plan = discoveryPlan(instanceNames, options);
      if (!plan.names.length) return {};
      if (!plan.missing.length) return plan.found;
      let info;
      try {
        info = await queryWindowsInstancesAsync(plan.missing, options);
      } catch {
        info = {};
      }
      return applyDiscovery(plan, info);
    }
    function discoverLocalInstance(instanceName, options = {}) {
      if ((options.platform || process.platform) !== "win32") return null;
      if (!instanceName) return null;
      return discoverLocalInstances([instanceName], options)[instanceName] || null;
    }
    function instanceToDiscover(parts, parseDataSource2, { portOverride } = {}) {
      const raw = parts.datasource || parts.server || parts.addr || parts.address || parts.networkaddress;
      if (!raw) return null;
      const { host, instanceName, port } = parseDataSource2(raw);
      if (port || parts.port || portOverride || !instanceName || !isLocalHost(host)) return null;
      return { host, instanceName };
    }
    function withDiscoveredPort(parts, parseDataSource2, options = {}) {
      const target = instanceToDiscover(parts, parseDataSource2, options);
      if (!target) return { parts, discovered: null };
      const discover = options.discover || discoverLocalInstance;
      const found = discover(target.instanceName, options);
      if (!found) return { parts, discovered: null };
      const targetHost = found.address || target.host;
      const dataSource = targetHost.includes(":") ? `[${targetHost}],${found.port}` : `${targetHost},${found.port}`;
      return {
        parts: { ...parts, datasource: dataSource, server: void 0 },
        discovered: {
          instanceName: target.instanceName,
          host: targetHost,
          port: found.port,
          onlyLoopback: Boolean(found.address)
        }
      };
    }
    module2.exports = {
      DEFAULT_CACHE_FILE,
      CACHE_TTL_MS,
      CACHE_VERSION,
      QUERY_TIMEOUT_MS,
      tdsVerdict,
      isLocalHost,
      isSafeInstanceName,
      buildScript,
      pickAddress,
      chooseEndpoint,
      discoverLocalInstance,
      discoverLocalInstances,
      discoverLocalInstancesAsync,
      queryWindowsInstance,
      queryWindowsInstances,
      queryWindowsInstancesAsync,
      instanceToDiscover,
      withDiscoveredPort
    };
  }
});

// src/secrets.js
var require_secrets = __commonJS({
  "src/secrets.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var crypto = require("crypto");
    var { execFileSync } = require("child_process");
    function configDir() {
      return process.platform === "win32" ? path2.join(process.env.APPDATA || os.homedir(), "ahora-sql-mcp") : path2.join(
        process.env.XDG_CONFIG_HOME || path2.join(os.homedir(), ".config"),
        "ahora-sql-mcp"
      );
    }
    function keyPath() {
      return path2.join(configDir(), "secret.key");
    }
    var DPAPI = "dpapi";
    var AES = "aes-256-gcm";
    var VERSION = "v1";
    var DPAPI_TAG = `${DPAPI}:${VERSION}:`;
    var AES_TAG = `${AES}:${VERSION}:`;
    function isProtected(value) {
      return typeof value === "string" && (value.startsWith(DPAPI_TAG) || value.startsWith(AES_TAG));
    }
    function dpapiScript(method) {
      return [
        "$ErrorActionPreference='Stop'",
        "Add-Type -AssemblyName System.Security",
        "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser",
        "$out=New-Object Collections.Generic.List[string]",
        "while($null -ne ($line=[Console]::In.ReadLine())){",
        "  $line=$line.Trim()",
        "  if($line.Length -eq 0){continue}",
        "  $b=[Convert]::FromBase64String($line)",
        "  $r=[Security.Cryptography.ProtectedData]::" + method + "($b,$null,$scope)",
        "  $out.Add([Convert]::ToBase64String($r))",
        "}",
        "[Console]::Out.Write(($out -join [string][char]10))"
      ].join("\n");
    }
    function runDpapi(method, inputs, { exec = execFileSync } = {}) {
      if (inputs.length === 0) return [];
      const out = exec(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", dpapiScript(method)],
        {
          input: `${inputs.join("\n")}
`,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          // 5 segundos, no 15: descifrar son ~0,5 s medidos, y esto corre en el arranque del
          // wrapper, donde el cliente MCP esta contando sus 30 segundos hacia el saludo. Un
          // tope de 15 se comia la mitad del presupuesto sin dar ninguna opcion de arreglo.
          timeout: 5e3,
          windowsHide: true
        }
      );
      const lines = String(out).split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length !== inputs.length) {
        throw new Error(
          `DPAPI ha devuelto ${lines.length} resultados para ${inputs.length} secretos`
        );
      }
      return lines;
    }
    function loadOrCreateKey(file = keyPath()) {
      try {
        const raw = Buffer.from(fs2.readFileSync(file, "utf8").trim(), "base64");
        if (raw.length === 32) return raw;
      } catch {
      }
      const key = crypto.randomBytes(32);
      fs2.mkdirSync(path2.dirname(file), { recursive: true });
      fs2.writeFileSync(file, `${key.toString("base64")}
`, {
        encoding: "utf8",
        mode: 384
      });
      try {
        fs2.chmodSync(file, 384);
      } catch {
      }
      return key;
    }
    function readKey(file = keyPath()) {
      let raw;
      try {
        raw = Buffer.from(fs2.readFileSync(file, "utf8").trim(), "base64");
      } catch {
        throw new Error(
          `Falta el fichero de claves ${file}, necesario para descifrar las credenciales. Vuelve a ejecutar el instalador para volver a introducirlas.`
        );
      }
      if (raw.length !== 32) throw new Error(`El fichero de claves ${file} no es valido.`);
      return raw;
    }
    function aesProtect(plaintext, file) {
      const key = loadOrCreateKey(file);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const payload = Buffer.concat([iv, cipher.getAuthTag(), enc]);
      return AES_TAG + payload.toString("base64");
    }
    function aesReveal(token, file) {
      const payload = Buffer.from(token.slice(AES_TAG.length), "base64");
      const key = readKey(file);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
      decipher.setAuthTag(payload.subarray(12, 28));
      return Buffer.concat([
        decipher.update(payload.subarray(28)),
        decipher.final()
      ]).toString("utf8");
    }
    function protectAll(values, { exec, keyFile, platform = process.platform, onFallback } = {}) {
      const list = values.map((v) => String(v));
      if (list.length === 0) return [];
      if (platform === "win32") {
        try {
          const b64 = list.map((v) => Buffer.from(v, "utf8").toString("base64"));
          return runDpapi("Protect", b64, { exec }).map((c) => DPAPI_TAG + c);
        } catch (err) {
          if (onFallback) onFallback(err);
        }
      }
      return list.map((v) => aesProtect(v, keyFile));
    }
    function protect(value, options) {
      return protectAll([value], options)[0];
    }
    function revealAll(values, { exec, keyFile, platform = process.platform } = {}) {
      const out = new Array(values.length);
      const dpapiIdx = [];
      const dpapiPayload = [];
      values.forEach((value, i) => {
        if (!isProtected(value)) {
          out[i] = value;
        } else if (value.startsWith(AES_TAG)) {
          out[i] = aesReveal(value, keyFile);
        } else {
          dpapiIdx.push(i);
          dpapiPayload.push(value.slice(DPAPI_TAG.length));
        }
      });
      if (dpapiPayload.length > 0) {
        if (platform !== "win32") {
          throw new Error(
            "Estas credenciales se cifraron con DPAPI de Windows y solo se pueden descifrar en Windows con la misma cuenta. Vuelve a ejecutar el instalador."
          );
        }
        let plain;
        try {
          plain = runDpapi("Unprotect", dpapiPayload, { exec });
        } catch (err) {
          throw new Error(
            `No se han podido descifrar las credenciales. Suele significar que se cifraron con otra cuenta de Windows o en otro equipo: vuelve a ejecutar el instalador para volver a introducirlas. (${err.message})`
          );
        }
        plain.forEach((b64, n) => {
          out[dpapiIdx[n]] = Buffer.from(b64, "base64").toString("utf8");
        });
      }
      return out;
    }
    function reveal2(value, options) {
      return revealAll([value], options)[0];
    }
    module2.exports = {
      configDir,
      keyPath,
      isProtected,
      protect,
      protectAll,
      reveal: reveal2,
      revealAll
    };
  }
});

// bin/start-mssql-mcp.js
var require_start_mssql_mcp = __commonJS({
  "bin/start-mssql-mcp.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { spawn: spawn2 } = require("child_process");
    var { instanceToDiscover } = require_discover_instance();
    var { isProtected } = require_secrets();
    var USAGE2 = "Uso \xE2\u20AC\u201D elige UNA fuente de conexion:\n  a) --config-file <Web.config | appsettings.json | carpeta>\n     --connection-name <NombreConexion[:alias]>   (repetible para multi-BD)\n  b) --connection-string <cadena ADO.NET>         (repetible; con varias, cada una necesita --alias)\n  c) --server <host[\\instancia]> --database <BD> --user <usuario> --password <clave>\n  d) --from-env                                   (toma las MSSQL_* del entorno del cliente MCP)\n  e) --credentials-file <ruta a un JSON>          (credenciales cifradas, fuera del repositorio)\n\nOpcionales:\n  --environment <nombre>        entorno de appsettings.<entorno>.json (def.: ASPNETCORE_ENVIRONMENT o Development)\n  --alias <nombre>             alias para --connection-string, en el mismo orden\n  --port <puerto>              salida si SQL Browser esta parado; vale para todas\n  --port <alias>:<puerto>      repetible; puerto de UNA conexion, cuando cada BD\n                               esta en una instancia con su propio puerto\n  --encrypt <true|false>       solo con la fuente (c)\n  --trust-server-certificate <true|false>   solo con la fuente (c)\n  --production                 marca la conexion como produccion; incompatible con --allow-writes\n  --allow-writes               solo local o pruebas; habilita escritura en TODAS las conexiones\n  --allow-writes-for <alias>  repetible; habilita escritura solo en esa conexion (multi-BD)\n  --allow-sql-dir <carpeta>    repetible; carpetas extra para execute_sql_file";
    function serverEntry() {
      const bundled = path2.join(__dirname, "ahora-sql-mcp.cjs");
      if (fs2.existsSync(bundled)) return bundled;
      const fromSource = path2.join(__dirname, "..", "src", "index.js");
      if (fs2.existsSync(fromSource)) return fromSource;
      throw new Error(
        `No se encuentra el servidor. Se ha buscado en:
  ${bundled}
  ${fromSource}
Si trabajas desde el repositorio, ejecuta \`npm run build\`.`
      );
    }
    function parseArgs2(argv) {
      const out = {
        connections: [],
        connectionStrings: [],
        aliases: [],
        allowWrites: false,
        allowWritesFor: [],
        fromEnv: false,
        production: false,
        ports: [],
        sqlDirs: []
      };
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--config-file") out.configFile = argv[++i];
        else if (argv[i] === "--connection-name") out.connections.push(argv[++i]);
        else if (argv[i] === "--connection-string")
          out.connectionStrings.push(argv[++i]);
        else if (argv[i] === "--alias") out.aliases.push(argv[++i]);
        else if (argv[i] === "--environment") out.environment = argv[++i];
        else if (argv[i] === "--server") out.server = argv[++i];
        else if (argv[i] === "--database") out.database = argv[++i];
        else if (argv[i] === "--user") out.user = argv[++i];
        else if (argv[i] === "--password") out.password = argv[++i];
        else if (argv[i] === "--encrypt") out.encrypt = argv[++i];
        else if (argv[i] === "--trust-server-certificate")
          out.trustServerCertificate = argv[++i];
        else if (argv[i] === "--from-env") out.fromEnv = true;
        else if (argv[i] === "--credentials-file") out.credentialsFile = argv[++i];
        else if (argv[i] === "--production") out.production = true;
        else if (argv[i] === "--allow-writes") out.allowWrites = true;
        else if (argv[i] === "--allow-writes-for") out.allowWritesFor.push(argv[++i]);
        else if (argv[i] === "--allow-sql-dir") out.sqlDirs.push(argv[++i]);
        else if (argv[i] === "--port") {
          const value = argv[++i];
          out.ports.push(value);
          if (/^\d+$/.test(String(value ?? "").trim())) out.port = String(value).trim();
        } else {
          console.error(`Argumento no reconocido: ${argv[i]}`);
          process.exit(1);
        }
      }
      return out;
    }
    function normalizeAdoKey(key) {
      return String(key).toLowerCase().replace(/\s+/g, "");
    }
    function parseAdoConnectionString2(connString) {
      const parts = {};
      for (const piece of String(connString).split(";")) {
        const trimmed = piece.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf("=");
        if (idx === -1) {
          if (/^\d+$/.test(trimmed) && !parts.port) parts.port = trimmed;
          continue;
        }
        parts[normalizeAdoKey(trimmed.slice(0, idx))] = trimmed.slice(idx + 1).trim();
      }
      return parts;
    }
    function decodeXmlEntities(s) {
      return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    }
    function stripBom(text) {
      return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
    }
    function extractConnectionStringsSection(xml) {
      const open = xml.match(/<connectionStrings\b([^>]*?)(\/?)>/i);
      if (!open) return null;
      const attrs = open[1];
      if (open[2] === "/") return { attrs, body: "" };
      const start = open.index + open[0].length;
      const closeIdx = xml.toLowerCase().indexOf("</connectionstrings>", start);
      return { attrs, body: closeIdx === -1 ? xml.slice(start) : xml.slice(start, closeIdx) };
    }
    function readWebConfigConnections(filePath, seen = /* @__PURE__ */ new Set()) {
      const real = path2.resolve(filePath);
      if (seen.has(real)) return {};
      seen.add(real);
      const section = extractConnectionStringsSection(fs2.readFileSync(real, "utf8"));
      if (!section) return {};
      const configSource = section.attrs.match(/\bconfigSource\s*=\s*"([^"]*)"/i);
      if (configSource) {
        const external = path2.resolve(path2.dirname(real), configSource[1]);
        if (!fs2.existsSync(external)) {
          throw new Error(
            `El Web.config apunta a configSource="${configSource[1]}" pero no existe: ${external}`
          );
        }
        return readWebConfigConnections(external, seen);
      }
      const out = {};
      for (const tag of section.body.match(/<add\b[\s\S]*?(?:\/>|<\/add>)/gi) || []) {
        const name = tag.match(/\bname\s*=\s*"([^"]*)"/);
        const conn = tag.match(/\bconnectionString\s*=\s*"([^"]*)"/);
        if (name && conn) out[name[1]] = decodeXmlEntities(conn[1]);
      }
      return out;
    }
    function readAppSettingsConnections(filePath) {
      let json;
      try {
        json = JSON.parse(stripBom(fs2.readFileSync(filePath, "utf8")));
      } catch (err) {
        throw new Error(`No se pudo interpretar ${filePath} como JSON: ${err.message}`);
      }
      const sectionKey = Object.keys(json).find(
        (k) => k.toLowerCase() === "connectionstrings"
      );
      const section = sectionKey ? json[sectionKey] : null;
      if (!section || typeof section !== "object") return {};
      const out = {};
      for (const [name, value] of Object.entries(section)) {
        if (typeof value === "string") out[name] = value;
      }
      return out;
    }
    function resolveEnvironment2(environment, env = process.env) {
      return environment || env.ASPNETCORE_ENVIRONMENT || "Development";
    }
    function appSettingsChain(filePath, environment) {
      const dir = path2.dirname(filePath);
      const file = path2.basename(filePath);
      const match = file.match(/^(appsettings)\.(.+)\.json$/i);
      const base = match ? `${match[1]}.json` : file;
      const candidates = [
        path2.join(dir, `appsettings.${environment}.json`),
        filePath,
        path2.join(dir, base)
      ];
      const seen = /* @__PURE__ */ new Set();
      return candidates.filter((p) => {
        const key = process.platform === "win32" ? p.toLowerCase() : p;
        if (seen.has(key) || !fs2.existsSync(p)) return false;
        seen.add(key);
        return true;
      });
    }
    function configChain(configFile, environment) {
      const ext = path2.extname(configFile).toLowerCase();
      if (ext === ".config") return [configFile];
      if (ext === ".json") return appSettingsChain(configFile, environment);
      throw new Error(
        `Extension no soportada '${ext}'. Usa un Web.config o un appsettings.json.`
      );
    }
    function readConnectionsFrom(file) {
      return path2.extname(file).toLowerCase() === ".config" ? readWebConfigConnections(file) : readAppSettingsConnections(file);
    }
    function readConnString2(configFile, name, { environment } = {}) {
      const env = resolveEnvironment2(environment);
      const chain = configChain(configFile, env);
      if (chain.length === 0) {
        throw new Error(`No existe el archivo de configuracion: ${configFile}`);
      }
      const empty = [];
      const available = /* @__PURE__ */ new Set();
      for (const file of chain) {
        const connections = readConnectionsFrom(file);
        for (const key2 of Object.keys(connections)) available.add(key2);
        const key = Object.keys(connections).find(
          (k) => k.toLowerCase() === String(name).toLowerCase()
        );
        if (key === void 0) continue;
        if (connections[key].trim() === "") {
          empty.push(file);
          continue;
        }
        return { value: connections[key], source: file };
      }
      const detail = [];
      if (empty.length > 0) {
        detail.push(
          `Existe pero esta vacia en: ${empty.join(", ")}. En .NET Core el valor real suele estar en appsettings.${env}.json; usa --environment si tu entorno no es ${env}.`
        );
      }
      if (available.size > 0) {
        detail.push(`Disponibles: ${[...available].join(", ")}.`);
      }
      throw new Error(
        `No se encontro la cadena de conexion '${name}'. ` + `Consultado: ${chain.join(", ")}. ${detail.join(" ")}`.trim()
      );
    }
    function listConnectionNames2(configFile, { environment } = {}) {
      const names = /* @__PURE__ */ new Set();
      try {
        for (const file of configChain(configFile, resolveEnvironment2(environment))) {
          for (const key of Object.keys(readConnectionsFrom(file))) names.add(key);
        }
      } catch {
      }
      return [...names];
    }
    function resolveConfigFile2(configFile) {
      if (!fs2.existsSync(configFile)) {
        throw new Error(`No existe el archivo de configuracion: ${configFile}`);
      }
      if (!fs2.statSync(configFile).isDirectory()) return configFile;
      for (const candidate of ["appsettings.json", "Web.config"]) {
        const p = path2.join(configFile, candidate);
        if (fs2.existsSync(p)) return p;
      }
      throw new Error(
        `La carpeta ${configFile} no contiene appsettings.json ni Web.config.`
      );
    }
    var POLICY_VARS = /* @__PURE__ */ new Set(["MSSQL_SQL_DIRS"]);
    var ENABLE_WRITES_RE = /^MSSQL_(.+_)?ENABLE_WRITES$/i;
    function isPolicyVar(upper) {
      return POLICY_VARS.has(upper) || ENABLE_WRITES_RE.test(upper);
    }
    function cleanEnv2(keepConnectionVars = false, source = process.env) {
      const env = {};
      for (const [k, v] of Object.entries(source)) {
        const upper = k.toUpperCase();
        if (!upper.startsWith("MSSQL_")) {
          env[k] = v;
          continue;
        }
        if (keepConnectionVars && !isPolicyVar(upper)) env[k] = v;
      }
      return env;
    }
    function parseDataSource2(raw) {
      let s = String(raw ?? "").trim();
      if (/^".*"$/.test(s) || /^'.*'$/.test(s)) s = s.slice(1, -1).trim();
      let protocol;
      const proto = s.match(/^(tcp|np|lpc|admin)\s*:/i);
      if (proto) {
        protocol = proto[1].toLowerCase();
        s = s.slice(proto[0].length).trim();
      }
      if (s.startsWith("\\\\")) {
        const pipe = s.slice(2).split("\\");
        return { host: pipe[0] || "", instanceName: void 0, port: void 0, protocol: "np" };
      }
      let bracketed;
      const bracket = s.match(/^\[([^\]]*)\]\s*(.*)$/);
      if (bracket) {
        bracketed = bracket[1].trim();
        s = bracket[2].trim().replace(/^[,;:]\s*/, "");
      }
      let host = bracketed || "";
      let instanceName;
      let port;
      for (const token of s.split(/[,;:]/).map((t) => t.trim()).filter(Boolean)) {
        if (/^\d+$/.test(token)) {
          if (!port) port = token;
          continue;
        }
        if (token.includes("\\")) {
          const [left, right] = token.split("\\");
          const leftTrimmed = left.trim();
          if (/^\d+$/.test(leftTrimmed)) {
            if (!port) port = leftTrimmed;
          } else if (!host) {
            host = leftTrimmed;
          }
          if (right && !instanceName) instanceName = right.trim();
          continue;
        }
        if (!host) host = token;
        else if (!instanceName) instanceName = token;
      }
      if (host === "." || /^\(local\)$/i.test(host)) host = "localhost";
      if (instanceName && /^MSSQLSERVER$/i.test(instanceName)) instanceName = void 0;
      return { host, instanceName, port, protocol };
    }
    function portFor(ports, alias) {
      let bare;
      for (const raw of ports || []) {
        const value = String(raw ?? "").trim();
        const named = value.match(/^(.+?)\s*:\s*(\d+)$/);
        if (named) {
          if (alias && named[1].trim().toLowerCase() === String(alias).toLowerCase()) {
            return named[2];
          }
          continue;
        }
        if (/^\d+$/.test(value)) bare = value;
      }
      return bare;
    }
    function applyConnection(env, prefix, parts, label, portOverride) {
      const dataSource = parts.datasource || parts.server || parts.addr || parts.address || parts.networkaddress;
      const database = parts.initialcatalog || parts.database;
      const user = parts.userid || parts.uid || parts.user;
      const password = parts.password || parts.pwd;
      if (!dataSource) throw new Error(`[${label}] No se pudo determinar el servidor.`);
      if (!database) throw new Error(`[${label}] No se pudo determinar la base de datos.`);
      if (!user || !password) {
        throw new Error(
          `[${label}] La cadena de conexion no lleva usuario y contrasena. El servidor todavia no soporta autenticacion integrada de Windows.`
        );
      }
      const { host, instanceName, port, protocol } = parseDataSource2(dataSource);
      if (!host) throw new Error(`[${label}] No se pudo interpretar el servidor '${dataSource}'.`);
      if (protocol === "np" || protocol === "lpc") {
        throw new Error(
          `[${label}] El Data Source usa el protocolo '${protocol}' (${protocol === "np" ? "canalizaciones nombradas" : "memoria compartida"}), que este servidor no soporta porque su driver es solo TCP. Usa 'tcp:HOST,PUERTO' o 'HOST\\INSTANCIA'.`
        );
      }
      const finalPort = portOverride || port || parts.port;
      if (finalPort) {
        env[`${prefix}PORT`] = String(finalPort);
      } else if (instanceName) {
        env[`${prefix}INSTANCE_NAME`] = instanceName;
      }
      env[`${prefix}SERVER`] = host;
      env[`${prefix}DATABASE`] = database;
      env[`${prefix}USER`] = user;
      env[`${prefix}PASSWORD`] = password;
      if (parts.encrypt) env[`${prefix}ENCRYPT`] = parts.encrypt.toLowerCase();
      if (parts.trustservercertificate) {
        env[`${prefix}TRUST_SERVER_CERTIFICATE`] = parts.trustservercertificate.toLowerCase();
      }
      return {
        target: host + (finalPort ? `,${finalPort}` : instanceName ? `\\${instanceName}` : ""),
        database,
        viaInstance: Boolean(!finalPort && instanceName)
      };
    }
    function readCredentialsFile2(filePath) {
      if (!fs2.existsSync(filePath)) {
        throw new Error(`No existe el fichero de credenciales: ${filePath}`);
      }
      let json;
      try {
        json = JSON.parse(stripBom(fs2.readFileSync(filePath, "utf8")));
      } catch (err) {
        throw new Error(`No se pudo interpretar ${filePath} como JSON: ${err.message}`);
      }
      const check = (alias, raw) => {
        if (!raw || typeof raw !== "object") {
          throw new Error(`[${alias || "credenciales"}] entrada no valida en ${filePath}`);
        }
        return raw;
      };
      const raws = json.connections && typeof json.connections === "object" ? Object.keys(json.connections).map((alias) => ({
        alias,
        raw: check(alias, json.connections[alias])
      })) : [{ alias: void 0, raw: check(void 0, json) }];
      if (json.connections && raws.length === 0) {
        throw new Error(`${filePath} no declara ninguna conexion dentro de "connections".`);
      }
      for (const { alias, raw } of raws) {
        if (raw.passwordEnc !== void 0 && !isProtected(raw.passwordEnc)) {
          throw new Error(
            `[${alias || "credenciales"}] el campo passwordEnc de ${filePath} no tiene una marca de cifrado reconocible. Vuelve a ejecutar el instalador.`
          );
        }
      }
      const passwords = raws.map(
        ({ raw }) => raw.passwordEnc === void 0 ? raw.password : raw.passwordEnc
      );
      return raws.map(({ alias, raw }, i) => ({
        alias,
        parts: partsFromFlags({
          server: raw.port ? `${raw.server},${raw.port}` : raw.server,
          database: raw.database,
          user: raw.user,
          password: passwords[i],
          encrypt: raw.encrypt === void 0 ? void 0 : String(raw.encrypt),
          trustServerCertificate: raw.trustServerCertificate === void 0 ? void 0 : String(raw.trustServerCertificate)
        })
      }));
    }
    function partsFromFlags({
      server,
      database,
      user,
      password,
      encrypt,
      trustServerCertificate
    }) {
      const parts = {};
      if (server) parts.datasource = server;
      if (database) parts.initialcatalog = database;
      if (user) parts.userid = user;
      if (password) parts.password = password;
      if (encrypt) parts.encrypt = encrypt;
      if (trustServerCertificate) parts.trustservercertificate = trustServerCertificate;
      return parts;
    }
    function resolveSources(args) {
      const hasFlags = Boolean(args.server || args.database || args.user || args.password);
      const used = [
        args.configFile && "--config-file",
        args.connectionStrings.length > 0 && "--connection-string",
        hasFlags && "--server/--database/--user/--password",
        args.fromEnv && "--from-env",
        args.credentialsFile && "--credentials-file"
      ].filter(Boolean);
      if (used.length === 0) return { kind: "none" };
      if (used.length > 1) {
        throw new Error(
          `Elige una sola fuente de conexion. Se han indicado varias: ${used.join(", ")}.`
        );
      }
      if (args.fromEnv) return { kind: "env" };
      if (args.credentialsFile) {
        return {
          kind: "credentialsFile",
          entries: readCredentialsFile2(args.credentialsFile)
        };
      }
      if (args.configFile) {
        if (args.connections.length === 0) {
          const configFile = resolveConfigFile2(args.configFile);
          const names = listConnectionNames2(configFile, {
            environment: args.environment
          });
          throw new Error(
            `Falta --connection-name.` + (names.length > 0 ? ` Disponibles en ${configFile}: ${names.join(", ")}.` : "")
          );
        }
        return { kind: "configFile", entries: args.connections };
      }
      if (args.connectionStrings.length > 0) {
        if (args.connectionStrings.length > 1 && args.aliases.length !== args.connectionStrings.length) {
          throw new Error(
            `Con ${args.connectionStrings.length} --connection-string hacen falta ${args.connectionStrings.length} --alias, en el mismo orden. Hay ${args.aliases.length}.`
          );
        }
        return { kind: "connectionString", entries: args.connectionStrings };
      }
      const missing = ["server", "database", "user", "password"].filter((k) => !args[k]);
      if (missing.length > 0) {
        throw new Error(
          `Faltan datos de conexion: ${missing.map((m) => `--${m}`).join(", ")}.`
        );
      }
      return { kind: "flags", entries: [null] };
    }
    function describeEnvConnections(env) {
      const multi = Object.keys(env).filter((k) => /^MSSQL_(.+)_DATABASE$/i.test(k));
      if (multi.length > 0) {
        return multi.map((k) => {
          const raw = k.match(/^MSSQL_(.+)_DATABASE$/i)[1];
          const prefix = `MSSQL_${raw}_`;
          return {
            key: raw.toLowerCase(),
            target: env[`${prefix}SERVER`] || env.MSSQL_SERVER || "(sin MSSQL_SERVER)",
            database: env[k],
            viaInstance: Boolean(env[`${prefix}INSTANCE_NAME`] || env.MSSQL_INSTANCE_NAME)
          };
        });
      }
      if (env.MSSQL_SERVER || env.MSSQL_DATABASE) {
        return [
          {
            key: "maindb",
            target: env.MSSQL_SERVER || "(sin MSSQL_SERVER)",
            database: env.MSSQL_DATABASE || "(sin MSSQL_DATABASE)",
            viaInstance: Boolean(env.MSSQL_INSTANCE_NAME)
          }
        ];
      }
      throw new Error(
        '--from-env no ha encontrado ninguna MSSQL_* de conexion en el entorno. Define MSSQL_SERVER/MSSQL_DATABASE/MSSQL_USER/MSSQL_PASSWORD (o las MSSQL_<ALIAS>_* para multi-BD) en el bloque "env" del cliente MCP.'
      );
    }
    function main2() {
      const args = parseArgs2(process.argv.slice(2));
      if (args.production && (args.allowWrites || args.allowWritesFor.length > 0)) {
        console.error(
          "--production y --allow-writes/--allow-writes-for son incompatibles.\nEsta configuracion esta marcada como PRODUCCION. Si de verdad necesitas\nescribir, quita --production a conciencia y asume lo que implica."
        );
        process.exit(1);
      }
      let source;
      try {
        source = resolveSources(args);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
      if (source.kind === "none") {
        console.error(`Faltan argumentos.

${USAGE2}`);
        process.exit(1);
      }
      const env = cleanEnv2(source.kind === "env");
      const resolved = [];
      const pendingInstances = [];
      let credentialsInArgv = false;
      try {
        if (source.kind === "env") {
          resolved.push(...describeEnvConnections(env));
        } else {
          const multi = source.entries.length > 1;
          const configFile = source.kind === "configFile" ? resolveConfigFile2(args.configFile) : null;
          const prepared = [];
          source.entries.forEach((entry, i) => {
            let connString;
            let alias;
            let label;
            if (source.kind === "credentialsFile") {
              alias = entry.alias;
              label = alias || "credenciales";
            } else if (source.kind === "configFile") {
              const [name, aliasFromEntry] = String(entry).split(":");
              if (!name) throw new Error(`--connection-name vacio en '${entry}'`);
              if (multi && !aliasFromEntry) {
                throw new Error(
                  `Con varias conexiones cada una necesita alias: --connection-name ${name}:<alias>`
                );
              }
              alias = aliasFromEntry;
              label = aliasFromEntry || name;
              connString = readConnString2(configFile, name, {
                environment: args.environment
              }).value;
            } else if (source.kind === "connectionString") {
              credentialsInArgv = true;
              alias = args.aliases[i];
              label = alias || `connection-string ${i + 1}`;
              connString = entry;
            } else {
              credentialsInArgv = Boolean(args.password);
              alias = args.aliases[0];
              label = alias || "maindb";
            }
            if (!multi && alias) {
              console.error(
                `  Nota: con una sola conexion la clave es 'maindb'; el alias '${alias}' no se usa.`
              );
            }
            const prefix = multi ? `MSSQL_${alias.toUpperCase()}_` : "MSSQL_";
            const rawParts = source.kind === "credentialsFile" ? entry.parts : source.kind === "flags" ? partsFromFlags(args) : parseAdoConnectionString2(connString);
            prepared.push({
              key: multi ? alias.toLowerCase() : "maindb",
              label,
              prefix,
              rawParts,
              portOverride: portFor(args.ports, alias || "maindb")
            });
          });
          for (const p of prepared) {
            const natural = instanceToDiscover(p.rawParts, parseDataSource2);
            const skippedByPort = Boolean(natural && p.portOverride);
            const pendingInstance = natural && !p.portOverride ? natural.instanceName : null;
            const info = applyConnection(env, p.prefix, p.rawParts, p.label, p.portOverride);
            if (pendingInstance) {
              pendingInstances.push({ label: p.label, instanceName: pendingInstance });
            }
            resolved.push({ key: p.key, ...info, skippedByPort, pendingInstance });
          }
        }
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
      env.MSSQL_ENABLE_WRITES = args.allowWrites ? "true" : "false";
      const writeOverrides = [];
      for (const raw of args.allowWritesFor) {
        const alias = String(raw ?? "").trim();
        const match = resolved.find((r) => r.key.toLowerCase() === alias.toLowerCase());
        if (!match) {
          console.error(
            `--allow-writes-for '${alias}' no coincide con ninguna conexion. Disponibles: ${resolved.map((r) => r.key).join(", ")}.`
          );
          process.exit(1);
        }
        env[`MSSQL_${match.key.toUpperCase()}_ENABLE_WRITES`] = "true";
        writeOverrides.push(match.key);
      }
      const resolvedSqlDirs = [];
      for (const dir of args.sqlDirs) {
        if (!fs2.existsSync(dir)) {
          console.error(`No existe la carpeta indicada en --allow-sql-dir: ${dir}`);
          process.exit(1);
        }
        resolvedSqlDirs.push(fs2.realpathSync(dir));
      }
      env.MSSQL_SQL_DIRS = resolvedSqlDirs.join(path2.delimiter);
      const anyWrites = args.allowWrites || writeOverrides.length > 0;
      const mode = args.allowWrites ? "LECTURA-ESCRITURA" : writeOverrides.length > 0 ? "LECTURA-ESCRITURA PARCIAL" : "SOLO LECTURA";
      const origin = {
        configFile: `${args.configFile} (entorno ${resolveEnvironment2(args.environment)})`,
        connectionString: "--connection-string",
        flags: "--server/--database/--user/--password",
        env: "MSSQL_* del entorno del cliente MCP (--from-env)",
        credentialsFile: `${args.credentialsFile} (credenciales cifradas, fuera del repositorio)`
      }[source.kind];
      console.error("\xE2\u201D\u20AC".repeat(64));
      console.error(
        `AHORA-SQL-MCP \xE2\u20AC\u201D modo ${mode}${args.production ? "  \xC2\xB7  PRODUCCION" : ""}`
      );
      console.error(`  Conexion desde: ${origin}`);
      for (const r of resolved) {
        const dbWrites = args.allowWrites || writeOverrides.includes(r.key);
        console.error(
          `  [${r.key}] ${r.target} / ${r.database}${dbWrites ? "  (lectura-escritura)" : ""}`
        );
      }
      console.error(`  SQL desde: ${fs2.realpathSync(process.cwd())} (carpeta del proyecto)`);
      for (const dir of resolvedSqlDirs) {
        console.error(`             ${dir} (--allow-sql-dir)`);
      }
      for (const d of pendingInstances) {
        console.error(
          `  [${d.label}] instancia local ${d.instanceName}: el puerto se averigua en el primer uso, no aqui (y se vuelve a averiguar si deja de servir)`
        );
      }
      if (resolved.some((r) => r.skippedByPort)) {
        console.error(
          "  Con --port no se pregunta al sistema por la instancia, asi que tampoco se\n  detecta si solo escucha en la loopback. Si la conexion falla con el puerto\n  correcto, pon 127.0.0.1 como servidor en lugar del nombre del equipo."
        );
      }
      if (resolved.some((r) => r.viaInstance && !r.pendingInstance)) {
        console.error(
          "  Instancia nombrada REMOTA: la resuelve el SQL Browser del otro equipo, que\n  tiene que estar activo, o el TCP/IP habilitado en esa instancia. Si falla,\n  indica el puerto con --port <alias>:<puerto>."
        );
      }
      if (credentialsInArgv) {
        console.error(
          "  AVISO: la contrasena viaja en la linea de comandos, asi que queda en el\n  .mcp.json y en el listado de procesos. Para evitarlo, usa --from-env."
        );
      }
      if (anyWrites) {
        console.error(
          `  AVISO: escrituras y DDL habilitados${args.allowWrites ? "" : ` para: ${writeOverrides.join(", ")}`}. Solo para local o pruebas.`
        );
      }
      console.error("\xE2\u201D\u20AC".repeat(64));
      const child = spawn2(process.execPath, [serverEntry()], { env, stdio: "inherit" });
      child.on("error", (err) => {
        console.error(`No se ha podido lanzar el servidor: ${err.message}`);
        process.exit(1);
      });
      child.on("exit", (code, signal) => {
        if (signal) {
          console.error(`El servidor ha terminado por la senal ${signal}.`);
          process.exit(1);
        }
        process.exit(code ?? 1);
      });
      const stopChild = () => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill();
          } catch {
          }
        }
      };
      process.on("exit", stopChild);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(sig, () => {
          stopChild();
          process.exit(0);
        });
      }
    }
    if (require.main === module2) main2();
    module2.exports = {
      serverEntry,
      parseArgs: parseArgs2,
      parseAdoConnectionString: parseAdoConnectionString2,
      normalizeAdoKey,
      parseDataSource: parseDataSource2,
      portFor,
      cleanEnv: cleanEnv2,
      applyConnection,
      partsFromFlags,
      readCredentialsFile: readCredentialsFile2,
      readConnString: readConnString2,
      listConnectionNames: listConnectionNames2,
      readWebConfigConnections,
      readAppSettingsConnections,
      appSettingsChain,
      configChain,
      resolveConfigFile: resolveConfigFile2,
      resolveEnvironment: resolveEnvironment2,
      resolveSources,
      describeEnvConnections
    };
  }
});

// bin/start-ahora-mcp.js
var fs = require("fs");
var path = require("path");
var { spawn } = require("child_process");
var {
  resolveConfigFile,
  readConnString,
  readCredentialsFile,
  parseAdoConnectionString,
  parseDataSource,
  resolveEnvironment,
  listConnectionNames
} = require_start_mssql_mcp();
var { reveal } = require_secrets();
var USAGE = "Uso \u2014 hace falta el servidor y UNA fuente de conexion:\n  --server-dll <ruta>            ahora-mcp.dll publicado (se lanza con `dotnet exec`)\n  --server-exe <ruta>            alternativa: el ejecutable, si la publicacion trae apphost\n\n  a) --config-file <Web.config | appsettings.json | carpeta>\n     --connection-name <NombreConexion>\n     [--environment <nombre>]    entorno de appsettings.<entorno>.json\n  b) --credentials-file <ruta a un JSON>   (credenciales cifradas, fuera del repositorio)\n     [--db <alias>]              cual de las conexiones del fichero, si trae varias\n\nOpcionales:\n  --production                   marca la conexion como produccion (solo aviso: este\n                                 servidor no tiene modo de solo lectura)";
function parseArgs(argv) {
  const out = { production: false };
  const takes = {
    "--server-dll": "serverDll",
    "--server-exe": "serverExe",
    "--config-file": "configFile",
    "--connection-name": "connectionName",
    "--environment": "environment",
    "--credentials-file": "credentialsFile",
    "--db": "db"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--production") {
      out.production = true;
      continue;
    }
    const key = takes[flag];
    if (!key) throw new Error(`Argumento no reconocido: ${flag}`);
    const value = argv[i + 1];
    if (value === void 0 || value.startsWith("--")) {
      throw new Error(`${flag} necesita un valor.`);
    }
    if (out[key] !== void 0) {
      throw new Error(
        `${flag} solo puede aparecer una vez: el MCP de producto maneja una sola base de datos por proceso. Para exponer otra, registra otro servidor MCP.`
      );
    }
    out[key] = value;
    i += 1;
  }
  return out;
}
function quoteAdoValue(value) {
  const s = String(value);
  if (!/[;"'=\s]/.test(s)) return s;
  return `"${s.split('"').join('""')}"`;
}
function buildErpConnectionString(parts, label) {
  const dataSource = parts.datasource || parts.server || parts.addr || parts.address || parts.networkaddress;
  const database = parts.initialcatalog || parts.database;
  const user = parts.userid || parts.uid || parts.user;
  const password = parts.password || parts.pwd;
  if (!dataSource) throw new Error(`[${label}] No se pudo determinar el servidor.`);
  if (!database) throw new Error(`[${label}] No se pudo determinar la base de datos.`);
  if (!user || !password) {
    throw new Error(
      `[${label}] La cadena de conexion no lleva usuario y contrasena. El MCP de producto admite autenticacion de Windows, pero solo por su dialogo de login, que no puede salir cuando lo arranca un cliente MCP.`
    );
  }
  const { host, instanceName, port } = parseDataSource(dataSource);
  if (!host) throw new Error(`[${label}] No se pudo interpretar el servidor '${dataSource}'.`);
  const finalPort = port || parts.port;
  const target = host + (finalPort ? `,${finalPort}` : instanceName ? `\\${instanceName}` : "");
  const encrypt = (parts.encrypt || "").toLowerCase() === "true";
  const trust = (parts.trustservercertificate || "").toLowerCase() !== "false";
  const connString = [
    `Data Source=${quoteAdoValue(target)}`,
    `Initial Catalog=${quoteAdoValue(database)}`,
    `User ID=${quoteAdoValue(user)}`,
    `Password=${quoteAdoValue(password)}`,
    `Encrypt=${encrypt ? "True" : "False"}`,
    `TrustServerCertificate=${trust ? "True" : "False"}`
  ].join(";");
  return { connString, target, database };
}
function resolveConnection(args) {
  const sources = [
    args.configFile && "--config-file",
    args.credentialsFile && "--credentials-file"
  ].filter(Boolean);
  if (sources.length === 0) return null;
  if (sources.length > 1) {
    throw new Error(`Elige una sola fuente de conexion. Se han indicado: ${sources.join(", ")}.`);
  }
  if (args.credentialsFile) {
    const entries = readCredentialsFile(args.credentialsFile);
    let entry;
    if (entries.length === 1) {
      entry = entries[0];
      if (args.db && entry.alias && entry.alias.toLowerCase() !== args.db.toLowerCase()) {
        throw new Error(
          `--db '${args.db}' no coincide con la unica conexion del fichero ('${entry.alias}').`
        );
      }
    } else {
      const aliases = entries.map((e) => e.alias).filter(Boolean);
      if (!args.db) {
        throw new Error(
          `${args.credentialsFile} declara varias conexiones (${aliases.join(", ")}) y el MCP de producto solo maneja una. Indica cual con --db <alias>.`
        );
      }
      entry = entries.find(
        (e) => (e.alias || "").toLowerCase() === String(args.db).toLowerCase()
      );
      if (!entry) {
        throw new Error(
          `--db '${args.db}' no existe en ${args.credentialsFile}. Disponibles: ${aliases.join(", ")}.`
        );
      }
    }
    const label = entry.alias || "credenciales";
    const parts = { ...entry.parts };
    if (parts.password) parts.password = reveal(parts.password);
    return { parts, label, origin: `${args.credentialsFile} (credenciales cifradas)` };
  }
  const configFile = resolveConfigFile(args.configFile);
  if (!args.connectionName) {
    const names = listConnectionNames(configFile, { environment: args.environment });
    throw new Error(
      "Falta --connection-name." + (names.length > 0 ? ` Disponibles en ${configFile}: ${names.join(", ")}.` : "")
    );
  }
  const { value, source } = readConnString(configFile, args.connectionName, {
    environment: args.environment
  });
  return {
    parts: parseAdoConnectionString(value),
    label: args.connectionName,
    origin: `${configFile} (${path.basename(source)}, entorno ${resolveEnvironment(args.environment)})`
  };
}
function cleanEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^AHORA_MCP_/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}
function serverCommand(args) {
  if (args.serverExe) {
    if (!fs.existsSync(args.serverExe)) {
      throw new Error(`No existe el ejecutable del MCP de producto: ${args.serverExe}`);
    }
    return { command: args.serverExe, args: [] };
  }
  if (!args.serverDll) {
    throw new Error("Falta --server-dll (o --server-exe): sin el no hay servidor que lanzar.");
  }
  if (!fs.existsSync(args.serverDll)) {
    throw new Error(
      `No existe ${args.serverDll}. Vuelve a lanzar el instalador para publicar el MCP de producto.`
    );
  }
  return { command: "dotnet", args: ["exec", args.serverDll] };
}
function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}

${USAGE}`);
    process.exit(1);
  }
  let connection;
  let launcher;
  try {
    connection = resolveConnection(args);
    if (!connection) {
      console.error(`Faltan argumentos.

${USAGE}`);
      process.exit(1);
    }
    launcher = serverCommand(args);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  let erp;
  try {
    erp = buildErpConnectionString(connection.parts, connection.label);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const env = cleanEnv();
  env.AHORA_MCP_ERP = erp.connString;
  console.error("\u2500".repeat(64));
  console.error(`AHORA-ERP-MCP \u2014 MCP de desarrollo de producto${args.production ? "  \xB7  PRODUCCION" : ""}`);
  console.error(`  Conexion desde: ${connection.origin}`);
  console.error(`  [${connection.label}] ${erp.target} / ${erp.database}`);
  console.error(
    "  AVISO: este servidor SIEMPRE puede escribir (ahora_ejecutar_dml, ahora_crear_*,\n  ahora_modificar_*, ahora_borrar_*). No tiene modo de solo lectura."
  );
  if (args.production) {
    console.error(
      "  Y esta apuntando a PRODUCCION. Cada cambio va contra el ERP en vivo."
    );
  }
  console.error("\u2500".repeat(64));
  const child = spawn(launcher.command, launcher.args, { env, stdio: "inherit" });
  child.on("error", (err) => {
    console.error(
      `No se ha podido lanzar el MCP de producto: ${err.message}` + (launcher.command === "dotnet" ? "\nComprueba que el runtime de .NET este instalado y en el PATH." : "")
    );
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`El MCP de producto ha terminado por la senal ${signal}.`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}
if (require.main === module) main();
module.exports = {
  parseArgs,
  quoteAdoValue,
  buildErpConnectionString,
  resolveConnection,
  cleanEnv,
  serverCommand,
  USAGE
};
