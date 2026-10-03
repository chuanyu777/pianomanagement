#!/usr/bin/env bash
# 本地库 + 迁移 + 起服务 + 业务冒烟，一条命令跑完（避免后台进程被回收）。
set -u
cd /d/DevSpace/piano-management/apps/api

echo "── 1) 重建本地 Postgres（prisma dev，不需要 Docker）"
npx prisma dev stop default >/dev/null 2>&1 || true
npx prisma dev stop default >/dev/null 2>&1 || true
npx prisma dev rm default >/dev/null 2>&1 || true
OUT=$(timeout 200 npx prisma dev --detach --name default 2>&1)
BASE=$(echo "$OUT" | grep -oE 'postgres://[^ ]+' | tail -1 | sed 's/@localhost:/@127.0.0.1:/')
if [ -z "$BASE" ]; then echo "起库失败："; echo "$OUT" | tail -6; exit 1; fi
APPDB=$(echo "$BASE" | sed -E 's#/[^/?]*(\?|$)#/piano\1#')

cat > ./dbwait.tmp.mjs <<'JS'
import pg from 'pg';
const [url, mode] = process.argv.slice(2);
for (let i = 1; i <= 30; i++) {
  try {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    if (mode === 'create') {
      const e = await c.query("SELECT 1 FROM pg_database WHERE datname='piano'");
      if (e.rowCount === 0) await c.query('CREATE DATABASE piano');
      console.log('数据库已就绪（第 ' + i + ' 次尝试）');
    } else {
      console.log('连接正常（第 ' + i + ' 次尝试）');
    }
    await c.end();
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 3000));
  }
}
console.error('30 次尝试都没连上');
process.exit(1);
JS

echo "── 2) 等库就绪并建应用库"
node ./dbwait.tmp.mjs "$BASE" create || { echo "库没起来"; rm -f ./dbwait.tmp.mjs; exit 1; }
node ./dbwait.tmp.mjs "$APPDB" ping || { echo "piano 库连不上"; rm -f ./dbwait.tmp.mjs; exit 1; }
rm -f ./dbwait.tmp.mjs

echo "── 3) 应用迁移"
DATABASE_URL="$APPDB" npx prisma migrate deploy 2>&1 | tail -4

echo "── 4) 起服务并等它就绪"
export SMOKE_PW="$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
DATABASE_URL="$APPDB" node dist/main.js > /tmp/api-smoke.log 2>&1 &
APIPID=$!
READY=0
for i in $(seq 1 20); do
  if grep -q "API 已启动" /tmp/api-smoke.log 2>/dev/null; then READY=1; break; fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then echo "服务没起来："; tail -12 /tmp/api-smoke.log; kill $APIPID 2>/dev/null; exit 1; fi
grep -E "数据库连通性|API 已启动" /tmp/api-smoke.log | tail -2

echo "── 5) 业务冒烟"
python smoke.tmp.py
SMOKE=$?
kill $APIPID 2>/dev/null
echo "── 冒烟退出码 = $SMOKE"
echo "── 服务端 ERROR 行："
grep -E "\[ERROR\]" /tmp/api-smoke.log | head -6 || echo "  (无)"
exit $SMOKE
