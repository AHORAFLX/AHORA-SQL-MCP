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
npx --yes --package=github:AHORAFLX/AHORA-SQL-MCP#v1.2.0 ahora-setup
```

Se abre un formulario en el navegador: detecta tu `Web.config` o `appsettings.json`, **valida la
conexión de verdad contra el servidor antes de escribir nada**, pregunta si es producción y escribe
la configuración del cliente que uses.

Solo configura el MCP de SQL: **no instala skills**, eso lo haces tú en el paso 1.

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

Crea un fichero `.mcp.json` en la **raíz del proyecto** y pega el bloque que te corresponda.
Lo único que tienes que cambiar es la ruta del fichero de configuración.

> El servidor **tiene que llamarse `mssql`**. Ese nombre es lo que hace que las skills lo encuentren.
> Si lo llamas de otra forma no da error: simplemente las skills dejan de ver la base de datos.

### Flexygo en .NET Framework (tiene `Web.config`)

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": [
        "--yes", "--package=github:AHORAFLX/AHORA-SQL-MCP#v1.2.0", "start-mssql-mcp",
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
    "mssql": {
      "command": "npx",
      "args": [
        "--yes", "--package=github:AHORAFLX/AHORA-SQL-MCP#v1.2.0", "start-mssql-mcp",
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

### Sin `Web.config` ni `appsettings.json`

Los datos van en `env`, nunca en los argumentos: `.mcp.json` se commitea.

> La alternativa, y lo que hace el instalador guiado, es `--credentials-file`: las credenciales se
> guardan en un JSON en `%APPDATA%\ahora-sql-mcp\` y en el `.mcp.json` solo queda su ruta. Así ni
> siquiera están en el fichero del proyecto.

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": [
        "--yes", "--package=github:AHORAFLX/AHORA-SQL-MCP#v1.2.0", "start-mssql-mcp",
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

1. **Reinicia el cliente MCP.** Sin reiniciar no lee el `.mcp.json`.
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
| No aparece ninguna herramienta de SQL | No has reiniciado el cliente |
| `No se encontro la cadena de conexion`, con el nombre correcto | .NET Core: la cadena está vacía en `appsettings.json` y tu entorno no es `Development`. Añade `"--environment", "<nombre>"`. El error te dice en qué ficheros ha buscado |
| El error lista nombres de conexión distintos a los que pusiste | Los nombres varían entre proyectos. Usa los que te lista |
| Timeout al conectar, con instancia nombrada | El servicio SQL Browser está parado. Añade `"--port", "1433"` |
| `Integrated Security=True` | No está soportado: la cadena necesita usuario y contraseña |

Para cualquier otra cosa, pide al agente que use la skill **`setup-mcp-sql`**: te hace las preguntas
y te genera el `.mcp.json`.

---

## Más detalle

- [README.md](README.md) — configuración completa del MCP
- [docs/REFERENCE.md](docs/REFERENCE.md) — catálogo de herramientas, límites y modelo de seguridad
