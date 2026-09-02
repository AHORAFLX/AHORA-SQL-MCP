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
