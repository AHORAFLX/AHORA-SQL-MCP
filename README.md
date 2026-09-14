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
> npx --yes --package=github:AHORAFLX/AHORA-SQL-MCP#v1.14.0 ahora-setup
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
git clone --branch v1.14.0 --depth 1 https://github.com/AHORAFLX/AHORA-SQL-MCP.git
cd AHORA-SQL-MCP
npm ci
npm run build
```

**Usa `npm ci`, nunca `npm install`.** `npm ci` respeta el `package-lock.json` commiteado, que es
lo que garantiza hashes de integridad y el mismo árbol de dependencias en las 60 máquinas.
`npm install` puede actualizar transitivas silenciosamente y rompe esa garantía.

`npm run build` genera `bundle/`, que es **lo que se ejecuta de verdad**: los tres binarios del
paquete (`start-mssql-mcp`, `ahora-sql-mcp` y `ahora-setup`) salen de ahí, con todas sus
dependencias dentro de cada fichero. Por eso el paquete publicado no declara ninguna dependencia
de ejecución y su instalación no resuelve ningún árbol — eran 166 paquetes y 88 segundos con la
caché en frío, más de lo que el cliente MCP espera. Ver
[por qué esto no puede tardar](#por-qué-esto-no-puede-tardar).

> **Si tocas `src/`, `bin/` o `installer/`, vuelve a ejecutar `npm run build`.** Los tests corren
> contra las fuentes, así que pueden pasar con un `bundle/` viejo. `npm run verify:bundle` arranca
> el paquete construido en una carpeta sin `node_modules` y le habla MCP de verdad: comprueba que
> contesta al `initialize`, que expone las 12 tools con sus nombres y que el driver `mssql` se
> resuelve desde dentro del paquete.

```bash
npm run verify:bundle
```

---

## Configuración: el `.mcp.json` del proyecto

El servidor **debe llamarse exactamente `ahora-sql`**. Ese nombre determina que las herramientas
se expongan como `mcp__ahora-sql__*`; ponerle otro no produce ningún error, simplemente deja de
coincidir con las reglas de permisos que escribe el instalador y con lo que documentan las skills
de SC0.

> **Antes se llamaba `mssql`.** Ese nombre chocaba con la extensión nativa de SQL Server
> de VS Code (`ms-mssql.mssql`), que registra sus propias herramientas de Copilot llamadas
> `mssql_list_databases`, `mssql_list_tables`, `mssql_list_views`, `mssql_run_query`… VS Code
> cualifica las herramientas de un servidor MCP con el nombre del servidor, así que nuestras
> `list_databases` / `list_tables` / `list_views` producían **exactamente los mismos
> identificadores** que las suyas, y el resto quedaba mezclado en un grupo «mssql»
> indistinguible en el selector de herramientas.
>
> El instalador migra solo: al reinstalar retira la entrada `mssql` **si es nuestra** (deja
> intacta cualquier otra) y reescribe las reglas `mcp__mssql__*` de `settings.local.json` con el
> nombre nuevo. Si tienes un `.mcp.json` escrito a mano, renombra la clave.

Hay que elegir **una** fuente de conexión de las cinco: `--config-file` (Web.config de
Framework o `appsettings.json` de Core), `--connection-string`, los datos sueltos
(`--server/--database/--user/--password`), `--from-env` o `--credentials-file`. Mezclarlas es un
error de arranque, no hay precedencia que adivinar.

> **De dónde sale `<RUTA>`.** De un clon del repositorio con `npm run build` hecho, o de la
> instalación que hace el instalador guiado, que en Windows deja el servidor en
> `%LOCALAPPDATA%\AHORA-SQL-MCP\node_modules\@ahoraflx\sql-mcp`. En los dos casos el binario es
> `bundle/start-mssql-mcp.cjs`.
>
> Lo que **no** hay que poner es `"command": "npx"` con `--package=github:…`. Medido: **95 s**
> hasta el `initialize` con la caché de npm vacía, y con la caché caliente tres tomas de 8,5 s,
> 11 s y **75,8 s** — `npx` vuelve a resolver la referencia contra GitHub en cada arranque, así
> que ni estando caliente es fiable. El cliente MCP descarta el servidor a los 30 s y el agente se
> queda sin herramientas. Apuntar al binario directamente cuesta **254-283 ms**. Ver
> [por qué esto no puede tardar](#por-qué-esto-no-puede-tardar).

### Una sola base de datos (solo lectura)

```json
{
  "mcpServers": {
    "ahora-sql": {
      "command": "node",
      "args": [
        "<RUTA>/AHORA-SQL-MCP/bundle/start-mssql-mcp.cjs",
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
    "ahora-sql": {
      "command": "node",
      "args": [
        "<RUTA>/AHORA-SQL-MCP/bundle/start-mssql-mcp.cjs",
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

**No hay límite de dos.** `--connection-name` es repetible tantas veces como haga falta, y el
instalador (formulario y terminal) deja marcar todas las cadenas del fichero, cada una con su
alias. `config` y `data` son solo los alias que esperan las skills de SC0 en un Flexygo típico.
El alias acaba dentro de un nombre de variable de entorno (`MSSQL_<ALIAS>_DATABASE`), así que
solo admite letras, dígitos y guion bajo, empezando por letra.

### Flexygo migrado a .NET Core: `appsettings.json`

Mismo `--connection-name`, solo cambia el `--config-file`. Puedes apuntar al fichero o
directamente a la carpeta que lo contiene (normalmente `conf`):

```json
"args": [
  "<RUTA>/AHORA-SQL-MCP/bundle/start-mssql-mcp.cjs",
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
    "ahora-sql": {
      "command": "node",
      "args": ["<RUTA>/AHORA-SQL-MCP/bundle/start-mssql-mcp.cjs", "--from-env"],
      "env": {
        "MSSQL_SERVER": "PC_158",
        "MSSQL_INSTANCE_NAME": "SQL2022",
        "MSSQL_DATABASE": "MiBD",
        "MSSQL_USER": "sa",
        "MSSQL_PASSWORD": "x"
      }
    }
  }
}
```

⚠️ **Con `--from-env` la instancia va en `MSSQL_INSTANCE_NAME`, nunca dentro de `MSSQL_SERVER`.**
Es la única fuente que **no pasa por el parser del `Data Source`**: las `MSSQL_*` se copian tal cual
al servidor, así que un `"MSSQL_SERVER": "PC_158\\SQL2022"` llega al driver como nombre de host
literal y falla con un `ESOCKET` que no dice nada de la barra invertida. Puesto en
`MSSQL_INSTANCE_NAME`, en cambio, sí sirve: el descubrimiento del puerto lo hace el servidor sobre la
configuración final, así que también alcanza a `--from-env`. `MSSQL_PORT` y `MSSQL_INSTANCE_NAME` no
pueden ir los dos a la vez, que es un error de arranque.

`--from-env` es la única excepción al saneado del entorno: deja pasar las `MSSQL_*` de conexión
porque son justo lo que el cliente aporta. Las variables de política —
`MSSQL_ENABLE_WRITES`, cada `MSSQL_<ALIAS>_ENABLE_WRITES` y `MSSQL_SQL_DIRS` — se sobrescriben
igualmente, así que ni con `--from-env` puede el entorno habilitar escrituras, ni globales ni de
una base de datos concreta. Para multi-BD, usa las `MSSQL_<ALIAS>_DATABASE` de siempre.

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

**Si la instancia es de esta misma máquina, el servidor averigua el puerto él solo.** Le pregunta al
sistema en qué puerto escucha esa instancia —localiza el proceso del servicio y mira sus puertos a la
escucha— y conecta por ahí. No necesita permisos de administrador, ni el servicio SQL Browser, ni que
nadie fije un puerto.

Tres detalles que hacen que esto aguante en cualquier máquina:

- **Se resuelve en el primer uso de esa conexión**, no al arrancar, y no se escribe en la
  configuración. Por eso funciona aunque el puerto sea **dinámico** y cambie en cada reinicio — y si
  cambia con el servidor ya en marcha, se vuelve a averiguar sin reiniciar nada (ver
  [Cuando el puerto cambia a mitad de sesión](#cuando-el-puerto-cambia-a-mitad-de-sesión)).
- Si la instancia **solo escucha en la loopback**, conecta por `127.0.0.1` o `[::1]` en lugar de por
  el nombre del equipo. Es un caso real, y es el que hace fracasar un `--port` a secas: el puerto es
  correcto pero en la IPv4 del equipo no escucha nadie.
- Si hay un **puerto estático** fijado en el registro, gana ese: es el que un administrador ha puesto
  a propósito.

El banner de arranque dice qué conexiones lo harán, y el servidor lo dice cuando lo hace:

```
[data] instancia local SQL2022: el puerto se averigua en el primer uso, no aqui
[data] instancia SQL2022 resuelta: ::1,59212  (solo escucha en loopback)
```

Queda sin resolver solo si esa instancia **no tiene TCP/IP a la escucha en absoluto** (protocolo
desactivado), porque entonces no hay ningún puerto que descubrir.

#### Por qué esto no retrasa el arranque

Preguntar al sistema cuesta un arranque de PowerShell más dos consultas CIM: **3,5-4,5 segundos**
medidos. Ese tiempo se pagaba **antes** de levantar el servidor MCP, así que se lo comía el cliente
esperando el saludo `initialize`. Su límite son 30 segundos por defecto (`MCP_TIMEOUT`), y al agotarse
**descarta el servidor entero**: las tools no llegaban a aparecer. Con varios MCP arrancando a la vez
ese presupuesto se agota antes de lo que parece, y era la causa principal del "a veces hay que
reiniciar el MCP" — reiniciar caía dentro del minuto de caché del sondeo, y entonces sí.

Ahora el sondeo **no está en el camino del saludo**. El servidor registra sus tools y contesta
`initialize` sin haber preguntado nada; el sondeo lo paga la primera tool que use esa conexión, una
vez por proceso. Medido en la misma máquina y en frío:

| | Antes | Ahora |
|---|---|---|
| `initialize` + `tools/list` | 4.594 ms | **254 - 283 ms** |
| primera tool de esa conexión | 8 ms | 3.535 ms |
| siguientes | 8 ms | 8 ms |

Los 638 ms que figuraban aquí eran de cuando el sondeo ya se había sacado del arranque pero el
servidor seguía cargando `mssql` y descifrando credenciales antes de contestar. Quitadas esas dos
cosas, la cifra baja a los 254-283 ms de la tabla.

Y siguen en pie las precauciones que abaratan el sondeo:

- **Una sola consulta para todas las conexiones.** El coste es el mismo con una conexión que con
  cinco, porque las consultas caras se hacen una vez y se reparten entre las instancias.
- **Una caché de 60 segundos** en el directorio temporal, compartida por todos los MCP del usuario.
  Evita que varios servidores que arrancan seguidos repitan el mismo sondeo. Es corta a propósito:
  un reinicio del servicio SQL con puerto dinámico se nota enseguida.
- **Con `--port` no se pregunta**, porque el puerto ya lo has dicho tú.

#### Cuando el puerto cambia a mitad de sesión

Un puerto dinámico cambia **cada vez que arranca el servicio SQL**, y eso puede pasar con el servidor
MCP ya en marcha: al reiniciar el servicio, al despertar el portátil, al reconectar la VPN. El puerto
que se averiguó deja de llevar a ninguna parte y las tools empiezan a fallar con `ECONNRESET` o
`ESOCKET`.

**Eso ya no obliga a reiniciar el MCP.** Cuando un pool que funcionaba se rompe, el servidor lo tira,
descarta el puerto que estaba usando y lo vuelve a averiguar en el intento siguiente, saltándose la
caché. En la práctica: **vuelve a lanzar la misma tool** y a la segunda funciona. Si falla de forma
repetida ya no es esto, y toca mirar el servicio o fijar el puerto con `--port`.

**Para un servidor remoto** no se puede preguntar al sistema, así que ahí resolver una instancia por
nombre sí **exige que el servicio SQL Browser esté arrancado**. Si está parado, la conexión agota el
tiempo de espera y el wrapper te lo avisa al arrancar.

**Y hay una segunda causa del mismo síntoma: el protocolo TCP/IP desactivado en esa instancia.**
En máquinas de desarrollo con varias instancias es habitual que solo una tenga TCP habilitado.
Cuidado con el diagnóstico: **que SSMS conecte no descarta ninguna de las dos.** Para instancias
locales SSMS usa memoria compartida, mientras que tedious —el driver de este servidor— es solo TCP.
Compruébalo en SQL Server Configuration Manager, en Protocolos de `<INSTANCIA>` → TCP/IP.

La salida es indicar el puerto:

```json
"args": [
  "<RUTA>/AHORA-SQL-MCP/bundle/start-mssql-mcp.cjs",
  "--config-file", "<RUTA_PROYECTO>/Web.config",
  "--connection-name", "ConfConnectionString",
  "--port", "1433"
]
```

**Si cada base de datos vive en una instancia distinta**, un único `--port` no sirve: usa la forma
`alias:puerto`, que es repetible y se puede combinar con un valor general.

```json
"--connection-name", "ConfConnectionString:config",
"--connection-name", "DataConnectionString:data",
"--port", "config:1433",
"--port", "data:1435"
```

Con una sola conexión el alias es `maindb`, así que `--port maindb:1433` también vale.

`--port` y la instancia nombrada son **excluyentes** — tedious no admite las dos a la vez, así
que al fijar puerto se descarta la instancia. Y como el puerto ya lo has dicho tú, con `--port`
**no se pregunta al sistema**: se ahorran los ~4 segundos del sondeo en la primera tool. Lo que se
pierde a cambio es detectar que la instancia solo escucha en la loopback, así que si la conexión falla
con el puerto correcto, pon `127.0.0.1` como servidor en lugar del nombre del equipo. El banner lo
recuerda.

Para saber en qué puerto escucha una instancia:

```powershell
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.<INSTANCIA>\MSSQLServer\SuperSocketNetLib\Tcp\IPAll' | Select-Object TcpPort, TcpDynamicPorts
```

Si `TcpDynamicPorts` tiene valor y `TcpPort` está vacío, el puerto cambia en cada reinicio del
servicio. No hace falta hacer nada: el servidor lo averigua solo, y lo vuelve a averiguar si cambia,
así que ni SQL Browser ni un puerto estático son necesarios.

Al averiguarlo no basta con mirar qué puertos tiene abiertos el proceso de la instancia. Se han
visto instancias con **más de uno**, y alguno que acepta la conexión y la corta en el saludo, así
que a cada candidato se le manda un saludo TDS y solo se tiene en cuenta el que contesta. Entre los
que contestan gana el puerto del registro, después el que anotó el servicio al arrancar, después
el 1433, y por último el que escucha en todas las IP antes que el que solo escucha en loopback.

Si aun así falla, `--port <alias>:<puerto>` manda sobre todo lo anterior.

### Escritura: solo local o pruebas

Añade `--allow-writes` como último argumento. Sin ese flag el servidor arranca en solo lectura.

Con varias bases de datos (`--connection-name X:alias` repetido), `--allow-writes` habilita
escritura en **todas** a la vez. Para dar escritura solo a una conexión concreta y dejar el resto
en solo lectura, usa `--allow-writes-for <alias>` (repetible) en su lugar:

```json
"args": [
  "...",
  "--connection-name", "ConfConnectionString:config",
  "--connection-name", "DataConnectionString:data",
  "--allow-writes-for", "data"
]
```

En el ejemplo, `config` queda en solo lectura y `data` en lectura-escritura. `--allow-writes` y
`--allow-writes-for` son incompatibles con `--production`.

El wrapper escribe en stderr, al arrancar, el modo activo y las bases de datos resueltas — cada
conexión se marca con `(lectura-escritura)` si le corresponde. Si en el log del MCP no ves ese
bloque, no está arrancando el wrapper.

El `.mcp.json` solo contiene rutas, nunca credenciales: por eso se puede commitear en el
repositorio del proyecto. Las credenciales se leen del `Web.config` en tiempo de arranque.

Cuando no hay `Web.config` ni `appsettings.json`, el instalador las guarda en
`%APPDATA%\ahora-sql-mcp\<proyecto>.json`, y **la contraseña va cifrada**: DPAPI de Windows, ámbito
`CurrentUser`, así que solo tu cuenta y en ese equipo puede descifrarla y no hay ninguna clave que
custodiar. El wrapper la descifra en memoria al arrancar. Detalles en
[docs/REFERENCE.md](docs/REFERENCE.md#password-at-rest--srcsecretsjs).

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
  "<RUTA>/AHORA-SQL-MCP/bundle/start-mssql-mcp.cjs",
  "--config-file", "<RUTA_PROYECTO>/Web.config",
  "--connection-name", "DataConnectionString",
  "--allow-sql-dir", "C:/Codigo GIT/skills",
  "--allow-writes"
]
```

`--allow-sql-dir` es repetible. El wrapper imprime al arrancar la carpeta del proyecto y las
carpetas extra, porque la raíz por defecto depende de dónde se arranque el servidor.

Ejecutar de verdad exige `--allow-writes` (o `--allow-writes-for <alias>` para el `dbKey` que se
use). Sin eso el tool sigue disponible con `dryRun: true`, que lee el fichero, lo trocea por `GO`
y devuelve los batches con su línea de inicio sin ejecutar nada — útil para revisar un script antes
de lanzarlo.

---

## El MCP de desarrollo de producto (`ahora-erp`), al lado de este

El instalador puede registrar, **además** de `ahora-sql`, un segundo servidor MCP en el mismo
fichero de cliente: `ahora-erp`, que es el paquete
[`ahora-mcp`](https://nuget.ahorabh.com/packages/ahora-mcp/) del equipo de producto. No es una
variante de este servidor ni lo sustituye: es otro proceso, escrito en .NET, con 98 herramientas
propias para personalizar el ERP.

**Conviven a propósito.** Los prefijos no chocan —`mcp__ahora-sql__list_tables` frente a
`mcp__ahora-erp__ahora_leer_objeto`— y las reglas de `permissions.allow` de cada uno son
independientes. El reparto es: `ahora-sql` para leer y diagnosticar con SQL arbitrario sobre
cualquier `dbKey`; `ahora-erp` para aplicar personalizaciones con las validaciones del producto.

Lo que aporta este repositorio son tres cosas, todas por el mismo motivo —que la contraseña del
ERP no acabe en un fichero que se commitea:

1. **`bin/start-ahora-mcp.js`**, un lanzador. `ahora-mcp` se configura con la variable de entorno
   `AHORA_MCP_ERP`, que lleva la cadena de conexión entera. Escribirla en el bloque `env` del
   `.mcp.json` sería meter usuario y contraseña en el repositorio. El lanzador guarda **de dónde**
   sacarla (el `Web.config` del proyecto, o el fichero de credenciales cifrado con DPAPI en
   `%APPDATA%`), la resuelve en cada arranque y se la pasa al proceso hijo por el entorno.
2. **`installer/product-mcp.js`**, la instalación. El paquete no es un `dotnet tool`: es un
   `lib/net10.0-windows7.0` con el `.dll` y sus dependencias declaradas como dependencias NuGet
   normales. Se publica con un proyecto mínimo generado al vuelo en
   `%LOCALAPPDATA%\ahora-mcp` —carpeta propia y hermana de la del MCP de SQL, para que
   desinstalar aquel borrando su carpeta no se lleve este por delante—, y se arranca con
   `dotnet exec ahora-mcp.dll`: la
   forma que el propio paquete contempla en su `buildTransitive/ahora-mcp.targets`. Como esa
   restauración necesita `api.nuget.org` (el feed de AHORA solo hospeda `ahora-mcp`, no las
   dependencias de Microsoft), hay una segunda vía: copiar una carpeta ya publicada, sin red ni SDK.

   Al consultar el feed **completa la cadena de certificados** si el servidor la deja a medias, que
   es el caso de `nuget.ahorabh.com`: manda un intermedio que no firma su hoja y omite el bueno.
   Windows y el navegador lo tapan solos —por eso `curl` entra y Node no—, así que el instalador
   hace lo mismo: baja el emisor que falta de la URL que el propio certificado publica en su
   extensión AIA y **comprueba que lo firme una raíz de confianza antes de usarlo**. Esa
   comprobación no es opcional: la descarga es por HTTP plano y un certificado metido en `ca` pasa
   a ser ancla de confianza, así que sin verificarlo quien interceptara esa descarga podría colar
   el suyo. Nunca se desactiva la verificación (`NODE_TLS_REJECT_UNAUTHORIZED=0` cambiaría un
   problema del servidor por un agujero en todas las máquinas del equipo).
3. **Reglas de permisos propias.** Sus herramientas no comparten vocabulario con las de aquí
   (`ahora_leer_*` frente a `list_*`), así que un comodín no cubre las dos.

Dos límites que conviene tener presentes, y ninguno se puede arreglar desde aquí:

- **Una sola base de datos por proceso.** Su `ahora_connect` solo acepta servidor y base de datos
  con autenticación Windows; no hay alias ni `dbKey`. El instalador hace elegir cuál.
- **No tiene modo de solo lectura.** `ahora_ejecutar_dml` y la familia
  `ahora_crear_*`/`ahora_modificar_*`/`ahora_borrar_*` están siempre disponibles y no hay ningún
  conmutador que las desactive. Por eso el instalador **no lo ofrece** con el perfil de producción,
  y sus reglas de escritura se piden aparte y por defecto no se añaden.

---

## El MCP de navegador (`playwright`), también al lado

Tercera casilla del instalador, y tercera entrada del mismo fichero de cliente: el
[MCP de Playwright](https://www.npmjs.com/package/@playwright/mcp) de Microsoft. Cierra el círculo
de una personalización — se cambia la configuración en la base de datos con `ahora-sql` o
`ahora-erp`, y se **abre la pantalla** para comprobar que se ve como toca. Los tres prefijos son
distintos (`mcp__ahora-sql__*`, `mcp__ahora-erp__ahora_*`, `mcp__playwright__browser_*`), así que
ninguno tapa a los demás.

Es un paquete de un tercero y aquí no se mantiene. Lo que aporta este repositorio
(`installer/playwright-mcp.js`) son tres decisiones, y las tres tienen su motivo:

1. **Se instala, no se resuelve en cada arranque.** La forma que documenta Microsoft es
   `npx @playwright/mcp@latest`, que es exactamente el patrón que este repositorio se quitó de
   encima para su propio servidor con los números de más abajo: npx resuelve el paquete cada vez
   que el cliente levanta el MCP, y al agotarse los 30 segundos el servidor entero se descarta.
   Aquí queda instalado en `%LOCALAPPDATA%\playwright-mcp` —hermana de las otras dos, por lo mismo
   que aquellas— y la configuración apunta a su `cli.js`. Si npm no se alcanza y ya había una
   versión instalada, se reutiliza esa en lugar de dejar al instalador sin poder terminar.
2. **No se bajan los navegadores de Playwright.** El `postinstall` de `playwright` baja Chromium,
   Firefox y WebKit: del orden de medio giga desde su CDN, dentro de un `npm install` que parecía
   ir de otra cosa. No hace falta: `--browser chrome|msedge` conduce el navegador que ya está en la
   máquina, y en Windows 11 Edge está siempre. La instalación va con
   `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` y el canal se detecta mirando las rutas de siempre (ni
   Chrome ni Edge se añaden al `PATH`, así que `where chrome` no encuentra un Chrome que sí está).
   Solo si no hay ninguno de los dos se baja **Chromium**, y se baja aparte, con su propio aviso.
3. **Reglas de permisos que separan mirar de tocar.** De serie entran las de mirar —navegar,
   capturar, leer DOM, consola y red—; el clic y el teclado se piden aparte, porque un clic en una
   pantalla del ERP ejecuta lo que haya detrás del botón y eso puede acabar en un `INSERT` que no
   pasa por ninguna regla del MCP de SQL. `browser_evaluate` y `browser_run_code_unsafe` **no
   reciben regla en ningún caso**: ejecutan el código que se les pase dentro de la página, así que
   autorizarlas de antemano equivale a autorizar cualquier cosa. Los nombres salen del `tools/list`
   real del servidor, no de su documentación.

Y una cosa que **no** hace: pisar un `playwright` que no escribió él. Quien lo tenga configurado a
mano con sus propios flags se lo encuentra igual al marcar la casilla (se avisa y no se sustituye)
y al desmarcarla (se retira solo la entrada que apunta a nuestra instalación).

---

## Por qué esto no puede tardar

El cliente MCP arranca el servidor y espera el saludo `initialize`. Si no llega a tiempo
**descarta el servidor entero** y el agente se queda sin herramientas, con un error de la forma
`CONNECT_TIMEOUT: MCP server ahora-sql connection timed out after 30000ms`. El presupuesto por
defecto son **30 segundos**, y hay dos maneras distintas de agotarlo:

- **Lo que se paga siempre**, en cada arranque: lo que el servidor haga antes de contestar.
- **Lo que se paga una vez por máquina**: instalar el paquete, si el `.mcp.json` lo resuelve con
  `npx` en cada arranque.

Las dos están medidas abajo. Todas las cifras son de la misma máquina (Windows 11, Node 22.12,
npm 10.9) y con un servidor SQL **inalcanzable a propósito**, para que ninguna medida incluya el
tiempo de una base de datos que responde.

### Tiempo hasta el `initialize`

| Escenario | Antes (v1.8.3) | Ahora |
|---|---|---|
| `npx`, caché de npm **vacía** | **95.143 ms** | **1.752 ms** |
| `npx`, caché **caliente** | 8.497 / 10.950 / **75.754** ms | 1.921 - 2.152 ms |
| Binario instalado, sin `npx` | — | **254 - 283 ms** |
| Paquetes instalados | **166** | **1** |

Los tres valores de la fila «caché caliente» son tres tomas consecutivas, no un rango: con el
spec `github:` una de cada tres se iba a **75 segundos** porque `npx` vuelve a resolver la
referencia contra GitHub aunque el paquete ya esté descargado. Eso es lo que explica que «con la
caché caliente conecta bien» fuera cierto casi siempre y falso de vez en cuando, sin patrón
visible.

### Lo que se ha sacado del camino del saludo

Ninguna de estas cuatro cosas hacía falta para contestar `initialize`, y las cuatro se pagaban
antes de contestarlo:

| Coste | Antes | Ahora |
|---|---|---|
| Sondeo del puerto de la instancia (PowerShell) | 3.291 - 5.030 ms | en el primer uso de esa conexión |
| Descifrado de credenciales (DPAPI, PowerShell) | 505 - 536 ms | en el primer uso de esa conexión |
| Carga de `mssql` + `tedious` | 313 - 545 ms (432 módulos) | en la primera consulta |
| Carga del servidor completo | 524 - 667 ms (666 módulos) | **256 - 338 ms (236 módulos)** |

Esta parte importa **aunque la caché esté caliente y el paquete ya esté instalado**, y es la que
de verdad se paga siempre. Con la base de datos detrás de una VPN, el sondeo y el descifrado
pueden tardar bastante más que en esta máquina, y antes ese tiempo salía del presupuesto del
saludo. Ahora el servidor contesta con sus tools registradas sin haber abierto un socket, sin
haber validado credenciales y sin haber cargado el driver.

### Distribución: las tres salidas, medidas

Aquí está el resultado que no se ve venir. Empaquetar el servidor en un fichero sin dependencias
lleva los 166 paquetes a 1, pero **no arregla el arranque en frío si se sigue usando el spec
`github:`**:

| Salida | Instalación en frío | Paquetes | Veredicto |
|---|---|---|---|
| `github:` con dependencias *(lo de antes)* | 88.336 ms | 166 | descartada |
| `github:` con el paquete construido | **99.458 ms** | 1 | **no sirve** |
| Tarball (lo que sirve el registro de npm) | **1.573 ms** | 1 | vale para `npx` |
| Instalación global + binario en el `.mcp.json` | **0 ms al arrancar** | 1 | **recomendada** |

**Dicho explícitamente: empaquetar por sí solo NO baja el arranque en frío de 30 segundos.** Con
el spec `github:` sigue en ~99 s, es decir, ni mejora. El motivo es que el coste no estaba en
resolver dependencias sino en que `npm` **clona el repositorio** para un spec `github:`: 59 s de
`git clone` + empaquetado en el perfil de esta máquina, más 20 s de desempaquetado, y eso no
depende de cuántos paquetes haya dentro. Sobre un repositorio grande incluso empeora, porque el
fichero construido pesa más que las fuentes.

Lo que sí lo arregla es **quitar git del camino**. De ahí las dos recomendaciones, en este orden:

1. **Instalación global y el binario directo en el `.mcp.json`** — la recomendada. Es la única
   que garantiza que en el arranque no se instale nada: el coste de instalación pasa a ser cero y
   quedan los 254-283 ms del servidor. Además es la única inmune a que GitHub o el registro estén
   lentos o caídos justo cuando alguien abre el editor. Cuesta un paso manual al actualizar, que
   es exactamente lo que el instalador guiado automatiza.
2. **Publicar en el registro de npm** con el paquete ya construido — si se quiere seguir usando
   `npx`. La resolución pasa a ser la de un tarball (1.573 ms medidos frente a 88.336 ms), y el
   arranque completo con `npx` baja a 1.752 ms en frío. Sigue dependiendo de la red en el primer
   arranque de cada máquina, y el paquete es `private: true`, así que habría que decidir antes si
   se publica como paquete con ámbito restringido o en un registro interno.

El paquete construido (`npm run build`) es la base de las dos: sin él, cualquiera de las dos
seguiría instalando 166 paquetes.

### Paliativos del lado del cliente

Esto **no** sustituye a lo de arriba: sube el techo en lugar de bajar el coste. Sirve para
desatascar una máquina concreta hoy, no como configuración a repartir.

- **`MCP_TIMEOUT`** amplía el límite de arranque de Claude Code, **en milisegundos**. La
  documentación oficial lo describe como «MCP server startup timeout» y da el ejemplo
  `MCP_TIMEOUT=10000 claude` para un límite de 10 segundos; el valor por defecto son los 30.000 ms
  que aparecen en el mensaje de error. Comprobado en la
  [documentación de MCP de Claude Code](https://code.claude.com/docs/en/mcp), no supuesto.

  ```bash
  MCP_TIMEOUT=120000 claude
  ```

  Ojo con lo que hace de verdad: mientras el cliente espera, el agente no tiene estas
  herramientas. Un timeout de dos minutos convierte un fallo visible en dos minutos de arranque
  en silencio.

- **`--prefer-offline`** en los argumentos de `npx` hace que npm use lo que ya tenga en la caché
  y solo vaya a la red a por lo que falte. Ayuda en el arranque **en caliente**; en el primero de
  cada máquina no hay nada en la caché y no cambia nada.

  ```json
  "args": ["--yes", "--prefer-offline", "--package=@ahoraflx/sql-mcp", "start-mssql-mcp", "..."]
  ```

---

## Decisiones de diseño

| Decisión | Motivo |
|---|---|
| El proceso **no carga `.env`** | Un `.env` suelto en el directorio de trabajo podría definir `MSSQL_ENABLE_WRITES` y habilitar escrituras sin que nadie lo pidiera. La configuración entra solo por el entorno que prepara el wrapper. |
| **Solo transporte stdio**, sin transporte HTTP | No lo usamos. Menos superficie de ataque y menos código que mantener. |
| **`bundle/start-mssql-mcp.cjs` como única vía de arranque** | Resuelve la conexión desde el `Web.config` del proyecto, sanea el entorno y decide el modo de acceso. Mantiene las credenciales fuera del `.mcp.json`. |
| Paquete `@ahoraflx/sql-mcp` con `private: true` | Es de uso interno; `private` impide publicarlo por error en el registro público. |
| **Se publica `bundle/`, no `src/`** | Instalar el servidor era lo que agotaba el presupuesto del cliente MCP. Con todo dentro de tres ficheros, la instalación no resuelve ni descarga ningún árbol: 166 paquetes → 1. `dependencies` está vacío a propósito y `test/packaging.test.js` falla si alguien lo rellena. |
| **`mssql` se carga en la primera consulta**, no al arrancar | Son 313-545 ms y 432 de los 666 módulos que cargaba el servidor, y ninguna tool los necesita para anunciarse. `src/db/driver.js` lo carga la primera vez que alguien lo pide; `test/lazy-start.test.js` falla si vuelve a cargarse al arrancar. |
| **El wrapper no descifra las credenciales**, pasa el token al servidor | Descifrar con DPAPI cuesta un arranque de PowerShell (505-536 ms medidos) y se pagaba antes de que el servidor existiera. El fichero de credenciales no cambia de formato: lo que cambia es quién lo abre y cuándo. Se sigue validando la **forma** del token al arrancar, que es gratis, para que un fichero corrupto falle ahí y no en la primera consulta. |

`express` y `express-rate-limit` los arrastra `@modelcontextprotocol/sdk`, no nuestro código, y en
modo stdio no se ejecutan. Ya no aparecen en ninguna instalación: quedan dentro del fichero
construido, sin resolverse como paquetes.

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
- **Las instancias nombradas REMOTAS necesitan SQL Browser arrancado**, o indicar `--port`. Las
  locales las resuelve el servidor preguntando al sistema. Ver arriba.
- **`trustServerCertificate` vale `true` por defecto**: acepta cualquier certificado de servidor.
- **`describe_table` y `list_indexes` no aceptan nombres de tres partes.** El esquema Zod
  restringe los identificadores a `Tabla` o `esquema.Tabla`. Para consultas entre bases de datos
  hay que usar `execute_read_query` con SQL crudo, o el `dbKey` correspondiente.
- **`resources/list` enumera todas las tablas base de cada `dbKey`** (tope de 500 por BD). En
  AHORA_ERP eso es mucha respuesta; conviene que las skills usen `list_tables` con paginación en
  lugar de los resources.
- **`execute_read_query` devuelve 100 filas por defecto** (máximo 1000). Si una skill necesita
  más, tiene que paginar con `offset`.
- **`execute_write_query` es todo-o-nada.** Toda la consulta va en UNA transacción explícita, se
  trocea por `GO` igual que un `.sql`, y si algo falla no se aplica nada. Las sentencias que SQL
  Server no admite dentro de una transacción (`CREATE`/`ALTER DATABASE`, `BACKUP`, `RESTORE`,
  `CREATE FULLTEXT INDEX`) necesitan `transactional: false`, que renuncia a la atomicidad —y,
  porque un `Request` sobre el pool coge y suelta conexión en cada sentencia, también al estado
  de sesión entre ellas—. En ese modo, si falla a media tanda, el error enumera exactamente qué
  sentencias quedaron commiteadas.
- **`execute_sql_file` ejecuta todo el script en una sola transacción.** No es solo por
  atomicidad: un `Request` creado sobre el pool coge y suelta conexión en cada batch, así que sin
  transacción los batches irían a conexiones distintas y se rompería la semántica de `GO` (el
  `SET ANSI_NULLS ON` no aplicaría al `CREATE PROCEDURE` siguiente, y una `#tmp` del primer batch
  no existiría en el segundo). Consecuencia: **las sentencias que no admiten transacción no son
  soportadas** — `CREATE`/`ALTER DATABASE`, `BACKUP`, `CREATE FULLTEXT INDEX`.
- **`execute_sql_file` rechaza un `USE` al principio de un batch.** Cambiaría la base de datos de
  una conexión que después vuelve al pool y contaminaría llamadas posteriores. La base de datos se
  elige con `dbKey`.
- **Los `SET` del script sobreviven al batch, pero no a la conexión.** Antes del commit se
  restauran los valores por defecto de tedious (`ANSI_NULLS`, `QUOTED_IDENTIFIER` y compañía) como
  repaso pragmático; lo que cierra el hueco de verdad es que **cada conexión se resetea al salir
  del pool**, lo que devuelve las opciones SET a su estado inicial y tira las tablas temporales.
  Ver «Higiene del pool» más abajo.
- **Los `.sql` deben llevar BOM si no son UTF-8.** SSMS guarda en UTF-16LE con BOM, que se detecta
  y decodifica bien. Un UTF-16 **sin** BOM se rechaza con un error claro en lugar de mandar texto
  con NUL al servidor. Tope de tamaño: 2 MB, y 500 batches por fichero.

---

## Higiene del pool: transacciones huérfanas y timeouts por llamada

Un pool reparte la **misma** conexión a llamadas que no tienen nada que ver entre sí, así que el
estado que una deja pegado a la conexión lo hereda la siguiente. El caso que duele es una
transacción abierta, y llegaba a pasar así:

1. Una lectura se cancela —timeout del cliente, o el `AbortSignal` del cliente MCP—. `request.cancel()`
   no mata nada de golpe: manda un paquete ATTENTION y espera el acuse del servidor.
2. Mientras ese acuse no llega, el request sigue en vuelo, y **tedious serializa los requests de una
   conexión**: el `ROLLBACK` de la transacción de lectura no se puede ni enviar. Fallaba con
   `EREQINPROG` dentro de un `catch` vacío.
3. La conexión volvía al pool con `@@TRANCOUNT = 1`.

Medido contra SQL Server: cuatro sesiones `program_name='node-mssql'` durmiendo con
`open_transaction_count = 1` entre 372 y 434 segundos, `sys.dm_exec_requests` vacío y un único lock
`DATABASE` en modo `S` por sesión. **No bloquean a nadie**, y por eso no se ve como un bloqueo. El
daño era el de después: llamadas posteriores y sin relación fallando de forma intermitente —según en
qué conexión del pool cayeran—, con un `operation timed out for an unknown reason` que apunta al
servidor y no dice nada.

Lo peor no era ni eso. Una **lectura** que hereda la transacción se salva sola: su propio `ROLLBACK`
deshace todo el `@@TRANCOUNT`, heredado incluido. Una **escritura** no: hace `BEGIN` sobre el 1 que
hereda, el `COMMIT` lo baja a 1 otra vez, y el dato se queda dentro de una transacción ajena que
nadie va a cerrar. La llamada contestaba `committed: true` y el dato no era durable — desde otra
sesión no se veía. `scripts/repro-pool-poisoning.js` lo demuestra: con el saneado desactivado, la
lectura de comprobación se queda bloqueada en el lock exclusivo del `INSERT`.

Lo que hay ahora, por orden de lo que aporta:

- **Cada conexión se sanea al SALIR del pool**, no al devolverla. Es un `validate` propio en tarn
  (`config.pool.validate`, que mssql mezcla después de poner el suyo) que hace un reset de conexión
  TDS: el servidor deshace cualquier transacción abierta, tira las tablas temporales y restaura las
  opciones `SET`. Si la conexión no se deja resetear —o si el servidor sigue diciendo que tiene
  transacción abierta— se rechaza, y tarn crea otra en su lugar. **No cuesta un viaje extra**:
  sustituye al `SELECT 1` que mssql ya lanzaba por defecto. Con esto, una conexión quemada deja de
  contaminar a las llamadas siguientes.
- **Una conexión cuya cancelación o rollback ha fallado no vuelve al pool: se destruye.** La
  cancelación se espera con un límite acotado (5 s), se comprueba `@@TRANCOUNT` en **esa** conexión,
  y si no es 0 —o no se puede comprobar— la conexión se marca, se cierra (lo único que hace que el
  servidor deshaga la transacción *ya*, en lugar de dejarla durmiendo) y se suelta para que el pool
  recupere el hueco. Sin ese último paso cada fallo quemaría una plaza del pool para siempre, y al
  agotarlas todo `acquire` posterior muere por timeout.
- **El error del rollback ya no se traga.** En lugar de un timeout genérico, el mensaje dice que la
  transacción de esa conexión no se pudo cerrar, con qué `@@TRANCOUNT` se quedó, que la conexión se
  ha descartado y que hay que reintentar. Código de error `ETXNABANDONED`. El caso legítimo —un
  `COMMIT` explícito dentro de la consulta del usuario, que cierra la transacción envolvente— sigue
  sin ser un error: se sondea el `@@TRANCOUNT` y si es 0 no hay nada que reportar.
- **`list_databases` publica `recycledConnections`** por `dbKey`: cuántas conexiones se han tirado al
  sanearlas. Un contador que no se mueve descarta esta causa de un vistazo.

Y el timeout, que era la otra mitad del problema: `requestTimeout` (30 s por defecto) es de **pool**,
y no había forma de subirlo para una llamada. Un `DELETE` legítimo sobre una tabla concentradora con
41 FK `ON DELETE CASCADE` no cabe en 30 s y, tal como estaba, no se podía ejecutar. `execute_read_query`,
`execute_write_query` y `execute_sql_file` aceptan ahora **`timeoutMs` por llamada** (1.000–600.000 ms),
que se aplica donde tedious lo lee de verdad (`request.timeout` del request de tedious, que mssql nunca
llegaba a poner).

**`execute_sql_file` no hereda los 30 s: su defecto son 90.000 ms.** Ese presupuesto es **por batch**,
no por script, así que un despliegue largo no se penaliza por ser largo. El batch que se pasaba de 30 s
nunca era el `CREATE PROCEDURE` —eso son milisegundos— sino el `CREATE INDEX` o el `MERGE` de datos que
va detrás, que caen justo en la franja de 30-70 s; y como el script entero va en una sola transacción,
quedarse corto ahí no costaba una sentencia, costaba el despliegue completo con su rollback. Los otros
dos siguen en los 30 s del pool: ahí el límite es el freno que interesa conservar para un `SELECT`
desbocado, y quien necesite más lo pide con `timeoutMs`.

---

## Desarrollo

```bash
npm test              # tests unitarios, sin base de datos
npm run integration   # requiere una BD real; ver docs/REFERENCE.md
npm run repro:pool    # requiere una BD real; reproduce el envenenamiento del pool
```

`repro:pool` es la reproducción del fallo descrito en «Higiene del pool»: envenena una conexión
del pool a mano, comprueba en `sys.dm_exec_sessions` que no queda ninguna transacción huérfana y
lanza 20 lecturas seguidas. Sin el saneado al adquirir, tres de sus comprobaciones fallan.

```bash
MSSQL_TEST_SERVER=localhost MSSQL_TEST_INSTANCE=SQL2022 MSSQL_TEST_USER=sa MSSQL_TEST_PASSWORD='...' npm run repro:pool
```

Al subir versión, **comprueba que los nombres de las herramientas no han cambiado**: si cambian,
hay que actualizar las skills de SC0 en el mismo momento.

## Licencia

MIT — ver [LICENSE](LICENSE). El aviso de copyright incluye a Mihai-Nicolae Dulgheru porque parte
del código del servidor procede de su proyecto `mssql-mcp-node`, también MIT. La licencia obliga a
conservar ese aviso: **no lo borres del fichero LICENSE.**
