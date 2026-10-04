@echo off
REM 一键启动本地开发环境（前置：后端已构建 cd apps\api ^&^& npm run build）
cd /d %~dp0

echo [1/3] 启动数据库（Docker 里的 Postgres，端口 5433）...
docker compose up -d db
timeout /t 6 /nobreak >nul

echo [2/3] 启动后端  http://localhost:3000/api ...
cd apps\api
start "piano-api" cmd /k "node dist\main.js"
cd ..\..

echo [3/3] 启动前端  http://localhost:5173 ...
cd apps\web
start "piano-web" cmd /k "npm run dev"
cd ..\..

echo.
echo 完成。浏览器打开 http://localhost:5173
