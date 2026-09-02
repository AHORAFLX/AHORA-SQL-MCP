/**
 * Resolucion del endpoint real de una conexion, en el PRIMER USO y no al arrancar.
 *
 * Una instancia nombrada local no lleva puerto en la cadena de conexion, y tedious solo
 * habla TCP: hay que averiguarlo. Averiguarlo cuesta ~4 segundos de PowerShell
 * (bin/discover-instance.js), y hasta ahora eso se pagaba en el wrapper, ANTES de
 * levantar el servidor, con el cliente MCP contando sus 30 segundos hacia el
 * `initialize`. Cuando la maquina iba justa no llegaba, el cliente descartaba el
 * servidor entero y las tools no aparecian; al reiniciar caia en el minuto de cache del
 * sondeo y entonces si. De ahi el "a veces hay que reiniciar el MCP".
 *
 * Aqui el saludo `initialize` se contesta con las tools ya registradas y sin haber
 * preguntado nada. El sondeo se paga en la primera tool que use esa conexion, una vez
 * por proceso, y de forma asincrona para no dejar de atender el canal JSON-RPC mientras
 * PowerShell responde.
 *
 * La segunda razon de existir de este modulo es que el resultado se pueda TIRAR. El
 * puerto de una instancia dinamica cambia cada vez que arranca el servicio SQL, asi que
 * un puerto resuelto no es un dato permanente: es una suposicion con fecha de caducidad
 * desconocida. Cuando el pool que lo usaba se rompe, `invalidateEndpoint` marca la
 * suposicion como sospechosa y la siguiente conexion vuelve a preguntar, saltandose
 * tambien la cache en disco. Antes no habia forma de hacerlo sin reiniciar el proceso.
 */
const {
  DEFAULT_CACHE_FILE,
  discoverLocalInstancesAsync,
  isLocalHost,
} = require("../../bin/discover-instance");

/** dbKey -> { from: la config de origen, config: la ya resuelta } */
const resolved = new Map();
/** dbKeys cuya resolucion hay que rehacer preguntando otra vez al sistema. */
const stale = new Set();

/**
 * ¿Por que instancia habria que preguntar para esta config, si por alguna?
 *
 * Solo se pregunta cuando falta el puerto, hay instancia y el servidor es esta misma
 * maquina. Una instancia nombrada REMOTA no se puede sondear desde aqui, asi que se
 * deja tal cual y la resuelve el SQL Browser del otro lado, como siempre.
 */
function instanceToResolve(config) {
  const instanceName = config?.options?.instanceName;
  if (!instanceName) return null;
  if (config.port) return null;
  if (!isLocalHost(config.server)) return null;
  return instanceName;
}

/**
 * La config con la que hay que conectar de verdad.
 *
 * Devuelve la misma config que se le da cuando no hay nada que resolver, y una copia con
 * `port` (y sin `options.instanceName`, que tedious no admite a la vez) cuando el sondeo
 * ha dado con el puerto. Si el sondeo falla se devuelve la original: mejor intentarlo por
 * nombre de instancia que no intentarlo.
 */
async function resolveEndpoint(
  dbKey,
  config,
  {
    discover = discoverLocalInstancesAsync,
    cacheFile = DEFAULT_CACHE_FILE,
    log = console.error,
  } = {}
) {
  const cached = resolved.get(dbKey);
  // La comparacion es por identidad de la config de origen: si cambiara (no pasa hoy,
  // `getConfig` devuelve siempre el mismo objeto), lo resuelto ya no le corresponde.
  if (cached && cached.from === config && !stale.has(dbKey))
    return cached.config;

  const instanceName = instanceToResolve(config);
  if (!instanceName) {
    resolved.set(dbKey, { from: config, config });
    stale.delete(dbKey);
    return config;
  }

  const refresh = stale.has(dbKey);
  const found = (await discover([instanceName], { cacheFile, refresh }))[
    instanceName
  ];
  stale.delete(dbKey);

  if (!found) {
    log(
      `[${dbKey}] no se ha podido averiguar el puerto de la instancia ${instanceName}; ` +
        "se intentara por nombre, que necesita el servicio SQL Browser."
    );
    resolved.set(dbKey, { from: config, config });
    return config;
  }

  // Sin `instanceName`: tedious rechaza puerto e instancia a la vez.
  const options = { ...config.options };
  delete options.instanceName;
  const out = {
    ...config,
    server: found.address || config.server,
    port: Number(found.port),
    options,
  };

  log(
    `[${dbKey}] instancia ${instanceName} resuelta: ${out.server},${out.port}` +
      (found.address ? "  (solo escucha en loopback)" : "") +
      (refresh ? "  (vuelto a averiguar)" : "")
  );
  resolved.set(dbKey, { from: config, config: out });
  return out;
}

/**
 * Marca la resolucion de esta conexion como sospechosa.
 *
 * La llama `getPool` cuando un pool se rompe o no conecta por un error de endpoint. No
 * borra nada por si misma: la siguiente resolucion es la que vuelve a preguntar, de modo
 * que invalidar es gratis y no dispara sondeos que nadie ha pedido.
 */
function invalidateEndpoint(dbKey) {
  stale.add(dbKey);
}

/** Lo que se ha resuelto ya, para diagnostico. */
function getResolvedEndpoints() {
  const out = {};
  for (const [dbKey, { config }] of resolved.entries()) {
    out[dbKey] = {
      server: config.server,
      port: config.port,
      instanceName: config.options?.instanceName,
      stale: stale.has(dbKey),
    };
  }
  return out;
}

function _resetForTests() {
  resolved.clear();
  stale.clear();
}

module.exports = {
  instanceToResolve,
  resolveEndpoint,
  invalidateEndpoint,
  getResolvedEndpoints,
  _resetForTests,
};
