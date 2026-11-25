FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 AS lambda-adapter

FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /var/task
COPY --from=lambda-adapter /lambda-adapter /opt/extensions/lambda-adapter
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV PORT=8080
ENV AWS_LWA_PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/health
EXPOSE 8080
CMD ["npm", "start"]
