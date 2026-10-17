# Collecte de pièces – image de production. Aucune dépendance npm à l'étape 1 (Node 24 suffit, SQLite inclus).
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
# Liste des pièces et textes des e-mails : modifiables sans toucher au code.
COPY config/ ./config/
# Base de données (et, à l'étape 3, pièces chiffrées) : volume Docker monté sur /data.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TRUST_PROXY=1 INTERNAL_PORT=3001 INTERNAL_HOST=0.0.0.0
USER node
# 3000 : site public, routé par Traefik. 3001 : port interne réservé à n8n, sur le seul réseau privé du projet.
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:3000/sante || exit 1
CMD ["node", "src/index.js"]
