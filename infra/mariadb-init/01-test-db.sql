-- 통합 테스트 전용 database (개발 DB와 분리)
CREATE DATABASE IF NOT EXISTS jev_chat_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON jev_chat_test.* TO 'jev'@'%';
-- prisma migrate dev 전용 shadow database (서버 전체 CREATE/DROP 권한 대신 이 DB만 허용)
CREATE DATABASE IF NOT EXISTS jev_chat_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON jev_chat_shadow.* TO 'jev'@'%';
FLUSH PRIVILEGES;
