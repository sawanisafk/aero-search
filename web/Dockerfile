# syntax=docker/dockerfile:1
# Aero Search — static frontend image (nginx) built from the workspace root
# (context must be the repository root because web/ is an npm workspace).

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm --workspace web run build

FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
