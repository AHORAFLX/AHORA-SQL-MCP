# Instalar — guía rápida

Para un compañero que empieza de cero. Son dos cosas y unos cinco minutos:

| | Qué es |
|---|---|
| **Skills** | El conocimiento del equipo (cómo crear objetos Flexygo, campos configurables, resolver tickets…) |
| **MCP de SQL** | El acceso del agente a la base de datos real, para que verifique tablas y columnas en lugar de suponerlas |

Instala las dos. Con skills pero sin MCP, el agente genera T-SQL contra nombres inventados.

---

## 0. Requisitos

- [Node.js](https://nodejs.org/) 18 o superior.
- Acceso git a los repos privados de AHORA (el mismo con el que ya clonas repos del equipo).
- Un cliente con soporte MCP: Claude Code, VS Code con Copilot, Cursor…

No hace falta clonar ningún repositorio.

---

## Atajo para el paso 2: el instalador guiado

El paso 1 (skills) se hace con un comando y no tiene más. El paso 2 (el MCP) es el que tiene
enjundia, y hay un instalador que lo hace por ti. Ábrelo **desde la carpeta de tu proyecto**:

```bash
npx --yes --package=github:AHORAFLX/AHORA-SQL-MCP#v1.8.3 ahora-setup
```

Se abre un formulario en el navegador: detecta tu `Web.config` o `appsettings.json`, **se conecta de
verdad al servidor para comprobar que funciona antes de escribir nada**, pregunta si es producción y
escribe la configuración del cliente que uses.

Solo configura el MCP de SQL: **no instala skills**, eso lo haces tú en el paso 1.

**No necesitas proyecto.** Si lo lanzas sobre una carpeta vacía —el caso típico del implantador que
solo quiere consultar una base de datos— te pide servidor, base de datos, usuario y contraseña,
prueba la conexión, y guarda las credenciales en `%APPDATA%\ahora-sql-mcp\` para que **no acaben en
el `.mcp.json`**, que es un fichero que se commitea. En la carpeta solo queda el `.mcp.json` con la
ruta. Abres esa carpeta con tu cliente y ya tienes acceso a la BD.

Si el servidor no responde te lo dice y te deja seguir marcando una casilla, porque puede ser la VPN
o el SQL Browser parado y no una errata.

También ofrece **permitir de antemano las consultas de lectura**, para que el modo auto de Claude Code
no te las deniegue en mitad de una demo con un mensaje que no menciona el MCP. Las **escrituras se
quedan fuera** salvo que lo pidas expresamente: que te pregunte antes de escribir es el freno que
interesa conservar.

- `--cli` → asistente de terminal en vez de formulario (necesario por RDP sin navegador).
- `--no-open` → no lanza el navegador, solo imprime la URL.

Quien te esté formando puede darte en su lugar un `INSTALAR-AHORA.cmd` (doble clic) o un
`ahora-setup.exe`; hacen exactamente esto mismo.

---

## 1. Skills

Las de `common` **primero y siempre**: contienen las reglas que el resto referencia.

```bash
npx skills add AHORAFLX/AHORA-SCO-SKILLS/skills/common
```

Después, las categorías que uses:

```bash
npx skills add AHORAFLX/AHORA-SCO-SKILLS/skills/SQL
```

```bash
npx skills add AHORAFLX/AHORA-SCO-SKILLS/skills/Flexygo
```

```bash
npx skills add AHORAFLX/AHORA-SCO-SKILLS/skills/General
```

---

## 2. MCP de SQL

Instala el servidor una vez:

```bash
npm install --omit=dev github:AHORAFLX/AHORA-SQL-MCP#v1.8.3 --prefix "%LOCALAPPDATA%\AHORA-SQL-MCP"
```

Después crea un fichero `.mcp.json` en la **raíz del proyecto** y pega el bloque que te
corresponda. Lo único que tienes que cambiar es la ruta del fichero de configuración.

> El servidor **tiene que llamarse `ahora-sql`**. Ese nombre es lo que hace que las skills lo
> encuentren. Si lo llamas de otra forma no da error: simplemente las skills dejan de ver la base
> de datos.
>
> **Se llamaba `mssql`.** Chocaba con la extensión nativa de SQL Server de VS Code, que registra
> sus propias herramientas `mssql_list_databases`, `mssql_list_tables`, `mssql_list_views`… y
> acababan mezcladas con las nuestras. Si vuelves a lanzar el instalador, la entrada vieja se
> retira sola; si tu `.mcp.json` está escrito a mano, renombra la clave.
>
> **No pongas `"command": "npx"` con `--package=github:…`**, que es lo que se documentaba antes.
> Eso resuelve el paquete contra GitHub en **cada arranque** del MCP: unos 7 segundos cada vez, y
> unos 48 la primera vez con una versión nueva. El cliente espera 30 segundos y al agotarse
> descarta el servidor entero, así que el agente se queda sin herramientas y te dice que "las
> conexiones MCP están inestables". Instalado una vez, el arranque baja a menos de un segundo.

### Flexygo en .NET Framework (tiene `Web.config`)

```json
{
  "mcpServers": {
    "ahora-sql": {
      "command": "node",
      "args": [
        "C:/Users/TU_USUARIO/AppData/Local/AHORA-SQL-MCP/node_modules/@ahoraflx/sql-mcp/bin/start-mssql-mcp.js",
        "--config-file", "C:/ruta/al/proyecto/Web.config",
        "--connection-name", "ConfConnectionString:config",
        "--connection-name", "DataConnectionString:data"
      ]
    }
  }
}
```

### Flexygo migrado a .NET Core (tiene `appsettings.json`)

Igual, pero apuntando a la carpeta que contiene el `appsettings.json` (normalmente `conf`):

```json
{
  "mcpServers": {
    "ahora-sql": {
      "command": "node",
      "args": [
        "C:/Users/TU_USUARIO/AppData/Local/AHORA-SQL-MCP/node_modules/@ahoraflx/sql-mcp/bin/start-mssql-mcp.js",
        "--config-file", "C:/ruta/al/proyecto/Backend/conf",
        "--connection-name", "ConfConnectionString:config",
        "--connection-name", "DataConnectionString:data"
      ]
    }
  }
}
```

### Una sola base de datos

Quita el `--connection-name` que no necesites. El `dbKey` pasa a ser `maindb`.

### Más de dos

Añade un `--connection-name NOMBRE:alias` por cada una. No hay tope, y el instalador guiado deja
marcarlas todas. El alias acaba dentro de un nombre de variable de entorno, así que solo admite
letras, dígitos y guion bajo, empezando por letra.

### Sin `Web.config` ni `appsettings.json`

Los datos van en `env`, nunca en los argumentos: `.mcp.json` se commitea.

> La alternativa, y lo que hace el instalador guiado, es `--credentials-file`: las credenciales se
> guardan en un JSON en `%APPDATA%\ahora-sql-mcp\` y en el `.mcp.json` solo queda su ruta. Así ni
> siquiera están en el fichero del proyecto.

```json
{
  "mcpServers": {
    "ahora-sql": {
      "command": "node",
      "args": [
        "C:/Users/TU_USUARIO/AppData/Local/AHORA-SQL-MCP/node_modules/@ahoraflx/sql-mcp/bin/start-mssql-mcp.js",
        "--from-env"
      ],
      "env": {
        "MSSQL_SERVER": "PC_158\\SQL2022",
        "MSSQL_DATABASE": "MiBD",
        "MSSQL_USER": "usuario",
        "MSSQL_PASSWORD": "clave"
      }
    }
  }
}
```

### Cosas que quizá necesites añadir

| Añade | Cuándo |
|---|---|
| `"--allow-writes"` | El agente tiene que ejecutar INSERT/UPDATE/DDL. **Solo en local o pruebas**, nunca contra producción. Sin este flag el MCP arranca en solo lectura. |
| `"--production"` | La BD es de producción. Marca la configuración y hace que `--allow-writes` **falle al arrancar**, no que avise. Son incompatibles a propósito. |
| `"--allow-sql-dir", "C:/ruta/a/scripts"` | Vas a ejecutar ficheros `.sql` que están **fuera** de la carpeta del proyecto. Los de dentro ya funcionan sin configurar nada. |
| `"--environment", "<nombre>"` | Solo .NET Core, si el `appsettings` con las cadenas rellenas no es el de `Development`. |

---

## 3. Comprobar que funciona

1. **Abre una sesión nueva sobre esa carpeta.** La configuración se lee al arrancar la sesión y es
   de ámbito **proyecto**: una sesión abierta sobre otra carpeta no la ve.
   - **Claude Desktop** (pestaña Code): `Ctrl+N` y elige la carpeta. No hace falta cerrar la app.
   - **Claude Code en terminal**: `cd` a la carpeta y ejecuta `claude`.
   - **Copilot en VS Code**: abre la carpeta como espacio de trabajo y recarga la ventana.

   La primera vez te pedirá **aprobar** el servidor, porque viene de un `.mcp.json` de proyecto.
   Acepta. El servidor tarda unos segundos en conectar: puede que el agente diga que aún no está
   disponible y lo esté un momento después.
2. Busca en el log del MCP el bloque de arranque:

   ```
   AHORA-SQL-MCP — modo SOLO LECTURA
     Conexion desde: C:/ruta/al/proyecto/conf (entorno Development)
     [config] PC_158\SQL2022 / PROYECTO_IC
     [data] PC_158\SQL2022 / PROYECTO
     SQL desde: C:\ruta\al\proyecto (carpeta del proyecto)
   ```

   Si ese bloque no aparece, el wrapper no está arrancando: revisa la ruta del `.mcp.json`.
3. Pide al agente: *«lista las bases de datos configuradas»*. Debe responder con `config` y `data`
   (o `maindb` si solo hay una).

---

## Si algo falla

| Síntoma | Causa habitual |
|---|---|
| No aparece ninguna herramienta de SQL | No has abierto una sesión nueva, o la has abierto sobre otra carpeta |
| `⏸ Pending approval` al mirar con `claude mcp list` | Falta aprobar el servidor: abre una sesión sobre la carpeta y acepta. Si lo rechazaste, `claude mcp reset-project-choices` |
| Elegí "VS Code" pero uso la extensión de Claude Code | Son agentes distintos. La extensión **es** Claude Code y lee `.mcp.json`; la opción de VS Code es para GitHub Copilot |
| En VS Code salen herramientas de SQL duplicadas o el agente usa las que no son | Tienes un `.mcp.json` viejo con el servidor llamado `mssql`, que choca con la extensión nativa `ms-mssql.mssql`. Vuelve a lanzar el instalador: renombra el servidor a `ahora-sql` y retira la entrada anterior |
| `Permission denied ... Blocked by classifier` al usar una herramienta | Es la capa de permisos de Claude Code en modo auto, no el MCP. El instalador puede añadir las reglas; o añádelas a mano en `permissions.allow` de `.claude/settings.local.json`: `mcp__ahora-sql__list_*`, `mcp__ahora-sql__describe_*`, `mcp__ahora-sql__execute_read_query` |
| `No se encontro la cadena de conexion`, con el nombre correcto | .NET Core: la cadena está vacía en `appsettings.json` y tu entorno no es `Development`. Añade `"--environment", "<nombre>"`. El error te dice en qué ficheros ha buscado |
| El error lista nombres de conexión distintos a los que pusiste | Los nombres varían entre proyectos. Usa los que te lista |
| Timeout al conectar, con instancia nombrada **local** | El wrapper intenta averiguar el puerto solo. Si aun así falla, esa instancia no tiene **TCP/IP a la escucha**: habilítalo en SQL Server Configuration Manager (Protocolos de `<INSTANCIA>` → TCP/IP) y reinicia el servicio. **Que SSMS conecte no lo descarta**: en local SSMS usa memoria compartida y este driver es solo TCP |
| Timeout con instancia nombrada **remota** | Ahí no se puede preguntar al sistema: hace falta el servicio **SQL Browser** arrancado en ese servidor, o pasar el puerto con `"--port", "<alias>:<puerto>"` |
| `Integrated Security=True` | No está soportado: la cadena necesita usuario y contraseña |

Para cualquier otra cosa, pide al agente que use la skill **`setup-mcp-sql`**: te hace las preguntas
y te genera el `.mcp.json`.

---

## Más detalle

- [README.md](README.md) — configuración completa del MCP
- [docs/REFERENCE.md](docs/REFERENCE.md) — catálogo de herramientas, límites y modelo de seguridad
