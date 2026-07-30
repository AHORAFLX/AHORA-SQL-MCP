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
 * Devuelve tambien la direccion, porque una instancia puede estar escuchando solo en
 * la loopback: en ese caso conectarse al nombre del equipo falla aunque el puerto sea
 * el correcto, y hay que usar 127.0.0.1 o ::1.
 */
const os = require("os");
const { execFileSync } = require("child_process");

/** Nombres que se refieren a esta misma maquina. */
function isLocalHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return false;
  if (["localhost", "127.0.0.1", "::1", ".", "(local)"].includes(h)) return true;
  const name = String(os.hostname() || "").toLowerCase();
  return h === name || h === name.split(".")[0];
}

/**
 * Consulta al sistema por la instancia. Solo Windows; en el resto no aplica.
 *
 * Se pide en una sola invocacion de PowerShell y se devuelve JSON para no depender
 * de como se formatee la salida en cada idioma de Windows.
 */
function queryWindowsInstance(instanceName, { exec = execFileSync } = {}) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$inst = '${String(instanceName).replace(/'/g, "''")}'
$names = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL'
$id = $names.$inst
$staticPort = $null
if ($id) {
  $tcp = Get-ItemProperty ("HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\" + $id + "\\MSSQLServer\\SuperSocketNetLib\\Tcp\\IPAll")
  if ($tcp.TcpPort -match '^\\d+$') { $staticPort = [int]$tcp.TcpPort }
}
$svc = Get-CimInstance Win32_Service -Filter ("Name='MSSQL$" + $inst + "'")
$listen = @()
if ($svc -and $svc.ProcessId) {
  $listen = @(Get-NetTCPConnection -State Listen |
    Where-Object { $_.OwningProcess -eq $svc.ProcessId } |
    ForEach-Object { @{ port = [int]$_.LocalPort; address = [string]$_.LocalAddress } })
}
[pscustomobject]@{ staticPort = $staticPort; listening = $listen } | ConvertTo-Json -Depth 4 -Compress
`;
  const out = exec(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }
  );
  const parsed = JSON.parse(String(out).trim() || "{}");
  const listening = parsed.listening
    ? Array.isArray(parsed.listening)
      ? parsed.listening
      : [parsed.listening]
    : [];
  return { staticPort: parsed.staticPort || undefined, listening };
}

/** ¿Escucha en todas las direcciones, o solo en la loopback? */
function pickAddress(listening, port) {
  const forPort = listening.filter((l) => Number(l.port) === Number(port));
  if (forPort.some((l) => l.address === "0.0.0.0" || l.address === "::")) return null;
  const loopback = forPort.find((l) => l.address === "127.0.0.1" || l.address === "::1");
  return loopback ? loopback.address : null;
}

/**
 * Puerto (y direccion si hace falta) de una instancia local.
 *
 * Precedencia: el puerto estatico del registro, que es el que el administrador ha
 * fijado a proposito; y si no hay, el que este realmente a la escucha, que es el
 * unico dato fiable cuando el puerto es dinamico.
 */
function discoverLocalInstance(instanceName, options = {}) {
  // `platform` es inyectable para poder probar la logica fuera de Windows.
  if ((options.platform || process.platform) !== "win32") return null;
  if (!instanceName) return null;

  let info;
  try {
    info = queryWindowsInstance(instanceName, options);
  } catch {
    return null; // sin PowerShell, o instancia inexistente: no se pudo averiguar
  }

  const candidates = [];
  if (info.staticPort) candidates.push(info.staticPort);
  // 1433 primero si aparece: es el habitual y el mas probable de ser el bueno.
  const listeningPorts = info.listening.map((l) => Number(l.port)).filter(Boolean);
  if (listeningPorts.includes(1433)) candidates.push(1433);
  for (const p of listeningPorts) if (!candidates.includes(p)) candidates.push(p);

  const port = candidates[0];
  if (!port) return null;

  return { port: String(port), address: pickAddress(info.listening, port) || undefined };
}

/**
 * Sustituye la instancia nombrada por host,puerto cuando se puede averiguar.
 *
 * Solo actua si hace falta: hay instancia, no hay puerto escrito y el servidor es
 * esta misma maquina. Si no se puede averiguar, se deja tal cual y la conexion sigue
 * intentandose por nombre, como antes.
 */
function withDiscoveredPort(parts, parseDataSource, options = {}) {
  const discover = options.discover || discoverLocalInstance;
  const raw = parts.datasource || parts.server || parts.addr || parts.address || parts.networkaddress;
  if (!raw) return { parts, discovered: null };

  const { host, instanceName, port } = parseDataSource(raw);
  if (port || parts.port || !instanceName || !isLocalHost(host)) {
    return { parts, discovered: null };
  }

  const found = discover(instanceName, options);
  if (!found) return { parts, discovered: null };

  const targetHost = found.address || host;
  // Un IPv6 va entre corchetes o los ':' del propio host se confunden con el
  // separador del puerto.
  const dataSource = targetHost.includes(":")
    ? `[${targetHost}],${found.port}`
    : `${targetHost},${found.port}`;

  return {
    parts: { ...parts, datasource: dataSource, server: undefined },
    discovered: {
      instanceName,
      host: targetHost,
      port: found.port,
      onlyLoopback: Boolean(found.address),
    },
  };
}

module.exports = {
  isLocalHost,
  pickAddress,
  discoverLocalInstance,
  queryWindowsInstance,
  withDiscoveredPort,
};
