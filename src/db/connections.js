/**
 * Higiene de las conexiones CRUDAS que viven dentro del pool.
 *
 * POR QUE HACE FALTA ESTO
 *
 * Un pool reparte la MISMA conexion a llamadas que no tienen nada que ver entre si, asi
 * que el estado que una deja pegado a la conexion lo hereda la siguiente. El caso que
 * duele es una transaccion abierta: si una lectura no consigue hacer su ROLLBACK -porque
 * su cancelacion no aterrizo y tedious serializa los requests de una conexion, asi que el
 * ROLLBACK no se puede ni enviar- la conexion vuelve al pool con @@TRANCOUNT=1. Medido
 * contra SQL Server: cuatro sesiones `node-mssql` durmiendo con open_transaction_count=1
 * entre 372 y 434 s, sin nada en sys.dm_exec_requests y con un unico lock DATABASE en
 * modo S. No bloquean a nadie -de ahi que no se vea como un bloqueo- pero quien coja esa
 * conexion despues arranca ya dentro de una transaccion ajena.
 *
 * Aqui viven las dos mitades de la cura:
 *
 *   - `makeAcquireReset`, el `validate` que tarn ejecuta al coger una conexion del pool.
 *     Sanea la conexion ANTES de entregarla y la rechaza si no se deja sanear. Esto es lo
 *     que hace que el fallo se cure solo: una conexion quemada deja de contaminar a las
 *     llamadas siguientes aunque nadie mas toque nada.
 *   - `destroyConnection`, para sacar del pool -de verdad y para siempre- la conexion
 *     cuya cancelacion o rollback ha fallado, en lugar de devolverla al monton.
 *
 * Todo lo de este modulo tolera que le pasen un objeto que no sea una conexion de tedious
 * (`undefined`, un doble de test, o el driver nativo de Windows, que no tiene `reset`).
 * Es a proposito: es codigo de limpieza, y reventar limpiando seria peor que no limpiar.
 */

/** Cuanto se espera, como maximo, a que una conexion se sanee al cogerla del pool. */
const ACQUIRE_RESET_TIMEOUT_MS = 5000;

/** Cuanto se espera, como maximo, a que el socket de una conexion quemada se cierre. */
const CLOSE_TIMEOUT_MS = 2000;

/**
 * `promise` con un plazo. Al vencer, rechaza; NO cancela nada.
 *
 * Es justo lo que hace falta en un camino de limpieza: lo que no puede pasar es quedarse
 * colgado esperando a una conexion que ya no va a contestar. Un `validate` de tarn que no
 * resuelve nunca deja el acquire esperando hasta su propio timeout y sale por el generico
 * "operation timed out for an unknown reason", que no orienta a nada.
 */
function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    // El timer NO se hace `unref`: es corto y acotado por definicion, y ambas salidas lo
    // limpian, asi que no puede retener el proceso mas alla de `ms`. Con `unref`, en
    // cambio, un proceso ocioso podria salir sin que el plazo llegase a vencer, y quien
    // espera la limpieza se quedaria esperando para siempre.
    const timer = setTimeout(() => {
      const err = new Error(`${label} did not complete in ${ms}ms`);
      err.code = "ETIMEOUT";
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** La conexion que una transaccion tiene pinchada, si sigue teniendola. */
function acquiredConnection(transaction) {
  return transaction?._acquiredConnection || null;
}

/** ¿Se puede volver a repartir esta conexion? */
function isReusable(connection) {
  return Boolean(connection) && !connection.closed && !connection.hasError;
}

/**
 * ¿Le queda una transaccion abierta?
 *
 * `inTransaction` no es una suposicion del cliente: tedious lo mantiene con los tokens
 * ENVCHANGE de BEGIN/COMMIT/ROLLBACK que manda el servidor, asi que es lo ultimo que el
 * servidor dijo sobre el @@TRANCOUNT de esta sesion.
 */
function hasOpenTransaction(connection) {
  return connection?.inTransaction === true;
}

/**
 * Devuelve la conexion a su estado inicial, con plazo.
 *
 * `reset` de tedious esta pensado exactamente para esto ("Can be useful for connection
 * pool implementations"): marca el siguiente mensaje con el bit de reset de TDS, que hace
 * que el servidor deshaga cualquier transaccion abierta, tire las tablas temporales y
 * restaure las opciones SET de la sesion. Cuesta un viaje de ida y vuelta, el mismo que
 * ya costaba el `SELECT 1` con el que mssql valida las conexiones por defecto.
 */
function resetConnection(connection, timeoutMs = ACQUIRE_RESET_TIMEOUT_MS) {
  if (typeof connection?.reset !== "function") {
    // Sin `reset` no hay nada que ejecutar; el estado que conocemos es el que hay.
    return Promise.resolve();
  }
  return withTimeout(
    new Promise((resolve, reject) => {
      try {
        connection.reset((err) => (err ? reject(err) : resolve()));
      } catch (err) {
        reject(err);
      }
    }),
    timeoutMs,
    "connection reset"
  );
}

/**
 * El `validate` que tarn ejecuta al sacar una conexion de la lista de libres.
 *
 * Sustituye al `_poolValidate` de mssql (que solo lanza un `SELECT 1`) por algo que
 * ademas LIMPIA, y por el mismo precio en viajes al servidor. Devolver `false` no es
 * perder la llamada: tarn destruye ese recurso, crea otro y sirve el acquire con el
 * nuevo, asi que quien llama solo nota que su consulta tardo una conexion mas.
 *
 * Las tres respuestas posibles, y por que:
 *   - la conexion ya venia cerrada o marcada -> `false`, como haria mssql.
 *   - el reset falla o no contesta en plazo -> `false`. Una conexion que no se deja
 *     sanear es precisamente la que no hay que repartir, y el plazo evita que un
 *     `validate` colgado se convierta en un acquire colgado.
 *   - el reset va bien pero el servidor sigue diciendo que hay transaccion abierta ->
 *     `false`. Es el cinturon y los tirantes: si el reset no bastase para deshacerla, la
 *     conexion se tira en lugar de entregarse envenenada.
 */
function makeAcquireReset({
  timeoutMs = ACQUIRE_RESET_TIMEOUT_MS,
  onDiscard,
} = {}) {
  return function validateOnAcquire(connection) {
    if (!isReusable(connection)) return false;
    return resetConnection(connection, timeoutMs).then(
      () => {
        if (!hasOpenTransaction(connection)) return true;
        onDiscard?.("open-transaction", connection);
        return false;
      },
      (err) => {
        onDiscard?.(err?.code || "reset-failed", connection);
        return false;
      }
    );
  };
}

/** Cierra el socket de la conexion, con plazo, sin propagar errores. */
function closeConnection(connection, timeoutMs = CLOSE_TIMEOUT_MS) {
  if (!connection || connection.closed) return Promise.resolve();
  return withTimeout(
    new Promise((resolve) => {
      try {
        if (typeof connection.once === "function") {
          connection.once("end", resolve);
          connection.close();
        } else {
          connection.close();
          resolve();
        }
      } catch {
        resolve();
      }
    }),
    timeoutMs,
    "connection close"
  ).catch(() => {});
}

/**
 * Saca una conexion de circulacion para siempre.
 *
 * Los tres pasos hacen falta, y en este orden:
 *
 *  1. `hasError = true` es la marca de "no reutilizar" que el propio mssql ya entiende
 *     -su `_poolValidate` y el nuestro rechazan cualquier conexion que la lleve-. Se pone
 *     PRIMERO y de forma sincrona, para que ninguna carrera pueda repartirla mientras se
 *     cierra.
 *  2. Cerrar el socket es lo unico que hace que el servidor deshaga la transaccion
 *     huerfana AHORA. Sin esto la sesion se queda durmiendo con @@TRANCOUNT=1 hasta que
 *     alguien la mate a mano: son las cuatro sesiones de la medida.
 *  3. Devolver el hueco al pool. tarn no tiene forma de destruir un recurso que sigue en
 *     `used`, asi que hay que soltarlo para que el `validate` del siguiente acquire lo
 *     tire y cree otro. Sin este paso cada fallo quemaria una plaza del pool para
 *     siempre, y al agotarlas todo acquire posterior muere por timeout.
 */
async function destroyConnection(pool, connection) {
  if (!connection) return false;
  try {
    connection.hasError = true;
  } catch {
    // Un doble de test puede tener la propiedad en solo lectura; da igual, lo que manda
    // es el cierre de abajo.
  }
  const closed = closeConnection(connection);
  try {
    pool?.release?.(connection);
  } catch {
    // La conexion puede haber sido soltada ya por el driver; el hueco esta libre.
  }
  await closed;
  return true;
}

module.exports = {
  ACQUIRE_RESET_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
  withTimeout,
  acquiredConnection,
  isReusable,
  hasOpenTransaction,
  resetConnection,
  makeAcquireReset,
  closeConnection,
  destroyConnection,
};
