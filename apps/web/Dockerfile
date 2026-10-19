FROM node:24-bookworm-slim AS build

WORKDIR /workspace
COPY . .
RUN npm install --include=dev \
    && case "$(node -p 'process.arch')" in \
      arm64) rolldown_binding=arm64-gnu ;; \
      x64) rolldown_binding=x64-gnu ;; \
      *) echo "Unsupported Docker architecture for Vite/Rolldown: $(node -p 'process.arch')" >&2; exit 1 ;; \
    esac \
    && npm install --no-save --package-lock=false "@rolldown/binding-linux-${rolldown_binding}@1.2.14" \
    && npm run build -w @piano/web

FROM nginx:1.27-alpine
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
RUN printf '%s\n' \
    'server {' \
    '  listen 80;' \
    '  server_name _;' \
    '  root /usr/share/nginx/html;' \
    '  location /api/ {' \
    '    proxy_pass http://core:3000;' \
    '    proxy_http_version 1.1;' \
    '    proxy_set_header Host $host;' \
    '    proxy_set_header X-Real-IP $remote_addr;' \
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
    '    proxy_set_header X-Forwarded-Proto $scheme;' \
    '  }' \
    '  location / {' \
    '    try_files $uri $uri/ /index.html;' \
    '  }' \
    '}' > /etc/nginx/conf.d/default.conf

EXPOSE 80
