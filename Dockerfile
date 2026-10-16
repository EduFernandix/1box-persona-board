FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node","server.js"]
