/**
 * Deteccion de herramientas del PATH de la maquina.
 *
 * Vive aparte de installer/setup.js porque installer/product-mcp.js tambien la
 * necesita —para saber si hay SDK de .NET— y setup.js importa product-mcp.js: si
 * esto siguiera en setup.js, el require seria un ciclo con los exports a medio
 * definir, que es exactamente el problema que ya documenta setup.js con gui.js.
 */
const { execFileSync } = require("child_process");

/**
 * Version de un ejecutable del PATH de la MAQUINA, o null si no esta.
 *
 * Dos intentos, y el ORDEN importa: primero SIN shell, y solo si eso falla, con shell.
 *
 * Con shell hace falta para `npm`, que en Windows es `npm.cmd` y no se puede ejecutar
 * directamente. Pero `node` es un .exe y no lo necesita, y pedir shell cuando no hace
 * falta ataba esta comprobacion a que el shell del sistema estuviera sano.
 *
 * No es hipotetico: en un equipo con una instalacion de Git para Windows cuyo sh.exe
 * aborta con "fatal error - add_item ... failed, errno 1" -un fallo del runtime MSYS que
 * se dispara de forma intermitente-, `node --version` fallaba aqui y checkNode()
 * concluia que en el equipo no hay Node instalado. El instalador se negaba a seguir en
 * una maquina que si lo tiene, y el mensaje no daba ninguna pista de por que.
 */
function toolVersion(command) {
  const intentos = process.platform === "win32" ? [false, true] : [false];
  for (const conShell of intentos) {
    try {
      const salida = execFileSync(command, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        shell: conShell,
      });
      if (salida && salida.trim()) return salida.trim();
    } catch {
      // Se prueba la forma siguiente; si no queda ninguna, se devuelve null.
    }
  }
  return null;
}

module.exports = { toolVersion };
