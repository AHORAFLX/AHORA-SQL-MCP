const { z } = require("zod");
const { revealAll, isProtected } = require("./secrets");

/**
 * Cuanto vive una conexion libre en el pool antes de cerrarse.
 *
 * Eran 30 s, el valor por defecto de mssql, y en un MCP es el peor valor posible: entre
 * dos llamadas del modelo pasan casi siempre mas de 30 s pensando, asi que cada tool
 * encontraba el pool vacio y pagaba un connect entero -TCP, TLS y login- para una
 * consulta de milisegundos. Con `min: 0` el pool no repone nada por su cuenta, de modo
 * que el coste se repetia en practicamente todas las llamadas de una sesion.
 *
 * Subirlo no arriesga nada que no este ya cubierto: una conexion que muere mientras
 * espera -reinicio del servicio SQL, portatil suspendido- la rechaza el `validate` al
 * cogerla (db/connections.js) y tarn crea otra; y tedious lleva keep-alive TCP, con lo
 * que un socket a medio cerrar acaba marcado como cerrado sin esperar al reset. Cinco
 * minutos cubre con holgura una sesion de trabajo con pausas y sigue soltando las
 * conexiones cuando de verdad se deja de usar el MCP.
 */
const POOL_IDLE_TIMEOUT_MS = 300000;

const dbConnectionSchema = z.object({
  server: z.string().min(1),
  port: z.number().int().positive().optional(),
  user: z.string().min(1),
  password: z.string().min(1),
  database: z.string().min(1),
  options: z.object({
    encrypt: z.boolean(),
    trustServerCertificate: z.boolean(),
    // AHORA: instancia nombrada (PC_158\PC_158). Requiere SQL Browser activo,
    // porque tedious lo usa para resolver el puerto dinamico de la instancia.
    instanceName: z.string().min(1).optional(),
  }),
  connectionTimeout: z.number().int().positive().default(30000),
  requestTimeout: z.number().int().positive().default(30000),
  pool: z
    .object({
      max: z.number().int().positive().default(10),
      min: z.number().int().nonnegative().default(0),
      idleTimeoutMillis: z
        .number()
        .int()
        .nonnegative()
        .default(POOL_IDLE_TIMEOUT_MS),
    })
    .default({ max: 10, min: 0, idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS }),
});

function buildConfig({
  server,
  port,
  instanceName,
  user,
  password,
  database,
  encrypt,
  trustServerCertificate,
}) {
  // tedious rechaza puerto e instancia a la vez: son mutuamente excluyentes.
  // Fallamos aqui con un mensaje claro en vez de dejar que reviente el driver.
  if (port && instanceName) {
    throw new Error(
      "No se puede indicar puerto e instancia nombrada a la vez. " +
        "Usa el puerto si SQL Browser esta parado, o la instancia si esta activo."
    );
  }

  const cfg = {
    server: server || "localhost",
    user,
    password,
    database,
    options: {
      encrypt: encrypt === "true",
      trustServerCertificate: trustServerCertificate !== "false",
    },
  };
  if (port) cfg.port = Number.parseInt(port, 10);
  if (instanceName) cfg.options.instanceName = instanceName;
  return dbConnectionSchema.parse(cfg);
}

/**
 * Las contrasenas, ya en claro, en el mismo orden que se piden.
 *
 * El wrapper ya no descifra antes de arrancar el servidor: pasa el token tal cual en
 * MSSQL_*_PASSWORD y se abre aqui, que es la primera vez que alguien necesita conectar
 * de verdad. `revealAll` deja intacto lo que no lleva marca de cifrado, asi que una
 * contrasena en claro (--from-env, o un fichero de credenciales de una version anterior)
 * pasa por aqui sin coste ninguno.
 *
 * En un solo lote y no una por una porque cada descifrado con DPAPI cuesta un arranque de
 * PowerShell (~0,5 s medidos): con multi-BD, uno por conexion.
 */
function revealPasswords(values, reveal) {
  // Sin nada cifrado no se llama al descifrador: asi el camino habitual no depende de
  // que PowerShell exista ni de que DPAPI este disponible.
  if (!values.some((v) => typeof v === "string" && isProtected(v))) return values;
  return reveal(values);
}

function loadConfigsFromEnv(env = process.env, { reveal = revealAll } = {}) {
  const multiKeys = Object.keys(env).filter((k) =>
    /^MSSQL_(.+)_DATABASE$/.test(k)
  );

  if (multiKeys.length > 0) {
    const entries = multiKeys.map((key) => {
      const [, raw] = key.match(/^MSSQL_(.+)_DATABASE$/);
      return { key, dbKey: raw.toLowerCase(), p: `MSSQL_${raw}_` };
    });

    const passwords = revealPasswords(
      entries.map(({ p }) => env[`${p}PASSWORD`] || env.MSSQL_PASSWORD),
      reveal
    );

    const configs = {};
    const errors = [];
    entries.forEach(({ key, dbKey, p }, i) => {
      try {
        configs[dbKey] = buildConfig({
          server: env[`${p}SERVER`] || env.MSSQL_SERVER,
          port: env[`${p}PORT`],
          instanceName: env[`${p}INSTANCE_NAME`] || env.MSSQL_INSTANCE_NAME,
          user: env[`${p}USER`] || env.MSSQL_USER,
          password: passwords[i],
          database: env[key],
          encrypt: env[`${p}ENCRYPT`] || env.MSSQL_ENCRYPT,
          trustServerCertificate:
            env[`${p}TRUST_SERVER_CERTIFICATE`] ||
            env.MSSQL_TRUST_SERVER_CERTIFICATE,
        });
      } catch (err) {
        errors.push(`${dbKey}: ${err.message}`);
      }
    });
    if (Object.keys(configs).length === 0) {
      throw new Error(
        `[config] No valid database configuration found. ${errors.join("; ")}`
      );
    }
    if (errors.length > 0) {
      console.warn(`[config] warnings: ${errors.join("; ")}`);
    }
    return { configs, mode: "multi" };
  }

  if (env.MSSQL_SERVER || env.MSSQL_DATABASE) {
    return {
      mode: "single",
      configs: {
        maindb: buildConfig({
          server: env.MSSQL_SERVER,
          port: env.MSSQL_PORT,
          instanceName: env.MSSQL_INSTANCE_NAME,
          user: env.MSSQL_USER,
          password: revealPasswords([env.MSSQL_PASSWORD], reveal)[0],
          database: env.MSSQL_DATABASE,
          encrypt: env.MSSQL_ENCRYPT,
          trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE,
        }),
      },
    };
  }

  throw new Error(
    "[config] No valid database configuration found. Set MSSQL_* for single mode or MSSQL_<NAME>_* for multi mode."
  );
}

let cached;

function getConfigs() {
  if (!cached) cached = loadConfigsFromEnv();
  return cached;
}

function getConfig(dbKey) {
  const { configs } = getConfigs();
  const key = dbKey ? String(dbKey).toLowerCase() : Object.keys(configs)[0];
  if (!configs[key]) {
    throw new Error(
      `[config] Invalid dbKey '${dbKey}'. Available: ${Object.keys(configs).join(", ")}`
    );
  }
  return { dbKey: key, config: configs[key] };
}

function getDefaultDbKey() {
  return Object.keys(getConfigs().configs)[0];
}

function listDbKeys() {
  return Object.keys(getConfigs().configs);
}

function _resetForTests() {
  cached = undefined;
}

module.exports = {
  POOL_IDLE_TIMEOUT_MS,
  loadConfigsFromEnv,
  getConfigs,
  getConfig,
  getDefaultDbKey,
  listDbKeys,
  _resetForTests,
};
