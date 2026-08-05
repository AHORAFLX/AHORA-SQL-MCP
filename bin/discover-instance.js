/**
 * Descubre en que puerto escucha DE VERDAD una instancia local de SQL Server.
 *
 * El problema que resuelve: tedious solo habla TCP, y para llegar a una instancia
 * nombrada necesita su puerto. Las dos vias clasicas exigen permisos de
 * administrador en cada maquina — arrancar el servicio SQL Browser, o fijar un
 * puerto estatico en Configuration Manager — asi que no sirven para instalar el MCP
 * en muchos equipos uno por uno.
 *
 * Aqui se pregunta al sistema, que no necesita privilegios: se localiza el proceso
 * del servicio de esa instancia y se mira en que puerto y en que direcciones esta
 * escuchando. Se hace EN CADA ARRANQUE, no se escribe en la configuracion, y por eso
 * aguanta que el puerto sea dinamico y cambie al reiniciar.
 *
 * Que un puerto este abierto no significa que sirva: al proceso de una instancia se le han
 * visto puertos que aceptan la conexion y la cortan en el saludo. Asi que a cada candidato
 * se le manda un saludo TDS y solo se tiene en cuenta si contesta. Contestar cuesta un
 * milisegundo, y no contestar tambien, asi que la comprobacion sale practicamente gratis.
 *
 * Devuelve tambien la direccion, porque una instancia puede estar escuchando solo en
 * la loopback: en ese caso conectarse al nombre del equipo falla aunque el puerto sea
 * el correcto, y hay que usar 127.0.0.1 o ::1.
 *
 * COSTE: preguntar cuesta un arranque de PowerShell mas dos consultas CIM, unos 2
 * segundos, y el wrapper lo hace ANTES de levantar el servidor MCP, asi que ese tiempo
 * se lo come el cliente esperando el saludo `initialize`. Su limite son 30 segundos
 * por defecto (MCP_TIMEOUT), y al agotarse descarta el servidor entero: las tools no
 * llegan a aparecer. De ahi las dos precauciones de aqui: se pregunta por TODAS las
 * instancias en una sola invocacion, de modo que el coste no crece con el numero de
 * conexiones, y hay una cache corta entre procesos para que varios MCP arrancando a la
 * vez no repitan cada uno el mismo sondeo.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Fichero de cache de puertos, compartido por todos los MCP de este usuario.
 *
 * Solo se usa si se pide expresamente, con `cacheFile`, para que las pruebas no toquen
 * el fichero real. El wrapper si lo pide.
 */
const DEFAULT_CACHE_FILE = path.join(os.tmpdir(), "ahora-sql-mcp-ports.json");

/**
 * Vida de la cache. Corta a proposito: cubre el arranque simultaneo de varios MCP y
 * los reinicios seguidos del cliente, que es donde duele, y sigue siendo lo bastante
 * breve para que un reinicio del servicio SQL con puerto dinamico se note en el
 * arranque siguiente.
 */
const CACHE_TTL_MS = 60_000;

/**
 * Formato de las entradas de la cache.
 *
 * Se sube cuando cambia como se elige el puerto. Sin esto, actualizar el MCP no arreglaba
 * nada durante el primer minuto: la entrada equivocada seguia en el fichero y el arranque
 * la reutilizaba, con lo que la version nueva parecia igual de rota que la vieja.
 */
const CACHE_VERSION = 2;

/** Nombres que se refieren a esta misma maquina. */
function isLocalHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return false;
  if (["localhost", "127.0.0.1", "::1", ".", "(local)"].includes(h)) return true;
  const name = String(os.hostname() || "").toLowerCase();
  return h === name || h === name.split(".")[0];
}

/**
 * Un nombre de instancia que se puede interpolar en el script sin miedo.
 *
 * El nombre puede venir de un Web.config ajeno, asi que no se mete tal cual en una
 * consulta WQL. SQL Server solo admite letras, digitos, `_`, `$` y `#`, de modo que lo
 * que no encaje ahi no es una instancia y no se pregunta por ella.
 */
function isSafeInstanceName(name) {
  return /^[A-Za-z0-9_$#-]+$/.test(String(name || ""));
}

/** ConvertTo-Json colapsa las listas de un elemento en un objeto; aqui se deshace. */
function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * El script que se le pasa a PowerShell.
 *
 * Las tres consultas caras — registro, servicios y puertos a la escucha — se hacen UNA
 * vez y luego se reparten entre las instancias pedidas. `Get-NetTCPConnection` enumera
 * todas las conexiones del equipo, asi que llamarla una vez por instancia era justo lo
 * que hacia crecer el coste con el numero de conexiones.
 *
 * El sondeo TDS va aqui dentro, y no en Node con el modulo `net`, para que todo esto siga
 * siendo sincrono: el wrapper lo llama sin `await` y volverlo asincrono arrastraria tambien
 * a la sonda del instalador. PowerShell ya esta arrancado y pagado, y sondear un puerto son
 * dos milisegundos, asi que aprovechar esta misma invocacion es lo mas barato que hay.
 */
function buildScript(names) {
  const list = names.map((n) => `'${n}'`).join(",");
  // El '$' del nombre del servicio va escapado con tilde invertida: el filtro viaja dentro
  // de una cadena entrecomillada de PowerShell, y sin escapar se expandia como si
  // 'MSSQL$SQL2022' llevara una variable `$SQL2022`. Al no existir, quedaba en blanco y el
  // filtro se convertia en Name='MSSQL': no encontraba el servicio de NINGUNA instancia
  // nombrada, no se veia ningun puerto y el descubrimiento no llegaba a proponer nada.
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

/**
 * Consulta al sistema por varias instancias a la vez. Devuelve un objeto indexado por
 * nombre de instancia.
 *
 * El limite de tiempo es de la invocacion COMPLETA, no de cada instancia: el peor caso
 * no crece con el numero de conexiones, que es lo que hay que garantizar para no
 * agotar el MCP_TIMEOUT del cliente.
 */
function queryWindowsInstances(instanceNames, { exec = execFileSync } = {}) {
  const names = [...new Set(asList(instanceNames).map(String))].filter(isSafeInstanceName);
  if (!names.length) return {};

  const out = exec(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", buildScript(names)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }
  );
  const parsed = JSON.parse(String(out).trim() || "{}");
  // Las claves de una hashtable de PowerShell no distinguen mayusculas, y los nombres
  // de instancia tampoco, asi que la busqueda no puede ser sensible a ellas.
  const byLower = new Map(
    Object.entries(parsed).map(([key, value]) => [String(key).toLowerCase(), value])
  );

  const result = {};
  for (const name of names) {
    const entry = byLower.get(name.toLowerCase()) || {};
    result[name] = {
      staticPort: entry.staticPort || undefined,
      dynamicPort: entry.dynamicPort || undefined,
      listening: asList(entry.listening),
    };
  }
  return result;
}

/** Igual que `queryWindowsInstances`, para una sola instancia. */
function queryWindowsInstance(instanceName, options = {}) {
  const result = queryWindowsInstances([instanceName], options);
  return (
    result[instanceName] || { staticPort: undefined, dynamicPort: undefined, listening: [] }
  );
}

/** ¿Este oyente acepta conexiones desde cualquier IP, o solo desde una concreta? */
function isWildcard(entry) {
  return entry.address === "0.0.0.0" || entry.address === "::";
}

/**
 * ¿Sirve este puerto para conectarse?
 *
 * Un puerto puede estar publicado en varias direcciones y no responder igual en todas
 * — una IPv6 de enlace local no se deja sondear, por ejemplo — asi que basta con que
 * UNA conteste para darlo por bueno, y hacen falta TODAS en contra para descartarlo.
 * Sin dato de sondeo se da por bueno: es lo que hay en la cache escrita por una version
 * anterior, y ahi el comportamiento debe seguir siendo el de entonces.
 */
function tdsVerdict(entries) {
  if (entries.some((l) => l.tds === true)) return "ok";
  if (entries.length && entries.every((l) => l.tds === false)) return "dead";
  return "unknown";
}

/** ¿Escucha en todas las direcciones, o solo en la loopback? */
function pickAddress(listening, port) {
  const forPort = listening.filter((l) => Number(l.port) === Number(port));
  if (forPort.some((l) => l.address === "0.0.0.0" || l.address === "::")) return null;
  const loopback = forPort.find((l) => l.address === "127.0.0.1" || l.address === "::1");
  return loopback ? loopback.address : null;
}

/**
 * Elige puerto y direccion a partir de lo que ha contado el sistema.
 *
 * Antes se cogia el primer puerto de la lista, y la lista la ordena el sistema operativo
 * a su gusto. Un dia aparecio una instancia con DOS puertos abiertos: el suyo, y otro solo
 * en loopback que aceptaba la conexion y la cortaba justo en el saludo TDS. Salio el malo,
 * y como el wrapper deja el puerto escrito en el entorno antes de levantar el servidor, el
 * proceso entero se quedaba inservible: todas las tools fallaban con ECONNRESET.
 *
 * De ahi las dos reglas de aqui. Primero se descarta lo que no ha contestado al saludo, que
 * es la unica prueba de que al otro lado hay un SQL Server. Y entre lo que queda se ordena
 * por lo fiable que es la pista, no por el orden en que lo conto el sistema, para que la
 * eleccion sea siempre la misma:
 *
 *   1. el puerto estatico del registro, que un administrador ha fijado a proposito
 *   2. el dinamico que el servicio anoto al arrancar, que es el de la instancia
 *   3. el 1433, el de toda la vida
 *   4. el que escucha en todas las IP antes que el que solo escucha en loopback
 */
function chooseEndpoint(info) {
  if (!info) return null;

  const byPort = new Map();
  for (const entry of asList(info.listening)) {
    const port = Number(entry.port);
    if (!port) continue;
    if (!byPort.has(port)) byPort.set(port, []);
    byPort.get(port).push(entry);
  }

  const rankOf = (port, entries) => {
    if (Number(info.staticPort) === port) return 0;
    if (Number(info.dynamicPort) === port) return 1;
    if (port === 1433) return 2;
    if (entries.some(isWildcard)) return 3;
    return 4;
  };

  const usable = [...byPort.entries()]
    .filter(([, entries]) => tdsVerdict(entries) !== "dead")
    .sort(([a, ea], [b, eb]) => rankOf(a, ea) - rankOf(b, eb) || a - b);

  // Si no se ha visto NINGUN puerto se recurre al registro, como se hacia antes de
  // sondear: puede que la consulta de puertos haya fallado y el fijado siga siendo bueno.
  // Pero si se han visto y todos han fallado el saludo, no se ofrece ninguno: mejor que la
  // conexion se intente por nombre de instancia que darle un puerto que ya sabemos muerto.
  const port = byPort.size === 0 ? info.staticPort : usable.length ? usable[0][0] : null;
  if (!port) return null;

  return {
    port: String(port),
    address: pickAddress(asList(info.listening), port) || undefined,
  };
}

/**
 * Lee la cache, descartando lo caducado.
 *
 * Si el fichero esta corrupto se ignora: lo escriben varios procesos a la vez sin
 * bloqueo, asi que encontrarlo a medias es un resultado posible, y volver a sondear es
 * exactamente lo que hay que hacer entonces.
 */
function readCache(file, now) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
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

/** Guarda la cache. Es un lujo: si no se puede escribir, se sondea la proxima vez. */
function writeCache(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  } catch {
    // sin cache el comportamiento es el de siempre, preguntar en cada arranque
  }
}

/**
 * Puerto (y direccion si hace falta) de varias instancias locales, en una sola
 * consulta al sistema. Devuelve un objeto indexado por nombre; las instancias que no
 * se han podido averiguar quedan a `null`.
 *
 * Se cachea tambien el resultado negativo: una instancia inexistente, o con TCP/IP
 * desactivado, cuesta lo mismo que una que si esta, y no hay razon para pagarlo en
 * cada arranque.
 */
function discoverLocalInstances(instanceNames, options = {}) {
  if ((options.platform || process.platform) !== "win32") return {};
  const names = [...new Set(asList(instanceNames).filter(Boolean).map(String))];
  if (!names.length) return {};

  const now = options.now || Date.now();
  const cacheFile = options.cacheFile;
  const cache = cacheFile ? readCache(cacheFile, now) : {};

  const found = {};
  const missing = [];
  for (const name of names) {
    const hit = cache[name.toLowerCase()];
    if (hit) {
      found[name] = hit.found
        ? { port: String(hit.found.port), address: hit.found.address || undefined }
        : null;
    } else {
      missing.push(name);
    }
  }

  if (missing.length) {
    let info;
    try {
      info = queryWindowsInstances(missing, options);
    } catch {
      info = {}; // sin PowerShell, o consulta agotada: no se pudo averiguar
    }
    for (const name of missing) {
      found[name] = chooseEndpoint(info[name]) || null;
      cache[name.toLowerCase()] = { v: CACHE_VERSION, at: now, found: found[name] };
    }
    if (cacheFile) writeCache(cacheFile, cache);
  }

  return found;
}

/** Puerto (y direccion si hace falta) de una instancia local. */
function discoverLocalInstance(instanceName, options = {}) {
  // `platform` es inyectable para poder probar la logica fuera de Windows.
  if ((options.platform || process.platform) !== "win32") return null;
  if (!instanceName) return null;
  return discoverLocalInstances([instanceName], options)[instanceName] || null;
}

/**
 * ¿Por que instancia habria que preguntar para esta conexion, si por alguna?
 *
 * Separado de `withDiscoveredPort` porque el wrapper necesita saberlo de TODAS las
 * conexiones antes de preguntar, para preguntar por todas de una vez.
 *
 * Solo hace falta si: hay instancia, no hay puerto escrito, el servidor es esta misma
 * maquina y nadie ha indicado el puerto a mano. Lo ultimo es `portOverride`, es decir
 * `--port <alias>:<puerto>`: si el puerto ya lo sabemos, sondear el sistema para
 * averiguarlo no aporta nada y solo retrasa el arranque.
 */
function instanceToDiscover(parts, parseDataSource, { portOverride } = {}) {
  const raw =
    parts.datasource || parts.server || parts.addr || parts.address || parts.networkaddress;
  if (!raw) return null;

  const { host, instanceName, port } = parseDataSource(raw);
  if (port || parts.port || portOverride || !instanceName || !isLocalHost(host)) return null;
  return { host, instanceName };
}

/**
 * Sustituye la instancia nombrada por host,puerto cuando se puede averiguar.
 *
 * Si no se puede averiguar, se deja tal cual y la conexion sigue intentandose por
 * nombre, como antes.
 */
function withDiscoveredPort(parts, parseDataSource, options = {}) {
  const target = instanceToDiscover(parts, parseDataSource, options);
  if (!target) return { parts, discovered: null };

  const discover = options.discover || discoverLocalInstance;
  const found = discover(target.instanceName, options);
  if (!found) return { parts, discovered: null };

  const targetHost = found.address || target.host;
  // Un IPv6 va entre corchetes o los ':' del propio host se confunden con el
  // separador del puerto.
  const dataSource = targetHost.includes(":")
    ? `[${targetHost}],${found.port}`
    : `${targetHost},${found.port}`;

  return {
    parts: { ...parts, datasource: dataSource, server: undefined },
    discovered: {
      instanceName: target.instanceName,
      host: targetHost,
      port: found.port,
      onlyLoopback: Boolean(found.address),
    },
  };
}

module.exports = {
  DEFAULT_CACHE_FILE,
  CACHE_TTL_MS,
  CACHE_VERSION,
  tdsVerdict,
  isLocalHost,
  isSafeInstanceName,
  buildScript,
  pickAddress,
  chooseEndpoint,
  discoverLocalInstance,
  discoverLocalInstances,
  queryWindowsInstance,
  queryWindowsInstances,
  instanceToDiscover,
  withDiscoveredPort,
};
