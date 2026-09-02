/*
 * El paquete que se publica no puede volver a arrastrar dependencias.
 *
 * Instalar el servidor era lo que agotaba el CONNECT_TIMEOUT del cliente MCP: 166
 * paquetes, 88 s medidos con la cache en frio. Todo eso viaja ahora dentro de bundle/.
 * Basta con que alguien anada una linea a `dependencies` para que vuelva a resolverse un
 * arbol al arrancar, y el sintoma tardaria semanas en atribuirse a esa linea. Estos
 * tests son el aviso.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const pkg = require("../package.json");

test("el paquete publicado no declara dependencias de ejecucion", () => {
  assert.deepEqual(
    Object.keys(pkg.dependencies || {}),
    [],
    "cada dependencia aqui es un arbol que npm resuelve ANTES de que Node arranque, " +
      "dentro del presupuesto del cliente MCP. Si de verdad hace falta, va en " +
      "devDependencies y entra en el paquete via `npm run build`."
  );
});

test("los tres binarios apuntan al paquete construido", () => {
  // Apuntar a src/ o bin/ seria un paquete que se instala rapido y no arranca: sin
  // dependencias instaladas, sus `require` no encuentran nada.
  for (const [nombre, destino] of Object.entries(pkg.bin)) {
    assert.match(
      destino,
      /^\.\/bundle\//,
      `el bin '${nombre}' deberia salir de bundle/, no de ${destino}`
    );
  }
});

test("lo que se publica incluye bundle/ y nada que no arranque", () => {
  assert.ok(
    pkg.files.includes("bundle/"),
    "sin bundle/ en `files` el paquete se publica vacio de codigo"
  );
  for (const dir of ["src/", "bin/", "installer/"]) {
    assert.ok(
      !pkg.files.includes(dir),
      `${dir} no puede publicarse: sin dependencias instaladas no puede ejecutarse`
    );
  }
});

test("cada bin declarado existe en el arbol de ficheros", () => {
  // Si falta, es que no se ha ejecutado `npm run build` tras cambiar el codigo. Se
  // avisa aqui y no en la maquina de quien lo instale.
  for (const [nombre, destino] of Object.entries(pkg.bin)) {
    const full = path.join(ROOT, destino);
    assert.ok(
      fs.existsSync(full),
      `falta ${destino} (bin '${nombre}'). Ejecuta: npm run build`
    );
  }
});

test("el paquete construido no contiene rutas de la maquina que lo construyo", () => {
  // esbuild puede colar rutas absolutas en mensajes de error o en sourcemaps. Aqui no
  // hay credenciales, pero una ruta con el nombre de usuario del que construye no tiene
  // por que repartirse.
  const bundle = fs.readFileSync(
    path.join(ROOT, "bundle", "start-mssql-mcp.cjs"),
    "utf8"
  );
  assert.ok(
    !/C:\\\\?Users\\\\?[A-Za-z0-9._-]+\\\\?/i.test(bundle),
    "el paquete lleva dentro una ruta de perfil de usuario"
  );
});
