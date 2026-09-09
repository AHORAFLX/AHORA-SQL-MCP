/*
 * Los pines de version tienen que ir a la par que package.json.
 *
 * El pin no es cosmetico: es la version que se DESCARGA e instala. Dos formas de que
 * duela, y las dos han pasado ya:
 *
 *  - Un pin viejo instala una version anterior a la que el instalador espera. Con el
 *    paquete empaquetado eso significa instalar algo SIN bundle/ y escribir un .mcp.json
 *    que apunta a un fichero que no existe.
 *  - `installer/INSTALAR-AHORA.cmd` se quedo en v1.8.3 mientras el repositorio iba por
 *    v1.8.4, y hubo que corregirlo despues (commit e917d6d).
 *
 * PKG_SPEC se construye con la version de package.json, asi que publicar una version
 * exige que exista la etiqueta correspondiente en GitHub. Esto no lo puede comprobar un
 * test sin red; lo que si comprueba es que todo lo que hay escrito apunte a la MISMA
 * version, que es donde se cuela el error.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { version } = require("../package.json");

/** Cada `#vX.Y.Z` que aparezca en un fichero. */
function pines(rel) {
  const texto = fs.readFileSync(path.join(ROOT, rel), "utf8");
  return [...texto.matchAll(/#v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
}

/**
 * Cada `--branch vX.Y.Z`, que es la OTRA forma de fijar la version.
 *
 * Se escapo de la comprobacion durante cuatro versiones: el README decia
 * `git clone --branch v1.9.0` mientras el repositorio iba por v1.12.1, y quien siguiera
 * la instalacion manual se llevaba un clon anterior al MCP de producto entero. No lo
 * cazaba nadie porque el patron `#vX.Y.Z` no aparece en esa linea.
 *
 * Se busca `--branch` y no cualquier `vX.Y.Z` a proposito: hay menciones historicas
 * legitimas -"Antes (v1.8.3)" en la tabla de tiempos- que no son pines y que un patron
 * mas amplio convertiria en un test que hay que ir apagando.
 */
function pinesDeClonado(rel) {
  const texto = fs.readFileSync(path.join(ROOT, rel), "utf8");
  return [...texto.matchAll(/--branch\s+v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
}

test("el .cmd de arranque instala la version de este repositorio", () => {
  const encontrados = pines("installer/INSTALAR-AHORA.cmd");
  assert.ok(encontrados.length > 0, "el .cmd deberia llevar un pin de version");
  for (const p of encontrados) {
    assert.equal(
      p,
      version,
      `INSTALAR-AHORA.cmd instala v${p} pero el repositorio va por v${version}`
    );
  }
});

test("los comandos de instalacion de la documentacion van a esta version", () => {
  for (const doc of ["README.md", "INSTALAR.md"]) {
    for (const p of pines(doc)) {
      assert.equal(
        p,
        version,
        `${doc} apunta a v${p} pero el repositorio va por v${version}`
      );
    }
  }
});

test("los `git clone --branch` de la documentacion traen esta version", () => {
  // Es la instalacion manual del README: un pin viejo aqui clona un arbol anterior, y
  // el sintoma no es un error sino un repositorio al que le faltan cosas.
  for (const doc of ["README.md", "INSTALAR.md"]) {
    for (const p of pinesDeClonado(doc)) {
      assert.equal(
        p,
        version,
        `${doc} clona v${p} pero el repositorio va por v${version}`
      );
    }
  }
});

test("la version del paquete construido es la de package.json", () => {
  // El bundle lleva dentro una copia de package.json: es de donde sale el `serverInfo`
  // que ve el cliente MCP. Si no coincide, es que falta ejecutar `npm run build`.
  const bundle = fs.readFileSync(
    path.join(ROOT, "bundle", "ahora-sql-mcp.cjs"),
    "utf8"
  );
  assert.ok(
    bundle.includes(`"${version}"`),
    `bundle/ahora-sql-mcp.cjs no contiene la version ${version}. Ejecuta: npm run build`
  );
});
