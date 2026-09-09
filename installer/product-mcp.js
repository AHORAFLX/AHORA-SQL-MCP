/**
 * Instalacion del MCP de desarrollo de producto (`ahora-mcp`).
 *
 * Es un servidor de OTRO equipo, publicado en el feed interno
 * https://nuget.ahorabh.com/packages/ahora-mcp/. Aqui no se compila ni se mantiene:
 * solo se deja instalado y configurado al lado de `ahora-sql`, que es lo unico que
 * este instalador sabe hacer.
 *
 * POR QUE NO ES UN `dotnet tool install`
 *
 * El paquete NO es un tool package: no trae `tools/` ni DotnetToolSettings.xml. Es un
 * `lib/net10.0-windows7.0` con el .dll (los prompts van dentro como recursos
 * embebidos, asi que no hace falta repartir la carpeta Prompts/) y sus dependencias
 * declaradas como dependencias NuGet normales: Microsoft.Data.SqlClient,
 * Microsoft.CodeAnalysis.CSharp, ScriptDom y ModelContextProtocol.
 *
 * La unica forma soportada de convertir eso en algo ejecutable es dejar que el SDK lo
 * restaure: un proyecto minimo que referencia el paquete, `dotnet publish`, y la
 * carpeta resultante ya lleva el .dll con todas sus dependencias al lado. El propio
 * paquete trae un `buildTransitive/ahora-mcp.targets` que copia su runtimeconfig.json
 * y su deps.json a la salida "sin ellos `dotnet exec` no arranca bien" — es decir, la
 * forma de ejecucion que su autor contempla es exactamente esta.
 *
 * No hay apphost (`ahora-mcp.exe`) en esa salida, porque el ejecutable lo produce el
 * proyecto que lo referencia, no el paquete. Por eso el lanzador arranca con
 * `dotnet exec <ruta>/ahora-mcp.dll`, comprobado equivalente al .exe.
 *
 * LA CARPETA YA PUBLICADA, COMO RESPALDO
 *
 * La restauracion necesita alcanzar api.nuget.org para las dependencias de Microsoft:
 * el feed de AHORA solo hospeda `ahora-mcp`. En una red donde nuget.org no se alcanza
 * —comprobado: en el equipo de desarrollo api.nuget.org no resuelve, mientras
 * www.nuget.org y github.com si— el `dotnet publish` no puede terminar. Para eso esta
 * `installProductFromFolder`: copia una carpeta ya publicada (la que se reparte
 * comprimida) y deja el mismo resultado sin tocar la red ni necesitar SDK.
 */
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const tls = require("tls");
const { execFileSync } = require("child_process");

const { toolVersion } = require("./tools");

const PRODUCT_PACKAGE = "ahora-mcp";
const PRODUCT_FEED = "https://nuget.ahorabh.com/v3/index.json";
const PRODUCT_VERSIONS_URL = `https://nuget.ahorabh.com/v3/package/${PRODUCT_PACKAGE}/index.json`;
const PUBLIC_FEED = "https://api.nuget.org/v3/index.json";

/** El paquete es net10.0-windows: con un SDK anterior la restauracion ni empieza. */
const MIN_DOTNET_MAJOR = 10;

/** El fichero que hay que lanzar dentro de la instalacion. */
const PRODUCT_DLL = `${PRODUCT_PACKAGE}.dll`;

/**
 * Carpeta estable donde queda instalado el MCP de producto.
 *
 * HERMANA de la del servidor de SQL, no dentro. `%LOCALAPPDATA%` por lo mismo que en
 * installer/runtime.js: es por usuario, no se sincroniza con el perfil de dominio y no
 * pide elevacion.
 *
 * Estuvo colgando de `%LOCALAPPDATA%\AHORA-SQL-MCP\` con la idea de reunir bajo una
 * raiz todo lo que deja este instalador. Era peor por dos motivos. Uno, esa carpeta se
 * llama como OTRO producto, con otro equipo y otro ciclo de versiones detras. Y dos, el
 * gesto natural para desinstalar el MCP de SQL es borrar su carpeta: eso se llevaba por
 * delante el MCP de producto sin decir nada, y la entrada `ahora-erp` del .mcp.json
 * quedaba apuntando a un .dll inexistente — un fallo que no aparece al desinstalar, sino
 * al abrir la sesion siguiente.
 */
function productRuntimeDir({ platform = process.platform, env = process.env, home } = {}) {
  const homeDir = home || os.homedir();
  if (platform === "win32") {
    return path.join(
      env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"),
      PRODUCT_PACKAGE
    );
  }
  return path.join(
    env.XDG_DATA_HOME || path.join(homeDir, ".local", "share"),
    PRODUCT_PACKAGE
  );
}

/** La salida publicada, separada del proyecto que la genera. */
function productAppDir(dir) {
  return path.join(dir, "app");
}

function productDll(dir) {
  return path.join(productAppDir(dir), PRODUCT_DLL);
}

/** Marca de que version quedo instalada, para no volver a publicar la misma. */
function stampPath(dir) {
  return path.join(productAppDir(dir), "ahora-mcp-instalado.json");
}

function installedProductVersion(dir) {
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath(dir), "utf8"));
    return fs.existsSync(productDll(dir)) ? stamp.version || null : null;
  } catch {
    return null;
  }
}

/**
 * Ordena versiones de NuGet sin traerse un paquete de semver.
 *
 * Solo se comparan las estables: una preview del MCP de producto no es lo que hay que
 * dejarle instalado a un compañero en una formacion.
 */
function compareVersions(a, b) {
  const parse = (v) => String(v).split(".").map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function pickLatest(versions) {
  const stable = (versions || []).filter((v) => typeof v === "string" && !v.includes("-"));
  if (stable.length === 0) return null;
  return stable.slice().sort(compareVersions).pop();
}

/**
 * Traduce el fallo de red a algo accionable.
 *
 * El caso real, y no es de red: nuget.ahorabh.com sirve una CADENA DE CERTIFICADOS
 * INCOMPLETA. Manda como intermedio "Sectigo RSA Domain Validation Secure Server CA",
 * que no es quien firma su hoja -la firma "Sectigo Public Server Authentication CA DV
 * R36"-, y ese intermedio no viaja. Windows y los navegadores lo disimulan porque
 * descargan el intermedio que falta por la extension AIA del certificado; Node no lo
 * hace, asi que aqui sale `UNABLE_TO_VERIFY_LEAF_SIGNATURE` mientras `curl` y el
 * navegador van bien. Sin esta explicacion, el mensaje de Node parece un problema del
 * equipo de quien instala, que es el sitio donde NO esta el problema.
 */
function explainNetworkError(err, url) {
  // `erroresTls` y no `tls`: ese nombre tapaba el modulo `tls` del principio del
  // fichero. Aqui no se usaba y por eso no rompia, pero es la clase de trampa que
  // explota el dia que alguien anada una linea dentro de esta funcion.
  const erroresTls = new Set([
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  ]);
  if (err && erroresTls.has(err.code)) {
    return new Error(
      `${err.message} — el certificado de ${new URL(url).host} no se puede validar. ` +
        "No es tu red: ese servidor sirve una cadena de certificados incompleta. El " +
        "instalador intenta completarla solo, bajando el emisor que falta de donde el " +
        "propio certificado dice (extension AIA) y comprobando que lo firme una raiz " +
        "de confianza, que es lo que hacen Windows y el navegador; si has llegado a " +
        "este mensaje es que tampoco eso ha funcionado. Se arregla de verdad en el " +
        "servidor, instalando el intermedio correcto. Mientras tanto: si ya tienes el " +
        "MCP de producto instalado se reutiliza esa version, y si no, indica una " +
        "carpeta con el ya publicado."
    );
  }
  return err;
}

/**
 * Completa la cadena que el servidor deja a medias, sin bajar la guardia.
 *
 * nuget.ahorabh.com no manda el intermedio que firma su certificado. Windows y los
 * navegadores lo resuelven solos: el propio certificado publica en su extension AIA
 * (Authority Information Access, campo "CA Issuers") la URL de donde bajarlo. Node no
 * hace ese paso, y de ahi que curl entre y el instalador no.
 *
 * Aqui se hace ese paso a mano. Lo que NO se hace, y es la diferencia que importa, es
 * desactivar la verificacion: `NODE_TLS_REJECT_UNAUTHORIZED=0` haria que el instalador
 * se tragara CUALQUIER certificado de CUALQUIER servidor durante toda su ejecucion, que
 * es cambiar un problema del servidor por un agujero en todas las maquinas del equipo.
 *
 * LA SALVAGUARDA. El intermedio se baja por HTTP PLANO -asi lo define AIA-, asi que
 * quien pueda interceptar esa descarga podria devolver un certificado suyo. Y meterlo en
 * `ca` no lo trata como un eslabon mas: lo convierte en ANCLA DE CONFIANZA, con lo que
 * cualquier cosa firmada por el se daria por buena. Por eso antes de usarlo se comprueba
 * que de verdad lo ha firmado una raiz de las que Node ya trae: si no encadena, se
 * descarta y volvemos al camino de siempre. Un intermedio falsificado no supera esa
 * comprobacion, porque el atacante tendria que firmarlo con una raiz publica.
 *
 * La conexion con `rejectUnauthorized: false` de aqui abajo se usa SOLO para leer el
 * certificado que presenta el servidor, nunca para traer contenido: la peticion de
 * verdad se reintenta despues con la verificacion entera puesta.
 */
async function fetchMissingIssuer(host, port = 443, { timeoutMs = 15000 } = {}) {
  const leaf = await new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerX509Certificate();
        socket.destroy();
        resolve(cert);
      }
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`${host} no responde`));
    });
  });

  const aia = leaf && leaf.infoAccess;
  const match = aia && aia.match(/CA Issuers - URI:(http:\/\/\S+)/);
  if (!match) return null;

  const der = await new Promise((resolve, reject) => {
    const req = http.get(match[1], (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${match[1]} ha respondido ${res.statusCode}`));
        return;
      }
      const trozos = [];
      res.on("data", (c) => trozos.push(c));
      res.on("end", () => resolve(Buffer.concat(trozos)));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${match[1]} no responde`)));
  });

  return validateIssuer(der);
}

/**
 * Devuelve el certificado en PEM solo si lo ha firmado una raiz de confianza.
 *
 * Esta aparte de `fetchMissingIssuer` para poder probarla sin red, que es donde esta el
 * riesgo: es la unica linea entre "completar una cadena que el servidor deja a medias" y
 * "aceptar el certificado que quiera darnos quien controle la descarga por HTTP".
 *
 * `roots` es inyectable por lo mismo: un test puede comprobar que con otras raices el
 * mismo certificado se rechaza.
 */
function validateIssuer(der, roots = tls.rootCertificates) {
  const issuer = new crypto.X509Certificate(der);
  for (const pem of roots) {
    const root = new crypto.X509Certificate(pem);
    // Las dos comprobaciones hacen falta, y por separado: `checkIssued` casa emisor con
    // sujeto -que es solo texto- y `verify` es la que comprueba la FIRMA. Sin la
    // segunda, falsificar el intermedio seria copiar un nombre.
    if (issuer.checkIssued(root) && issuer.verify(root.publicKey)) {
      return issuer.toString();
    }
  }
  return null;
}

/** GET de un JSON, con tiempo de espera: sin el, una red rara cuelga el instalador. */
function getJson(url, { timeoutMs = 15000, get = https.get } = {}) {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${url} ha respondido ${res.statusCode}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`${url} no ha devuelto JSON: ${err.message}`));
        }
      });
    });
    req.on("error", (err) => reject(explainNetworkError(err, url)));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${url} no responde (${timeoutMs} ms)`));
    });
  });
}

/** ¿El fallo es "me falta un eslabon de la cadena" y no otra cosa? */
function isMissingIssuerError(err) {
  return Boolean(
    err &&
      (err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        err.code === "UNABLE_TO_GET_ISSUER_CERT" ||
        /unable to verify the first certificate|unable to get (local )?issuer certificate/i.test(
          err.message || ""
        ))
  );
}

/**
 * GET de un JSON que, si la cadena viene incompleta, la completa y reintenta.
 *
 * Primero se pide con la verificacion de serie. Solo si falla POR ESO -no por un
 * certificado caducado, ni por un nombre que no casa, ni por una raiz desconocida- se
 * intenta bajar el emisor que falta y se repite la peticion con la verificacion entera.
 * Si el emisor no se puede conseguir o no encadena con una raiz de confianza, se propaga
 * el error original: el instalador sigue teniendo su camino de la carpeta.
 */
async function getJsonCompletandoCadena(url, options = {}) {
  try {
    return await getJson(url, options);
  } catch (err) {
    if (!isMissingIssuerError(err) || options.get) throw err;
    const { host, port } = new URL(url);
    let issuer;
    try {
      issuer = await fetchMissingIssuer(host, port || 443, options);
    } catch {
      throw err;
    }
    if (!issuer) throw err;
    return getJson(url, {
      ...options,
      get: (u, cb) => https.get(u, { ca: [...tls.rootCertificates, issuer] }, cb),
    });
  }
}

/** La ultima version estable publicada en el feed de AHORA. */
async function latestProductVersion({ url = PRODUCT_VERSIONS_URL, ...options } = {}) {
  const doc = await getJsonCompletandoCadena(url, options);
  const latest = pickLatest(doc && doc.versions);
  if (!latest) throw new Error(`El feed no publica ninguna version estable de ${PRODUCT_PACKAGE}.`);
  return latest;
}

/**
 * SDK de .NET de la maquina.
 *
 * Se mira el SDK y no el runtime: restaurar y publicar es trabajo del SDK. Un equipo
 * con solo el runtime instalado puede EJECUTAR el MCP de producto pero no
 * construirlo, y ahi la salida es la carpeta ya publicada.
 */
function dotnetSdkVersion(version = toolVersion("dotnet")) {
  if (!version) return null;
  const major = Number(String(version).split(".")[0]);
  return Number.isFinite(major) && major >= MIN_DOTNET_MAJOR ? version : null;
}

function checkDotnetSdk(version = toolVersion("dotnet")) {
  if (!version) {
    throw new Error(
      "No hay SDK de .NET en este equipo (no esta en el PATH). El MCP de producto se " +
        `publica desde NuGet, y para eso hace falta el SDK de .NET ${MIN_DOTNET_MAJOR} ` +
        "o superior: https://dotnet.microsoft.com/download"
    );
  }
  if (!dotnetSdkVersion(version)) {
    throw new Error(
      `El SDK de .NET ${version} es demasiado antiguo. El paquete ${PRODUCT_PACKAGE} es ` +
        `net${MIN_DOTNET_MAJOR}.0-windows y no se puede restaurar con un SDK anterior.`
    );
  }
  return version;
}

/**
 * Proyecto minimo que solo existe para arrastrar el paquete y sus dependencias.
 *
 * `Program.cs` es un punto de entrada vacio a proposito: el servidor es el .dll del
 * paquete, no este ejecutable. Hace falta porque el SDK no publica un `Exe` sin
 * entrada, y `Exe` es lo que copia las dependencias planas a la salida.
 *
 * `SatelliteResourceLanguages=en` recorta las 12 carpetas de traducciones que arrastra
 * ScriptDom y que nadie lee aqui.
 */
function projectFiles(version) {
  return {
    "nuget.config": `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="${PUBLIC_FEED}" />
    <add key="ahora" value="${PRODUCT_FEED}" />
  </packageSources>
</configuration>
`,
    "ahora-mcp-host.csproj": `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net${MIN_DOTNET_MAJOR}.0-windows</TargetFramework>
    <OutputType>Exe</OutputType>
    <UseWindowsForms>true</UseWindowsForms>
    <Nullable>disable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <GenerateDocumentationFile>false</GenerateDocumentationFile>
    <SatelliteResourceLanguages>en</SatelliteResourceLanguages>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="${PRODUCT_PACKAGE}" Version="[${version}]" />
  </ItemGroup>
</Project>
`,
    "Program.cs": `// Punto de entrada vacio: el servidor MCP es ${PRODUCT_DLL}, que llega del paquete.
// Este proyecto solo existe para que el SDK restaure y copie sus dependencias.
internal static class Host
{
    private static void Main()
    {
    }
}
`,
  };
}

/**
 * Publica el MCP de producto desde el feed y devuelve la ruta de su .dll.
 *
 * Idempotente por version: si ya esta publicada esa misma, no se vuelve a llamar al
 * SDK, que es lo que tarda.
 */
function installProductMcp({
  version,
  dir = productRuntimeDir(),
  exec = execFileSync,
  force = false,
  sdkVersion,
} = {}) {
  if (!version) throw new Error("Falta la version del paquete a instalar.");

  const dll = productDll(dir);
  if (!force && installedProductVersion(dir) === version) {
    return { dll, dir, version, reused: true };
  }

  checkDotnetSdk(sdkVersion === undefined ? toolVersion("dotnet") : sdkVersion);

  const build = path.join(dir, "build");
  fs.mkdirSync(build, { recursive: true });
  for (const [name, content] of Object.entries(projectFiles(version))) {
    fs.writeFileSync(path.join(build, name), content, "utf8");
  }

  // La salida va FUERA de la carpeta del proyecto: dejarla dentro mezcla el
  // resultado con obj/ y bin/, y un `-o .` sobre el propio proyecto es un fallo del
  // SDK, no un aviso.
  exec(
    "dotnet",
    [
      "publish",
      "ahora-mcp-host.csproj",
      "-c",
      "Release",
      "-o",
      productAppDir(dir),
      "--nologo",
      "-v",
      "minimal",
    ],
    {
      // Por `cwd` y no por ruta absoluta en el argumento: asi el nuget.config que
      // acabamos de escribir es el que manda, que es lo que anade el feed de AHORA.
      cwd: build,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 900000,
    }
  );

  if (!fs.existsSync(dll)) {
    throw new Error(
      `La publicacion termino sin errores pero no aparece ${dll}. ` +
        `Revisa que el paquete del feed se llame ${PRODUCT_PACKAGE}.`
    );
  }
  fs.writeFileSync(
    stampPath(dir),
    `${JSON.stringify({ version, origen: PRODUCT_FEED, fecha: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
  return { dll, dir, version, reused: false };
}

/**
 * Instala desde una carpeta ya publicada, sin red ni SDK.
 *
 * Es la via para las maquinas donde no se alcanza api.nuget.org: se copia la carpeta
 * que reparte el equipo de producto (la del .zip, la que lleva ahora-mcp.dll con sus
 * dependencias al lado) y queda exactamente igual de utilizable que la publicada.
 */
function installProductFromFolder({ source, dir = productRuntimeDir() } = {}) {
  if (!source) throw new Error("Falta la carpeta de origen del MCP de producto.");
  const from = path.resolve(source);
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
    throw new Error(`No existe la carpeta: ${from}`);
  }
  const origen = path.join(from, PRODUCT_DLL);
  if (!fs.existsSync(origen)) {
    throw new Error(
      `En ${from} no esta ${PRODUCT_DLL}. Indica la carpeta que contiene el MCP de ` +
        "producto ya publicado (la que trae ahora-mcp.dll con sus dependencias al lado)."
    );
  }

  const app = productAppDir(dir);
  // Se borra antes de copiar: mezclar dos publicaciones distintas deja dependencias
  // de la anterior que el deps.json de la nueva no menciona, y eso falla al arrancar
  // con un error de carga de ensamblado que no apunta a nada.
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  fs.cpSync(from, app, { recursive: true });

  const version = readAssemblyVersion(path.join(app, PRODUCT_DLL));
  fs.writeFileSync(
    stampPath(dir),
    `${JSON.stringify({ version, origen: from, fecha: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
  return { dll: productDll(dir), dir, version, reused: false, source: from };
}

/**
 * Version del .dll copiado, para poder decir cual quedo instalada.
 *
 * Se pregunta al propio binario (`--version`) en lugar de leer metadatos: es una
 * llamada que ya sabemos que responde y no obliga a interpretar el formato PE.
 * Si falla, no se cae la instalacion — es informacion, no un requisito.
 */
function readAssemblyVersion(dll, exec = execFileSync) {
  try {
    const out = exec("dotnet", ["exec", dll, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60000,
    });
    return String(out).trim().split("+")[0] || null;
  } catch {
    return null;
  }
}

/**
 * Que version se va a instalar, dado lo que se sabe del equipo.
 *
 * El feed sirve para SABER la version, no para instalar una que ya esta: si la
 * publicacion ya existe en disco, `installProductMcp` la reutiliza sin tocar la red.
 * Por eso un feed caido no puede impedir seguir cuando hay algo instalado — que es lo
 * que pasaba: el formulario decia "ya instalado 0.64.0" y acto seguido se negaba a
 * escribir la configuracion por no haber podido preguntar cual es la ultima.
 *
 * Devuelve tambien POR QUE, para poder decirlo en pantalla en lugar de instalar algo
 * distinto de lo que el usuario cree.
 */
function versionToInstall({ latest = null, installed = null } = {}) {
  if (latest) {
    return {
      version: latest,
      origen: installed === latest ? "feed (ya estaba publicada)" : "feed",
      alDia: true,
    };
  }
  if (installed) {
    return {
      version: installed,
      origen: "la ya instalada en este equipo (el feed no responde)",
      alDia: false,
    };
  }
  return { version: null, origen: null, alDia: false };
}

module.exports = {
  PRODUCT_PACKAGE,
  PRODUCT_FEED,
  PRODUCT_VERSIONS_URL,
  PRODUCT_DLL,
  MIN_DOTNET_MAJOR,
  productRuntimeDir,
  productAppDir,
  productDll,
  installedProductVersion,
  compareVersions,
  pickLatest,
  latestProductVersion,
  getJsonCompletandoCadena,
  fetchMissingIssuer,
  validateIssuer,
  isMissingIssuerError,
  versionToInstall,
  explainNetworkError,
  dotnetSdkVersion,
  checkDotnetSdk,
  projectFiles,
  installProductMcp,
  installProductFromFolder,
  readAssemblyVersion,
};
