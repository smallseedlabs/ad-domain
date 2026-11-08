#!/bin/sh
set -e
if [ "$(id -u)" = "0" ]; then
  exec su-exec proba:proba node dist/main.js
fi
exec node dist/main.js
