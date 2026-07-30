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
REM    - Credenciales de git de AHORA     (las mismas que para clonar repos)
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

REM Se ejecuta desde la carpeta del proyecto, no desde la del .cmd: el instalador
REM propone el directorio actual como raiz del proyecto.
echo  Carpeta actual: %CD%
echo.
echo  Si esta no es la raiz de tu proyecto, cierra esta ventana, copia el .cmd
echo  a la carpeta del proyecto y vuelve a ejecutarlo desde alli.
echo.
pause

npx --yes --package=github:AHORAFLX/AHORA-SQL-MCP#v1.2.0 ahora-setup

echo.
if errorlevel 1 (
  echo  [X] El instalador ha terminado con errores. Revisa los mensajes de arriba.
) else (
  echo  [OK] Instalador terminado.
)
echo.
pause
