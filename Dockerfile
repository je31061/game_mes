# Factory World — 컨테이너 이미지 (Koyeb / Hugging Face Spaces / Fly.io / Oracle VM / Docker 공용)
#   docker build -t factory-world .
#   docker run -p 3000:3000 -e FW_ADMIN_PASSWORD=바꿀비밀번호 -v fwdata:/data factory-world
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# 데이터(DB·업로드·시크릿)는 /data 볼륨에 — 볼륨을 붙이지 않으면 컨테이너 재시작 때 초기화
ENV FW_DATA_DIR=/data FW_BACKUP_DIR=/data/backups PORT=3000
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
