/**
 * Cifrado de las contrasenas que el instalador deja en disco.
 *
 * El problema: el fichero de credenciales (%APPDATA%\ahora-sql-mcp\<proyecto>.json)
 * es la salida para los proyectos sin Web.config ni appsettings.json, y guardaba la
 * contrasena en claro. Cualquier cosa que lea ese JSON —una copia de seguridad, un
 * fichero adjuntado a un ticket de soporte, otro proceso del mismo equipo— se
 * llevaba la contrasena de la base de datos.
 *
 * La solucion en Windows es DPAPI (`ProtectedData`, ambito CurrentUser): cifra con
 * una clave derivada de la cuenta de Windows, que gestiona el sistema. No hay
 * ninguna clave que guardar, y el texto cifrado solo lo puede abrir la MISMA cuenta
 * en la MISMA maquina. Es lo que usa por dentro el Administrador de credenciales de
 * Windows, y no anade dependencias: se llama por PowerShell, igual que ya se hace
 * para descubrir el puerto de las instancias.
 *
 * Fuera de Windows no hay equivalente sin dependencias nativas, asi que se cifra con
 * AES-256-GCM y una clave aleatoria en un fichero aparte con permisos 0600. Ojo con
 * lo que eso protege de verdad: quien pueda leer el fichero de claves puede
 * descifrar igualmente. En POSIX el 0600 si se respeta, asi que la proteccion
 * equivale a la que ya tenia el JSON, y ademas la contrasena deja de ser legible de
 * un vistazo.
 *
 * La alternativa a cifrar es no escribir nada: `--from-env` deja las MSSQL_* en el
 * bloque "env" del cliente MCP y este fichero no llega a existir.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

/** El mismo directorio de configuracion que usa el fichero de credenciales. */
function configDir() {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "ahora-sql-mcp")
    : path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "ahora-sql-mcp"
      );
}

/** Clave del respaldo AES. Separada del JSON para que copiar el JSON no baste. */
function keyPath() {
  return path.join(configDir(), "secret.key");
}

const DPAPI = "dpapi";
const AES = "aes-256-gcm";
const VERSION = "v1";
const DPAPI_TAG = `${DPAPI}:${VERSION}:`;
const AES_TAG = `${AES}:${VERSION}:`;

/**
 * El texto cifrado se etiqueta con el esquema y la version.
 *
 * Sin la etiqueta habria que adivinar como descifrar, y cambiar de esquema mas
 * adelante obligaria a reinstalar todo. Con ella, un fichero antiguo y uno nuevo
 * conviven.
 */
function isProtected(value) {
  return (
    typeof value === "string" &&
    (value.startsWith(DPAPI_TAG) || value.startsWith(AES_TAG))
  );
}

/**
 * Guion de PowerShell para DPAPI.
 *
 * Entra y sale TODO en base64, una linea por secreto: ni la contrasena ni el texto
 * cifrado pasan por la linea de comandos (que es visible en el listado de procesos)
 * ni por ConvertTo-Json, cuyo trato de las listas de un solo elemento cambia entre
 * versiones de PowerShell.
 */
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
    "[Console]::Out.Write(($out -join [string][char]10))",
  ].join("\n");
}

function runDpapi(method, inputs, { exec = execFileSync } = {}) {
  if (inputs.length === 0) return [];
  const out = exec(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", dpapiScript(method)],
    {
      input: `${inputs.join("\n")}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      // 5 segundos, no 15: descifrar son ~0,5 s medidos, y esto corre en el arranque del
      // wrapper, donde el cliente MCP esta contando sus 30 segundos hacia el saludo. Un
      // tope de 15 se comia la mitad del presupuesto sin dar ninguna opcion de arreglo.
      timeout: 5000,
      windowsHide: true,
    }
  );
  const lines = String(out)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length !== inputs.length) {
    throw new Error(
      `DPAPI ha devuelto ${lines.length} resultados para ${inputs.length} secretos`
    );
  }
  return lines;
}

/** Crea la clave del respaldo AES la primera vez, con permisos restringidos. */
function loadOrCreateKey(file = keyPath()) {
  try {
    const raw = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (raw.length === 32) return raw;
  } catch {
    // no existe todavia: se genera una nueva
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${key.toString("base64")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // en Windows no aplica
  }
  return key;
}

function readKey(file = keyPath()) {
  let raw;
  try {
    raw = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  } catch {
    throw new Error(
      `Falta el fichero de claves ${file}, necesario para descifrar las credenciales. ` +
        "Vuelve a ejecutar el instalador para volver a introducirlas."
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
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Cifra varios secretos de una vez.
 *
 * En bloque y no uno a uno porque cada llamada a DPAPI cuesta un arranque de
 * PowerShell (~0,3 s), y descifrar ocurre tambien al arrancar el servidor, donde el
 * cliente MCP esta contando hacia su MCP_TIMEOUT.
 */
function protectAll(
  values,
  { exec, keyFile, platform = process.platform, onFallback } = {}
) {
  const list = values.map((v) => String(v));
  if (list.length === 0) return [];
  if (platform === "win32") {
    try {
      const b64 = list.map((v) => Buffer.from(v, "utf8").toString("base64"));
      return runDpapi("Protect", b64, { exec }).map((c) => DPAPI_TAG + c);
    } catch (err) {
      // Que DPAPI no este disponible no puede dejar la contrasena en claro: se cifra
      // con el respaldo y se avisa, porque su clave si vive en disco.
      if (onFallback) onFallback(err);
    }
  }
  return list.map((v) => aesProtect(v, keyFile));
}

function protect(value, options) {
  return protectAll([value], options)[0];
}

/**
 * Descifra varios secretos de una vez.
 *
 * Lo que no lleva etiqueta se devuelve tal cual: son los ficheros de credenciales
 * escritos por versiones anteriores, que guardaban la contrasena en claro y tienen
 * que seguir arrancando.
 */
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
        "Estas credenciales se cifraron con DPAPI de Windows y solo se pueden " +
          "descifrar en Windows con la misma cuenta. Vuelve a ejecutar el instalador."
      );
    }
    let plain;
    try {
      plain = runDpapi("Unprotect", dpapiPayload, { exec });
    } catch (err) {
      throw new Error(
        "No se han podido descifrar las credenciales. Suele significar que se " +
          "cifraron con otra cuenta de Windows o en otro equipo: vuelve a ejecutar " +
          `el instalador para volver a introducirlas. (${err.message})`
      );
    }
    plain.forEach((b64, n) => {
      out[dpapiIdx[n]] = Buffer.from(b64, "base64").toString("utf8");
    });
  }

  return out;
}

function reveal(value, options) {
  return revealAll([value], options)[0];
}

module.exports = {
  configDir,
  keyPath,
  isProtected,
  protect,
  protectAll,
  reveal,
  revealAll,
};
