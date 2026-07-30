# AHORA-SQL-MCP

Servidor MCP de SQL Server para los proyectos **Flexygo** y **AHORA_ERP**. Da a Claude Code
acceso al esquema real de la base de datos para que las skills de
[AHORA-SCO-SKILLS](https://github.com/AHORAFLX/AHORA-SCO-SKILLS) puedan verificar tablas,
columnas, vistas y procedimientos **antes** de generar T-SQL, en lugar de suponerlos.

> **Este repositorio no se instala a mano.** Usa la skill `setup-mcp-sql` del repositorio de
> skills: clona este repo, ejecuta `npm ci` y genera el `.mcp.json` del proyecto.

La referencia técnica completa del servidor (catálogo de las 12 herramientas, resources, prompts,
variables de entorno, modelo de seguridad, test de integración) está en
**[docs/REFERENCE.md](docs/REFERENCE.md)**. Este documento cubre la instalación y la
configuración en proyectos de AHORA.

---

## Instalación

Requiere Node 18 o superior.

```bash
git clone --branch v1.0.0 --depth 1 https://github.com/AHORAFLX/AHORA-SQL-MCP.git
cd AHORA-SQL-MCP
npm ci
```

**Usa `npm ci`, nunca `npm install`.** `npm ci` respeta el `package-lock.json` commiteado, que es
lo que garantiza hashes de integridad y el mismo árbol de dependencias en las 60 máquinas.
`npm install` puede actualizar transitivas silenciosamente y rompe esa garantía.

---

## Configuración: el `.mcp.json` del proyecto

El servidor **debe llamarse exactamente `mssql`**. Ese nombre determina que las herramientas se
expongan como `mcp__mssql__*`, y las skills de SC0 dependen de esos nombres. Renombrarlo no
produce ningún error: simplemente las skills dejan de encontrar la base de datos y vuelven a
generar SQL sin verificar, que es el peor modo de fallo posible.

### Una sola base de datos (solo lectura)

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": [
        "<RUTA>/AHORA-SQL-MCP/bin/start-mssql-mcp.js",
        "--config-file", "<RUTA_PROYECTO>/Web.config",
        "--connection-name", "DataConnectionString"
      ]
    }
  }
}
```

### Flexygo: base de datos de configuración y de datos

Flexygo necesita las dos a la vez — `Objects`, `Objects_Properties`, `Objects_Views` y `Modules`
viven en la de configuración; las tablas de negocio en la de datos. Con alias, todas las
herramientas aceptan un parámetro `dbKey` para elegir (`config` o `data`).

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": [
        "<RUTA>/AHORA-SQL-MCP/bin/start-mssql-mcp.js",
        "--config-file", "<RUTA_PROYECTO>/Web.config",
        "--connection-name", "ConfigDatabaseName:config",
        "--connection-name", "DataConnectionString:data"
      ]
    }
  }
}
```

### Instancias nombradas (SQL Server local)

El wrapper interpreta el `Data Source` de la cadena de conexión en todos sus formatos:
`10.0.0.9`, `PC_158\PC_158`, `PC_158,1433`, `(local)`, `.` y el prefijo `tcp:`. Si detecta una
instancia nombrada, la pasa como `instanceName` y no hace falta configurar nada más.

**Pero resolver una instancia por nombre exige que el servicio SQL Browser esté arrancado**, que
es quien traduce el nombre de instancia a su puerto. Suele estar parado. Si lo está, la conexión
agota el tiempo de espera y el wrapper te lo avisa al arrancar.

La salida es indicar el puerto:

```json
"args": [
  "<RUTA>/AHORA-SQL-MCP/bin/start-mssql-mcp.js",
  "--config-file", "<RUTA_PROYECTO>/Web.config",
  "--connection-name", "ConfConnectionString",
  "--port", "1433"
]
```

`--port` y la instancia nombrada son **excluyentes** — tedious no admite las dos a la vez, así
que al fijar puerto se descarta la instancia. Para saber en qué puerto escucha una instancia:

```powershell
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.<INSTANCIA>\MSSQLServer\SuperSocketNetLib\Tcp\IPAll' | Select-Object TcpPort, TcpDynamicPorts
```

Si `TcpDynamicPorts` tiene valor y `TcpPort` está vacío, el puerto cambia en cada reinicio: ahí
la única opción estable es arrancar SQL Browser.

### Escritura: solo local o pruebas

Añade `--allow-writes` como último argumento. Sin ese flag el servidor arranca en solo lectura.

El wrapper escribe en stderr, al arrancar, el modo activo y las bases de datos resueltas. Si en
el log del MCP no ves ese bloque, no está arrancando el wrapper.

El `.mcp.json` solo contiene rutas, nunca credenciales: por eso se puede commitear en el
repositorio del proyecto. Las credenciales se leen del `Web.config` en tiempo de arranque.

### Ejecutar ficheros `.sql`

`execute_sql_file` recibe una **ruta** y ejecuta el script, el equivalente a `sqlcmd -i fichero.sql`.
Es la vía para desplegar un stored procedure: no tiene el tope de 10.000 caracteres de
`execute_write_query`, entiende los separadores `GO`, y evita que el modelo tenga que volver a
teclear el T-SQL a mano.

Por defecto solo puede leer ficheros **dentro de la carpeta del proyecto** — el directorio de
trabajo del servidor MCP, que es la raíz del proyecto cuando lo arranca Claude Code desde el
`.mcp.json`. Para un `.sql` que vive fuera, por ejemplo en el repositorio de skills, hay que
autorizar la carpeta de forma explícita:

```json
"args": [
  "<RUTA>/AHORA-SQL-MCP/bin/start-mssql-mcp.js",
  "--config-file", "<RUTA_PROYECTO>/Web.config",
  "--connection-name", "DataConnectionString",
  "--allow-sql-dir", "C:/Codigo GIT/skills",
  "--allow-writes"
]
```

`--allow-sql-dir` es repetible. El wrapper imprime al arrancar la carpeta del proyecto y las
carpetas extra, porque la raíz por defecto depende de dónde se arranque el servidor.

Ejecutar de verdad exige `--allow-writes`. Sin ese flag el tool sigue disponible con
`dryRun: true`, que lee el fichero, lo trocea por `GO` y devuelve los batches con su línea de
inicio sin ejecutar nada — útil para revisar un script antes de lanzarlo.

---

## Decisiones de diseño

| Decisión | Motivo |
|---|---|
| El proceso **no carga `.env`** | Un `.env` suelto en el directorio de trabajo podría definir `MSSQL_ENABLE_WRITES` y habilitar escrituras sin que nadie lo pidiera. La configuración entra solo por el entorno que prepara el wrapper. |
| **Solo transporte stdio**, sin transporte HTTP | No lo usamos. Menos superficie de ataque y menos código que mantener. |
| **`bin/start-mssql-mcp.js` como única vía de arranque** | Resuelve la conexión desde el `Web.config` del proyecto, sanea el entorno y decide el modo de acceso. Mantiene las credenciales fuera del `.mcp.json`. |
| Paquete `@ahoraflx/sql-mcp` con `private: true` | Es de uso interno; `private` impide publicarlo por error en el registro público. |

`express` y `express-rate-limit` siguen en el árbol de dependencias: los arrastra
`@modelcontextprotocol/sdk`, no nuestro código. En modo stdio no se ejecutan.

---

## Límites — léelo antes de confiar en el modo solo lectura

**El modo solo lectura es una barrera de ergonomía, no una garantía de seguridad.**

Las lecturas se ejecutan dentro de una transacción que siempre se revierte, lo que protege
frente a escrituras accidentales: un `SELECT INTO`, un `INSERT` colado tras un comentario. Pero
un `COMMIT TRANSACTION` explícito dentro de la consulta cierra esa transacción, y lo que venga
después se ejecuta en autocommit y persiste. No hay lista negra de palabras clave, y es
deliberado: son triviales de evitar y dan una falsa sensación de seguridad.

**La única frontera real son los permisos del login de SQL Server.** Para que "producción no se
escribe" sea una política y no una expectativa, hace falta un login dedicado con `db_datareader`
en los servidores de producción. Mientras eso no exista, la garantía depende de que cada
desarrollador configure bien su `.mcp.json`.

### Limitaciones conocidas

- **No soporta autenticación integrada de Windows.** La cadena de conexión tiene que llevar
  usuario y contraseña; los proyectos con `Integrated Security=True` no arrancan. Es la
  limitación más probable de encontrarse en desarrollo local, y no es fácil de resolver: tedious
  no puede usar el token de Windows del proceso, solo NTLM con credenciales explícitas.
- **Las instancias nombradas necesitan SQL Browser arrancado**, o indicar `--port`. Ver arriba.
- **`trustServerCertificate` vale `true` por defecto**: acepta cualquier certificado de servidor.
- **`describe_table` y `list_indexes` no aceptan nombres de tres partes.** El esquema Zod
  restringe los identificadores a `Tabla` o `esquema.Tabla`. Para consultas entre bases de datos
  hay que usar `execute_read_query` con SQL crudo, o el `dbKey` correspondiente.
- **`resources/list` enumera todas las tablas base de cada `dbKey`** (tope de 500 por BD). En
  AHORA_ERP eso es mucha respuesta; conviene que las skills usen `list_tables` con paginación en
  lugar de los resources.
- **`execute_read_query` devuelve 100 filas por defecto** (máximo 1000). Si una skill necesita
  más, tiene que paginar con `offset`.
- **`execute_sql_file` ejecuta todo el script en una sola transacción.** No es solo por
  atomicidad: un `Request` creado sobre el pool coge y suelta conexión en cada batch, así que sin
  transacción los batches irían a conexiones distintas y se rompería la semántica de `GO` (el
  `SET ANSI_NULLS ON` no aplicaría al `CREATE PROCEDURE` siguiente, y una `#tmp` del primer batch
  no existiría en el segundo). Consecuencia: **las sentencias que no admiten transacción no son
  soportadas** — `CREATE`/`ALTER DATABASE`, `BACKUP`, `CREATE FULLTEXT INDEX`.
- **`execute_sql_file` rechaza un `USE` al principio de un batch.** Cambiaría la base de datos de
  una conexión que después vuelve al pool y contaminaría llamadas posteriores. La base de datos se
  elige con `dbKey`.
- **Los `SET` del script sobreviven en la conexión.** Antes del commit se restauran los valores por
  defecto de tedious (`ANSI_NULLS`, `QUOTED_IDENTIFIER` y compañía), pero es un repaso pragmático,
  no un reset de conexión: un `SET` menos habitual puede quedar activo en esa conexión del pool.
- **Los `.sql` deben llevar BOM si no son UTF-8.** SSMS guarda en UTF-16LE con BOM, que se detecta
  y decodifica bien. Un UTF-16 **sin** BOM se rechaza con un error claro en lugar de mandar texto
  con NUL al servidor. Tope de tamaño: 2 MB, y 500 batches por fichero.

---

## Desarrollo

```bash
npm test              # tests unitarios, sin base de datos
npm run integration   # requiere una BD real; ver docs/REFERENCE.md
```

Al subir versión, **comprueba que los nombres de las herramientas no han cambiado**: si cambian,
hay que actualizar las skills de SC0 en el mismo momento.

## Licencia

MIT — ver [LICENSE](LICENSE). El aviso de copyright incluye a Mihai-Nicolae Dulgheru porque parte
del código del servidor procede de su proyecto `mssql-mcp-node`, también MIT. La licencia obliga a
conservar ese aviso: **no lo borres del fichero LICENSE.**
