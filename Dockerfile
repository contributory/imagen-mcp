FROM node:22-alpine

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY main.js ./

ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "main.js"]
