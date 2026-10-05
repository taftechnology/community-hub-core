#!/bin/sh
set -eu
mkdir -p /var/lib/postgresql/tls
cp /certs/server.crt /var/lib/postgresql/tls/server.crt
cp /certs/server.key /var/lib/postgresql/tls/server.key
chown postgres:postgres /var/lib/postgresql/tls/server.crt /var/lib/postgresql/tls/server.key
chmod 600 /var/lib/postgresql/tls/server.key
exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file=/var/lib/postgresql/tls/server.crt \
  -c ssl_key_file=/var/lib/postgresql/tls/server.key
