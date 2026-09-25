@echo off
REM ---------------------------------------------------------------------------
REM  Instalador de AHORA-SQL-MCP.
REM
REM  Deja el MCP de SQL configurado en la carpeta del proyecto. No instala skills.
REM
REM  Es el fichero que se le pasa al companero en la formacion: doble clic y ya.
REM  No lleva nada dentro; solo lanza el instalador guiado desde GitHub, asi que
REM  siempre instala la version buena sin tener que redistribuir nada.
REM
REM  Requisitos en la maquina destino:
REM    - Node.js 18 o superior            (https://nodejs.org/)
REM    - Git for Windows en el PATH       (npm lo usa para bajar el paquete de GitHub)
REM ---------------------------------------------------------------------------
setlocal

echo.
echo  Instalador AHORA-SQL-MCP
echo  ========================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [X] No se encuentra Node.js en el PATH.
  echo      Instala Node LTS desde https://nodejs.org/ y vuelve a ejecutar esto.
  echo.
  pause
  exit /b 1
)

REM Sin git, npx no puede resolver `github:...` y falla con un "Command failed" que no
REM dice la causa. Caso real: un companero sin Git for Windows.
where git >nul 2>nul
if errorlevel 1 (
  echo  [X] No se encuentra Git en el PATH.
  echo      npm lo necesita para descargar el instalador de GitHub, aunque no
  echo      clones nada. Instala Git for Windows:
  echo        winget install --id Git.Git -e
  echo      o desde https://git-scm.com/download/win, abre una ventana nueva y
  echo      vuelve a ejecutar esto.
  echo.
  pause
  exit /b 1
)

REM El instalador propone la carpeta actual como raiz del proyecto, pero se puede
REM cambiar dentro. Lanzarlo desde el proyecto solo ahorra teclearla.
echo  Carpeta actual: %CD%
echo.
echo  El instalador propondra esta carpeta como raiz del proyecto. Si no es la
echo  correcta, podras cambiarla dentro: no hace falta mover este fichero.
echo.
pause

REM OJO: este pin se sube a mano. No lo deriva nadie, asi que va en la lista de
REM ficheros a tocar en cada `chore(release)`, junto a package.json, README.md
REM e INSTALAR.md. Quedarse atras aqui instala una version vieja en silencio.
npx --yes --package=github:AHORAFLX/AHORA-SQL-MCP#v1.15.1 ahora-setup

echo.
if errorlevel 1 (
  echo  [X] El instalador ha terminado con errores. Revisa los mensajes de arriba.
) else (
  echo  [OK] Instalador terminado.
)
echo.
pause
