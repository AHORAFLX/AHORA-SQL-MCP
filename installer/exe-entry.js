// Punto de entrada del .exe empaquetado.
//
// Dentro de un SEA no hay un `module` de entrada contra el que comparar
// `require.main`, asi que setup.js no se autoarranca. Este fichero es el que se
// empaqueta y lo unico que hace es lanzarlo.
require("./setup").run();
