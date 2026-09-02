#!/usr/bin/env node
/**
 * Empaqueta el servidor y su wrapper en dos ficheros JS sin dependencias.
 *
 *   node scripts/build-bundle.js
 *
 * POR QUE EXISTE ESTO
 *
 * El `.mcp.json` de los proyectos apunta al servidor con un spec `github:`. Con la cache
 * de npm en frio, eso obliga a `git fetch` + resolucion + instalacion COMPLETA del arbol
 * de dependencias antes de que Node llegue a arrancar: 166 paquetes y 91,8 s medidos en
 * una maquina de trabajo. El cliente MCP corta a los 30 s (CONNECT_TIMEOUT) y descarta el
 * servidor entero, asi que las tools no aparecen. Una vez la cache esta caliente conecta
 * bien, y de ahi la sensacion de que "a veces hay que reiniciar el MCP".
 *
 * Con todo dentro de un fichero, `npm install` de este paquete instala CERO paquetes: no
 * hay arbol que resolver ni tarballs que bajar. Es la unica de las tres salidas que ataca
 * la causa en lugar de hacerla mas rapida.
 *
 * QUE SE EMPAQUETA Y POR QUE DOS FICHEROS
 *
 * El wrapper y el servidor son dos procesos: el wrapper prepara el entorno (y solo el
 * entorno) y lanza el servidor limpio, que es lo que impide que un MSSQL_* heredado de la
 * maquina active escrituras. Empaquetarlos juntos no serviria: hacen falta dos entradas
 * ejecutables de verdad.
 *
 * LA PEREZA SE MANTIENE
 *
 * esbuild envuelve cada modulo CommonJS en una funcion que no corre hasta el primer
 * `require`, asi que el `require("mssql")` perezoso de src/db/driver.js sigue siendo
 * perezoso dentro del paquete. Eso lo verifica `npm run verify:bundle`, no la fe.
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "bundle");

/**
 * Cada entrada ejecutable, con el nombre con el que se publica.
 *
 * El instalador entra aqui porque tambien es un `bin` del paquete y `installer/probe.js`
 * carga `mssql` para probar la conexion: sin empaquetarlo, publicar sin dependencias lo
 * dejaria sin arrancar. Su entrada es exe-entry.js (no setup.js) porque es la que llama
 * a `run()` sola, sin depender de `require.main`.
 *
 * `shebang` solo donde el fuente no lo trae ya en su linea 1: esbuild conserva el del
 * fichero de entrada, y un segundo shebang caeria en la linea 2, donde es un error de
 * sintaxis en lugar de un shebang.
 */
const ENTRIES = [
  { in: "bin/start-mssql-mcp.js", out: "start-mssql-mcp.cjs" },
  { in: "src/index.js", out: "ahora-sql-mcp.cjs" },
  { in: "installer/exe-entry.js", out: "ahora-setup.cjs", shebang: true },
];

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const results = [];
  for (const entry of ENTRIES) {
    const outfile = path.join(OUT, entry.out);
    const result = await esbuild.build({
      entryPoints: [path.join(ROOT, entry.in)],
      outfile,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      ...(entry.shebang ? { banner: { js: "#!/usr/bin/env node" } } : {}),
      // Sin minificar. Pesa mas, pero un fallo en produccion se lee en el stack, y el
      // tamano del fichero no es lo que costaba tiempo: era instalar 166 paquetes.
      minify: false,
      sourcemap: false,
      logLevel: "warning",
      // `mssql` mira si existe el driver nativo de Windows y sigue sin el si no esta.
      // Marcarlo externo evita que esbuild falle por un opcional que nadie usa aqui.
      external: ["msnodesqlv8"],
      metafile: true,
    });

    const bytes = fs.statSync(outfile).size;
    results.push({
      entrada: entry.in,
      salida: path.relative(ROOT, outfile),
      kb: Math.round(bytes / 1024),
      warnings: result.warnings.length,
    });
  }

  for (const r of results) {
    console.log(`  ${r.entrada}  ->  ${r.salida}  (${r.kb} KB, ${r.warnings} avisos)`);
  }
  console.log(`\nListo. ${results.length} ficheros en ${path.relative(ROOT, OUT)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
