#!/usr/bin/env node
/**
 * Construye dist/ahora-setup.exe, un unico ejecutable con el instalador dentro.
 *
 *   node installer/build-exe.js
 *
 * Usa las SEA (Single Executable Applications) que trae Node de serie. esbuild y
 * postject se invocan con npx y NO se anaden a las dependencias del repo: solo
 * hacen falta para construir, nunca para ejecutar.
 *
 * El .exe lleva el runtime de Node embebido, asi que pesa lo que pese node.exe
 * (~110 MB). No se autofirma: en maquinas con SmartScreen o antivirus estrictos
 * puede dar aviso la primera vez. Si eso molesta, installer/INSTALAR-AHORA.cmd
 * hace lo mismo sin binario.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const BUNDLE = path.join(DIST, "setup.bundle.js");
const SEA_CONFIG = path.join(DIST, "sea-config.json");
const BLOB = path.join(DIST, "setup.blob");
const EXE = path.join(DIST, process.platform === "win32" ? "ahora-setup.exe" : "ahora-setup");
const FUSE = "fce680ab2cc467b6e072b8b5df1996b2";

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

function npx(args) {
  execFileSync("npx", ["--yes", ...args], {
    stdio: "inherit",
    cwd: ROOT,
    shell: process.platform === "win32",
  });
}

function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    console.error(`Hacen falta Node 20+ para las SEA. Tienes ${process.versions.node}.`);
    process.exit(1);
  }

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  step("Empaquetando el instalador en un solo fichero (esbuild)");
  npx([
    "esbuild",
    path.relative(ROOT, path.join(__dirname, "exe-entry.js")),
    "--bundle",
    "--platform=node",
    "--target=node20",
    `--outfile=${path.relative(ROOT, BUNDLE)}`,
  ]);

  step("Generando el blob SEA");
  fs.writeFileSync(
    SEA_CONFIG,
    JSON.stringify(
      { main: BUNDLE, output: BLOB, disableExperimentalSEAWarning: true },
      null,
      2
    ),
    "utf8"
  );
  execFileSync(process.execPath, ["--experimental-sea-config", SEA_CONFIG], {
    stdio: "inherit",
    cwd: ROOT,
  });

  step("Copiando el runtime de Node");
  fs.copyFileSync(process.execPath, EXE);

  step("Inyectando el blob en el ejecutable (postject)");
  npx([
    "postject",
    path.relative(ROOT, EXE),
    "NODE_SEA_BLOB",
    path.relative(ROOT, BLOB),
    "--sentinel-fuse",
    `NODE_SEA_FUSE_${FUSE}`,
  ]);

  const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(0);
  step(`Listo: ${EXE}  (${mb} MB)`);
  console.log("\nPruebalo antes de repartirlo. Se ejecuta desde la carpeta del proyecto.");
}

if (require.main === module) main();
