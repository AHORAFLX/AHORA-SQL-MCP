# AHORA-SQL-MCP

Servidor MCP de SQL Server para los proyectos **Flexygo** y **AHORA_ERP**. Da a Claude Code
acceso al esquema real de la base de datos para que las skills de
[AHORA-SCO-SKILLS](https://github.com/AHORAFLX/AHORA-SCO-SKILLS) puedan verificar tablas,
columnas, vistas y procedimientos **antes** de generar T-SQL, en lugar de suponerlos.

> **¿Vienes a instalarlo por primera vez?** → **[INSTALAR.md](INSTALAR.md)**, guía de cinco minutos
> con el `.mcp.json` listo para copiar. O deja que el instalador guiado escriba la configuración por
> ti, validando la conexión antes:
>
> ```bash
> npx --yes --package=github:AHORAFLX/AHORA-SQL-MCP#v1.5.0 ahora-setup
> ```

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
git clone --branch v1.5.0 --depth 1 https://github.com/AHORAFLX/AHORA-SQL-MCP.git
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

Hay que elegir **una** fuente de conexión de las cinco: `--config-file` (Web.config de
Framework o `appsettings.json` de Core), `--connection-string`, los datos sueltos
(`--server/--database/--user/--password`), `--from-env` o `--credentials-file`. Mezclarlas es un
error de arranque, no hay precedencia que adivinar.

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

Con una sola conexión la clave es siempre `maindb`, aunque pases alias; el wrapper lo avisa al
arrancar en vez de ignorarlo en silencio.

### Flexygo migrado a .NET Core: `appsettings.json`

Mismo `--connection-name`, solo cambia el `--config-file`. Puedes apuntar al fichero o
directamente a la carpeta que lo contiene (normalmente `conf`):

```json
"args": [
  "<RUTA>/AHORA-SQL-MCP/bin/start-mssql-mcp.js",
  "--config-file", "<RUTA_PROYECTO>/Backend/conf",
  "--connection-name", "ConfConnectionString:config",
  "--connection-name", "DataConnectionString:data"
]
```

**Lo que hay que saber de Core:** en `appsettings.json` las cadenas suelen estar declaradas pero
**vacías**, y las reales viven en `appsettings.Development.json`. El wrapper aplica la misma
superposición que ASP.NET Core — `appsettings.<entorno>.json` gana sobre `appsettings.json` — y
trata una cadena vacía como ausente, así que sigue buscando. El entorno sale de `--environment`,
o de `ASPNETCORE_ENVIRONMENT`, o es `Development`. Si tu entorno se llama de otra forma:

```json
"--environment", "Local"
```

El banner de arranque dice de qué fichero salió cada cadena, y si no encuentra el nombre te lista
los que sí existen.

### Sin fichero de configuración

Para apuntar a una base de datos suelta, sin Web.config ni appsettings. Tres formas:

```json
"--connection-string", "Data Source=PC_158\\SQL2022;Initial Catalog=MiBD;User ID=sa;Password=x"
```

```json
"--server", "PC_158\\SQL2022", "--database", "MiBD", "--user", "sa", "--password", "x"
```

Las dos dejan la contraseña en el `.mcp.json` y en el listado de procesos, y el wrapper lo avisa
al arrancar. Si eso importa — y en un `.mcp.json` que se commitea importa — la tercera forma la
saca de ahí:

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["<RUTA>/AHORA-SQL-MCP/bin/start-mssql-mcp.js", "--from-env"],
      "env": {
        "MSSQL_SERVER": "PC_158\\SQL2022",
        "MSSQL_DATABASE": "MiBD",
        "MSSQL_USER": "sa",
        "MSSQL_PASSWORD": "x"
      }
    }
  }
}
```

`--from-env` es la única excepción al saneado del entorno: deja pasar las `MSSQL_*` de conexión
porque son justo lo que el cliente aporta. Las dos variables de política —
`MSSQL_ENABLE_WRITES` y `MSSQL_SQL_DIRS` — se sobrescriben igualmente, así que ni con
`--from-env` puede el entorno habilitar escrituras. Para multi-BD, usa las
`MSSQL_<ALIAS>_DATABASE` de siempre.

Con varias `--connection-string` cada una necesita su `--alias` en el mismo orden:

```json
"--connection-string", "<cadena conf>", "--alias", "config",
"--connection-string", "<cadena datos>", "--alias", "data"
```

### Instancias nombradas (SQL Server local)

El wrapper lee el `Data Source` **tal como esté escrito**, en cualquiera de sus formas, para no
perder un puerto que el propio fichero ya trae:

| Forma | Ejemplo |
|---|---|
| host | `10.0.0.9` |
| host\instancia | `PC_158\SQL2022` |
| host,puerto | `PC_158,1433` |
| host\instancia,puerto | `PC_158\SQL2022,1435` |
| host,puerto\instancia | `192.168.9.26,1433\AHORA_R` |
| separador `;` o `:` | `PC_158;1435`, `PC_158:1435` |
| IPv6 entre corchetes | `[::1],1433` |
| alias locales | `.`, `.\SQL2022`, `(local)`, `(local)\SQL2022` |
| comillas y espacios | `"PC_158\SQL2022"` |
| prefijos de protocolo | `tcp:`, `np:`, `lpc:`, `admin:` |

El puerto también se recoge si viene en su propia clave (`Port=1435`) o suelto tras un `;`. Y el
servidor se acepta bajo cualquiera de sus alias: `Data Source`, `Server`, `Address`, `Addr`,
`Network Address`.

Dos normalizaciones que evitan depender del SQL Browser sin necesidad: `HOST\MSSQLSERVER` es la
instancia **por defecto**, así que se descarta el nombre; y `np:` (canalizaciones nombradas) y
`lpc:` (memoria compartida) **se rechazan con un mensaje claro**, porque tedious es solo TCP y
tratarlos como TCP acaba en un tiempo de espera que no explica nada.

Si detecta una instancia nombrada y no hay puerto, la pasa como `instanceName`.

**Pero resolver una instancia por nombre exige que el servicio SQL Browser esté arrancado**, que
es quien traduce el nombre de instancia a su puerto. Suele estar parado. Si lo está, la conexión
agota el tiempo de espera y el wrapper te lo avisa al arrancar.

**Y hay una segunda causa del mismo síntoma: el protocolo TCP/IP desactivado en esa instancia.**
En máquinas de desarrollo con varias instancias es habitual que solo una tenga TCP habilitado.
Cuidado con el diagnóstico: **que SSMS conecte no descarta ninguna de las dos.** Para instancias
locales SSMS usa memoria compartida, mientras que tedious —el driver de este servidor— es solo TCP.
Compruébalo en SQL Server Configuration Manager, en Protocolos de `<INSTANCIA>` → TCP/IP.

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
