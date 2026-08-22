FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY main.js ./
# Không cần copy data — ảnh trả về qua response, không lưu ra host fs
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "main.js"]
