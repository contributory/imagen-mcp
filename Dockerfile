FROM denoland/deno:2.9.6

WORKDIR /app
COPY deno.json supabase-queue.ts main.ts ./
RUN deno cache main.ts supabase-queue.ts

ENV PORT=8000
EXPOSE 8000
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-import", "scripts/serve.ts"]
