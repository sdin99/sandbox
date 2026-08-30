# 단독 서비스 배포용 이미지 — dist/standalone.js 실행
# (기존 API 서버에 mount하는 모드에서는 이 파일이 필요 없다)

FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# 파일 저장소 경로 — 컨테이너에서는 볼륨(emptyDir/PVC)을 여기에 마운트할 것
ENV ASSET_MCP_EXPORT_DIR=/data/exports
EXPOSE 8000
CMD ["node", "dist/standalone.js"]
