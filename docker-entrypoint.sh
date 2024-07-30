#!/bin/sh
if ! which -- "${1}"; then
  # first arg is not an executable
  if [ -e /tmp/.X99-lock ]; then rm /tmp/.X99-lock -f; fi
  export DISPLAY=:99
  Xvfb "${DISPLAY}" -nolisten unix &
  # exec node --inspect=0.0.0.0:9229 /usr/src/app/ "$@"
  exec node /usr/src/app/ "$@"
fi

exec "$@"
