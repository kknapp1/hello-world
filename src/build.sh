set -e
cd "$(dirname "$0")"
npx esbuild main.js --bundle --minify --format=iife --target=es2020 --legal-comments=none --outfile=bundle.js
python3 - <<'PY'
page = open('page.html').read()
js = open('bundle.js').read().replace('</script', '<\\/script')
body = page.replace('/*BUNDLE*/', '\n/* three.js (MIT) https://threejs.org */\n' + js)
open('../site/index.html', 'w').write('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + body.replace('<canvas', '</head>\n<body>\n<canvas', 1) + '</body>\n</html>\n')
open('../site/artifact.html', 'w').write(body)
PY
ls -la ../site
