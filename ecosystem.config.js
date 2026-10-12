// PM2 설정. 시크릿을 넣지 않는다 — jev-chat-api/.env(서버에만 존재, 권한 600)를 앱이 dotenv로 읽는다.
module.exports = {
  apps: [
    {
      name: "jev-chat-api",
      cwd: "./jev-chat-api",
      script: "dist/app/main.js",
      exec_mode: "fork",
      instances: 1, // Socket.IO 세션 큐·멱등 진행 목록이 프로세스 메모리에 있으므로 단일 인스턴스
      max_memory_restart: "512M",
      kill_timeout: 10000, // 진행 중 처리 마무리 시간
      env: { NODE_ENV: "development" },
      env_production: { NODE_ENV: "production" },
    },
  ],
};
