FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
USER node
EXPOSE 3000
CMD ["node", "--max-old-space-size=128", "start-site.js"]
