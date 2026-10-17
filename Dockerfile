# Collecte de pièces – image de production. Aucune dépendance npm à l'étape 1 (Node 24 suffit, SQLite inclus).
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
# Base de données (et, à l'étape 3, pièces chiffrées) : volume Docker monté sur /data.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TRUST_PROXY=1
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:3000/sante || exit 1
CMD ["node", "src/index.js"]
