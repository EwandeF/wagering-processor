#!/usr/bin/env bash
# Prova que as migrations são reversíveis: sobe tudo, desfaz tudo e sobe de novo,
# num banco descartável, e compara o schema antes e depois.
set -euo pipefail
cd "$(dirname "$0")/.."

DB=migration_roundtrip
ADMIN=(docker compose exec -T postgres psql -U wager -d postgres -v ON_ERROR_STOP=1 -t -A)
SCRATCH=(docker compose exec -T postgres psql -U wager -d "$DB" -v ON_ERROR_STOP=1 -t -A)
MIGRATE=(bun run src/infrastructure/database/migrate.ts)
COUNT=$(ls src/infrastructure/database/migrations/Migration*.ts | wc -l)

# O pg_dump 16.x grava um token aleatório em \restrict: sai da comparação.
dump() { docker compose exec -T postgres pg_dump -U wager -s "$DB" | grep -Ev '^\\(un)?restrict'; }

"${ADMIN[@]}" -c "drop database if exists $DB"
"${ADMIN[@]}" -c "create database $DB"
export DATABASE_URL="postgresql://wager:wager@localhost:5432/$DB"

echo "== $COUNT migrations: subindo =="
"${MIGRATE[@]}" up
dump > /tmp/schema_before.sql
echo "tabelas: $("${SCRATCH[@]}" -c "select count(*) from information_schema.tables where table_schema = 'public'")"

echo "== desfazendo todas =="
for _ in $(seq "$COUNT"); do "${MIGRATE[@]}" down; done
left=$("${SCRATCH[@]}" -c "select string_agg(table_name, ',') from information_schema.tables where table_schema = 'public'")
funcs=$("${SCRATCH[@]}" -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'")
echo "sobrou: $left | funções: $funcs"

echo "== subindo de novo =="
"${MIGRATE[@]}" up
dump > /tmp/schema_after.sql

status=0
if [ "$left" != "mikro_orm_migrations" ] || [ "$funcs" != "0" ]; then
  echo "FALHOU: sobrou algo depois de desfazer tudo"
  status=1
fi
if diff -q /tmp/schema_before.sql /tmp/schema_after.sql > /dev/null; then
  echo "OK: schema idêntico depois de desfazer tudo e refazer ($(wc -l < /tmp/schema_after.sql) linhas)"
else
  echo "FALHOU: os schemas diferem"
  diff /tmp/schema_before.sql /tmp/schema_after.sql | head -20
  status=1
fi

"${ADMIN[@]}" -c "drop database $DB"
exit $status
