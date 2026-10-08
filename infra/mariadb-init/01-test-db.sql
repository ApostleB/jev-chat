-- 통합 테스트 전용 database (개발 DB와 분리)
CREATE DATABASE IF NOT EXISTS jev_chat_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON jev_chat_test.* TO 'jev'@'%';
-- prisma migrate dev의 shadow database 생성 권한
GRANT CREATE, DROP ON *.* TO 'jev'@'%';
FLUSH PRIVILEGES;
