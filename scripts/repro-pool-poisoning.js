#!/usr/bin/env node
/**
 * Reproduccion, contra un SQL Server de verdad, del fallo que envenenaba el pool.
 *
 *   MSSQL_TEST_PASSWORD='...' node scripts/repro-pool-poisoning.js
 *
 * Env (todo opcional menos la contrasena):
 *   MSSQL_TEST_SERVER    default: localhost
 *   MSSQL_TEST_PORT      default: 1433        (omitir si se usa instancia nombrada)
 *   MSSQL_TEST_INSTANCE  instancia nombrada, p.ej. SQL2022
 *   MSSQL_TEST_USER      default: sa
 *   MSSQL_TEST_PASSWORD  requerido
 *
 * EL FALLO QUE SE REPRODUCE
 *
 * Una lectura cuya cancelacion no aterriza deja la conexion en el pool con @@TRANCOUNT=1:
 * el ROLLBACK no se puede ni enviar, porque tedious serializa los requests de una
 * conexion y el request cancelado sigue en vuelo. La medida que lo delato: cuatro sesiones
 * `program_name='node-mssql'` durmiendo con `open_transaction_count=1` entre 372 y 434 s,
 * `sys.dm_exec_requests` vacio y un unico lock DATABASE en modo S por sesion. No bloquean
 * a nadie; el dano es que la siguiente llamada que coja esa conexion hereda la transaccion.
 *
 * QUE COMPRUEBA, en el orden del criterio de aceptacion
 *
 *   1. Una conexion envenenada A MANO (BEGIN TRANSACTION y devuelta al pool sin rollback,
 *      que es exactamente el estado en el que la dejaba el fallo) se sanea o se tira al
 *      cogerla, y no contamina a nadie.
 *   2. Tras una lectura que revienta por timeout y se cancela, NINGUNA sesion de este
 *      proceso queda con open_transaction_count > 0 - consultado en sys.dm_exec_sessions,
 *      no deducido.
 *   3. Lo mismo con una lectura abortada a media (el camino del AbortSignal del cliente
 *      MCP, que es el que disparaba el fallo original).
 *   4. Una escritura de varias sentencias que falla a media tanda no aplica NADA, y el
 *      error dice cuales se habian ejecutado.
 *   5. Veinte lecturas seguidas despues de todo lo anterior, y ninguna falla por herencia
 *      de conexion.
 *
 * Deja la base de datos temporal borrada incluso si algo revienta.
 */
const sql = require("mssql");

const SERVER = process.env.MSSQL_TEST_SERVER || "localhost";
const INSTANCE = process.env.MSSQL_TEST_INSTANCE;
const PORT = INSTANCE
  ? undefined
  : process.env.MSSQL_TEST_PORT
    ? Number(process.env.MSSQL_TEST_PORT)
    : 1433;
const USER = process.env.MSSQL_TEST_USER || "sa";
const PASSWORD = process.env.MSSQL_TEST_PASSWORD;

if (!PASSWORD) {
  console.error(
    "MSSQL_TEST_PASSWORD is required. See the header comment for setup instructions."
  );
  process.exit(2);
}

const TEST_DB = `mcp_poison_${Date.now()}`;
const masterConfig = {
  server: SERVER,
  ...(PORT ? { port: PORT } : {}),
  user: USER,
  password: PASSWORD,
  database: "master",
  connectionTimeout: 15000,
  requestTimeout: 30000,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    ...(INSTANCE ? { instanceName: INSTANCE } : {}),
  },
};

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`[FAIL] ${name}${detail ? " - " + detail : ""}`);
  }
}

/**
 * Las sesiones `node-mssql` que estan dentro de una transaccion, segun el servidor.
 *
 * Acotado por `login_time`: un servidor de desarrollo compartido puede tener ya
 * transacciones huerfanas de OTRO cliente -de hecho las tenia la primera vez que se corrio
 * esto, dos sesiones durmiendo con open_transaction_count=1 y 400 s de inactividad, que es
 * justo la huella de este fallo- y contarlas aqui haria fallar la comprobacion por algo que
 * no ha hecho este proceso.
 */
const ORPHAN_SQL = `
  SELECT s.session_id, s.status, s.open_transaction_count, s.login_time,
         DATEDIFF(SECOND, s.last_request_end_time, SYSDATETIME()) AS idle_seconds,
         (SELECT COUNT(*) FROM sys.dm_exec_requests r WHERE r.session_id = s.session_id) AS requests
  FROM sys.dm_exec_sessions s
  WHERE s.program_name = 'node-mssql'
    AND s.session_id <> @@SPID
    AND s.open_transaction_count > 0
    AND s.login_time >= @since
  ORDER BY s.session_id`;

/** Momento a partir del cual una sesion es responsabilidad de esta ejecucion. */
let since = new Date();

async function orphanSessions(master) {
  const { recordset } = await master
    .request()
    .input("since", sql.DateTime2, since)
    .query(ORPHAN_SQL);
  return recordset;
}

/** Todas las huerfanas, sin acotar: solo para informar del estado de partida. */
async function preexistingOrphans(master) {
  const { recordset } = await master.request().query(`
    SELECT s.session_id, s.open_transaction_count,
           DATEDIFF(SECOND, s.last_request_end_time, SYSDATETIME()) AS idle_seconds
    FROM sys.dm_exec_sessions s
    WHERE s.program_name = 'node-mssql'
      AND s.session_id <> @@SPID
      AND s.open_transaction_count > 0
    ORDER BY s.session_id`);
  return recordset;
}

async function bootstrap() {
  const where = INSTANCE ? `${SERVER}\\${INSTANCE}` : `${SERVER}:${PORT}`;
  console.log(`Connecting to ${where} as ${USER}...`);
  const master = new sql.ConnectionPool(masterConfig);
  await master.connect();
  console.log(`Creating database [${TEST_DB}]...`);
  await master.request().query(`CREATE DATABASE [${TEST_DB}]`);
  await master.close();

  const pool = new sql.ConnectionPool({ ...masterConfig, database: TEST_DB });
  await pool.connect();
  await pool.request().batch(`
    CREATE TABLE dbo.Rows (Id INT PRIMARY KEY, Tag NVARCHAR(20) NOT NULL);
    INSERT INTO dbo.Rows (Id, Tag) VALUES (1,'a'), (2,'b'), (3,'c');
  `);
  await pool.close();
  console.log("Bootstrapped dbo.Rows with 3 rows.");
}

async function teardown() {
  try {
    await require("../src/db/pools").closeAllPools();
  } catch {
    // el modulo puede no haberse cargado
  }
  try {
    const master = new sql.ConnectionPool(masterConfig);
    await master.connect();
    await master
      .request()
      .query(
        `IF DB_ID('${TEST_DB}') IS NOT NULL ALTER DATABASE [${TEST_DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`
      );
    await master
      .request()
      .query(`IF DB_ID('${TEST_DB}') IS NOT NULL DROP DATABASE [${TEST_DB}]`);
    await master.close();
    console.log(`Dropped database [${TEST_DB}].`);
  } catch (err) {
    console.error(
      `Teardown error (manual cleanup may be needed for ${TEST_DB}):`,
      err.message
    );
  }
}

async function run() {
  process.env.MSSQL_SERVER = SERVER;
  if (PORT) process.env.MSSQL_PORT = String(PORT);
  else delete process.env.MSSQL_PORT;
  if (INSTANCE) process.env.MSSQL_INSTANCE_NAME = INSTANCE;
  process.env.MSSQL_USER = USER;
  process.env.MSSQL_PASSWORD = PASSWORD;
  process.env.MSSQL_DATABASE = TEST_DB;
  process.env.MSSQL_ENCRYPT = "false";
  process.env.MSSQL_TRUST_SERVER_CERTIFICATE = "true";
  process.env.MSSQL_ENABLE_WRITES = "true";

  const config = require("../src/config");
  config._resetForTests();
  const { getPool, getConnectionStatus } = require("../src/db/pools");
  const tools = require("../src/tools").modules;
  const tool = (name) => tools.find((t) => t.name === name);

  const master = new sql.ConnectionPool(masterConfig);
  await master.connect();

  const stale = await preexistingOrphans(master);
  if (stale.length > 0) {
    console.log(
      `NOTA: el servidor ya traia ${stale.length} sesion(es) node-mssql con transaccion ` +
        `abierta de antes de esta ejecucion (la huella del fallo, de otro cliente): ` +
        `${JSON.stringify(stale)}. No se cuentan.`
    );
  }
  // A partir de aqui, solo las sesiones que nazcan de este proceso.
  since = (await master.request().query("SELECT SYSDATETIME() AS now"))
    .recordset[0].now;

  const { dbKey, config: dbConfig } = config.getConfig();
  const pool = await getPool(dbKey, dbConfig);

  const read = (args) => tool("execute_read_query").handler(args, {});
  const write = (args) => tool("execute_write_query").handler(args, {});

  /** Envenena una conexion del pool y la devuelve: el estado exacto que dejaba el fallo. */
  async function poisonOnePooledConnection() {
    const tds = require("tedious");
    const poisoned = await pool.acquire();
    await new Promise((resolve, reject) => {
      poisoned.execSqlBatch(
        new tds.Request("BEGIN TRANSACTION", (err) =>
          err ? reject(err) : resolve()
        )
      );
    });
    const spid = (
      await new Promise((resolve, reject) => {
        const rows = [];
        const req = new tds.Request("SELECT @@SPID AS spid", (err) =>
          err ? reject(err) : resolve(rows)
        );
        req.on("row", (cols) => rows.push(cols[0].value));
        poisoned.execSqlBatch(req);
      })
    )[0];
    // Sin rollback, como pasaba cuando el ROLLBACK no se podia ni enviar.
    pool.release(poisoned);
    return { poisoned, spid };
  }

  async function openTransactionsOn(spid) {
    const { recordset } = await master
      .request()
      .input("spid", sql.Int, spid)
      .query(
        `SELECT open_transaction_count AS n FROM sys.dm_exec_sessions WHERE session_id = @spid`
      );
    return recordset.length === 0 ? 0 : recordset[0].n;
  }

  // ── 1. Una conexion envenenada a mano no contamina a la siguiente llamada ────────
  //
  // Se deja el pool exactamente como lo dejaba el fallo: una conexion libre con una
  // transaccion abierta. Se hace a mano porque provocar una cancelacion que NO aterrice
  // no es determinista, y el estado resultante -que es lo que hace dano- si lo es.
  {
    const { poisoned, spid } = await poisonOnePooledConnection();
    check(
      "la conexion se queda de verdad con una transaccion abierta (reproduccion)",
      poisoned.inTransaction === true,
      `inTransaction=${poisoned.inTransaction}`
    );
    check(
      "el servidor ve la sesion envenenada, como en la medida original",
      (await openTransactionsOn(spid)) > 0,
      `open_transaction_count=${await openTransactionsOn(spid)}`
    );

    const r = await read({
      query: "SELECT COUNT(*) AS c FROM dbo.Rows",
      limit: 10,
      offset: 0,
    });
    check(
      "una lectura posterior funciona pese a la conexion envenenada",
      r.structuredContent.recordset[0].c === 3,
      JSON.stringify(r.structuredContent)
    );
    check(
      "esa sesion concreta ya no tiene transaccion abierta (o ya no existe)",
      (await openTransactionsOn(spid)) === 0,
      `open_transaction_count=${await openTransactionsOn(spid)}`
    );
    const after = await orphanSessions(master);
    check(
      "y la transaccion heredada ya no esta en ninguna sesion de este proceso",
      after.length === 0,
      JSON.stringify(after)
    );
    const recycledCount =
      getConnectionStatus()[dbKey]?.recycledConnections ?? 0;
    console.log(
      `       (saneada al adquirirla ${recycledCount === 0 ? "con reset de TDS" : `tirandola: ${recycledCount} reciclada(s)`})`
    );
  }

  // ── 1b. Y una ESCRITURA sobre una conexion envenenada no se queda a medio commitear ──
  //
  // Esta es la cara peligrosa de la herencia, y la que solo cura el saneado al adquirir.
  // Una lectura se salva sola: su propio ROLLBACK deshace TODO el @@TRANCOUNT, heredado
  // incluido. Una escritura no: hace BEGIN sobre el 1 que hereda, COMMIT lo baja a 1 otra
  // vez, y la conexion vuelve al pool igual de envenenada... con el dato dentro de una
  // transaccion ajena que nadie va a commitear. La llamada dice "committed:true" y el dato
  // no es durable.
  {
    const { spid } = await poisonOnePooledConnection();
    const w = await write({
      query: "INSERT INTO dbo.Rows (Id, Tag) VALUES (99, 'z')",
    });
    check(
      "la escritura sobre la conexion envenenada dice que ha commiteado",
      w.structuredContent.committed === true
    );
    check(
      "y lo ha hecho de verdad: la conexion NO queda dentro de una transaccion ajena",
      (await openTransactionsOn(spid)) === 0,
      `la sesion ${spid} sigue con open_transaction_count=${await openTransactionsOn(spid)}: ` +
        "el INSERT esta dentro de una transaccion que nadie va a cerrar"
    );
    const orphans = await orphanSessions(master);
    check(
      "ninguna sesion de este proceso queda con transaccion abierta tras la escritura",
      orphans.length === 0,
      JSON.stringify(orphans)
    );
    // El dato tiene que ser visible desde OTRA sesion, que es la prueba de que se commiteo
    // de verdad y no se quedo dentro de la transaccion heredada. Con LOCK_TIMEOUT corto: si
    // el INSERT sigue sin commitear, su lock exclusivo bloquearia esta lectura en lugar de
    // devolver 0, y lo que queremos es una respuesta, no una espera.
    let seen = null;
    try {
      seen = (
        await master
          .request()
          .query(
            `SET LOCK_TIMEOUT 2000; SELECT COUNT(*) AS c FROM [${TEST_DB}].dbo.Rows WHERE Id = 99`
          )
      ).recordset[0].c;
    } catch (err) {
      seen = `bloqueado (${err.message})`;
    }
    check(
      "y el dato se ve desde otra sesion: el commit fue real",
      seen === 1,
      `filas visibles: ${seen}`
    );
    await write({ query: "DELETE FROM dbo.Rows WHERE Id = 99" });
  }

  // ── 2. Lectura que revienta por timeout: sin transacciones huerfanas ────────────
  {
    let message = "";
    try {
      await read({
        query: "WAITFOR DELAY '00:00:20'; SELECT 1 AS x",
        limit: 10,
        offset: 0,
        timeoutMs: 1000,
      });
    } catch (err) {
      message = err.message;
    }
    check(
      "timeoutMs por llamada corta la lectura (y no la deja correr los 20 s)",
      /timeout/i.test(message),
      message
    );
    // Al servidor le puede quedar un instante deshacer la transaccion tras el cierre.
    await new Promise((r) => setTimeout(r, 750));
    const orphans = await orphanSessions(master);
    check(
      "tras la lectura con timeout no queda NINGUNA sesion con open_transaction_count > 0",
      orphans.length === 0,
      JSON.stringify(orphans)
    );
  }

  // ── 3. Lectura abortada a media: el camino del AbortSignal del cliente MCP ──────
  {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    let message = "";
    try {
      await tool("execute_read_query").handler(
        {
          query: "WAITFOR DELAY '00:00:15'; SELECT 1 AS x",
          limit: 10,
          offset: 0,
        },
        { signal: controller.signal }
      );
    } catch (err) {
      message = err.message;
    }
    check(
      "una lectura abortada termina en error, no se queda colgada",
      message !== "",
      message
    );
    await new Promise((r) => setTimeout(r, 750));
    const orphans = await orphanSessions(master);
    check(
      "tras la lectura abortada tampoco queda ninguna transaccion huerfana",
      orphans.length === 0,
      JSON.stringify(orphans)
    );
  }

  // ── 4. Escritura de varias sentencias que falla a media tanda ──────────────────
  {
    // Tres DELETE: las dos primeras validas, la tercera contra una tabla que no existe.
    // Es el caso medido, con el fallo forzado en la tercera en lugar de por timeout.
    const query = [
      "DELETE FROM dbo.Rows WHERE Id = 1",
      "GO",
      "DELETE FROM dbo.Rows WHERE Id = 2",
      "GO",
      "DELETE FROM dbo.NoExisteEstaTabla WHERE Id = 3",
    ].join("\n");

    let err = null;
    try {
      await write({ query });
    } catch (e) {
      err = e;
    }
    check("la escritura falla", err !== null);
    check(
      "el error dice en que sentencia fallo y cuantas habia",
      err && /Statement 3 of 3 failed/.test(err.message),
      err?.message
    );
    check(
      "el error dice que NO se aplico nada, en lugar de devolver solo el fallo",
      err && /rolled back: nothing was applied/i.test(err.message),
      err?.message
    );
    check(
      "y enumera las sentencias que se habian ejecutado antes del fallo",
      err && Array.isArray(err.applied) && err.applied.length === 2,
      JSON.stringify(err?.applied)
    );

    const check3 = await read({
      query: "SELECT COUNT(*) AS c FROM dbo.Rows",
      limit: 10,
      offset: 0,
    });
    check(
      "las tres filas siguen ahi: la tanda fue todo-o-nada de verdad",
      check3.structuredContent.recordset[0].c === 3,
      `quedan ${check3.structuredContent.recordset[0].c} filas`
    );

    // Y el opt-out sigue siendo autocommit, con el aviso correspondiente.
    let optOutErr = null;
    try {
      await write({ query, transactional: false });
    } catch (e) {
      optOutErr = e;
    }
    check(
      "con transactional:false el error dice exactamente que se quedo COMMITEADO",
      optOutErr && /already COMMITTED/.test(optOutErr.message),
      optOutErr?.message
    );
    const left = await read({
      query: "SELECT COUNT(*) AS c FROM dbo.Rows",
      limit: 10,
      offset: 0,
    });
    check(
      "y en ese modo si se aplico la parte que decia el error",
      left.structuredContent.recordset[0].c === 1,
      `quedan ${left.structuredContent.recordset[0].c} filas`
    );
    await write({
      query: "INSERT INTO dbo.Rows (Id, Tag) VALUES (1,'a'), (2,'b')",
    });
  }

  // ── 5. Veinte lecturas seguidas, ninguna por herencia de conexion ──────────────
  {
    const errors = [];
    for (let i = 0; i < 20; i++) {
      try {
        const r = await read({
          query: `SELECT ${i} AS i, COUNT(*) AS c FROM dbo.Rows`,
          limit: 10,
          offset: 0,
        });
        if (r.structuredContent.recordset[0].c !== 3) {
          errors.push(`#${i}: ${r.structuredContent.recordset[0].c} filas`);
        }
      } catch (err) {
        errors.push(`#${i}: ${err.message}`);
      }
    }
    check(
      "20 lecturas seguidas y ninguna falla",
      errors.length === 0,
      errors.join(" | ")
    );
    const orphans = await orphanSessions(master);
    check(
      "y el pool no ha dejado ninguna transaccion abierta por el camino",
      orphans.length === 0,
      JSON.stringify(orphans)
    );
    console.log(
      `       (conexiones recicladas en toda la sesion: ${getConnectionStatus()[dbKey]?.recycledConnections ?? 0})`
    );
  }

  await master.close();
}

async function main() {
  let ok = false;
  try {
    await bootstrap();
    await run();
    ok = fail === 0;
  } catch (err) {
    console.error("Repro error:", err);
    fail++;
    failures.push(`fatal: ${err.message}`);
  } finally {
    await teardown();
  }

  console.log(`\n=== Pool poisoning repro: ${pass} pass / ${fail} fail ===`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log("  -", f);
  }
  process.exit(ok ? 0 : 1);
}

main();
