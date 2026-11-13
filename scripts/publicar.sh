#!/usr/bin/env bash
# Arma la carpeta que publica Netlify (dist/) SOLO con los archivos de la app.
# Antes se publicaba el repositorio completo: cualquiera podía descargar los
# SQL, el código del servidor, las pruebas, el manual y las notas internas.
#
# Si la página referencia un archivo que no está en la lista, la construcción
# falla y Netlify mantiene en línea la versión anterior (no se publica a medias).
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHIVOS=(
  index.html manifest.json config.js sw.js
  styles.css portal-ui.css
  pure.js borradores.js data-access.js reportes-exportacion.js lector-local.js
  foto-comprobante.js revision-comprobante.js portal-ui.js recorrido.js app.js
)

rm -rf dist
mkdir -p dist
cp "${ARCHIVOS[@]}" dist/
cp -R assets dist/assets

# Todo lo que la página, el service worker y la app piden a este mismo sitio
# tiene que estar publicado.
faltan=0
referencias=$(
  { grep -oE '(src|href)="[^"#:]+"' index.html | sed -E 's/^(src|href)="//; s/"$//'
    grep -oE '"/[^"]+"' sw.js | tr -d '"' | sed 's#^/##'
    grep -ohE "assets/[A-Za-z0-9._/-]+" app.js styles.css portal-ui.css manifest.json
  } | sed 's/?.*$//' | grep -v '^$' | sort -u
)
for ref in $referencias; do
  case "$ref" in index.html|"") continue ;; esac
  if [ ! -f "dist/$ref" ]; then echo "FALTA en la publicación: $ref" >&2; faltan=1; fi
done
[ -f dist/index.html ] || { echo "FALTA index.html" >&2; faltan=1; }
[ "$faltan" -eq 0 ] || exit 1

echo "Publicación lista en dist/: $(find dist -type f | wc -l) archivos."
